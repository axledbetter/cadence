/**
 * Active-profile resolution: file → env → flag, with path-safety gates.
 *
 * Public surface:
 *   - `resolveProfile({ cwd, envProfile, flagProfile })` — returns the
 *     fully-materialized active profile with its source tag. Hard-fails
 *     with `ProfileResolutionError` on any unknown name, path-traversal
 *     attempt, schema violation, filename mismatch, or YAML parse error.
 *
 * Internal (NOT re-exported from the package index):
 *   - `loadProfileByName(name)` — load + validate a single profile by
 *     name. Shares the `validateProfileNameAgainstAvailableStems()`
 *     path-safety gate with `resolveProfile()` so neither function can
 *     join an arbitrary string into a file path.
 *
 * Path-safety contract (spec v7.12.0 revised pass 3 CRITICAL #2): the
 * candidate name must (a) match the regex `^[a-z0-9][a-z0-9-]*$` and
 * (b) appear exactly in the enumerated stems of `presets/profiles/*.yaml`
 * BEFORE any file read. Names containing `/`, `\`, `..`, leading dots, or
 * path separators are rejected even if the regex passes. The `templates/`
 * subdirectory is skipped during enumeration.
 *
 * Parsing rules for `.autopilot/profile` (spec revised pass 1 finding #7
 * + pass 3 WARN #5):
 *   - Allowed: `enterprise\n`, `enterprise   \n`, `enterprise\n\n`,
 *     `enterprise\n\n\n` (single non-empty line, optional trailing
 *     whitespace + blank lines).
 *   - Rejected: `enterprise\nsolo\n` (two non-empty lines),
 *     `enterprise # comment` (inline comment), `enter prise` (embedded
 *     whitespace).
 *   - Empty / whitespace-only file → treat as unset (fall through to
 *     env/flag/default), do NOT raise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { findPackageRoot } from '../../cli/_pkg-root.ts';
import { createProtocolLoader, FilesystemSchemaRegistry } from '../protocol/loader.ts';
import { ensureMigrationsRegistered } from '../protocol/migrations/index.ts';
import { ProtocolError } from '../protocol/errors.ts';
import {
  ProfileResolutionError,
  type ProfileConfig,
  type ProfileResolutionSource,
  type ResolvedProfile,
} from './types.ts';

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_PROFILE_NAME = 'solo';
/**
 * Canonical env var that overrides the file layer. EXPORTED so PR2's
 * dispatcher reads `process.env[ENV_VAR_NAME]` from a single source of
 * truth (bugbot, low severity: "unused profile env constant" was due to
 * resolver taking the value via options — PR2 will plumb it in).
 */
export const ENV_VAR_NAME = 'CLAUDE_AUTOPILOT_PROFILE';
// U+FEFF — leading BOM that Windows editors often prepend to UTF-8 files
// (bugbot, medium severity). Stripped from `.autopilot/profile` content
// before parsing so `﻿enterprise` doesn't fail the regex.
const UTF8_BOM = '﻿';

// Lazy-loaded validator cache — keyed by package root so multiple roots
// in one process (tests with synthetic roots, embedding in a daemon
// that resolves multiple package installs) don't cross-contaminate
// (bugbot, low severity). Production callers will hit the same cache
// entry every time since findPackageRoot() returns a stable path.
const _validatorCache = new Map<string, ReturnType<Ajv['compile']>>();

function getValidator(packageRoot: string): ReturnType<Ajv['compile']> {
  const cached = _validatorCache.get(packageRoot);
  if (cached) return cached;
  const schemaPath = path.join(packageRoot, 'presets', 'schemas', 'profile.schema.json');
  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    throw new ProfileResolutionError(
      `Failed to load profile schema at ${schemaPath}`,
      {
        code: 'schema_violation',
        details: { cause: err instanceof Error ? err.message : String(err) },
        hint: 'Reinstall: npm install -g @delegance/cadence',
      },
    );
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  // v8.5.0 — `phaseRoute.baseUrl` uses `format: "uri"`; register
  // ajv-formats so the validator recognizes it instead of warning
  // "unknown format 'uri' ignored".
  addFormats(ajv);
  const compiled = ajv.compile(schemaJson as object);
  _validatorCache.set(packageRoot, compiled);
  return compiled;
}

