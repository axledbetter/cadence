---
"@delegance/cadence": minor
---

Schema-change manifests — first-class implement-phase output (v8.6.0).

Adds typed `schemaChanges?: SchemaChangeEntry[]` to the implement-phase output. The lifecycle layer detects schema changes in the diff (SQL via libpg-query, GraphQL, OpenAPI, TypeScript exports, protobuf) and refuses to advance past `endPhase('implement')` unless the manifest covers every detected semantic change via multiset matching.

Five new policy gates evaluated by the validate phase: `blockNotNullWithoutBackfill`, `blockDropColumnWithoutDeprecation`, `blockRlsWeakeningWithoutSecurityReview` (with `policyEvidence.securityReview.reviewer` evidence), `destructiveRequiresExpandContract`, and `pairedWithMustExist`. Validate fails CLOSED on corrupted artifacts and missing implement runs.

New `cadence schema scan` CLI verb generates a skeleton manifest from the current diff. PR-body marker `<!-- cadence:schema-changes -->` is replaced with a rendered markdown table by `cadence pr-desc`.

**Opt-in gate**: empty `profile.schemaPaths` (default) = no enforcement. Existing users see no change.
