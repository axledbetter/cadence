import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSqlChanges } from '../../src/core/schema-changes/detectors/sql.ts';

const FILE = 'data/deltas/test.sql';

async function detect(after: string, before = ''): Promise<ReturnType<typeof detectSqlChanges> extends Promise<infer T> ? T : never> {
  return detectSqlChanges({ file: FILE, beforeText: before, afterText: after });
}

describe('SQL detector — DDL', () => {
  it('CREATE TABLE → sql.create_table (additive)', async () => {
    const r = await detect('CREATE TABLE users (id uuid PRIMARY KEY);');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'sql.create_table');
    assert.equal(r[0]!.objectName, 'users');
    assert.equal(r[0]!.additive, true);
  });

  it('DROP TABLE → sql.drop_table (destructive)', async () => {
    const r = await detect('DROP TABLE users;');
    assert.equal(r[0]!.kind, 'sql.drop_table');
    assert.equal(r[0]!.additive, false);
  });

  it('RENAME TABLE → sql.rename_table', async () => {
    const r = await detect('ALTER TABLE users RENAME TO accounts;');
    assert.equal(r[0]!.kind, 'sql.rename_table');
    assert.equal(r[0]!.objectName, 'users');
  });

  it('ADD COLUMN nullable → sql.add_column (additive)', async () => {
    const r = await detect('ALTER TABLE users ADD COLUMN bio text;');
    assert.equal(r[0]!.kind, 'sql.add_column');
    assert.equal(r[0]!.subObjectName, 'bio');
    assert.equal(r[0]!.additive, true);
  });

  it('ADD COLUMN NOT NULL → sql.add_column (destructive)', async () => {
    const r = await detect("ALTER TABLE users ADD COLUMN bio text NOT NULL DEFAULT 'x';");
    assert.equal(r[0]!.kind, 'sql.add_column');
    assert.equal(r[0]!.additive, false);
  });

  it('DROP COLUMN → sql.drop_column (destructive)', async () => {
    const r = await detect('ALTER TABLE users DROP COLUMN bio;');
    assert.equal(r[0]!.kind, 'sql.drop_column');
    assert.equal(r[0]!.subObjectName, 'bio');
    assert.equal(r[0]!.additive, false);
  });

  it('ALTER COLUMN SET NOT NULL → sql.alter_column SET NOT NULL', async () => {
    const r = await detect('ALTER TABLE users ALTER COLUMN name SET NOT NULL;');
    assert.equal(r[0]!.kind, 'sql.alter_column');
    assert.equal(r[0]!.operation, 'SET NOT NULL');
    assert.equal(r[0]!.additive, false);
  });

  it('ALTER COLUMN DROP NOT NULL → sql.alter_column (additive)', async () => {
    const r = await detect('ALTER TABLE users ALTER COLUMN name DROP NOT NULL;');
    assert.equal(r[0]!.kind, 'sql.alter_column');
    assert.equal(r[0]!.additive, true);
  });

  it('ALTER COLUMN TYPE → sql.alter_column TYPE', async () => {
    const r = await detect('ALTER TABLE users ALTER COLUMN name TYPE varchar(100);');
    assert.equal(r[0]!.kind, 'sql.alter_column');
    assert.equal(r[0]!.operation, 'TYPE');
  });

  it('RENAME COLUMN → sql.alter_column rename', async () => {
    const r = await detect('ALTER TABLE users RENAME COLUMN name TO full_name;');
    assert.equal(r[0]!.kind, 'sql.alter_column');
    assert.equal(r[0]!.subObjectName, 'name');
    assert.match(r[0]!.operation ?? '', /rename/);
  });

  it('CREATE INDEX → sql.add_index (additive)', async () => {
    const r = await detect('CREATE INDEX users_name_idx ON users(name);');
    assert.equal(r[0]!.kind, 'sql.add_index');
    assert.equal(r[0]!.subObjectName, 'users_name_idx');
  });

  it('DROP INDEX → sql.drop_index', async () => {
    const r = await detect('DROP INDEX users_name_idx;');
    assert.equal(r[0]!.kind, 'sql.drop_index');
  });
});