/**
 * Test-only: clear the per-packageRoot validator cache. Required so
 * tests that swap synthetic package roots get a fresh schema.
 */
export function _resetSchemaCache(): void {
  _validatorCache.clear();
}

function resolvePackageRoot(): string {
  const root = findPackageRoot(import.meta.url);
  if (!root) {
    throw new ProfileResolutionError(
      'Could not locate Cadence package root (presets/profiles/ unreachable).',
      {
        code: 'unknown',
        hint: 'Reinstall: npm install -g @delegance/cadence',
      },
    );
  }
  return root;
}

/**
 * Enumerate direct `*.yaml` stems under `presets/profiles/`. The
 * `templates/` subdirectory is intentionally skipped so PR templates
 * never appear as available profiles.
 */
function enumerateAvailableStems(packageRoot: string): string[] {
  const profilesDir = path.join(packageRoot, 'presets', 'profiles');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch (err) {
    throw new ProfileResolutionError(
      `Failed to enumerate profiles at ${profilesDir}`,
      {
        code: 'unknown',
        details: { cause: err instanceof Error ? err.message : String(err) },
        hint: 'Reinstall: npm install -g @delegance/cadence',
      },
    );
  }
  const stems: string[] = [];
  for (const entry of entries) {
    // Skip subdirectories (notably `templates/`) and non-yaml files.
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml')) continue;
    stems.push(entry.name.slice(0, -'.yaml'.length));
  }
  stems.sort();
  return stems;
}

function validateProfileNameAgainstAvailableStems(
  name: string,
  packageRoot: string,
  source: ProfileResolutionSource,
): void {
  // Regex gate first — catches obvious path-traversal attempts (`..`, `/`,
  // `\`, leading dot, extension) before any directory read.
  if (!PROFILE_NAME_REGEX.test(name)) {
    throw new ProfileResolutionError(
      `Invalid profile name "${name}": must match ^[a-z0-9][a-z0-9-]*$`,
      {
        code: 'path_traversal',
        source,
        hint: `Profile names contain only lowercase letters, digits, and hyphens. Examples: solo, small-team, oss-maintainer.`,
      },
    );
  }
  // Stem-enumeration gate — even a regex-clean name must match a shipped
  // profile. Belt-and-suspenders against future schema drift.
  const stems = enumerateAvailableStems(packageRoot);
  if (!stems.includes(name)) {
    throw new ProfileResolutionError(
      `Unknown profile "${name}". Available: ${stems.join(', ')}`,
      {
        code: 'unknown',
        source,
        hint: `Pick one of the shipped profiles or run \`cadence profile list\`.`,
        details: { available: stems },
      },
    );
  }
}

function applyDefaults(raw: Partial<ProfileConfig>): ProfileConfig {
  // Schema has already enforced presence of required keys + type
  // constraints; this layer materializes the optional-key defaults so
  // every consumer sees a fully-populated ProfileConfig.
  const base: ProfileConfig = {
    profile: raw.profile as string,
    description: raw.description as string,
    codex_passes: raw.codex_passes as ProfileConfig['codex_passes'],
    auto_merge: raw.auto_merge ?? true,
    require_risk_frontmatter: raw.require_risk_frontmatter ?? false,
    pause_at_steps: raw.pause_at_steps ?? [],
    audit_log_path: raw.audit_log_path ?? null,
    codex_explanations: raw.codex_explanations ?? false,
    pr_template_path: raw.pr_template_path ?? null,
    contributor_policy: raw.contributor_policy ?? null,
  };
  if (raw.protocol_version !== undefined) {
    base.protocol_version = raw.protocol_version;
  }
  if (raw.phases !== undefined) {
    base.phases = raw.phases;
  }
  return base;
}

