# Plan — Issue #178 Frontend Quality (Layers 1+2 artifacts)

Spec: `docs/superpowers/specs/2026-05-26-issue-178-frontend-quality-design.md`
Risk: medium • Codex passes completed: 2 of 2 required pre-merge (third pass is Step 7 PR review)
Branch: `feat/issue-178-frontend-quality`
Base SHA: `34e0bd8` (master post-v8.3.0)

## Files (no existing-file modifications other than package.json + CHANGELOG + nextjs-supabase stack.md note)

New:
- `skills/frontend-impl-playbook/SKILL.md` — Layer 1 playbook content
- `scripts/audit-frontend.ts` — Layer 2 AST audit script
- `presets/schemas/frontend-quality.schema.json` — config JSON schema
- `src/core/detect/frontend-stack.ts` — `detectFrontendStack(cwd)` helper
- `tests/frontend-impl-playbook.test.ts` — skill-content invariant tests
- `tests/audit-frontend.test.ts` — per-rule + config + edge-case tests
- `tests/detect-frontend-stack.test.ts` — stack-detection tests
- `tests/fixtures/audit-frontend/broken.tsx` — syntax-error fixture for parse-failure test

Edited:
- `package.json` — add `"audit:frontend": "tsx scripts/audit-frontend.ts"` to `scripts`
- `CHANGELOG.md` — Unreleased entry: artifacts-only, manual invocation, wiring deferred
- `presets/nextjs-supabase/stack.md` — append one-line pointer to `npm run audit:frontend`

## Dependency verification (precondition — already verified)

Confirmed against `/Users/alexledbetter/work/claude-autopilot/package.json` at base SHA `34e0bd8`:

- `typescript: ^6` (devDependency) — present
- `ajv: ^8`, `ajv-formats: ^3.0.1` (direct deps) — present
- `minimatch: >=9` (direct dep) — present
- `tsx: >=4` (direct dep) — present

**No new package.json deps needed.** This is verified pre-plan, not deferred.

## Exit-code contract (single source of truth for code + tests)

| Exit | Meaning |
|------|---------|
| `0`  | Audit completed; zero error-severity findings |
| `1`  | Audit completed; one or more error-severity findings reported on stderr |
| `2`  | Operational/config/parse error — config schema violation, git-resolve failure, parse failure (unless `--allow-parse-failures`), unknown CLI flag, or zero auditable files matched a non-empty `--files=` (caller error) |

NOTE-severity findings (`alt=""` decorative review-flag) are reported ONLY when `--include-notes` is set; they NEVER change exit code on their own.

`--allow-parse-failures` downgrades parse failures to stderr WARNINGS and continues auditing other files. If ALL files in scope fail to parse with this flag set, the audit exits 0 with a stderr warning that nothing was audited (visible signal without crashing CI in mixed-fixture cases).

## Config file discovery

- Single lookup path: `<repo-root>/.autopilot/frontend-quality.json`
- Repo root = directory containing `package.json` walked up from `cwd`
- Missing file → defaults
- Present + malformed JSON → exit 2 with the parse error
- Present + valid JSON + AJV violation → exit 2 with JSON pointer + offending value