describe('SQL detector — views, functions, triggers, extensions', () => {
  it('CREATE VIEW → sql.create_view', async () => {
    const r = await detect('CREATE VIEW v AS SELECT 1;');
    assert.equal(r[0]!.kind, 'sql.create_view');
    assert.equal(r[0]!.objectName, 'v');
  });

  it('DROP VIEW → sql.drop_view', async () => {
    const r = await detect('DROP VIEW v;');
    assert.equal(r[0]!.kind, 'sql.drop_view');
  });

  it('CREATE FUNCTION → sql.create_function', async () => {
    const r = await detect("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;");
    assert.equal(r[0]!.kind, 'sql.create_function');
  });

  it('CREATE OR REPLACE FUNCTION → sql.alter_function', async () => {
    const r = await detect("CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;");
    assert.equal(r[0]!.kind, 'sql.alter_function');
  });

  it('DROP FUNCTION → sql.drop_function', async () => {
    const r = await detect('DROP FUNCTION f;');
    assert.equal(r[0]!.kind, 'sql.drop_function');
  });

  it('CREATE TRIGGER → sql.create_trigger', async () => {
    const r = await detect("CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();");
    assert.equal(r[0]!.kind, 'sql.create_trigger');
    assert.equal(r[0]!.objectName, 'users');
    assert.equal(r[0]!.subObjectName, 't');
  });

  it('DROP TRIGGER → sql.drop_trigger', async () => {
    const r = await detect('DROP TRIGGER t ON users;');
    assert.equal(r[0]!.kind, 'sql.drop_trigger');
    assert.equal(r[0]!.objectName, 'users');
    assert.equal(r[0]!.subObjectName, 't');
  });

  it('CREATE EXTENSION → sql.create_extension', async () => {
    const r = await detect('CREATE EXTENSION pgcrypto;');
    assert.equal(r[0]!.kind, 'sql.create_extension');
  });

  it('DROP EXTENSION → sql.drop_extension', async () => {
    const r = await detect('DROP EXTENSION pgcrypto;');
    assert.equal(r[0]!.kind, 'sql.drop_extension');
  });
});

describe('SQL detector — RLS / grants (load-bearing for Supabase)', () => {
  it('ENABLE ROW LEVEL SECURITY → sql.enable_rls', async () => {
    const r = await detect('ALTER TABLE users ENABLE ROW LEVEL SECURITY;');
    assert.equal(r[0]!.kind, 'sql.enable_rls');
    assert.equal(r[0]!.additive, true);
  });

  it('DISABLE ROW LEVEL SECURITY → sql.disable_rls (destructive)', async () => {
    const r = await detect('ALTER TABLE users DISABLE ROW LEVEL SECURITY;');
    assert.equal(r[0]!.kind, 'sql.disable_rls');
    assert.equal(r[0]!.additive, false);
  });

  it('FORCE ROW LEVEL SECURITY → sql.force_rls', async () => {
    const r = await detect('ALTER TABLE users FORCE ROW LEVEL SECURITY;');
    assert.equal(r[0]!.kind, 'sql.force_rls');
  });

  it('CREATE POLICY → sql.add_policy', async () => {
    const r = await detect('CREATE POLICY my_pol ON users USING (true);');
    assert.equal(r[0]!.kind, 'sql.add_policy');
    assert.equal(r[0]!.objectName, 'users');
    assert.equal(r[0]!.subObjectName, 'my_pol');
  });

  it('ALTER POLICY → sql.alter_policy', async () => {
    const r = await detect('ALTER POLICY my_pol ON users USING (false);');
    assert.equal(r[0]!.kind, 'sql.alter_policy');
  });

  it('DROP POLICY → sql.drop_policy', async () => {
    const r = await detect('DROP POLICY my_pol ON users;');
    assert.equal(r[0]!.kind, 'sql.drop_policy');
    assert.equal(r[0]!.objectName, 'users');
    assert.equal(r[0]!.subObjectName, 'my_pol');
  });

  it('GRANT → sql.grant', async () => {
    const r = await detect('GRANT SELECT ON users TO authenticated;');
    assert.equal(r[0]!.kind, 'sql.grant');
    assert.equal(r[0]!.additive, true);
  });

  it('REVOKE → sql.revoke (destructive)', async () => {
    const r = await detect('REVOKE SELECT ON users FROM authenticated;');
    assert.equal(r[0]!.kind, 'sql.revoke');
    assert.equal(r[0]!.additive, false);
  });

  it('CREATE ROLE → sql.create_role', async () => {
    const r = await detect('CREATE ROLE myrole;');
    assert.equal(r[0]!.kind, 'sql.create_role');
  });

  it('DROP ROLE → sql.drop_role', async () => {
    const r = await detect('DROP ROLE myrole;');
    assert.equal(r[0]!.kind, 'sql.drop_role');
  });
});