// -- Protocol loader for profile.yaml -----------------------------------
// Lazy-instantiated per packageRoot. The loader normalizes the declared
// `protocol_version` field (default '1.0.0') and validates the YAML
// against `profile-${declared}.json` then `profile-${current}.json`
// per the 3-stage pipeline. Spec:
// docs/superpowers/specs/2026-05-27-protocol-versioning-design.md.
const _profileProtocolLoaderCache = new Map<string, ReturnType<typeof createProtocolLoader>>();

function getProfileProtocolLoader(packageRoot: string): ReturnType<typeof createProtocolLoader> {
  const cached = _profileProtocolLoaderCache.get(packageRoot);
  if (cached) return cached;
  ensureMigrationsRegistered();
  const loader = createProtocolLoader({
    component: 'profile',
    schemaRegistry: new FilesystemSchemaRegistry(packageRoot),
  });
  _profileProtocolLoaderCache.set(packageRoot, loader);
  return loader;
}

/** Test-only — clear the protocol-loader cache (used when swapping
 *  synthetic package roots). */
export function _resetProfileProtocolLoaderCache(): void {
  _profileProtocolLoaderCache.clear();
}

/**
 * INTERNAL helper — load + validate a single profile by name. NOT
 * re-exported from `src/core/profile/index.ts`. External consumers MUST
 * use `resolveProfile()` so they go through the full precedence chain.
 *
 * Shares the path-safety gate with `resolveProfile()` — direct callers
 * (tests, internal tooling) get the same `../solo`, `templates/foo`,
 * `solo.yaml` rejection behavior before any file read.
 */
function loadProfileByName(
  name: string,
  packageRoot: string,
  source: ProfileResolutionSource,
): ProfileConfig {
  validateProfileNameAgainstAvailableStems(name, packageRoot, source);
  const profilePath = path.join(packageRoot, 'presets', 'profiles', `${name}.yaml`);
  let raw: string;
  try {
    raw = fs.readFileSync(profilePath, 'utf8');
  } catch (err) {
    // Stem enumeration listed this name moments ago — a read failure now
    // is a race / packaging bug, not a user error. Surface as `unknown`.
    throw new ProfileResolutionError(
      `Failed to read profile "${name}" at ${profilePath}`,
      {
        code: 'unknown',
        source,
        details: { cause: err instanceof Error ? err.message : String(err) },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new ProfileResolutionError(
      `Invalid YAML in profile "${name}" at ${profilePath}`,
      {
        code: 'parse_error',
        source,
        details: { cause: err instanceof Error ? err.message : String(err) },
      },
    );
  }
  // Protocol-loader handshake (v1.0.0+). Normalizes `protocol_version`,
  // runs migrations if needed, and returns the canonical current-shape
  // DTO. The legacy strict Ajv check below then validates the canonical
  // result — both schemas accept `protocol_version`, so the two passes
  // don't conflict. Spec: docs/superpowers/specs/2026-05-27-protocol-versioning-design.md.
  if (parsed && typeof parsed === 'object') {
    try {
      parsed = getProfileProtocolLoader(packageRoot).load(parsed).value;
    } catch (err) {
      if (err instanceof ProtocolError) {
        throw new ProfileResolutionError(
          `Profile "${name}" failed protocol-loader handshake (${err.code}): ${err.message}`,
          {
            code: 'schema_violation',
            source,
            details: {
              protocol_code: err.code,
              ...err.details,
            },
            ...(err.hint !== undefined ? { hint: err.hint } : {}),
          },
        );
      }
      throw err;
    }
  }
  const validate = getValidator(packageRoot);
  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).slice(0, 5).map(e => {
      const loc = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '<root>';
      if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
        return `${loc}: unexpected key "${e.params.additionalProperty as string}"`;
      }
      return `${loc}: ${e.message ?? 'invalid'}`;
    });
    throw new ProfileResolutionError(
      `Profile "${name}" failed schema validation:\n  ${errors.join('\n  ')}`,
      {
        code: 'schema_violation',
        source,
        details: { errors: validate.errors ?? [] },
      },
    );
  }
  const config = applyDefaults(parsed as Partial<ProfileConfig>);
  // Filename ↔ field match is a resolver-level check (schema can't see
  // the filename context).
  if (config.profile !== name) {
    throw new ProfileResolutionError(
      `Profile filename mismatch: file "${name}.yaml" declares profile "${config.profile}".`,
      {
        code: 'filename_mismatch',
        source,
        hint: `Rename the file to "${config.profile}.yaml" or change the \`profile:\` field to "${name}".`,
        details: { filename_stem: name, profile_field: config.profile },
      },
    );
  }
  return config;
}

