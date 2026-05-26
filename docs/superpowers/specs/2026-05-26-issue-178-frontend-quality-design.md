---
title: v7.10.0 — Frontend Quality: Stack-Aware Playbook + Deterministic Audit
risk: medium
issue: 178
codex_passes_completed: 2
---

# Frontend Quality — Layer 1 (Playbook) + Layer 2 (Audit) ARTIFACTS

> **Scope clarification (post-Codex pass 1):** This PR ships the **artifacts** —
> the playbook skill, the audit script, the config schema, and tests. It does
> NOT auto-wire either layer into the autopilot dispatcher (Step 3) or
> `validate.ts` (Step 4). The audit is invokable manually via
> `npm run audit:frontend`; the playbook is discoverable for humans and a
> future dispatcher patch. Auto-wiring is tracked as follow-up issues
> (TBD on this PR's merge) to avoid colliding with the three in-flight PRs
> (#29, #179, #180) that all touch dispatch/validate code.

## Problem

The autopilot pipeline gates on **correctness** (codex review) and **defects** (bugbot). It does NOT gate on **design quality**. UI features pass typecheck + tests + codex + bugbot and still ship as AI-slop:

- Naive Tailwind with inline hex colors instead of design tokens
- Missing loading / error / empty states (the slop-vs-real signature)
- Components rolling their own primitives when shadcn/MUI/Chakra equivalents exist
- Icon-only buttons with no `aria-label`, `<img>` with no `alt`, `<div onClick>` with no keyboard handler

Codex security review on the v7.10.0 frontend roadmap concluded:
- **Layer 1** (impl-agent system-prompt augmentation) is the strongest leverage point — telling the impl agent the conventions up front beats reviewing slop after the fact
- **Layer 2** (post-impl deterministic AST audit) is useful as a baseline floor, NOT a full design-quality gate
- **Layer 3** (senior-UX critique via screenshot + Playwright + axe) is post-MVP — defer until customer discovery confirms FE quality is a buyer pain

Issue #178 ships Layer 1 + Layer 2 together.

## Goals

1. **Layer 1 artifact**: a stack-aware playbook skill exists at `skills/frontend-impl-playbook/SKILL.md`. Future dispatcher patches read it and prepend it to impl-agent briefs when a task touches frontend files. This PR does NOT modify the dispatcher.
2. **Layer 2 artifact**: a deterministic AST audit (no LLM cost) exists at `scripts/audit-frontend.ts`. It scans changed files and reports violations of the rule set below. This PR does NOT auto-invoke it from `validate.ts` — invocation is via `npm run audit:frontend` (manual or project CI).
3. **Conditional scope at audit-runtime**: when invoked, the audit only inspects files in the PR diff (default `--base=<repo default branch, auto-detected>`). Backend-only PRs naturally short-circuit because no FE files are in the diff.
4. **Configurable per project** via `.autopilot/frontend-quality.json` — schema published in `presets/schemas/frontend-quality.schema.json`.
5. **Tests cover both layers** — skill-content invariants for Layer 1, per-rule positive/negative cases for Layer 2.

## Non-goals (deferred to a future issue)

- ESLint plugin distribution (e.g. `eslint-plugin-jsx-a11y` bundling) — recommend in playbook + README, don't bundle
- Testing-library state coverage assertions — recommend, don't enforce
- Playwright + axe scan for touched routes — Layer 3
- Image diff / visual regression — Layer 3
- Auto-fix for audit findings — surface, don't mutate

## Architecture

This PR ships two standalone artifacts. The wiring shown below in dashed lines
is the future end-state; the solid arrows are what this PR delivers.

```
   skills/frontend-impl-playbook/SKILL.md   <-- THIS PR (artifact)
                  ⋮
   future: autopilot Step 3 dispatcher reads this skill and prepends it to
   impl-agent briefs when a task's files match the FE-extension heuristic.
   (Deferred — see "Integration" section.)

   scripts/audit-frontend.ts                <-- THIS PR (artifact)
        │
        ├── reads .autopilot/frontend-quality.json (or defaults)
        ├── reads `git diff --name-only AM <base>...HEAD` (or --files=)
        ├── AST-walks matched *.{tsx,jsx} via ts.createSourceFile
        │       (ScriptKind.TSX for .tsx, ScriptKind.JSX for .jsx)
        └── exits 0 (clean) | 1 (violations) | 2 (config/infra error)

   future: validate.ts Step 4 invokes this script when FE files are in the
   diff. (Deferred — see "Integration" section.)
```

### Layer 1 — `skills/frontend-impl-playbook/SKILL.md`

Static skill content (~150 LOC). The autopilot impl-agent dispatch path checks
whether the task's file set contains frontend files (heuristic below) and, if
so, prepends the playbook's body into the impl-agent's system prompt.

**Stack-aware**: the playbook header says "DETECT THE PROJECT'S STACK FIRST" and
points the impl agent at:

1. `package.json` — read `dependencies` for shadcn (`@radix-ui/*`), MUI
   (`@mui/material`), Chakra (`@chakra-ui/react`), Mantine, Ant Design, Bootstrap.
2. `components.json` (shadcn marker file).
3. `tailwind.config.{ts,js}` — read `theme.extend.colors` for the design palette.
4. `.autopilot/stack.md` — optional explicit stack override.
5. The existing `app/components/ui/` or `src/components/ui/` tree — reuse those primitives.

**Playbook anchors:**

- Reuse existing primitives. Before writing a Button/Input/Select from scratch, search for the project's existing one and use it.
- Design tokens only. No `style={{ color: '#3b82f6' }}`. Resolve to `theme.colors.brand.primary` or its CSS variable.
- All four states by default. Every async-data screen must render `loading`, `error`, `empty`, and `success` — even if "empty" is a placeholder.
- Accessibility baseline. `<label>` for inputs, `aria-label` for icon-only buttons, `alt` for `<img>`, keyboard handlers for clickable non-button elements.
- Mobile-first responsive. Default styles apply at the smallest viewport; widen with `md:`/`lg:` prefixes.

The playbook is markdown — the autopilot dispatcher reads it as a string and
prepends it. No code paths in the playbook itself.

### Layer 2 — `scripts/audit-frontend.ts`

AST-based audit modeled on `scripts/audit-supabase-imports.ts`. Uses the
TypeScript compiler API (already a transitive dep via `tsx`).

**Rules (high-signal only):**

1. **`forbidRawColorLiterals`** — flag string literals matching `#[0-9a-fA-F]{3,8}` or `rgb(...)` / `rgba(...)` / `hsl(...)` inside JSX attribute values or `style={{ ... }}` object literals — UNLESS the file is in the configured `themeFiles` allowlist (e.g. `tailwind.config.ts`, `app/globals.css`).
2. **`requireAltOnImg`** — JSX `<img>` element with no `alt` attribute at all. `alt=""` (decorative) is allowed but flagged with a NOTE-level diagnostic.
3. **`requireAriaLabelOnIconButton`** — a button-like element with no accessible name. PASSES if:
   - It has `aria-label`, `aria-labelledby`, or `title`
   - It has any non-whitespace JSX text child anywhere in the subtree (recursive — `<Button><Icon/><span>Save</span></Button>` is named)
   - It has a descendant element with `className` containing `sr-only` (visually-hidden accessible name pattern — a `<Button><Icon/><span className="sr-only">Delete</span></Button>` is named)
   - It has the `asChild` prop (Radix asChild slot — the named element is the child component, not the button itself)
   FAILS if the element is named in the configurable button list (default: `button`, `Button`, `IconButton`, `DropdownMenuTrigger`, `TooltipTrigger`, `PopoverTrigger`, `SheetTrigger`, `AlertDialogTrigger`, `DialogTrigger`) AND none of the above accessible-name conditions hold.
4. **`forbidInteractiveDiv`** — `<div>` or `<span>` with `onClick` is flagged UNLESS ALL of the following are present (WCAG 2.1 keyboard accessibility requires all three):
   - `role="button"` (or `role="link"`/`role="menuitem"` etc — any role attribute), AND
   - A keyboard activation handler — `onKeyDown` or `onKeyUp`, AND
   - `tabIndex={0}` (focusability) — accepted forms: `tabIndex={0}`, `tabIndex="0"`, `tabIndex={someVar}` (any explicit tabIndex prop passes the focusability check; the audit doesn't try to constant-fold)
   The diagnostic message recommends using `<button>` as the better fix.
5. **`requireLabelForInput`** — `<input>` / `<textarea>` / `<select>` without an accessible name. An input PASSES if ANY of:
   - It has `aria-label`, `aria-labelledby`, or `title`
   - It has `type="hidden"` or `type="submit"` / `type="button"` (no label expected)
   - It has an `id` AND some `<label htmlFor={...}>` or `<Label htmlFor={...}>` whose `htmlFor` literal matches that id, anywhere in the SAME JSX parent subtree (search siblings + their descendants, up to 3 ancestor levels — covers the `<label htmlFor>...<input id />` sibling pattern, the `<div><label/><input/></div>` wrapper pattern, and shadcn `<Label htmlFor>` patterns).
   - It is wrapped by a `<label>...<input/></label>` (label as direct or transitive ancestor)
   - It is named on a **narrow** list of compound components that wire their own labeling internally — default: `FormControl`, `TextField` (MUI), `RadioGroup`. Note: shadcn `<Input>`, `<Textarea>`, `<Select>`, `<Checkbox>`, `<Switch>`, `<Combobox>` are intentionally NOT exempted — they wrap native form controls and still need an external `<Label>`. The list is configurable so projects using a self-labeling design system can opt out per-component.
   Both shadcn `<Label>` and native `<label>` are treated as label elements.
6. **`forbidMagicSpacing`** (opt-in, default off) — flag CSS-in-JS spacing values that aren't multiples of 4 (e.g. `padding: '17px'`). Off by default because tolerance varies wildly across design systems.

Each rule is independently togglable via `.autopilot/frontend-quality.json`. Rules default ON except `forbidMagicSpacing` (off).

**Exit codes:**
- `0` — no violations
- `1` — at least one violation; stderr lists `file:line:col rule: message`

**Scope (v1):** scans `**/*.{tsx,jsx}` ONLY. `.ts`/`.js`/`.css`/`.scss` files
are explicitly out of scope for v1 — adding CSS parsing or `.ts` string-literal
scanning is a follow-up. This is documented in the audit's `--help` output and
in the CHANGELOG so users don't expect raw-color detection in plain CSS.

**Diff resolution:** reads the diff from
`git diff --name-only --diff-filter=AM <base>...HEAD`. The default base is
auto-detected via `git symbolic-ref refs/remotes/origin/HEAD` (e.g. resolves
to `origin/master` for this repo). If that lookup fails, fall back to
`origin/main`, then `origin/master`, then bail with an error suggesting
`--base=<ref>`. The CLI accepts `--base=<ref>` to override and
`--files=<comma-separated>` to scan an explicit list (used by tests).

**No-fix mode:** the audit reports only. No mutation.

### Config — `.autopilot/frontend-quality.json`

Schema lives at `presets/schemas/frontend-quality.schema.json` with
`additionalProperties: false` to catch config typos (e.g. `requireAltOnImages`
instead of `requireAltOnImg`). Validated by AJV at script startup; exits 2 on
violation with the JSON pointer + offending value.

Example:

```json
{
  "componentLibrary": "shadcn",
  "themeFiles": [
    "app/components/theme/colors.tsx"
  ],
  "rawColorAllowedFiles": [
    "app/components/theme/colors.tsx",
    "app/components/ui/badge.tsx"
  ],
  "rules": {
    "forbidRawColorLiterals": true,
    "requireAltOnImg": true,
    "requireAriaLabelOnIconButton": true,
    "forbidInteractiveDiv": true,
    "requireLabelForInput": true,
    "forbidMagicSpacing": false
  },
  "ignorePaths": [
    "**/*.test.tsx",
    "**/*.stories.tsx"
  ]
}
```

Field semantics (clarified after pass-2 review):

- `componentLibrary` — informational metadata for the future Layer 1 playbook
  customization. NOT consumed by the v1 audit. Documented as future-facing.
- `themeFiles` — informational; reserved for future stack-detection / playbook
  use. NOT used by the v1 audit's raw-color allowlist (since CSS / `.ts` files
  are out of v1 scan scope anyway).
- `rawColorAllowedFiles` — actual allowlist consumed by `forbidRawColorLiterals`
  in v1. Repo-root-relative paths. Files in this list still get walked for
  other rules; only the raw-color check is skipped.
- `rules` — per-rule toggles. Defaults: all true except `forbidMagicSpacing`
  (false).
- `ignorePaths` — minimatch glob patterns applied repo-root-relative before
  extension filtering.

Missing config file → use defaults (all rules ON except `forbidMagicSpacing`),
empty allowlist, no extra ignores. Explicit `null` config value for a field is
rejected (use absence to mean "default").

### Runtime dependencies

All deps are already in `package.json`:
- `typescript` (`^6`) — devDependency, imported as `import ts from 'typescript'`. The audit runs via `tsx` from `package.json` "scripts", so the devDep is resolvable.
- `ajv` (`^8`) + `ajv-formats` (`^3`) — direct dependency. Used to validate `.autopilot/frontend-quality.json`.
- `minimatch` (`>=9`) — direct dependency. Used for `ignorePaths` glob matching.

No new package.json deps are added by this PR (acceptance criterion below
verifies this — change is artifact-only).

### Stack detection helper

Add `src/core/detect/frontend-stack.ts` — small, focused detection that returns:

```ts
type FrontendStack = {
  library: 'shadcn' | 'mui' | 'chakra' | 'mantine' | 'antd' | 'bootstrap' | 'custom' | 'unknown';
  hasTailwind: boolean;
  themeFiles: string[];        // files declared in config, else auto-detected
  primitivesDir: string | null; // app/components/ui or src/components/ui if present
};
```

Used by both Layer 1 (playbook header generation, if dynamic) and Layer 2 (the
audit reads `themeFiles` from this if not in the config).

## Data flow (Layer 2 audit)

```
1. Load .autopilot/frontend-quality.json (or defaults). AJV-validate with
   additionalProperties: false. Exit 2 on schema failure (CRITICAL bug class).
2. Resolve diff scope (single canonical resolver — used in both code and tests):
     - --files=FILE,FILE       → audit exactly these files (bypasses git)
     - --base=<ref>             → git diff --name-only --diff-filter=AM <ref>...HEAD
     - default                  → auto-detect base via the same precedence used
                                  by the existing detect-stack helpers:
                                  1. `git symbolic-ref refs/remotes/origin/HEAD`
                                     (strips `refs/remotes/`)
                                  2. `origin/main` if it exists
                                  3. `origin/master` if it exists
                                  4. else exit 2 with hint: pass --base=<ref>
3. Normalize each path to repo-root-relative, reject any path containing `..` or
   starting with `/` (path-traversal guard from config validation extends to
   diff entries too).
4. Apply `ignorePaths` glob patterns (matcher: `minimatch` — already a direct
   dep of @delegance/cadence). Patterns are matched against the
   repo-root-relative path. Filter happens BEFORE extension filtering so users
   can ignore noisy auto-generated `*.stories.tsx` etc without ext-prefix tax.
5. Filter to extensions `.tsx` and `.jsx`. Skip anything else silently — out of
   scope for v1.
6. For each remaining file:
     - Map extension to ts.ScriptKind: .tsx → TSX, .jsx → JSX
     - ts.createSourceFile(path, src, ScriptTarget.ESNext, /*setParents*/ true, scriptKind)
     - Inspect sourceFile.parseDiagnostics — if non-empty AND not --allow-parse-failures, exit 2
     - Walk AST with one visitor that collects {rule, node, severity, message}
       tuples for ALL enabled rules
7. Print findings to stderr in `file:line:col [rule] severity: message` format.
   Exit codes:
     - 0 — no error-severity findings
     - 1 — at least one error-severity finding
     - 2 — config/git/parse infra failure
   NOTE-severity findings (e.g. `alt=""` decorative review-flag) are printed
   ONLY when `--include-notes` is passed and never affect the exit code on
   their own. This keeps CI signal sharp.
```

## Test strategy

Mirror the `audit-supabase-imports.test.ts` pattern: each rule has a positive case (flagged) and a negative case (not flagged, including the type-erased / config-disabled escape valves).

**Layer 1 tests** (`tests/frontend-impl-playbook.test.ts`):
- Skill file exists and parses (YAML frontmatter + body)
- Skill content contains the five required anchors (reuse, tokens, four states, a11y, mobile-first) — guards against accidental deletion
- Stack-aware language present (regex for "DETECT" / "components.json" / "tailwind.config" / "package.json" — catches "I deleted the stack detection paragraph" regressions)

**Layer 2 tests** (`tests/audit-frontend.test.ts`):
- Per-rule positive + negative cases (12 tests)
- Config: missing config file → defaults applied
- Config: explicit `rules: { forbidRawColorLiterals: false }` → that rule does not fire
- Config: `themeFiles` allowlist — a fixture path declared in `themeFiles` skips the raw-color check; a non-allowlisted `.tsx` triggers it. (v1 only audits `.tsx`/`.jsx`, so the realistic themeFile would be e.g. `app/components/ui/theme.tsx` — `tailwind.config.ts` is out of scope until `.ts` scanning lands.)
- Files outside `*.{tsx,jsx}` extension are silently skipped (no crash, no false positive)
- Malformed config JSON → exit 2 with a clear error message (do NOT silently fall back; users won't notice the config never loaded)

**Stack-detection tests** (`tests/detect-frontend-stack.test.ts`):
- shadcn marker (`components.json` + `@radix-ui/*` in deps) → `library: 'shadcn'`
- MUI marker (`@mui/material` in deps, no `components.json`) → `library: 'mui'`
- No FE markers → `library: 'unknown'`, `hasTailwind: false`
- Tailwind without a component library → `library: 'custom'`, `hasTailwind: true`

## Failure modes + error handling

1. **AST parse failure** detection — `ts.createSourceFile` returns a SourceFile even for malformed input and surfaces issues via `sourceFile.parseDiagnostics`. The audit MUST inspect `parseDiagnostics` after parsing; if non-empty, emit the first diagnostic with `file:line:col message` and exit **2**. Operators can override with `--allow-parse-failures` if they have a known generated/exotic file they want skipped; defaults to NOT allowed. A regression test fixture (`tests/fixtures/audit-frontend/broken.tsx`) with a syntax error verifies exit code 2.
2. **Config schema-validation failure** → exit **2** with the AJV error path (which JSON pointer + which value). Do not fall back to defaults silently — config typos that disable a rule are exactly the bug class that lets slop through. Validate the config with `additionalProperties: false` so typos like `requireAltOnImages` (instead of `requireAltOnImg`) fail loud.
3. **`git diff` failure** (no resolvable base ref, detached HEAD, shallow clone) → exit **2** with remediation hint: `--base=<ref>` or `--files=<list>`. Do NOT fall back to "audit all tracked files" — that's a noisy CI surprise. Tests can drive the script via `--files=` to bypass git entirely.
4. **Path traversal** in `themeFiles` / `ignorePaths` — schema regex refuses `..` segments and absolute paths; config validation exits 2 on violation.
5. **JSX parse via wrong ScriptKind** — explicitly map extensions: `.tsx` → `ts.ScriptKind.TSX`, `.jsx` → `ts.ScriptKind.JSX`. A test asserts that a `.tsx` file containing `<Button onClick={() => {}}>Save</Button>` parses without error and is walked correctly.

## Integration with the autopilot pipeline

**Layer 1 wiring is documentation-only in this PR.** The autopilot Step 3 dispatcher does NOT yet auto-prepend the skill — that wiring is deferred to a follow-up because the dispatcher is currently being refactored in PR #179 (concurrent subagent execution). For now, the playbook lives at `skills/frontend-impl-playbook/SKILL.md` and is discoverable by humans + a future dispatcher change.

**Layer 2 wiring is also documentation-only in this PR.** The audit script lives at `scripts/audit-frontend.ts` and is invokable via `npx tsx scripts/audit-frontend.ts`. The SKILL.md Step 4 (validate) gets a one-paragraph note describing the optional check; full auto-invocation in `validate.ts` is a follow-up issue.

**Rationale for deferring wiring**: this PR is already ~600 LOC. Wiring into the dispatcher AND validate.ts touches load-bearing files in three concurrent PRs (#29, #179, #180). Shipping the artifacts first and wiring later is the safer sequence — and the audit can be added to a project's CI manually via `npm run audit:frontend` immediately.

## Acceptance criteria

- [ ] `skills/frontend-impl-playbook/SKILL.md` exists with the five playbook anchors and stack-detection guidance
- [ ] `scripts/audit-frontend.ts` exists and is invokable via `npx tsx scripts/audit-frontend.ts`
- [ ] `presets/schemas/frontend-quality.schema.json` exists and validates the example config
- [ ] `src/core/detect/frontend-stack.ts` exists with `detectFrontendStack(cwd)` exported
- [ ] `tests/frontend-impl-playbook.test.ts` covers skill-content invariants (3+ tests)
- [ ] `tests/audit-frontend.test.ts` covers all 6 rules + config + extension-filter edge cases (15+ tests)
- [ ] `tests/detect-frontend-stack.test.ts` covers 4+ stack-detection cases
- [ ] `package.json` adds `"audit:frontend": "tsx scripts/audit-frontend.ts"` to `scripts`
- [ ] `CHANGELOG.md` entry under Unreleased explaining the conditional-firing model and that wiring into autopilot dispatcher + validate.ts is a follow-up
- [ ] `presets/nextjs-supabase/stack.md` adds a one-line pointer to `npm run audit:frontend`

## Dependencies + sequencing

- Ships AFTER v7.9.1 (migrate sequencing — already merged into master at `34e0bd8`).
- Ships BEFORE Layer 3 (senior-UX critique gate) — out of scope here.
- Coexists with PRs #29, #179, #180 (3 parallel agents) — touches disjoint files. No expected merge conflicts.
- Customer discovery should validate that FE quality is a real buyer pain BEFORE expanding past Layer 2.

## Out of scope (codex pushback from earlier session — preserved)

- ESLint `eslint-plugin-jsx-a11y` bundling — recommended in playbook README, not bundled
- Testing Library state-coverage assertions — recommended in playbook, not enforced
- Playwright + axe scan — Layer 3, post-MVP
- Auto-fix on audit findings — surface only, no mutation

## Post-launch follow-ups

Captured from Codex pass 1 review of this spec (pre-implementation):

- **NOTE — ESLint pairing**: README + playbook recommend `eslint-plugin-jsx-a11y` rules (`alt-text`, `click-events-have-key-events`, `no-static-element-interactions`, `control-has-associated-label`) as a more comprehensive companion. The audit is positioned as a "minimum floor that runs without ESLint config."
- **NOTE — `additionalProperties: false`**: explicitly applied in the JSON Schema for `.autopilot/frontend-quality.json` so config typos fail loud (covers the `requireAltOnImages` bug class).
- **Follow-up — CSS / .ts scanning**: a future PR can extend the audit to parse CSS files (raw color literals in `*.css`) and `.ts` style constant modules. Out of scope for v1 to keep the LOC contained.
- **Follow-up — Auto-wire into Step 3 dispatcher**: when the concurrent-dispatcher work in PR #179 lands, a small patch can read `skills/frontend-impl-playbook/SKILL.md` and prepend it to impl-agent briefs whose task file list intersects `*.tsx`/`*.jsx`.
- **Follow-up — Auto-wire into `validate.ts` Step 4**: similar small patch — when the PR diff contains FE files, run `npm run audit:frontend` as part of the Phase-1 static check.
- **Follow-up — `componentLibrary` deeper integration**: today it's metadata for the future Layer 1 playbook customization; not consumed by the audit script in v1.

## References

- Issue #178 — feat(v7.10.0): frontend quality — stack-aware playbook + narrow deterministic audit
- `scripts/audit-supabase-imports.ts` — the AST audit pattern this script mirrors
- `tests/audit-supabase-imports.test.ts` — the test pattern this PR's tests mirror
- `skills/ui/SKILL.md`, `skills/simplify-ui/SKILL.md`, `skills/ui-ux-pro-max/SKILL.md`, `skills/make-interfaces-feel-better/SKILL.md` — existing FE skills (different scope: polish/audit existing screens; this PR's skill is for impl-agent guidance)