Schema enforces `additionalProperties: false` at the root object AND within `rules` (so a typo'd rule name fails loud).

## Rule semantic clarifications (extends spec where ambiguous)

### `forbidInteractiveDiv` — semantic intent

Rule semantics confirmed as **"forbid inaccessible interactive divs"** — a `<div role="button" tabIndex={0} onKeyDown={k} onClick={f}>` passes the rule because it IS keyboard-operable and semantically tagged. The diagnostic message for failing cases recommends `<button>` as the preferred fix. The rule name is preserved (`forbidInteractiveDiv`) for continuity with the spec; a future rename to `requireAccessibleInteractiveDiv` is a NOTE follow-up but doesn't change v1 behavior.

### `forbidRawColorLiterals` — v1 detection surface

v1 detects raw color literals (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`) inside:
- JSX `style={{ ... }}` object-literal property values that are string literals
- JSX string-attribute values on any element (e.g. `<svg fill="#3b82f6">`, `<Icon color="#fff">`)

**Out of scope for v1 (follow-up):** Tailwind arbitrary-value classes like `className="text-[#3b82f6]"`, `bg-[rgb(0,0,0)]`. Documented in the audit `--help` output AND the CHANGELOG so users know to layer in `eslint-plugin-tailwindcss` or equivalent for the className surface. This is a deliberate scope choice — className parsing requires a Tailwind-version-aware tokenizer and was Codex-flagged as too broad for v1.

### `rawColorAllowedFiles` — disambiguated semantics

Glob patterns (minimatch). A FILE listed in this allowlist is **exempted** from the `forbidRawColorLiterals` check; all other rules still apply to that file. Other files are checked normally. Empty/missing → no files exempted.

### `requireAriaLabelOnIconButton` — accessible-name precedence

A button-like element is "named" (passes) if ANY of:
1. `aria-label` attribute with non-empty value
2. `aria-labelledby` attribute with non-empty value
3. `title` attribute with non-empty value
4. ANY non-whitespace JSX text child (recursive across descendants)
5. ANY descendant with className containing `sr-only` AND any text child (visually-hidden accessible-name pattern)
6. Has `asChild` prop (Radix slot — defers accessible-name to child)

Otherwise FAILS.

Recognised button-like component names (configurable, default list per spec).

### `requireLabelForInput` — accessible-name precedence

An input/textarea/select is "labeled" (passes) if ANY of:
1. `aria-label` (non-empty)
2. `aria-labelledby` (non-empty)
3. `title` (non-empty)
4. `type` is `"hidden"`, `"submit"`, `"button"`, `"reset"`, or `"image"`
5. Has `id` AND a `<label htmlFor>` or `<Label htmlFor>` with matching literal value in the same JSX subtree (siblings + descendants up to 3 ancestor levels)
6. Is wrapped by `<label>...</label>` (label as direct or transitive ancestor)
7. Element name is in the configurable compound-component exemption list (default narrow: `FormControl`, `TextField`, `RadioGroup`)

Otherwise FAILS.

## Stack detection — `detectFrontendStack(cwd)` precise contract

Reads `<cwd>/package.json` (and `<cwd>/components.json` if present). Searches ALL dependency fields: `dependencies`, `devDependencies`, `peerDependencies`. Tailwind config detection looks for any of: `tailwind.config.ts`, `tailwind.config.js`, `tailwind.config.mjs`, `tailwind.config.cjs`.

Detection precedence for `library`:
1. `components.json` present → `'shadcn'` (the marker file is the canonical signal; do NOT require a specific Radix dep — shadcn projects vary in which primitives they install)
2. Any `@mui/material` or `@mui/core` in any dep field → `'mui'`
3. Any `@chakra-ui/react` in any dep field → `'chakra'`
4. Any `@mantine/core` → `'mantine'`
5. Any `antd` → `'antd'`
6. Any `bootstrap` or `react-bootstrap` → `'bootstrap'`
7. None of the above + Tailwind config present → `'custom'`
8. Else → `'unknown'`

`primitivesDir`: returns the first of `app/components/ui`, `src/components/ui`, `components/ui` (relative to `cwd`) that is a directory; else `null`.

## Sequencing (sequential — single-implementer worktree)

### Task 1 — schema + types foundation
Files: `presets/schemas/frontend-quality.schema.json`, `src/core/detect/frontend-stack.ts`
Why first: cheap, no dependencies on other tasks. Schema is the contract for Task 3.

### Task 2 — Layer 1 skill content
Files: `skills/frontend-impl-playbook/SKILL.md`
Why next: pure markdown; can be reviewed independently.

### Task 3 — Layer 2 audit script
Files: `scripts/audit-frontend.ts`
Depends on: Task 1 (schema for config validation, frontend-stack helper for theme-file allowlist resolution)

### Task 4 — Test fixtures + tests
Files: `tests/fixtures/audit-frontend/broken.tsx`, `tests/frontend-impl-playbook.test.ts`, `tests/audit-frontend.test.ts`, `tests/detect-frontend-stack.test.ts`
Depends on: Tasks 1-3

### Task 5 — Wiring + docs
Files: `package.json`, `CHANGELOG.md`, `presets/nextjs-supabase/stack.md`
Depends on: Tasks 1-4 (sanity-check `npm run audit:frontend` works)

## Test plan

```bash
# Per-task local check
npm test -- tests/audit-frontend.test.ts
npm test -- tests/frontend-impl-playbook.test.ts
npm test -- tests/detect-frontend-stack.test.ts

# End-to-end smoke (note the `--` to forward args through npm)
npm run audit:frontend -- --files=tests/fixtures/audit-frontend/broken.tsx
# expect: exit 2, parse-failure diagnostic

# Full test suite (Step 4 validate)
npm test
npm run typecheck
```

### Required test cases

**audit-frontend.test.ts** (≥15 tests):

Per-rule positive (flagged) + negative (not flagged) — 12 cases:
1. forbidRawColorLiterals: `style={{ color: '#3b82f6' }}` → flagged
2. forbidRawColorLiterals: `style={{ color: 'var(--brand)' }}` → not flagged
3. requireAltOnImg: `<img src="x.png" />` → flagged
4. requireAltOnImg: `<img src="x.png" alt="Logo" />` → not flagged
5. requireAriaLabelOnIconButton: `<Button><TrashIcon /></Button>` → flagged
6. requireAriaLabelOnIconButton: `<Button aria-label="Delete"><TrashIcon /></Button>` → not flagged; `<Button><TrashIcon /><span className="sr-only">Delete</span></Button>` → not flagged; `<Button asChild>...</Button>` → not flagged
7. forbidInteractiveDiv: `<div onClick={f}>X</div>` → flagged
8. forbidInteractiveDiv: `<div role="button" tabIndex={0} onKeyDown={k} onClick={f}>X</div>` → not flagged
9. requireLabelForInput: `<input id="email" />` (no label) → flagged
10. requireLabelForInput: `<><label htmlFor="email">Email</label><input id="email" /></>` → not flagged
11. requireLabelForInput: `<label>Name<input/></label>` (wrapper label) → not flagged
12. requireLabelForInput: `<input type="hidden" />` → not flagged

Config + edge cases — 5+ cases:
13. Missing config file → defaults applied, all enabled rules fire
14. Explicit `rules.forbidRawColorLiterals: false` → that rule does not fire
15. Config typo (`requireAltOnImages: false`) → exit 2 with AJV error message
16. `rawColorAllowedFiles` excludes a file → its raw-color check skipped, other rules still fire
17. `.css`/`.ts` files are silently skipped (out of v1 scope)
18. Parse failure (`broken.tsx` fixture) → exit 2, diagnostic on stderr
19. `--allow-parse-failures` flag + broken fixture → parse failure logged but not fatal, other files audited
20. `ignorePaths: ['**/*.stories.tsx']` matches before extension filter → file excluded entirely

**frontend-impl-playbook.test.ts** (3-5 tests):
- Skill file exists at `skills/frontend-impl-playbook/SKILL.md`
- Frontmatter parses as YAML, has `name` and `description` keys
- Body contains the 5 required anchors (regex assertions): reuse existing primitives, design tokens / no hex, four states (loading/error/empty/success), accessibility / ARIA, mobile-first
- Body contains stack-detection language (regex): `package.json`, `components.json`, `tailwind.config`
- Body does NOT hardcode shadcn-only language for projects that aren't shadcn (regex sanity: "If shadcn:" appears at least once, indicating conditional examples)

**detect-frontend-stack.test.ts** (4-6 tests):
- shadcn detection (`components.json` + `@radix-ui/react-slot` in deps)
- MUI detection (`@mui/material` in deps, no `components.json`)
- Tailwind alone → `library: 'custom'`, `hasTailwind: true`
- No FE markers → `library: 'unknown'`, `hasTailwind: false`
- primitivesDir resolves to `app/components/ui` or `src/components/ui` when present, else null

## Risks + mitigations

- **TypeScript AST API surface drift across `typescript` major versions** — `package.json` pins `typescript: ^6`, the test runner uses the same. Audit imports `import ts from 'typescript'` exactly like `scripts/audit-supabase-imports.ts` does (pattern already proven in CI).
- **AJV ESM/CJS dual-mode import quirks** — match the import style used elsewhere in the codebase. Grep for existing `import Ajv from 'ajv'` patterns; if none, follow the AJV docs' default ESM example with `import Ajv from 'ajv';`.
- **`minimatch` glob behavior on Windows paths** — normalize to forward slashes before matching (the same way `audit-supabase-imports.ts` does for its allowlist).
- **Test runner discovery** — the existing test runner (`scripts/test-runner.mjs`) auto-discovers `tests/*.test.ts`. New tests need no manual wiring.

## Out of scope (already documented in spec — preserved here for plan clarity)

- ESLint plugin bundling
- Auto-fix on findings
- CSS / `.ts` file scanning
- Playwright + axe Layer 3
- Dispatcher auto-prepend wiring (Step 3 of autopilot)
- `validate.ts` auto-invoke wiring (Step 4 of autopilot)

## Acceptance gate (Step 4 validate)

- All tests pass
- `npm run typecheck` clean (or at least no NEW errors vs. base)
- `npm run audit:supabase` still clean (sanity)
- New script runs without error on its own test fixtures