/**
 * Parse `.autopilot/profile` per the spec's normalization rules.
 *
 * Returns the candidate profile name, or `null` for an empty /
 * whitespace-only file (which falls through to env/flag/default — not an
 * error).
 *
 * Raises `ProfileResolutionError` for: multiple non-empty lines, inline
 * comments, or embedded whitespace in the name. Path-safety validation
 * happens later in the resolver (this function only cares about
 * well-formedness of the file).
 */
function parseProfileFile(contents: string): string | null {
  // Strip a leading UTF-8 BOM (`﻿`) — Windows editors often
  // prepend it to text files, and without this step `﻿enterprise`
  // would fail the profile-name regex even though the visible text
  // matches (bugbot, medium severity: "UTF-8 BOM breaks profile file").
  const normalized = contents.startsWith(UTF8_BOM) ? contents.slice(UTF8_BOM.length) : contents;
  // Split on \n; strip trailing CR (Windows CRLF) and trailing spaces +
  // tabs from each line. Without the explicit \r strip, a CRLF file
  // (`enterprise\r\n`) would carry the \r into the candidate name and
  // trip the embedded-whitespace check below — Windows users would never
  // be able to use the file (bugbot, medium severity).
  const lines = normalized.split('\n').map(l => l.replace(/[ \t\r]+$/, ''));
  const nonEmpty = lines.filter(l => l.length > 0);
  if (nonEmpty.length === 0) {
    // Empty / whitespace-only file — treat as unset.
    return null;
  }
  if (nonEmpty.length > 1) {
    throw new ProfileResolutionError(
      `.autopilot/profile contains multiple non-empty lines (only one profile name allowed).`,
      {
        code: 'parse_error',
        source: 'file',
        hint: `Keep a single profile name on the first line, e.g. \`enterprise\\n\`.`,
        details: { line_count: nonEmpty.length },
      },
    );
  }
  const candidate = nonEmpty[0]!;
  // Inline comment (`#` anywhere) is rejected — comments aren't supported
  // in this single-line config surface.
  if (candidate.includes('#')) {
    throw new ProfileResolutionError(
      `.autopilot/profile must not contain inline comments.`,
      {
        code: 'parse_error',
        source: 'file',
        hint: `Remove the \`#\` segment and keep only the profile name.`,
        details: { line: candidate },
      },
    );
  }
  // Embedded whitespace (spaces / tabs anywhere in the name).
  if (/\s/.test(candidate)) {
    throw new ProfileResolutionError(
      `.autopilot/profile must not contain whitespace inside the profile name.`,
      {
        code: 'parse_error',
        source: 'file',
        hint: `Profile names contain only lowercase letters, digits, and hyphens (e.g. \`small-team\`).`,
        details: { line: candidate },
      },
    );
  }
  return candidate;
}

export interface ResolveProfileOptions {
  cwd: string;
  envProfile?: string;
  flagProfile?: string;
}

/**
 * Resolve the active profile by walking the precedence chain:
 *
 *   default → file (`<cwd>/.autopilot/profile`) → env (`CLAUDE_AUTOPILOT_PROFILE`) → flag (`--profile`)
 *
 * Empty / whitespace-only env values are treated as unset (fall through).
 * Empty flag values (`--profile ""`) raise a typed error — supplying the
 * flag with an empty argument is unambiguously a CLI mistake.
 *
 * The selected name is validated against the available stems BEFORE the
 * YAML file is read, then loaded + schema-validated. The returned
 * `source` tag identifies which precedence layer won, useful for
 * `doctor` / `profile show`.
 */
