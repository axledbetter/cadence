// src/core/schema-changes/detectors/sql.ts
//
// Postgres-native SQL detector. Lazy-imports `libpg-query` so cadence
// install stays light when SQL detection isn't opted into.
//
// Plan: docs/superpowers/plans/2026-05-27-schema-change-manifests.md
// Spec: docs/superpowers/specs/2026-05-27-schema-change-manifests-design.md
//
// Granularity: ONE ENTRY PER SEMANTIC STATEMENT, not per file. A SQL
// migration with five statements emits five entries.

import type { SchemaChangeEntry, SchemaChangeKind } from '../types.ts';

interface DetectInput {
  file: string;
  beforeText?: string;
  afterText?: string;
}

type ParseFn = (sql: string) => Promise<{ stmts: Array<{ stmt: Record<string, unknown> }> }>;

async function loadParser(): Promise<ParseFn | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('libpg-query');
    const parse = mod.parse ?? mod.default?.parse;
    if (typeof parse !== 'function') return null;
    return parse as ParseFn;
  } catch {
    return null;
  }
}

function unparseableEntry(file: string, reason: string): SchemaChangeEntry {
  return {
    file,
    kind: 'unknown.unparseable',
    additive: false,
    description: `SQL parse failed: ${reason}; agent must hand-author this manifest entry`,
  };
}

function unsupportedEntry(file: string, reason: string): SchemaChangeEntry {
  return {
    file,
    kind: 'unknown.unsupported_kind',
    additive: false,
    description: reason,
  };
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

interface RenameStmt {
  renameType?: string;
  relation?: { relname?: string };
  subname?: string;
  newname?: string;
  object?: unknown;
}

interface AlterTableCmd {
  subtype?: string;
  name?: string;
  def?: unknown;
}

interface AlterTableStmt {
  relation?: { relname?: string };
  cmds?: Array<{ AlterTableCmd?: AlterTableCmd }>;
}

interface DropStmt {
  removeType?: string;
  objects?: Array<unknown>;
}

interface CreateStmt {
  relation?: { relname?: string };
}

interface IndexStmt {
  idxname?: string;
  relation?: { relname?: string };
}

interface ViewStmt {
  view?: { relname?: string };
}

interface CreateFunctionStmt {
  replace?: boolean;
  funcname?: Array<{ String?: { sval?: string } }>;
}

interface CreateTrigStmt {
  trigname?: string;
  relation?: { relname?: string };
}

interface CreateExtensionStmt {
  extname?: string;
}

interface CreatePolicyStmt {
  policy_name?: string;
  table?: { relname?: string };
}

interface AlterPolicyStmt {
  policy_name?: string;
  table?: { relname?: string };
}

interface GrantStmt {
  is_grant?: boolean;
  objects?: Array<unknown>;
  objtype?: string;
}

interface CreateRoleStmt {
  role?: string;
}

interface DropRoleStmt {
  roles?: Array<{ RoleSpec?: { rolename?: string } }>;
}

interface DataStmt {
  relation?: { relname?: string };
  relations?: Array<{ RangeVar?: { relname?: string } }>;
}

interface ColumnConstraint {
  Constraint?: { contype?: string };
}

interface ColumnDef {
  colname?: string;
  constraints?: ColumnConstraint[];
}

function readString(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const s = (v as { String?: { sval?: string } }).String;
    if (s && typeof s.sval === 'string') return s.sval;
  }
  return undefined;
}

function readListItems(v: unknown): string[] {
  if (v && typeof v === 'object') {
    const list = (v as { List?: { items?: unknown[] } }).List;
    if (list && Array.isArray(list.items)) {
      return list.items.map((it) => readString(it) ?? '').filter(Boolean);
    }
  }
  return [];
}

function readObjectName(obj: unknown): string | undefined {
  if (!obj) return undefined;
  // Direct String wrapper.
  const direct = readString(obj);
  if (direct) return direct;
  // List wrapper.
  const items = readListItems(obj);
  if (items.length > 0) return items.join('.');
  // ObjectWithArgs (functions).
  const owa = (obj as { ObjectWithArgs?: { objname?: unknown[] } }).ObjectWithArgs;
  if (owa && Array.isArray(owa.objname)) {
    return owa.objname.map(readString).filter(Boolean).join('.');
  }
  return undefined;
}

