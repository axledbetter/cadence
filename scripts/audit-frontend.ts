// scripts/audit-frontend.ts
//
// Layer 2 of the frontend-quality work (issue #178). Deterministic AST audit
// that scans `*.{tsx,jsx}` files for high-signal slop signals:
//   - raw color literals in JSX style props / string attributes
//   - missing alt on <img>
//   - icon-only buttons without an accessible name
//   - interactive <div>/<span> without role + keyboard handler + tabIndex
//   - inputs without a label / aria-label / aria-labelledby / title / wrapper
//
// Mirrors the shape of `scripts/audit-supabase-imports.ts`: same Finding
// type, same {script + test seam} pattern, same exit semantics.
//
// Exit codes (single source of truth — match plan + spec):
//   0 — clean, no error-severity findings
//   1 — at least one error-severity finding, listed on stderr
//   2 — operational/config/parse failure (config schema violation,
//       git-resolve failure, parse diagnostic, unknown flag)
//
// NOTE-severity findings (e.g. alt="" decorative review) are surfaced ONLY
// when --include-notes is passed and NEVER alter the exit code on their own.
//
// Usage:
//   npx tsx scripts/audit-frontend.ts                # diff vs default base
//   npx tsx scripts/audit-frontend.ts --base=master  # diff vs explicit ref
//   npx tsx scripts/audit-frontend.ts --files=a.tsx,b.tsx  # bypass git
//   npx tsx scripts/audit-frontend.ts --include-notes
//   npx tsx scripts/audit-frontend.ts --allow-parse-failures

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import Ajv from 'ajv';
import { minimatch } from 'minimatch';

// -- Types --------------------------------------------------------------------

type Severity = 'error' | 'note';

export interface Finding {
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: Severity;
  message: string;
}

interface FrontendQualityConfig {
  componentLibrary?: string;
  themeFiles?: string[];
  rawColorAllowedFiles?: string[];
  rules?: Partial<Record<RuleName, boolean>>;
  ignorePaths?: string[];
  buttonComponents?: string[];
  selfLabelingInputComponents?: string[];
}

type RuleName =
  | 'forbidRawColorLiterals'
  | 'requireAltOnImg'
  | 'requireAriaLabelOnIconButton'
  | 'forbidInteractiveDiv'
  | 'requireLabelForInput'
  | 'forbidMagicSpacing';

interface ResolvedConfig {
  rules: Record<RuleName, boolean>;
  rawColorAllowedFiles: string[];
  ignorePaths: string[];
  buttonComponents: Set<string>;
  selfLabelingInputComponents: Set<string>;
}

const DEFAULT_RULES: Record<RuleName, boolean> = {
  forbidRawColorLiterals: true,
  requireAltOnImg: true,
  requireAriaLabelOnIconButton: true,
  forbidInteractiveDiv: true,
  requireLabelForInput: true,
  forbidMagicSpacing: false,
};

const DEFAULT_BUTTON_COMPONENTS = [
  'button',
  'Button',
  'IconButton',
  'DropdownMenuTrigger',
  'TooltipTrigger',
  'PopoverTrigger',
  'SheetTrigger',
  'AlertDialogTrigger',
  'DialogTrigger',
];

const DEFAULT_SELF_LABELING_INPUTS = ['FormControl', 'TextField', 'RadioGroup'];

// Hex (3/4/6/8 hex digits) OR rgb(...)/rgba(...)/hsl(...)/hsla(...).
// Color keywords (e.g. "red", "transparent") intentionally NOT flagged in v1 —
// too many false positives on words like "border-red-500" Tailwind classes.
const RAW_COLOR_REGEX = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\()/;

// -- Config loading -----------------------------------------------------------

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

class ConfigError extends Error {}
class GitResolveError extends Error {}
class ParseFailureError extends Error {
  constructor(public diagnostic: { file: string; line: number; col: number; message: string }) {
    super(`Parse failure in ${diagnostic.file}:${diagnostic.line}:${diagnostic.col}: ${diagnostic.message}`);
  }
}

