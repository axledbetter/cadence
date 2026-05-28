---
"@delegance/cadence": minor
---

Cadence protocol versioning — first-class `protocol_version` field at every boundary that crosses a cadence release (profile.yaml, SKILL.md, state.json, phaseOutputs). The protocol is now versioned independently from the npm package via a `COMPONENT_VERSIONS` map; loaders normalize old-shape artifacts to the current version via a 3-stage pipeline (validate-declared → migrate → validate-current) so the internal engine never sees stale shapes. New CLI verbs: `cadence --protocol`, `cadence protocol changelog`, `cadence profile upgrade [--write]`, `cadence skill upgrade <path> [--write]`. Backward-compatible: profiles/skills/states without `protocol_version` default to `"1.0.0"` (the v8.5.x ecosystem baseline). Spec at `docs/superpowers/specs/2026-05-27-protocol-versioning-design.md`.