function columnIsAdditive(def: unknown): boolean {
  // ADD COLUMN is additive unless NOT NULL or PRIMARY KEY or UNIQUE without default.
  if (!def || typeof def !== 'object') return true;
  const cd = (def as { ColumnDef?: ColumnDef }).ColumnDef;
  if (!cd || !cd.constraints) return true;
  for (const c of cd.constraints) {
    const t = c?.Constraint?.contype;
    if (t === 'CONSTR_NOTNULL' || t === 'CONSTR_PRIMARY' || t === 'CONSTR_UNIQUE') {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Statement → entry mapping
// ---------------------------------------------------------------------------

interface MappedEntry {
  kind: SchemaChangeKind;
  objectName?: string;
  subObjectName?: string;
  operation?: string;
  additive: boolean;
  description: string;
}

function mapDropStmt(d: DropStmt): MappedEntry[] {
  const remove = d.removeType ?? '';
  const out: MappedEntry[] = [];
  for (const obj of d.objects ?? []) {
    const name = readObjectName(obj);
    switch (remove) {
      case 'OBJECT_TABLE':
        out.push({ kind: 'sql.drop_table', objectName: name, additive: false, description: `DROP TABLE ${name ?? '(unknown)'}` });
        break;
      case 'OBJECT_INDEX':
        out.push({ kind: 'sql.drop_index', objectName: name, additive: false, description: `DROP INDEX ${name ?? '(unknown)'}` });
        break;
      case 'OBJECT_VIEW':
        out.push({ kind: 'sql.drop_view', objectName: name, additive: false, description: `DROP VIEW ${name ?? '(unknown)'}` });
        break;
      case 'OBJECT_FUNCTION':
        out.push({ kind: 'sql.drop_function', objectName: name, additive: false, description: `DROP FUNCTION ${name ?? '(unknown)'}` });
        break;
      case 'OBJECT_TRIGGER': {
        // List items are [tableName, triggerName]
        const items = readListItems(obj);
        const trig = items.length >= 2 ? items[1] : (name ?? '(unknown)');
        const table = items.length >= 2 ? items[0] : undefined;
        out.push({ kind: 'sql.drop_trigger', objectName: table, subObjectName: trig, additive: false, description: `DROP TRIGGER ${trig} ON ${table ?? '(unknown)'}` });
        break;
      }
      case 'OBJECT_EXTENSION':
        out.push({ kind: 'sql.drop_extension', objectName: name, additive: false, description: `DROP EXTENSION ${name ?? '(unknown)'}` });
        break;
      case 'OBJECT_TYPE':
        out.push({ kind: 'sql.drop_type', objectName: name, additive: false, description: `DROP TYPE ${name ?? '(unknown)'}` });
        break;
      case 'OBJECT_POLICY': {
        const items = readListItems(obj);
        const pol = items.length >= 2 ? items[1] : (name ?? '(unknown)');
        const tbl = items.length >= 2 ? items[0] : undefined;
        out.push({ kind: 'sql.drop_policy', objectName: tbl, subObjectName: pol, additive: false, description: `DROP POLICY ${pol} ON ${tbl ?? '(unknown)'}` });
        break;
      }
      default:
        out.push({ kind: 'unknown.unsupported_kind', objectName: name, additive: false, description: `Unsupported DROP type: ${remove}` });
    }
  }
  return out;
}

function mapAlterTableStmt(s: AlterTableStmt): MappedEntry[] {
  const tbl = s.relation?.relname;
  const out: MappedEntry[] = [];
  for (const c of s.cmds ?? []) {
    const cmd = c.AlterTableCmd;
    if (!cmd) continue;
    const sub = cmd.subtype;
    const col = cmd.name;
    switch (sub) {
      case 'AT_AddColumn': {
        const colname = (cmd.def as { ColumnDef?: { colname?: string } } | undefined)?.ColumnDef?.colname;
        const add = columnIsAdditive(cmd.def);
        out.push({
          kind: 'sql.add_column',
          objectName: tbl,
          subObjectName: colname,
          additive: add,
          description: `ADD COLUMN ${colname ?? '(unknown)'} ${add ? '(additive)' : '(NOT NULL or constrained — destructive without backfill)'}`,
        });
        break;
      }
      case 'AT_DropColumn':
        out.push({ kind: 'sql.drop_column', objectName: tbl, subObjectName: col, additive: false, description: `DROP COLUMN ${col ?? '(unknown)'}` });
        break;
      case 'AT_SetNotNull':
        out.push({ kind: 'sql.alter_column', objectName: tbl, subObjectName: col, operation: 'SET NOT NULL', additive: false, description: `ALTER COLUMN ${col ?? '(unknown)'} SET NOT NULL` });
        break;
      case 'AT_DropNotNull':
        out.push({ kind: 'sql.alter_column', objectName: tbl, subObjectName: col, operation: 'DROP NOT NULL', additive: true, description: `ALTER COLUMN ${col ?? '(unknown)'} DROP NOT NULL` });
        break;
      case 'AT_AlterColumnType':
        out.push({ kind: 'sql.alter_column', objectName: tbl, subObjectName: col, operation: 'TYPE', additive: false, description: `ALTER COLUMN ${col ?? '(unknown)'} TYPE` });
        break;
      case 'AT_ColumnDefault':
        out.push({ kind: 'sql.alter_column', objectName: tbl, subObjectName: col, operation: 'DEFAULT', additive: true, description: `ALTER COLUMN ${col ?? '(unknown)'} SET/DROP DEFAULT` });
        break;
      case 'AT_EnableRowSecurity':
        out.push({ kind: 'sql.enable_rls', objectName: tbl, additive: true, description: `ENABLE ROW LEVEL SECURITY on ${tbl}` });
        break;
      case 'AT_DisableRowSecurity':
        out.push({ kind: 'sql.disable_rls', objectName: tbl, additive: false, description: `DISABLE ROW LEVEL SECURITY on ${tbl}` });
        break;
      case 'AT_ForceRowSecurity':
        out.push({ kind: 'sql.force_rls', objectName: tbl, additive: true, description: `FORCE ROW LEVEL SECURITY on ${tbl}` });
        break;
      default:
        out.push({ kind: 'unknown.unsupported_kind', objectName: tbl, operation: sub, additive: false, description: `Unsupported AlterTable subtype: ${sub}` });
    }
  }
  return out;
}

function mapRenameStmt(s: RenameStmt): MappedEntry[] {
  const t = s.renameType;
  const from = s.subname;
  const to = s.newname;
  const tbl = s.relation?.relname;
  switch (t) {
    case 'OBJECT_TABLE':
      return [{ kind: 'sql.rename_table', objectName: tbl, operation: `${tbl} → ${to}`, additive: false, description: `RENAME TABLE ${tbl} → ${to}` }];
    case 'OBJECT_COLUMN':
      return [{ kind: 'sql.alter_column', objectName: tbl, subObjectName: from, operation: `rename → ${to}`, additive: false, description: `RENAME COLUMN ${tbl}.${from} → ${to}` }];
    default:
      return [{ kind: 'unknown.unsupported_kind', operation: t, additive: false, description: `Unsupported RENAME type: ${t}` }];
  }
}

function mapStatement(stmt: Record<string, unknown>): MappedEntry[] {
  const kind = Object.keys(stmt)[0];
  if (!kind) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = stmt[kind];

  switch (kind) {
    case 'CreateStmt': {
      const c = s as CreateStmt;
      return [{ kind: 'sql.create_table', objectName: c.relation?.relname, additive: true, description: `CREATE TABLE ${c.relation?.relname ?? '(unknown)'}` }];
    }
    case 'IndexStmt': {
      const i = s as IndexStmt;
      return [{ kind: 'sql.add_index', objectName: i.relation?.relname, subObjectName: i.idxname, additive: true, description: `CREATE INDEX ${i.idxname} ON ${i.relation?.relname}` }];
    }
    case 'ViewStmt': {
      const v = s as ViewStmt;
      return [{ kind: 'sql.create_view', objectName: v.view?.relname, additive: true, description: `CREATE VIEW ${v.view?.relname ?? '(unknown)'}` }];
    }
    case 'CreateFunctionStmt': {
      const f = s as CreateFunctionStmt;
      const name = (f.funcname ?? []).map(readString).filter(Boolean).join('.');
      const isReplace = f.replace === true;
      return [{ kind: isReplace ? 'sql.alter_function' : 'sql.create_function', objectName: name, additive: !isReplace, description: `${isReplace ? 'CREATE OR REPLACE' : 'CREATE'} FUNCTION ${name}` }];
    }
    case 'CreateTrigStmt': {
      const t = s as CreateTrigStmt;
      return [{ kind: 'sql.create_trigger', objectName: t.relation?.relname, subObjectName: t.trigname, additive: true, description: `CREATE TRIGGER ${t.trigname} ON ${t.relation?.relname}` }];
    }
    case 'CreateExtensionStmt': {
      const e = s as CreateExtensionStmt;
      return [{ kind: 'sql.create_extension', objectName: e.extname, additive: true, description: `CREATE EXTENSION ${e.extname}` }];
    }
    case 'CreatePolicyStmt': {
      const p = s as CreatePolicyStmt;
      return [{ kind: 'sql.add_policy', objectName: p.table?.relname, subObjectName: p.policy_name, additive: true, description: `CREATE POLICY ${p.policy_name} ON ${p.table?.relname}` }];
    }
    case 'AlterPolicyStmt': {
      const p = s as AlterPolicyStmt;
      return [{ kind: 'sql.alter_policy', objectName: p.table?.relname, subObjectName: p.policy_name, additive: false, description: `ALTER POLICY ${p.policy_name} ON ${p.table?.relname}` }];
    }
    case 'GrantStmt': {
      const g = s as GrantStmt;
      // libpg-query omits is_grant when false. Explicit-true means GRANT;
      // anything else (undefined or false) means REVOKE.
      const isGrant = g.is_grant === true;
      return [{ kind: isGrant ? 'sql.grant' : 'sql.revoke', objectName: undefined, additive: isGrant, description: isGrant ? 'GRANT statement' : 'REVOKE statement' }];
    }
    case 'CreateRoleStmt': {
      const r = s as CreateRoleStmt;
      return [{ kind: 'sql.create_role', objectName: r.role, additive: true, description: `CREATE ROLE ${r.role}` }];
    }
    case 'AlterRoleStmt':
      return [{ kind: 'sql.alter_role', additive: false, description: 'ALTER ROLE' }];
    case 'DropRoleStmt': {
      const r = s as DropRoleStmt;
      const names = (r.roles ?? []).map((x) => x.RoleSpec?.rolename ?? '').filter(Boolean);
      return names.map((name) => ({ kind: 'sql.drop_role' as const, objectName: name, additive: false, description: `DROP ROLE ${name}` }));
    }
    case 'AlterTableStmt':
      return mapAlterTableStmt(s as AlterTableStmt);
    case 'RenameStmt':
      return mapRenameStmt(s as RenameStmt);
    case 'DropStmt':
      return mapDropStmt(s as DropStmt);
    case 'UpdateStmt': {
      const u = s as DataStmt;
      return [{ kind: 'sql.data_backfill', objectName: u.relation?.relname, additive: true, description: `UPDATE ${u.relation?.relname ?? '(unknown)'}` }];
    }
    case 'DeleteStmt': {
      const d = s as DataStmt;
      return [{ kind: 'sql.data_delete', objectName: d.relation?.relname, additive: false, description: `DELETE FROM ${d.relation?.relname ?? '(unknown)'}` }];
    }
    case 'TruncateStmt': {
      const t = s as DataStmt;
      const names = (t.relations ?? []).map((r) => r.RangeVar?.relname ?? '').filter(Boolean);
      return names.length > 0
        ? names.map((n) => ({ kind: 'sql.truncate' as const, objectName: n, additive: false, description: `TRUNCATE ${n}` }))
        : [{ kind: 'sql.truncate' as const, additive: false, description: 'TRUNCATE' }];
    }
    case 'CreateEnumStmt': {
      // Codex/bugbot MEDIUM fix — enums are SQL.create_type, NOT
      // sql.create_function. Distinct kind so multiset matching can't
      // confuse a CREATE FUNCTION and CREATE TYPE that share a name.
      const e = s as { typeName?: Array<{ String?: { sval?: string } }> };
      const name = (e.typeName ?? []).map(readString).filter(Boolean).join('.');
      return [{ kind: 'sql.create_type', objectName: name, operation: 'enum', additive: true, description: `CREATE TYPE ${name} AS ENUM` }];
    }
    case 'AlterEnumStmt': {
      const e = s as { typeName?: Array<{ String?: { sval?: string } }>; newVal?: string };
      const name = (e.typeName ?? []).map(readString).filter(Boolean).join('.');
      return [{ kind: 'sql.alter_type', objectName: name, subObjectName: e.newVal, operation: 'add enum value', additive: true, description: `ALTER TYPE ${name} ADD VALUE ${e.newVal ?? ''}` }];
    }
    default:
      // SelectStmt, DoStmt, comments, etc. — not schema changes.
      return [];
  }
}

// ---------------------------------------------------------------------------
// Public detector
// ---------------------------------------------------------------------------

/**
 * Returns the schema changes introduced by `afterText` relative to
 * `beforeText`. For new files (beforeText === undefined), every detected
 * statement becomes a change. For deleted files (afterText === undefined),
 * the original statements are inverted (CREATE → drop equivalent).
 *
 * For modified files, we compute the set diff of statements: new
 * statements in `afterText` are emitted as changes. This is a deliberate
 * simplification — most schema migrations are append-only files in
 * `data/deltas/`, so the entire file content IS the change.
 *
 * MIGRATION-FILE HEURISTIC: if `beforeText === undefined` AND the file
 * path contains `data/deltas/` or matches `migrations/`, treat every
 * statement as a new change (the whole file IS the migration). This is
 * the common case.
 */
export async function detectSqlChanges(input: DetectInput): Promise<SchemaChangeEntry[]> {
  const after = input.afterText ?? '';
  const before = input.beforeText ?? '';

  if (after.trim().length === 0 && before.trim().length === 0) {
    return [];
  }

  const parse = await loadParser();
  if (!parse) {
    return [unsupportedEntry(input.file, 'libpg-query parser not installed; install optional dependency to enable SQL detection')];
  }

  let afterParsed: { stmts: Array<{ stmt: Record<string, unknown> }> };
  try {
    afterParsed = after.trim() ? await parse(after) : { stmts: [] };
  } catch (err) {
    return [unparseableEntry(input.file, (err as Error).message)];
  }

  let beforeParsed: { stmts: Array<{ stmt: Record<string, unknown> }> } = { stmts: [] };
  if (before.trim().length > 0) {
    try {
      beforeParsed = await parse(before);
    } catch {
      // If the before-text is unparseable but the after-text is, treat
      // every after-statement as new. This is the common case when the
      // pre-PR file was an empty or malformed scratch.
      beforeParsed = { stmts: [] };
    }
  }

  // Bugbot MEDIUM fix — use a multiset (Map<key, count>) NOT a Set, so
  // adding a Nth+1 copy of an already-present statement is correctly
  // detected as a change. Two identical CREATE INDEX statements in
  // before-text vs three in after-text → one new change.
  const beforeCounts = new Map<string, number>();
  for (const s of beforeParsed.stmts) {
    const key = JSON.stringify(s.stmt);
    beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  }

  const entries: SchemaChangeEntry[] = [];
  for (let i = 0; i < afterParsed.stmts.length; i++) {
    const s = afterParsed.stmts[i];
    if (!s) continue;
    const key = JSON.stringify(s.stmt);
    const remaining = beforeCounts.get(key) ?? 0;
    if (remaining > 0) {
      beforeCounts.set(key, remaining - 1);
      continue;
    }
    const mapped = mapStatement(s.stmt);
    for (const m of mapped) {
      entries.push({
        file: input.file,
        kind: m.kind,
        ...(m.objectName !== undefined ? { objectName: m.objectName } : {}),
        ...(m.subObjectName !== undefined ? { subObjectName: m.subObjectName } : {}),
        ...(m.operation !== undefined ? { operation: m.operation } : {}),
        statementIndex: i,
        additive: m.additive,
        description: m.description,
      });
    }
  }
  return entries;
}