function loadConfig(repoRoot: string, schemaPath: string): ResolvedConfig {
  const cfgPath = path.join(repoRoot, '.autopilot', 'frontend-quality.json');
  let raw: FrontendQualityConfig = {};
  if (fs.existsSync(cfgPath)) {
    let text: string;
    try {
      text = fs.readFileSync(cfgPath, 'utf8');
    } catch (e) {
      throw new ConfigError(`Failed to read ${cfgPath}: ${(e as Error).message}`);
    }
    try {
      raw = JSON.parse(text) as FrontendQualityConfig;
    } catch (e) {
      throw new ConfigError(`Invalid JSON in ${cfgPath}: ${(e as Error).message}`);
    }
    let schemaText: string;
    try {
      schemaText = fs.readFileSync(schemaPath, 'utf8');
    } catch (e) {
      throw new ConfigError(`Failed to read schema ${schemaPath}: ${(e as Error).message}`);
    }
    const schema = JSON.parse(schemaText);
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(raw)) {
      const errs = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || '(root)'}: ${e.message ?? 'invalid'}${e.params ? ` (${JSON.stringify(e.params)})` : ''}`)
        .join('\n');
      throw new ConfigError(`Config validation failed for ${cfgPath}:\n${errs}`);
    }
  }
  const rules: Record<RuleName, boolean> = { ...DEFAULT_RULES, ...(raw.rules ?? {}) };
  const buttonComponents = new Set<string>(raw.buttonComponents ?? DEFAULT_BUTTON_COMPONENTS);
  const selfLabelingInputComponents = new Set<string>(raw.selfLabelingInputComponents ?? DEFAULT_SELF_LABELING_INPUTS);
  return {
    rules,
    rawColorAllowedFiles: raw.rawColorAllowedFiles ?? [],
    ignorePaths: raw.ignorePaths ?? [],
    buttonComponents,
    selfLabelingInputComponents,
  };
}

// -- Diff resolution ----------------------------------------------------------
//
// Uses spawnSync(execFile-style) — NOT exec/shell — so user-controlled
// arguments cannot inject shell metacharacters. The base ref still flows
// through git, but git itself validates the ref; our process boundary is
// argv array, never a shell string.

function runGit(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return {
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

function autoDetectBaseRef(repoRoot: string): string {
  const head = runGit(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (head.status === 0) {
    const ref = head.stdout.trim();
    if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  }
  const main = runGit(repoRoot, ['rev-parse', '--verify', 'origin/main']);
  if (main.status === 0) return 'origin/main';
  const master = runGit(repoRoot, ['rev-parse', '--verify', 'origin/master']);
  if (master.status === 0) return 'origin/master';
  throw new GitResolveError(
    'Could not auto-detect base ref (no origin/HEAD, origin/main, or origin/master).\n' +
    '  Pass --base=<ref> or --files=<comma-separated> explicitly.',
  );
}

function resolveDiffFiles(repoRoot: string, base: string): string[] {
  // git diff --name-only --diff-filter=AM <base>...HEAD
  // base is treated as a single ref argument, never as shell input.
  const res = runGit(repoRoot, ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]);
  if (res.status !== 0) {
    throw new GitResolveError(
      `git diff against ${base} failed: ${res.stderr.trim() || 'non-zero exit'}\n` +
      '  Pass --base=<ref> or --files=<comma-separated> explicitly.',
    );
  }
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Reject paths with .. segments or leading /. Returns null if invalid.
function normalizeRepoRelative(p: string): string | null {
  if (!p) return null;
  if (p.startsWith('/')) return null;
  const norm = p.replace(/\\/g, '/');
  if (norm.split('/').some((seg) => seg === '..')) return null;
  return norm;
}

function applyIgnorePaths(files: string[], ignorePatterns: string[]): string[] {
  if (ignorePatterns.length === 0) return files;
  return files.filter((f) => !ignorePatterns.some((pat) => minimatch(f, pat)));
}

function isAuditableExt(file: string): boolean {
  return file.endsWith('.tsx') || file.endsWith('.jsx');
}

// -- AST helpers --------------------------------------------------------------

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineColFromPos(sf: ts.SourceFile, pos: number): { line: number; col: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, col: character + 1 };
}

function jsxTagName(opening: ts.JsxOpeningLikeElement): string {
  const name = opening.tagName;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) return name.name.text;
  if (ts.isJsxNamespacedName(name)) return name.name.text;
  return '';
}

function getAttribute(opening: ts.JsxOpeningLikeElement, attrName: string): ts.JsxAttribute | null {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name && ts.isIdentifier(a.name) && a.name.text === attrName) {
      return a;
    }
  }
  return null;
}

function hasAttribute(opening: ts.JsxOpeningLikeElement, attrName: string): boolean {
  return getAttribute(opening, attrName) !== null;
}

/**
 * Returns true if the attribute's value is a non-empty string. For
 * `foo="bar"` returns true; for `foo=""` returns false; for `foo={someVar}`
 * conservatively returns true (we cannot evaluate the expression).
 */
function attributeHasNonEmptyValue(attr: ts.JsxAttribute): boolean {
  const init = attr.initializer;
  if (!init) return false;
  if (ts.isStringLiteral(init)) return init.text.trim().length > 0;
  if (ts.isJsxExpression(init)) {
    const expr = init.expression;
    if (!expr) return false;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return expr.text.trim().length > 0;
    }
    return true;
  }
  return false;
}

function attributeStringValue(attr: ts.JsxAttribute): string | null {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const expr = init.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  }
  return null;
}

/**
 * Walk the children of a JSX element looking for any non-whitespace text or
 * any descendant element with `sr-only` in its className. Returns true if a
 * visible OR sr-only-text accessible-name source is found.
 */
function hasAccessibleTextDescendant(node: ts.JsxElement | ts.JsxFragment): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isJsxText(n)) {
      if (n.text.trim().length > 0) { found = true; return; }
    } else if (ts.isJsxExpression(n) && n.expression) {
      const expr = n.expression;
      if ((ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && expr.text.trim().length > 0) {
        found = true; return;
      }
    } else if (ts.isJsxElement(n)) {
      const opening = n.openingElement;
      const cls = getAttribute(opening, 'className');
      if (cls) {
        const v = attributeStringValue(cls);
        if (v && /\bsr-only\b/.test(v)) {
          for (const c of n.children) {
            if (ts.isJsxText(c) && c.text.trim().length > 0) { found = true; return; }
            if (ts.isJsxExpression(c)) { found = true; return; }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  ts.forEachChild(node, visit);
  return found;
}

// -- Rule implementations -----------------------------------------------------

function checkRawColorLiterals(
  sf: ts.SourceFile,
  filePath: string,
  cfg: ResolvedConfig,
  findings: Finding[],
): void {
  if (!cfg.rules.forbidRawColorLiterals) return;
  const isAllowed = cfg.rawColorAllowedFiles.some((pat) => minimatch(filePath, pat));
  if (isAllowed) return;

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && node.name.text === 'style') {
      const init = node.initializer;
      if (init && ts.isJsxExpression(init) && init.expression) {
        const expr = init.expression;
        if (ts.isObjectLiteralExpression(expr)) {
          for (const prop of expr.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const v = prop.initializer;
              if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
                if (RAW_COLOR_REGEX.test(v.text)) {
                  const { line, col } = lineColFromPos(sf, v.getStart(sf));
                  findings.push({
                    file: filePath,
                    line,
                    col,
                    rule: 'forbidRawColorLiterals',
                    severity: 'error',
                    message: `raw color literal "${v.text}" — use a design token from the theme instead`,
                  });
                }
              }
            }
          }
        }
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const init = node.initializer;
      const attrName = node.name && ts.isIdentifier(node.name) ? node.name.text : '';
      if (attrName !== 'style') {
        let strVal: string | null = null;
        if (ts.isStringLiteral(init)) strVal = init.text;
        else if (ts.isJsxExpression(init) && init.expression) {
          const e = init.expression;
          if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) strVal = e.text;
        }
        if (strVal && RAW_COLOR_REGEX.test(strVal)) {
          const { line, col } = lineColFromPos(sf, init.getStart(sf));
          findings.push({
            file: filePath,
            line,
            col,
            rule: 'forbidRawColorLiterals',
            severity: 'error',
            message: `raw color literal "${strVal}" in attribute "${attrName}" — use a design token from the theme instead`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function checkAltOnImg(
  sf: ts.SourceFile,
  filePath: string,
  cfg: ResolvedConfig,
  findings: Finding[],
): void {
  if (!cfg.rules.requireAltOnImg) return;
  function visit(node: ts.Node): void {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;
    if (opening && jsxTagName(opening) === 'img') {
      const alt = getAttribute(opening, 'alt');
      if (!alt) {
        const { line, col } = lineColFromPos(sf, opening.getStart(sf));
        findings.push({
          file: filePath,
          line,
          col,
          rule: 'requireAltOnImg',
          severity: 'error',
          message: '<img> is missing alt attribute (use alt="" for decorative-only images)',
        });
      } else if (!attributeHasNonEmptyValue(alt)) {
        const { line, col } = lineColFromPos(sf, alt.getStart(sf));
        findings.push({
          file: filePath,
          line,
          col,
          rule: 'requireAltOnImg',
          severity: 'note',
          message: 'alt="" — confirm the image is decorative and not informational',
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function checkAriaLabelOnIconButton(
  sf: ts.SourceFile,
  filePath: string,
  cfg: ResolvedConfig,
  findings: Finding[],
): void {
  if (!cfg.rules.requireAriaLabelOnIconButton) return;
  function visit(node: ts.Node): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    let elementForChildren: ts.JsxElement | null = null;
    if (ts.isJsxElement(node)) {
      opening = node.openingElement;
      elementForChildren = node;
    } else if (ts.isJsxSelfClosingElement(node)) {
      opening = node;
    }
    if (opening) {
      const tag = jsxTagName(opening);
      if (cfg.buttonComponents.has(tag)) {
        const ariaLabel = getAttribute(opening, 'aria-label');
        const ariaLabelledBy = getAttribute(opening, 'aria-labelledby');
        const title = getAttribute(opening, 'title');
        const asChild = hasAttribute(opening, 'asChild');
        const hasName =
          (ariaLabel && attributeHasNonEmptyValue(ariaLabel)) ||
          (ariaLabelledBy && attributeHasNonEmptyValue(ariaLabelledBy)) ||
          (title && attributeHasNonEmptyValue(title)) ||
          asChild;
        let textName = false;
        if (elementForChildren) {
          textName = hasAccessibleTextDescendant(elementForChildren);
        }
        if (!hasName && !textName) {
          const { line, col } = lineColFromPos(sf, opening.getStart(sf));
          findings.push({
            file: filePath,
            line,
            col,
            rule: 'requireAriaLabelOnIconButton',
            severity: 'error',
            message: `<${tag}> has no accessible name — add aria-label, visible text, or a <span className="sr-only"> label`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function checkInteractiveDiv(
  sf: ts.SourceFile,
  filePath: string,
  cfg: ResolvedConfig,
  findings: Finding[],
): void {
  if (!cfg.rules.forbidInteractiveDiv) return;
  function visit(node: ts.Node): void {
    let opening: ts.JsxOpeningLikeElement | null = null;
    if (ts.isJsxElement(node)) opening = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) opening = node;
    if (opening) {
      const tag = jsxTagName(opening);
      if (tag === 'div' || tag === 'span') {
        const hasOnClick = hasAttribute(opening, 'onClick');
        if (hasOnClick) {
          const hasRole = hasAttribute(opening, 'role');
          const hasKeyboard = hasAttribute(opening, 'onKeyDown') || hasAttribute(opening, 'onKeyUp');
          const hasTabIndex = hasAttribute(opening, 'tabIndex');
          if (!(hasRole && hasKeyboard && hasTabIndex)) {
            const missing: string[] = [];
            if (!hasRole) missing.push('role');
            if (!hasKeyboard) missing.push('onKeyDown/onKeyUp');
            if (!hasTabIndex) missing.push('tabIndex');
            const { line, col } = lineColFromPos(sf, opening.getStart(sf));
            findings.push({
              file: filePath,
              line,
              col,
              rule: 'forbidInteractiveDiv',
              severity: 'error',
              message: `<${tag} onClick> is missing: ${missing.join(', ')} — prefer <button> for clickable elements`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

const INPUT_TAGS = new Set(['input', 'textarea', 'select', 'Input', 'Textarea', 'Select']);

function collectLabelHtmlForsInSubtree(node: ts.Node): Set<string> {
  const ids = new Set<string>();
  function visit(n: ts.Node): void {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = jsxTagName(opening);
      if (tag === 'label' || tag === 'Label' || tag === 'FormLabel') {
        const attr = getAttribute(opening, 'htmlFor');
        if (attr) {
          const v = attributeStringValue(attr);
          if (v) ids.add(v);
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return ids;
}

interface PendingInputFinding {
  finding: Finding;
  inputId: string | null;
}

function checkLabelForInput(
  sf: ts.SourceFile,
  filePath: string,
  cfg: ResolvedConfig,
  findings: Finding[],
): void {
  if (!cfg.rules.requireLabelForInput) return;
  const pending: PendingInputFinding[] = [];
  function visit(node: ts.Node, insideLabel: boolean): void {
    if (ts.isJsxElement(node)) {
      const t = jsxTagName(node.openingElement);
      if (t === 'label' || t === 'Label' || t === 'FormLabel') {
        for (const c of node.children) visit(c, true);
        return;
      }
    }
    let opening: ts.JsxOpeningLikeElement | null = null;
    if (ts.isJsxElement(node)) opening = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) opening = node;
    if (opening) {
      const tag = jsxTagName(opening);
      if (INPUT_TAGS.has(tag) && !cfg.selfLabelingInputComponents.has(tag)) {
        const ariaLabel = getAttribute(opening, 'aria-label');
        const ariaLabelledBy = getAttribute(opening, 'aria-labelledby');
        const title = getAttribute(opening, 'title');
        const typeAttr = getAttribute(opening, 'type');
        const typeVal = typeAttr ? attributeStringValue(typeAttr) : null;
        const exemptedType = typeVal !== null && ['hidden', 'submit', 'button', 'reset', 'image'].includes(typeVal);
        const idAttr = getAttribute(opening, 'id');
        const idVal = idAttr ? attributeStringValue(idAttr) : null;
        const hasName =
          insideLabel ||
          exemptedType ||
          (ariaLabel && attributeHasNonEmptyValue(ariaLabel)) ||
          (ariaLabelledBy && attributeHasNonEmptyValue(ariaLabelledBy)) ||
          (title && attributeHasNonEmptyValue(title));
        if (!hasName) {
          const { line, col } = lineColFromPos(sf, opening.getStart(sf));
          pending.push({
            inputId: idVal,
            finding: {
              file: filePath,
              line,
              col,
              rule: 'requireLabelForInput',
              severity: 'error',
              message: `<${tag}>${idVal ? ` id="${idVal}"` : ''} has no accessible name — add a <Label htmlFor>, aria-label, or wrap in <label>`,
            },
          });
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, insideLabel));
  }
  visit(sf, false);

  // Resolve via file-wide htmlFor lookup — pragmatic v1 behavior.
  const allLabelIds = collectLabelHtmlForsInSubtree(sf);
  for (const p of pending) {
    if (p.inputId && allLabelIds.has(p.inputId)) continue;
    findings.push(p.finding);
  }
}

// -- Per-file walker ----------------------------------------------------------

export function auditSource(
  filePath: string,
  source: string,
  cfg: ResolvedConfig,
  opts: { allowParseFailures: boolean },
): Finding[] {
  const kind = scriptKindFor(filePath);
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, /*setParents*/ true, kind);
  // Codex pass-2 CRITICAL: ts.createSourceFile returns a SourceFile even for
  // malformed input and surfaces issues via parseDiagnostics. Inspect them.
  const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const d = diagnostics[0]!;
    const { line, col } = lineColFromPos(sf, d.start ?? 0);
    const msg = typeof d.messageText === 'string' ? d.messageText : ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (!opts.allowParseFailures) {
      throw new ParseFailureError({ file: filePath, line, col, message: msg });
    }
    process.stderr.write(`[audit-frontend] WARN: parse failure ${filePath}:${line}:${col} ${msg} (continuing due to --allow-parse-failures)\n`);
    return [];
  }
  const findings: Finding[] = [];
  checkRawColorLiterals(sf, filePath, cfg, findings);
  checkAltOnImg(sf, filePath, cfg, findings);
  checkAriaLabelOnIconButton(sf, filePath, cfg, findings);
  checkInteractiveDiv(sf, filePath, cfg, findings);
  checkLabelForInput(sf, filePath, cfg, findings);
  return findings;
}

// -- CLI ----------------------------------------------------------------------

interface CliArgs {
  base: string | null;
  files: string[] | null;
  allowParseFailures: boolean;
  includeNotes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { base: null, files: null, allowParseFailures: false, includeNotes: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--allow-parse-failures') out.allowParseFailures = true;
    else if (a === '--include-notes') out.includeNotes = true;
    else if (a.startsWith('--base=')) out.base = a.slice('--base='.length);
    else if (a.startsWith('--files=')) {
      out.files = a.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      throw new ConfigError(`Unknown flag: ${a}`);
    }
  }
  return out;
}

const HELP = `audit-frontend — Layer 2 deterministic FE audit

Usage:
  audit-frontend [--base=<ref>] [--files=a.tsx,b.tsx] [--include-notes] [--allow-parse-failures]

Flags:
  --base=<ref>             diff base (default: auto-detect origin/HEAD → origin/main → origin/master)
  --files=<a,b,c>          audit explicit files (bypasses git)
  --include-notes          print NOTE-severity findings (e.g. alt="" decorative review)
  --allow-parse-failures   downgrade parse failures to warnings instead of exit 2

Scope (v1): only *.tsx and *.jsx files. .ts/.js/.css/.scss are out of scope.
Config: <repo-root>/.autopilot/frontend-quality.json (schema at presets/schemas/).
`;

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`[audit-frontend] ${(e as Error).message}\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(path.resolve(here, '..'));
  const schemaPath = path.join(repoRoot, 'presets', 'schemas', 'frontend-quality.schema.json');

  let cfg: ResolvedConfig;
  try {
    cfg = loadConfig(repoRoot, schemaPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[audit-frontend] ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  let files: string[];
  if (args.files) {
    files = args.files;
  } else {
    let base = args.base;
    if (!base) {
      try {
        base = autoDetectBaseRef(repoRoot);
      } catch (e) {
        process.stderr.write(`[audit-frontend] ${(e as Error).message}\n`);
        return 2;
      }
    }
    try {
      files = resolveDiffFiles(repoRoot, base);
    } catch (e) {
      process.stderr.write(`[audit-frontend] ${(e as Error).message}\n`);
      return 2;
    }
  }
  const normalized: string[] = [];
  for (const f of files) {
    const n = normalizeRepoRelative(f);
    if (n === null) {
      process.stderr.write(`[audit-frontend] rejecting invalid path "${f}" (absolute or contains ..)\n`);
      return 2;
    }
    normalized.push(n);
  }
  const afterIgnore = applyIgnorePaths(normalized, cfg.ignorePaths);
  const auditable = afterIgnore.filter(isAuditableExt);

  if (auditable.length === 0) {
    process.stdout.write('[audit-frontend] OK — no auditable *.{tsx,jsx} files in scope\n');
    return 0;
  }

  const allFindings: Finding[] = [];
  for (const rel of auditable) {
    const abs = path.join(repoRoot, rel);
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      process.stderr.write(`[audit-frontend] cannot read ${rel}: ${(e as Error).message}\n`);
      return 2;
    }
    try {
      const f = auditSource(rel, src, cfg, { allowParseFailures: args.allowParseFailures });
      allFindings.push(...f);
    } catch (e) {
      if (e instanceof ParseFailureError) {
        process.stderr.write(
          `[audit-frontend] parse failure ${e.diagnostic.file}:${e.diagnostic.line}:${e.diagnostic.col}: ${e.diagnostic.message}\n` +
          '  Pass --allow-parse-failures to downgrade this to a warning.\n',
        );
        return 2;
      }
      throw e;
    }
  }

  const errors = allFindings.filter((f) => f.severity === 'error');
  const notes = allFindings.filter((f) => f.severity === 'note');

  if (errors.length > 0) {
    process.stderr.write(`[audit-frontend] FOUND ${errors.length} error(s) across ${auditable.length} file(s):\n`);
    for (const f of errors) {
      process.stderr.write(`  ${f.file}:${f.line}:${f.col}  [${f.rule}]  ${f.message}\n`);
    }
  } else {
    process.stdout.write(`[audit-frontend] OK — scanned ${auditable.length} file(s), no error-severity findings\n`);
  }
  if (args.includeNotes && notes.length > 0) {
    process.stderr.write(`[audit-frontend] ${notes.length} note(s):\n`);
    for (const f of notes) {
      process.stderr.write(`  ${f.file}:${f.line}:${f.col}  [${f.rule}]  ${f.message}\n`);
    }
  }
  return errors.length > 0 ? 1 : 0;
}

// -- Test seam ----------------------------------------------------------------

export function resolveConfigForTest(input: FrontendQualityConfig = {}): ResolvedConfig {
  const rules: Record<RuleName, boolean> = { ...DEFAULT_RULES, ...(input.rules ?? {}) };
  return {
    rules,
    rawColorAllowedFiles: input.rawColorAllowedFiles ?? [],
    ignorePaths: input.ignorePaths ?? [],
    buttonComponents: new Set<string>(input.buttonComponents ?? DEFAULT_BUTTON_COMPONENTS),
    selfLabelingInputComponents: new Set<string>(input.selfLabelingInputComponents ?? DEFAULT_SELF_LABELING_INPUTS),
  };
}

export {
  loadConfig,
  ConfigError,
  ParseFailureError,
  normalizeRepoRelative,
  applyIgnorePaths,
  isAuditableExt,
};

// Only auto-run as a script when invoked directly via tsx/node.
const invokedAsScript = (() => {
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  process.exit(main(process.argv.slice(2)));
}