export function resolveProfile(opts: ResolveProfileOptions): ResolvedProfile {
  const packageRoot = resolvePackageRoot();

  let candidate: string | null = null;
  let source: ProfileResolutionSource = 'default';

  // Resolve in REVERSE precedence order so a higher layer short-circuits
  // before we ever parse a lower layer. This matters because
  // `.autopilot/profile` parse errors are HARD failures — if we parsed
  // the file first, a broken file would block a user's emergency
  // `--profile solo` escape hatch (bugbot, medium severity: "Invalid
  // file blocks flag override"). End-to-end precedence is still
  // file < env < flag.

  // Layer 3 (highest): CLI flag. Empty flag value is explicitly rejected
  // — passing `--profile ""` is a user mistake, not an "unset" signal.
  // We use the `parse_error` code (not `path_traversal`) because an
  // empty string isn't a traversal attempt; it's a malformed CLI
  // argument that a downstream "wrong-remediation" branch (bugbot, low
  // severity) should distinguish from `../solo`-style attacks.
  const flagValue = opts.flagProfile;
  if (flagValue !== undefined) {
    if (flagValue.trim().length === 0) {
      throw new ProfileResolutionError(
        `--profile flag was supplied with an empty value.`,
        {
          code: 'parse_error',
          source: 'flag',
          hint: `Pass a profile name (e.g. \`--profile solo\`) or omit the flag.`,
        },
      );
    }
    candidate = flagValue.trim();
    source = 'flag';
  }

  // Layer 2: env var. Empty / whitespace-only env values fall through.
  if (candidate === null) {
    const envValue = opts.envProfile;
    if (envValue !== undefined && envValue.trim().length > 0) {
      candidate = envValue.trim();
      source = 'env';
    }
  }

  // Layer 1 (lowest): repo file. Only consumed when neither flag nor
  // env won. A higher-layer winner means we never touch the file, so a
  // broken `.autopilot/profile` doesn't block emergency overrides.
  if (candidate === null) {
    const profileFilePath = path.join(opts.cwd, '.autopilot', 'profile');
    if (fs.existsSync(profileFilePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(profileFilePath, 'utf8');
      } catch (err) {
        // Filesystem-level failure (EACCES, EIO, transient mount
        // issue) — NOT a content / parse problem. Bucket as `unknown`
        // so doctor messaging and downstream branches don't suggest
        // "fix your profile file's syntax" when the actual issue is
        // permissions (bugbot, low severity).
        throw new ProfileResolutionError(
          `Failed to read ${profileFilePath}`,
          {
            code: 'unknown',
            source: 'file',
            hint: `Check file permissions on .autopilot/profile, or delete the file to fall back to the env/flag/default chain.`,
            details: { cause: err instanceof Error ? err.message : String(err) },
          },
        );
      }
      const parsed = parseProfileFile(raw);
      if (parsed !== null) {
        candidate = parsed;
        source = 'file';
      }
    }
  }

  // Fall back to the shipped default if every layer was unset.
  if (candidate === null) {
    candidate = DEFAULT_PROFILE_NAME;
    source = 'default';
  }

  const config = loadProfileByName(candidate, packageRoot, source);
  return { name: candidate, config, source };
}

/**
 * Test-only helper — exposes `loadProfileByName` for direct tests that
 * need to assert the path-safety gate fires before any file read. NOT
 * re-exported from `src/core/profile/index.ts`. Underscore prefix marks
 * it as internal API per the package's `_*`-prefixed convention.
 */
export function _loadProfileByNameForTest(name: string, opts?: { packageRoot?: string }): ProfileConfig {
  const packageRoot = opts?.packageRoot ?? resolvePackageRoot();
  return loadProfileByName(name, packageRoot, 'default');
}

/**
 * Test-only helper — exposes the `.autopilot/profile` parser for unit
 * tests that exercise allow / reject cases without touching disk.
 */
export function _parseProfileFileForTest(contents: string): string | null {
  return parseProfileFile(contents);
}
