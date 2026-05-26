---
name: frontend-impl-playbook
description: Stack-aware frontend implementation playbook for autopilot impl-agents. When a task touches *.tsx/*.jsx/*.css files, dispatchers prepend this playbook to the agent's brief so the first draft already meets the design-quality floor (reuse existing primitives, design tokens only, four states by default, accessibility baseline, mobile-first). Read this skill manually before implementing UI changes if your autopilot version does not auto-attach it yet.
---

# Frontend Implementation Playbook

You are about to write or modify frontend code. Before you touch a single line, work through this checklist. The goal is to ship a first draft that does not need a "make it not feel like AI slop" pass later. The audit at `scripts/audit-frontend.ts` catches the mechanical signals (raw colors, missing alt, icon buttons without aria-label) — this playbook is for the harder calls.

## 0. DETECT THE PROJECT'S STACK FIRST

Do this before writing any new component. The wrong primitive will look fine in code review and feel wrong in production.

1. **Read `package.json`** — scan `dependencies`, `devDependencies`, and `peerDependencies` for:
   - `@radix-ui/*` packages — likely shadcn / Radix
   - `@mui/material` or `@mui/core` — Material UI
   - `@chakra-ui/react` — Chakra
   - `@mantine/core` — Mantine
   - `antd` — Ant Design
   - `react-bootstrap` / `bootstrap` — Bootstrap
   - `tailwindcss` — Tailwind (often paired with shadcn but standalone too)
2. **Look for `components.json`** at the repo root — this is the shadcn marker file. If present, the project is using shadcn primitives.
3. **Look for `tailwind.config.{ts,js,mjs,cjs}`** — confirms Tailwind. Read `theme.extend.colors` to learn the design palette so you can use semantic tokens (`text-brand-primary`) instead of raw values.
4. **Look in `.autopilot/stack.md`** — projects may declare their stack here. Treat this as authoritative override.
5. **List the existing primitives directory** — typically one of `app/components/ui/`, `src/components/ui/`, or `components/ui/`. Read the files. Build a mental list of what's available: `Button`, `Input`, `Select`, `Checkbox`, `Dialog`, `Sheet`, `Tabs`, etc.

If you cannot identify the stack from any of these signals, ASK before guessing. Picking the wrong UI library to add a "small new component" creates a fork in the codebase that is expensive to undo.

## 1. REQUIRED: Reuse existing primitives

Before writing a `Button`, `Input`, `Select`, `Dialog`, or any other primitive — search the codebase for the project's existing one and use it. The patterns:

- If shadcn: `import { Button } from '@/components/ui/button'` (or the project's alias).
- If MUI: `import { Button } from '@mui/material'`.
- If Chakra: `import { Button } from '@chakra-ui/react'`.

If the existing primitive doesn't quite fit, **extend it via props or a thin wrapper** — do not fork. A `<Button variant="ghost" size="sm">` is the right answer; a brand-new `<MySmallGhostButton>` that re-implements the same styles is not.

If shadcn: when you need a primitive that isn't in `components/ui/` yet, add it via `npx shadcn@latest add <name>`. Don't hand-write what `npx shadcn` will give you for free.

## 2. REQUIRED: Design tokens only — no hex literals, no magic numbers

- **Colors**: use the theme. `text-foreground`, `bg-card`, `border-input` for shadcn. `theme.palette.primary.main` for MUI. Never `color: '#3b82f6'` or `className="text-[#3b82f6]"`.
- **Spacing**: use the project's scale. Tailwind: `p-4` not `padding: 17px`. MUI: `theme.spacing(2)` or the `sx` prop with `p: 2`.
- **Type**: use the project's text classes / variants. Tailwind: `text-sm`, `text-lg`. MUI: `<Typography variant="body2">`. Don't ship one-off `font-size: 13.5px`.
- **Border radius**: use the token, never a literal pixel. `rounded-md`, `borderRadius: theme.shape.borderRadius`.

The audit (`scripts/audit-frontend.ts`) flags raw hex literals in JSX style props and string attributes. The hardest bug to find is the one that "looks fine" — a literal `#FAFAFA` instead of `bg-muted` is invisible until the theme changes and one card stays light while the rest go dark.

## 3. REQUIRED: All four states by default

Every async screen has four states. Slop ships with two ("loading", "success"). Real apps ship all four.

For every component that fetches data, decide explicitly what each state renders:

| State | When | Example |
|-------|------|---------|
| **loading** | First render before data is back | Skeleton row, spinner, shimmer card |
| **error** | Fetch failed | Friendly message + retry button. Not a stack trace. |
| **empty** | Fetch succeeded, zero results | Empty-state illustration + call to action. Not just blank screen. |
| **success** | Fetch succeeded, has data | The actual content |

If you find yourself writing only the success path, stop. Sketch the other three before you continue — the empty state is usually where a missed product decision lives ("what should the user do if there are no policies yet?").

For forms: there are also four equivalent states — `idle`, `submitting`, `error`, `submitted`. The `submitting` state should disable inputs and show progress; the `error` state should preserve the user's input so they don't have to retype.

## 4. REQUIRED: Accessibility baseline

Non-negotiable. These are caught mechanically by the audit, but you should land them yourself in the first draft.

- **Labels for inputs.** Every `<input>`, `<textarea>`, `<select>` needs either a visible `<Label htmlFor>` / `<label htmlFor>` with matching `id`, or an explicit `aria-label`. The shadcn primitive `<Input>` does NOT label itself; pair it with `<Label>`.
- **Alt for images.** `<img alt="Company logo">`. Decorative-only image? `<img alt="">` (empty string, explicit).
- **Aria-label for icon-only buttons.** `<Button aria-label="Delete row"><TrashIcon /></Button>`. NOT `<Button><TrashIcon /></Button>` — the screen-reader announces nothing. Visually-hidden text via `<span className="sr-only">` also works.
- **Keyboard support for clickable non-buttons.** If you're tempted to write `<div onClick>`, write `<button>` instead. If you absolutely need a div (Radix slot, layout wrapper), it must have `role="button"`, `tabIndex={0}`, AND `onKeyDown`/`onKeyUp` — all three.
- **Focus states.** `focus-visible:` ring on Tailwind, `:focus-visible` outline in CSS. Removing the outline without replacing it is the #1 a11y regression.
- **Color contrast.** WCAG AA = 4.5:1 for normal text, 3:1 for large text. Don't ship light-grey-on-white "helper text" without measuring it.
- **Avoid color-as-only-signal.** Status indicators need an icon or text, not just `text-green-500` vs `text-red-500`. Colorblind users.

## 5. REQUIRED: Mobile-first responsive

Write the styles for the smallest viewport first; widen with breakpoints. Tailwind: default classes apply at all sizes, `md:` / `lg:` prefixes layer on. MUI: `sx={{ display: { xs: 'block', md: 'flex' } }}`.

- **Touch targets ≥44x44 CSS px.** Icon-only buttons in a toolbar need padding.
- **Don't ship horizontal scroll** unintentionally. Test your table / form on a 375px-wide viewport before shipping.
- **Modals on mobile** should be full-screen or near-full-screen sheets, not a tiny centered dialog.

## 6. Recommended: pair this with lint rules

This playbook + the deterministic audit covers the floor. For deeper accessibility coverage, recommend (don't bundle — keeps autopilot light) these ESLint rules in your project's config:

- `eslint-plugin-jsx-a11y/alt-text`
- `eslint-plugin-jsx-a11y/click-events-have-key-events`
- `eslint-plugin-jsx-a11y/no-static-element-interactions`
- `eslint-plugin-jsx-a11y/control-has-associated-label`
- `eslint-plugin-jsx-a11y/no-noninteractive-tabindex`

These catch class-level patterns the AST audit doesn't (e.g. `onClick` on a non-button element discovered through JSX-A11Y's component-detection registry).

## 7. Common patterns — copy these instead of reinventing

### If shadcn:

```tsx
// Loading button (submitting state)
<Button disabled={isSubmitting}>
  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
  Save changes
</Button>

// Icon-only button — ALWAYS aria-label
<Button variant="ghost" size="icon" aria-label="Delete row">
  <Trash2 className="h-4 w-4" />
</Button>

// Empty state
<div className="flex flex-col items-center justify-center py-12 text-center">
  <Inbox className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
  <h3 className="mt-4 text-sm font-semibold">No policies yet</h3>
  <p className="mt-2 text-sm text-muted-foreground">
    Upload a COI or add a policy manually to get started.
  </p>
  <Button className="mt-4">Add policy</Button>
</div>

// Error state
<Alert variant="destructive">
  <AlertCircle className="h-4 w-4" />
  <AlertTitle>Failed to load policies</AlertTitle>
  <AlertDescription>
    {error.message}
    <Button variant="link" onClick={retry}>Try again</Button>
  </AlertDescription>
</Alert>

// Labeled input
<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" placeholder="you@example.com" />
</div>
```

### If MUI:

```tsx
// Icon-only button
<IconButton aria-label="Delete row">
  <DeleteIcon />
</IconButton>

// Labeled input
<TextField id="email" label="Email" type="email" fullWidth />
// TextField handles labeling internally — no separate <label> needed
```

### If Chakra:

```tsx
// Icon-only
<IconButton aria-label="Delete row" icon={<DeleteIcon />} />

// Labeled input
<FormControl>
  <FormLabel htmlFor="email">Email</FormLabel>
  <Input id="email" type="email" />
</FormControl>
```

## 8. Self-check before you finish

Run this short checklist before committing:

- [ ] Did I reuse the project's existing primitives instead of writing new ones?
- [ ] Are all colors theme tokens? (No `#` literals in JSX style or string attrs.)
- [ ] Are all four states implemented? (loading, error, empty, success — for async screens)
- [ ] Do all icon-only buttons have `aria-label`?
- [ ] Do all images have `alt`?
- [ ] Do all inputs have a visible or sr-only label?
- [ ] If I added a clickable non-button, does it have `role="button"`, `tabIndex={0}`, AND a keyboard handler?
- [ ] Does this look right at 375px wide?

Run `npm run audit:frontend` if the project has it wired. The audit will fail loudly on the mechanical issues; this self-check covers the rest.