describe('SQL detector — data ops', () => {
  it('UPDATE → sql.data_backfill', async () => {
    const r = await detect("UPDATE users SET name='x' WHERE id IS NULL;");
    assert.equal(r[0]!.kind, 'sql.data_backfill');
  });

  it('DELETE → sql.data_delete (destructive)', async () => {
    const r = await detect("DELETE FROM users WHERE name = 'old';");
    assert.equal(r[0]!.kind, 'sql.data_delete');
    assert.equal(r[0]!.additive, false);
  });

  it('TRUNCATE → sql.truncate (destructive)', async () => {
    const r = await detect('TRUNCATE users;');
    assert.equal(r[0]!.kind, 'sql.truncate');
    assert.equal(r[0]!.additive, false);
  });
});

describe('SQL detector — multi-statement granularity (codex CRITICAL)', () => {
  it('emits ONE ENTRY PER SEMANTIC STATEMENT, not per file', async () => {
    const r = await detect(`
      ALTER TABLE users ADD COLUMN birthdate date;
      UPDATE users SET birthdate = '1900-01-01' WHERE birthdate IS NULL;
      ALTER TABLE users ALTER COLUMN birthdate SET NOT NULL;
    `);
    assert.equal(r.length, 3);
    assert.equal(r[0]!.kind, 'sql.add_column');
    assert.equal(r[1]!.kind, 'sql.data_backfill');
    assert.equal(r[2]!.kind, 'sql.alter_column');
    // Each gets a statementIndex for multiset uniqueness.
    assert.equal(r[0]!.statementIndex, 0);
    assert.equal(r[1]!.statementIndex, 1);
    assert.equal(r[2]!.statementIndex, 2);
  });

  it('two ADD COLUMN statements emit two entries (multiset uniqueness via statementIndex)', async () => {
    const r = await detect(`
      ALTER TABLE users ADD COLUMN foo text;
      ALTER TABLE users ADD COLUMN bar text;
    `);
    assert.equal(r.length, 2);
    assert.notEqual(r[0]!.statementIndex, r[1]!.statementIndex);
  });
});

describe('SQL detector — generated columns and enum changes', () => {
  it('CREATE TYPE ... AS ENUM → entry', async () => {
    const r = await detect("CREATE TYPE color AS ENUM ('red','blue');");
    assert.ok(r.length >= 1);
    assert.match(r[0]!.description, /CREATE TYPE/);
  });

  it('ALTER TYPE ... ADD VALUE → entry', async () => {
    const r = await detect("ALTER TYPE color ADD VALUE 'green';");
    assert.ok(r.length >= 1);
    assert.equal(r[0]!.subObjectName, 'green');
    assert.equal(r[0]!.additive, true);
  });

  it('GENERATED column in CREATE TABLE — parsed as CreateStmt without crashing', async () => {
    const r = await detect("CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) STORED);");
    assert.equal(r[0]!.kind, 'sql.create_table');
  });
});

describe('SQL detector — diff semantics', () => {
  it('skips statements that appear identically in before-text', async () => {
    const before = 'CREATE TABLE users (id uuid);';
    const after = 'CREATE TABLE users (id uuid); ALTER TABLE users ADD COLUMN name text;';
    const r = await detectSqlChanges({ file: FILE, beforeText: before, afterText: after });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'sql.add_column');
  });

  it('unparseable SQL → unknown.unparseable entry', async () => {
    const r = await detect('this is not sql at all <<<>>>;');
    assert.equal(r[0]!.kind, 'unknown.unparseable');
  });

  it('empty before+after → no entries', async () => {
    const r = await detect('', '');
    assert.equal(r.length, 0);
  });
});
