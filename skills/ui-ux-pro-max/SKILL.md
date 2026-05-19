---
name: ui-ux-pro-max
description: Senior-level UX audit of an existing screen — produces a prioritized findings list, does NOT auto-fix. Use when the user asks for a "pro review", "expert critique", "ux audit", "senior take", "what would a designer catch", "is this production-grade", or wants rigorous evaluation of information architecture, cognitive load, accessibility, heuristic violations, and error states. Applies Nielsen heuristics, Fitts/Hick, WCAG, and measurable UX principles — not vibes. Complements /simplify-ui (subtraction) and /make-interfaces-feel-better (craft). For one-shot polish that includes audit + fix, use /ui instead.
---

# UI/UX Pro Max — the senior review

Apply senior-designer rigor to an existing screen. This is **evaluation**, not creation. Do not rebuild from scratch; produce a prioritized list of defects with evidence.

## Rules of engagement

- **No vibes.** Every finding names a principle (heuristic, law, or WCAG rule) and points at a specific element.
- **No rewrites during audit.** First list the findings; fix only what the user explicitly approves.
- **Prioritize by user impact.** Severity ranks: blocker (user cannot complete task) > major (noticeable friction) > minor (polish) > nit.
- **Cite evidence from the screen.** Don't generalize from principle — point at the component, class name, or pixel distance.

## 1. Heuristics pass (Nielsen + practical extensions)

Walk the screen against these in order. Flag violations with severity.

1. **Visibility of system status** — every long operation shows progress; every state change is visible within 1s.
2. **Match with real-world language** — field labels use the user's vocabulary, not internal schema names (`bop_160_occupancy` → "Occupancy Type").
3. **User control & undo** — destructive actions have confirm + undo; optimistic updates reveal failures.
4. **Consistency** — same action uses same verb/icon/color/position across the app. Note inconsistencies by exact location.
5. **Error prevention** — disable buttons that can't act yet, constrain inputs (dates, phone masks), validate on blur.
6. **Recognition over recall** — never ask users to remember what they typed on page 2 to fill page 3.
7. **Flexibility (power users)** — check for keyboard shortcuts, bulk actions, saved state, intelligent defaults.
8. **Aesthetic & minimalist design** — every visible element earns its spot; label + chip + helper + placeholder overlap is noise.
9. **Help users recognize/recover from errors** — error messages name the field, explain the problem, propose a fix.
10. **Help & docs in-context** — help text next to the field, not on a separate help page.

## 2. Physics + cognition

- **Fitts' Law** — target size ≥ 44×44 px for touch, ≥ 24×24 px for desktop; dangerous targets need *more* distance and size, not less. Close-buttons on toasts that are 18px is a defect.
- **Hick's Law** — flag dropdowns > 12 options without search. Lists > 5 items on a form field should be grouped or filtered.
- **Miller's 7±2** — flag screens asking for > 9 decisions at once; break into steps or collapse the optional ones.
- **Doherty threshold** — anything > 400ms without feedback reads as "broken". Note any interaction that is synchronous and slow.
- **Serial-position effect** — important CTAs go first or last, not middle.

## 3. Information architecture

- **Section cardinality** — can a user explain what goes in each section in one sentence? If no, the section is doing two jobs.
- **Field grouping** — fields that are answered from the same mental context go together (address block, employee counts, coverage limits). Cross-group fields that live together are a defect.
- **Progressive disclosure** — required first, optional expandable, rarely-used hidden. Note any section that leads with optional fields.
- **Scannability** — can the user scan and find the fields they've already answered in < 2 seconds? Test by reading only bold text and labels.
- **Density** — count fields per card. Under 3 is sleepy, over 9 is oppressive; target 3–6.

## 4. Accessibility (WCAG 2.2 AA baseline)

Run this as a pre-merge gate, not a "nice to have".

- **Color contrast** — body text ≥ 4.5:1, large text ≥ 3:1, UI components ≥ 3:1. Chips and pill backgrounds usually fail here; measure them.
- **Focus visible** — tab through the form. Every focusable element needs a visible ring *different* from the hover state.
- **Labels programmatically associated** — every input has a `<label for>` or `aria-labelledby`. Placeholder-as-label is a defect.
- **Error identification** — errors are announced to screen readers via `aria-live="polite"` or `aria-invalid`.
- **Motion preferences** — any non-essential animation respects `prefers-reduced-motion`.
- **Target size** — per WCAG 2.2, interactive targets ≥ 24×24 CSS px or have sufficient spacing.
- **Form autofill** — inputs use appropriate `autocomplete` attributes (email, tel, address-line1, …).

## 5. States — all of them

For every interactive component, check: default, hover, focus, active, disabled, loading, empty, error, success. Note which states are missing or visually identical.

## 6. Microcopy

- **Button verbs match action.** "Submit" is rarely right — "Send quote", "Save draft", "Request bind" are better.
- **Labels as statements, not questions.** "Do you own the building?" → "Building ownership" with a Yes/No.
- **Placeholders don't repeat the label.** "Email" label + "Enter your email" placeholder = pick one.
- **Error messages propose the fix**, not just the problem.
- **Empty states** tell users what will appear here and what to do to make it appear.

## Deliverable

A severity-sorted list shaped like this:

```
[blocker] Inputs are rendered without associated <label> — WCAG 1.3.1 violation — app/forms/signup/page.tsx:124
[major] "Progress" denominator counts optional fields; misleads users about completion — onboarding-sidebar.tsx:48
[major] Yes/No buttons (px-6 py-3) are 44px tall next to 32px select inputs — violates consistency heuristic — question-input.tsx:67
[minor] "Auto-filled" + "Suggested" chips render simultaneously on same field — visual noise — form-field.tsx:34
[nit] Section 2 header uses Playfair Display at 26px; rest of form is Figtree — typographic inconsistency
```

After the list, stop. Wait for the user to pick which to fix. Do not batch everything into one edit — that's a different skill.

## Known interactions

- Pair with `/simplify-ui` after this audit: its job is to cut what yours identifies as low-value.
- Pair with `/make-interfaces-feel-better` after the structural fixes land: its job is the craft layer above correctness.
- If your audit reveals the screen needs a redesign, not a polish, escalate to `frontend-design:frontend-design`.
