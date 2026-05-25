---
name: migrate
description: Framework-agnostic database migration orchestrator. Reads .autopilot/stack.md, runs the configured per-env command (Rails, Alembic, Prisma, Drizzle, golang-migrate, dbmate, flyway, supabase-cli, custom), enforces policy gates, and emits a structured result artifact. For Supabase-specific repos with data/deltas/* layout use `migrate-supabase` instead.
---

# /migrate — Generic database migration orchestrator

The thin, framework-agnostic migrate skill. Wraps any migration tool in a uniform contract:

1. Validate `.autopilot/stack.md` against the JSON schema
2. Resolve the configured skill + apply policy (clean git, manual approval, prod-in-CI gate)
3. Run `migrate.envs.<env>.command` via `spawn(shell: false)` — no shell injection surface
4. Capture stdout/stderr, parse the result artifact, append an audit-log entry
5. Return a `ResultArtifact` to the caller (autopilot pipeline or CLI)

This skill **does not know what your migration tool is**. It just executes the command you point it at and reports the outcome. Tool-specific behavior (e.g., Supabase's `data/deltas/*.sql` ledger or auto-regenerating `types/supabase.ts`) lives in `migrate-supabase`. Everything else uses this one.

## Usage

### CLI

```bash
cadence migrate                  # default env: dev
cadence migrate --env qa
cadence migrate --env prod --yes # required for prod (manual approval)
cadence migrate doctor           # validate stack.md without running

# Legacy `claude-autopilot migrate ...` continues to work as a bin alias.
```

### Autopilot pipeline

The dispatcher invokes the skill automatically when `migrate` is in the pipeline plan. The skill receives the invocation envelope via `AUTOPILOT_ENVELOPE` and writes its result to `AUTOPILOT_RESULT_PATH`.

## Configuration

Add a `migrate` block to `.autopilot/stack.md`:

```yaml
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "<tool>", args: ["<args>"] }
      env_file: ".env.dev"
    qa:
      command: { exec: "<tool>", args: ["<args>"] }
    prod:
      command: { exec: "<tool>", args: ["<args>"] }
  policy:
    allow_prod_in_ci: false
    require_clean_git: true
    require_manual_approval: true
    require_dry_run_first: false
```

The `init` flow auto-detects most common toolchains and pre-fills sensible commands. Run `cadence init` once to bootstrap.

## Examples by toolchain

### Rails (Active Record)

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "rails", args: ["db:migrate"] }
      env_file: ".env.development"
    prod:
      command: { exec: "rails", args: ["db:migrate", "RAILS_ENV=production"] }
```

### Alembic (Python)

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "alembic", args: ["upgrade", "head"] }
      env_file: ".env.dev"
    prod:
      command: { exec: "alembic", args: ["-x", "env=prod", "upgrade", "head"] }
```

### Django

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "python", args: ["manage.py", "migrate"] }
      env_file: ".env.dev"
```

### golang-migrate

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "migrate", args: ["-database", "$DATABASE_URL", "-path", "migrations", "up"] }
      env_file: ".env.dev"
```

### Prisma

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    prod:
      command: { exec: "prisma", args: ["migrate", "deploy"] }
```

### Drizzle

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "drizzle-kit", args: ["migrate"] }
      env_file: ".env.dev"
```

### dbmate

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "dbmate", args: ["up"] }
      env_file: ".env.dev"
```

### Flyway

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "flyway", args: ["migrate"] }
```

### Supabase CLI

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "supabase", args: ["migration", "up"] }
```

### Custom script

Anything goes — the dispatcher just runs `exec` with `args`:

```yaml
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "./scripts/db/migrate.sh", args: ["--env", "dev"] }
      env_file: ".env.dev"
```

## When to use `migrate-supabase` instead

Use `migrate.supabase@1` if your repo has the canonical Delegance/Supabase layout:
- `data/deltas/<timestamp>_<name>.sql` files as the source of truth
- `.claude/supabase-envs.json` with per-env `dbUrl`
- Auto-regeneration of `types/supabase.ts` after each apply
- Built-in promotion chain (dev → qa → prod with checksum verification)

Otherwise, use `migrate@1` with the appropriate command above.

## Policy enforcement

Every run goes through `policy-enforcer.ts` before the command executes. The default policy:

| Setting | Default | Effect |
|---------|---------|--------|
| `allow_prod_in_ci` | `false` | Fail if `--env prod` runs in CI without explicit override |
| `require_clean_git` | `true` | Fail if working tree has uncommitted changes |
| `require_manual_approval` | `true` | Fail prod runs without `--yes` flag |
| `require_dry_run_first` | `false` | Force a dry-run before apply (opt-in) |

Override per-environment if your workflow needs it. Tighter is better — these defaults catch real foot-guns.

## Result artifact

When invoked under the autopilot pipeline (`AUTOPILOT_ENVELOPE` set), the skill writes:

```json
{
  "contractVersion": "1.0",
  "skillId": "migrate@1",
  "invocationId": "<uuid>",
  "nonce": "<from envelope>",
  "status": "applied" | "skipped" | "validation-failed" | "needs-human" | "error",
  "reasonCode": "<short string>",
  "appliedMigrations": [],
  "destructiveDetected": false,
  "sideEffectsPerformed": ["no-side-effects"],
  "nextActions": []
}
```

The generic skill cannot enumerate `appliedMigrations` (that's tool-specific) — it leaves the array empty and reports `status: "applied"` if the command exited 0. Tool-specific result enrichment is the job of skills like `migrate-supabase` that understand the migration ledger format.

## Auditing

Every dispatch — success, failure, dry-run — writes one entry to `.autopilot/audit.log` (chained via `seq` + `prev_hash`). Inspect with:

```bash
cadence migrate doctor --audit-tail 10
```

## Stack.md schema

See `presets/schemas/migrate.schema.json` for the full JSON schema. Validation happens automatically on every dispatch — invalid `.autopilot/stack.md` fails closed before any command runs.
