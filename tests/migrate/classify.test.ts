// tests/migrate/classify.test.ts
//
// Phase 1 of issue #179 — migration classifier.
// Covers spec section "Tests" cases 1–17 (CLI smoke test #18 lives in
// tests/cli/migrate-classify.test.ts).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type StatementClass } from '../../src/core/migrate/classify.ts';

function expectClass(sql: string, expected: StatementClass, rule?: string) {
  const r = classify(sql);
  assert.equal(
    r.classification,
    expected,
    `expected file ${expected}, got ${r.classification}\n  stmts=${JSON.stringify(r.statements, null, 2)}`,
  );
  if (rule) {
    const hit = r.statements.find(s => s.rule === rule);
    assert.ok(hit, `expected rule ${rule} in statements: ${r.statements.map(s => s.rule).join(', ')}`);
  }
}

describe('classify — destructive top-level rules', () => {
  it('DROP TABLE', () => expectClass('DROP TABLE foo;', 'destructive', 'drop-table'));
  it('DROP TABLE IF EXISTS', () => expectClass('DROP TABLE IF EXISTS foo;', 'destructive', 'drop-table'));
  it('DROP INDEX', () => expectClass('DROP INDEX idx_foo;', 'destructive', 'drop-index'));
  it('DROP MATERIALIZED VIEW', () => expectClass('DROP MATERIALIZED VIEW mv;', 'destructive', 'drop-materialized-view'));
  it('DROP VIEW', () => expectClass('DROP VIEW v;', 'destructive', 'drop-view'));
  it('DROP FUNCTION', () => expectClass('DROP FUNCTION fn();', 'destructive', 'drop-function'));
  it('DROP PROCEDURE', () => expectClass('DROP PROCEDURE p();', 'destructive', 'drop-procedure'));
  it('DROP POLICY', () => expectClass('DROP POLICY p ON t;', 'destructive', 'drop-policy'));
  it('DROP TRIGGER', () => expectClass('DROP TRIGGER tg ON t;', 'destructive', 'drop-trigger'));
  it('DROP SCHEMA', () => expectClass('DROP SCHEMA s CASCADE;', 'destructive', 'drop-schema'));
  it('DROP TYPE', () => expectClass('DROP TYPE t;', 'destructive', 'drop-type'));
  it('DROP SEQUENCE', () => expectClass('DROP SEQUENCE s;', 'destructive', 'drop-sequence'));
  it('DROP EXTENSION', () => expectClass('DROP EXTENSION pgcrypto;', 'destructive', 'drop-extension'));
  it('DROP DOMAIN', () => expectClass('DROP DOMAIN d;', 'destructive', 'drop-domain'));
  it('TRUNCATE', () => expectClass('TRUNCATE foo;', 'destructive', 'truncate'));
  it('DELETE FROM', () => expectClass('DELETE FROM foo WHERE id = 1;', 'destructive', 'delete-from'));
  it('CREATE UNIQUE INDEX (non-concurrent)', () =>
    expectClass('CREATE UNIQUE INDEX idx ON t(c);', 'destructive', 'create-unique-index'));
  it('ALTER TABLE RENAME TO', () =>
    expectClass('ALTER TABLE foo RENAME TO bar;', 'destructive', 'alter-table-rename-to'));
  it('ALTER TABLE DISABLE ROW LEVEL SECURITY', () =>
    expectClass('ALTER TABLE foo DISABLE ROW LEVEL SECURITY;', 'destructive', 'disable-rls'));
});

describe('classify — destructive ALTER TABLE clauses', () => {
  it('DROP COLUMN', () =>
    expectClass('ALTER TABLE foo DROP COLUMN bar;', 'destructive', 'drop-column'));
  it('DROP COLUMN IF EXISTS', () =>
    expectClass('ALTER TABLE IF EXISTS public.foo DROP COLUMN IF EXISTS bar;', 'destructive', 'drop-column'));
  it('DROP CONSTRAINT', () =>
    expectClass('ALTER TABLE foo DROP CONSTRAINT foo_pkey;', 'destructive', 'drop-constraint'));
  it('ALTER COLUMN TYPE', () =>
    expectClass('ALTER TABLE foo ALTER COLUMN bar TYPE bigint;', 'destructive', 'alter-column-type'));
  it('ALTER COLUMN SET DATA TYPE', () =>
    expectClass('ALTER TABLE foo ALTER COLUMN bar SET DATA TYPE text;', 'destructive', 'alter-column-type'));
  it('ALTER COLUMN DROP NOT NULL', () =>
    expectClass('ALTER TABLE foo ALTER COLUMN bar DROP NOT NULL;', 'destructive', 'alter-column-drop-not-null'));
  it('ALTER COLUMN SET NOT NULL', () =>
    expectClass('ALTER TABLE foo ALTER COLUMN bar SET NOT NULL;', 'destructive', 'alter-column-set-not-null'));
  it('ALTER COLUMN DROP DEFAULT', () =>
    expectClass('ALTER TABLE foo ALTER COLUMN bar DROP DEFAULT;', 'destructive', 'alter-column-drop-default'));
  it('RENAME COLUMN', () =>
    expectClass('ALTER TABLE foo RENAME COLUMN bar TO baz;', 'destructive', 'rename-column'));
  it('RENAME COLUMN (implicit)', () =>
    expectClass('ALTER TABLE foo RENAME bar TO baz;', 'destructive', 'rename-column'));
  it('RENAME CONSTRAINT', () =>
    expectClass('ALTER TABLE foo RENAME CONSTRAINT old_name TO new_name;', 'destructive', 'rename-constraint'));
  it('SET SCHEMA', () =>
    expectClass('ALTER TABLE foo SET SCHEMA other;', 'destructive', 'set-schema'));
});

describe('classify — additive rules', () => {
  it('CREATE TABLE', () => expectClass('CREATE TABLE foo (id int);', 'additive', 'create-table'));
  it('CREATE TABLE IF NOT EXISTS', () =>
    expectClass('CREATE TABLE IF NOT EXISTS foo (id int);', 'additive', 'create-table'));
  it('CREATE INDEX CONCURRENTLY', () =>
    expectClass('CREATE INDEX CONCURRENTLY idx ON t(c);', 'additive', 'create-index-concurrently'));
  it('CREATE INDEX CONCURRENTLY IF NOT EXISTS', () =>
    expectClass('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON t(c);', 'additive', 'create-index-concurrently'));
  it('CREATE VIEW', () => expectClass('CREATE VIEW v AS SELECT 1;', 'additive', 'create-view'));
  it('CREATE MATERIALIZED VIEW', () =>
    expectClass('CREATE MATERIALIZED VIEW mv AS SELECT 1;', 'additive', 'create-materialized-view'));
  it('CREATE FUNCTION', () =>
    expectClass(`CREATE FUNCTION fn() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;`, 'additive', 'create-function'));
  it('CREATE PROCEDURE', () =>
    expectClass(`CREATE PROCEDURE p() AS $$ BEGIN END $$ LANGUAGE plpgsql;`, 'additive', 'create-procedure'));
  it('CREATE SCHEMA', () => expectClass('CREATE SCHEMA s;', 'additive', 'create-schema'));
  it('CREATE EXTENSION', () => expectClass('CREATE EXTENSION pgcrypto;', 'additive', 'create-extension'));
  it('CREATE TYPE', () => expectClass('CREATE TYPE x AS ENUM (\'a\', \'b\');', 'additive', 'create-type'));
  it('CREATE SEQUENCE', () => expectClass('CREATE SEQUENCE s;', 'additive', 'create-sequence'));
  it('CREATE DOMAIN', () => expectClass('CREATE DOMAIN d AS int;', 'additive', 'create-domain'));
  it('COMMENT ON', () => expectClass("COMMENT ON TABLE foo IS 'note';", 'additive', 'comment-on'));
});

describe('classify — ambiguous rules', () => {
  it('CREATE INDEX (non-concurrent)', () =>
    expectClass('CREATE INDEX idx ON t(c);', 'ambiguous', 'create-index-nonconcurrent'));
  it('CREATE UNIQUE INDEX CONCURRENTLY', () =>
    expectClass('CREATE UNIQUE INDEX CONCURRENTLY idx ON t(c);', 'ambiguous', 'create-unique-index-concurrent'));
  it('CREATE POLICY (permissive)', () =>
    expectClass("CREATE POLICY p ON t FOR SELECT USING (true);", 'ambiguous', 'create-policy'));
  it('CREATE POLICY (restrictive)', () =>
    expectClass("CREATE POLICY p ON t AS RESTRICTIVE FOR SELECT USING (true);", 'ambiguous', 'create-policy-restrictive'));
  it('ALTER POLICY', () =>
    expectClass("ALTER POLICY p ON t USING (true);", 'ambiguous', 'alter-policy'));
  it('CREATE TRIGGER', () =>
    expectClass('CREATE TRIGGER tg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION fn();', 'ambiguous', 'create-trigger'));
  it('CREATE OR REPLACE FUNCTION', () =>
    expectClass(`CREATE OR REPLACE FUNCTION fn() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;`, 'ambiguous', 'create-or-replace-function'));
  it('CREATE OR REPLACE VIEW', () =>
    expectClass('CREATE OR REPLACE VIEW v AS SELECT 1;', 'ambiguous', 'create-or-replace-view'));
  it('CREATE OR REPLACE PROCEDURE', () =>
    expectClass(`CREATE OR REPLACE PROCEDURE p() AS $$ BEGIN END $$ LANGUAGE plpgsql;`, 'ambiguous', 'create-or-replace-procedure'));
  it('GRANT', () => expectClass('GRANT SELECT ON t TO authenticated;', 'ambiguous', 'grant'));
  it('REVOKE', () => expectClass('REVOKE SELECT ON t FROM authenticated;', 'ambiguous', 'revoke'));
  it('ALTER TYPE', () => expectClass("ALTER TYPE x ADD VALUE 'c';", 'ambiguous', 'alter-type'));
  it('ALTER TABLE ENABLE RLS', () =>
    expectClass('ALTER TABLE t ENABLE ROW LEVEL SECURITY;', 'ambiguous', 'enable-rls-clause'));
  it('ADD CONSTRAINT (validated)', () =>
    expectClass('ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);', 'ambiguous', 'add-constraint'));
  it('VALIDATE CONSTRAINT', () =>
    expectClass('ALTER TABLE t VALIDATE CONSTRAINT c;', 'ambiguous', 'validate-constraint'));
});

describe('classify — additive ALTER TABLE clauses', () => {
  it('ADD COLUMN nullable', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar int;', 'additive', 'add-column-nullable'));
  it('ADD COLUMN with literal default', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar int DEFAULT 0;', 'additive', 'add-column-nullable'));
  it('ADD COLUMN NOT NULL with literal default', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar int NOT NULL DEFAULT 0;', 'additive', 'add-column-not-null-literal-default'));
  it('ADD COLUMN NOT NULL with string literal default', () =>
    expectClass("ALTER TABLE foo ADD COLUMN bar text NOT NULL DEFAULT 'x';", 'additive', 'add-column-not-null-literal-default'));
  it('ADD COLUMN GENERATED STORED', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar int GENERATED ALWAYS AS (baz + 1) STORED;', 'additive', 'add-column-generated-stored'));
  it('ADD CONSTRAINT NOT VALID', () =>
    expectClass('ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0) NOT VALID;', 'additive', 'add-constraint-not-valid'));
  it('ATTACH PARTITION', () =>
    expectClass('ALTER TABLE t ATTACH PARTITION t_p FOR VALUES IN (1);', 'additive', 'attach-partition'));
});

describe('classify — ADD COLUMN NOT NULL matrix', () => {
  it('NOT NULL no DEFAULT → ambiguous', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar int NOT NULL;', 'ambiguous', 'add-column-not-null-no-default'));
  it('NOT NULL DEFAULT now() → ambiguous (volatile)', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar timestamptz NOT NULL DEFAULT now();', 'ambiguous', 'add-column-not-null-volatile-default'));
  it('NOT NULL DEFAULT gen_random_uuid() → ambiguous (volatile)', () =>
    expectClass('ALTER TABLE foo ADD COLUMN bar uuid NOT NULL DEFAULT gen_random_uuid();', 'ambiguous', 'add-column-not-null-volatile-default'));
});

describe('classify — multi-clause ALTER TABLE', () => {
  it('ADD COLUMN, DROP COLUMN → destructive (drop wins)', () => {
    const r = classify('ALTER TABLE foo ADD COLUMN x int, DROP COLUMN y;');
    assert.equal(r.classification, 'destructive');
    assert.equal(r.statements[0]!.rule, 'drop-column');
  });
  it('ADD COLUMN, ADD COLUMN → additive', () =>
    expectClass('ALTER TABLE foo ADD COLUMN x int, ADD COLUMN y text;', 'additive'));
  it('SET NOT NULL, ADD COLUMN → destructive', () =>
    expectClass('ALTER TABLE foo ALTER COLUMN x SET NOT NULL, ADD COLUMN y int;', 'destructive', 'alter-column-set-not-null'));
  it('numeric(10,2) is NOT split as a comma-clause', () =>
    expectClass('ALTER TABLE foo ADD COLUMN x numeric(10,2);', 'additive', 'add-column-nullable'));
});

describe('classify — file reduce + mixed statements', () => {
  it('one additive + one destructive → file destructive', () => {
    const r = classify('CREATE TABLE foo (id int); DROP TABLE bar;');
    assert.equal(r.classification, 'destructive');
    assert.equal(r.statements.length, 2);
  });
  it('all additive → file additive', () => {
    const r = classify('CREATE TABLE foo (id int); CREATE INDEX CONCURRENTLY i ON foo(id);');
    assert.equal(r.classification, 'additive');
  });
  it('additive + ambiguous → file ambiguous', () => {
    const r = classify('CREATE TABLE foo (id int); GRANT SELECT ON foo TO web;');
    assert.equal(r.classification, 'ambiguous');
  });
  it('empty file → additive (no statements)', () => {
    assert.equal(classify('').classification, 'additive');
  });
  it('only-comments file → additive', () => {
    assert.equal(classify('-- hello\n/* world */').classification, 'additive');
  });
});

describe('classify — lexer correctness (comments + strings)', () => {
  it('DROP TABLE inside line comment is ignored', () =>
    expectClass("-- DROP TABLE foo\nCREATE TABLE bar (id int);", 'additive', 'create-table'));
  it('DROP TABLE inside block comment is ignored', () =>
    expectClass("/* DROP TABLE foo */ CREATE TABLE bar (id int);", 'additive', 'create-table'));
  it('DROP TABLE inside string literal is ignored', () => {
    const r = classify("INSERT INTO logs (msg) VALUES ('DROP TABLE foo');");
    // INSERT is not classified; falls through to unknown-statement (ambiguous).
    assert.equal(r.classification, 'ambiguous');
    assert.equal(r.statements[0]!.rule, 'unknown-statement');
  });
  it('DROP TABLE inside double-quoted identifier is ignored (as a name)', () => {
    const r = classify('CREATE TABLE "DROP TABLE foo" (id int);');
    assert.equal(r.classification, 'additive');
  });
  it('DROP TABLE inside dollar-quoted function body is opaque', () =>
    expectClass(
      `CREATE FUNCTION fn() RETURNS int AS $$ BEGIN /* -- ; */ DROP TABLE foo; RETURN 1; END $$ LANGUAGE plpgsql;`,
      'additive',
      'create-function',
    ));
  it('-- inside a string does not start a comment', () => {
    const r = classify("CREATE TABLE x (url text DEFAULT 'http://foo'); DROP TABLE bar;");
    assert.equal(r.classification, 'destructive');
    assert.equal(r.statements.length, 2);
  });
  it('; inside parens does not split statements', () => {
    const r = classify('CREATE FUNCTION fn(a int, b int) RETURNS int AS $$ SELECT a + b $$ LANGUAGE sql;');
    assert.equal(r.statements.length, 1);
  });
});

describe('classify — adversarial lexer cases', () => {
  it('unterminated /* … sets lexerComplete=false and forces ambiguous', () => {
    const r = classify('/* never closed CREATE TABLE foo (id int);');
    assert.equal(r.lexerComplete, false);
    assert.equal(r.classification, 'ambiguous');
    assert.ok(r.parseWarnings.length > 0);
  });
  it('unterminated string sets lexerComplete=false', () => {
    const r = classify("CREATE TABLE foo (s text DEFAULT 'never closed");
    assert.equal(r.lexerComplete, false);
  });
});

describe('classify — identifiers', () => {
  it('schema-qualified table name', () =>
    expectClass('DROP TABLE public.widgets;', 'destructive', 'drop-table'));
  it('double-quoted identifier', () =>
    expectClass('DROP TABLE "weird name";', 'destructive', 'drop-table'));
  it('schema-qualified double-quoted', () =>
    expectClass('DROP TABLE "sch ema"."table name";', 'destructive', 'drop-table'));
  it('IF EXISTS + ONLY + schema-qualified DROP COLUMN', () =>
    expectClass(
      'ALTER TABLE IF EXISTS public.foo DROP COLUMN IF EXISTS bar;',
      'destructive',
      'drop-column',
    ));
});

describe('classify — annotation: bypass', () => {
  it('valid bypass with incident=', () => {
    const sql =
      "-- @autopilot: classify=destructive_allowed_reason=incident=1234 hotfix for deprecated field\n" +
      'ALTER TABLE foo DROP COLUMN bar;';
    const r = classify(sql);
    assert.equal(r.classification, 'destructive');
    assert.equal(r.bypassed, true);
    assert.ok(r.bypassReason && r.bypassReason.includes('incident=1234'));
  });
  it('valid bypass with PR=', () => {
    const sql =
      "-- @autopilot: classify=destructive_allowed_reason=PR=456 ship the cleanup\n" +
      'DROP TABLE old;';
    const r = classify(sql);
    assert.equal(r.bypassed, true);
  });
  it('bypass without trace token is rejected', () => {
    const sql =
      "-- @autopilot: classify=destructive_allowed_reason=hotfix needed now\n" +
      'DROP TABLE old;';
    const r = classify(sql);
    assert.equal(r.classification, 'destructive');
    assert.equal(r.bypassed, false);
  });
  it('bypass under 10 chars is rejected', () => {
    const sql =
      "-- @autopilot: classify=destructive_allowed_reason=PR=1\n" +
      'DROP TABLE old;';
    const r = classify(sql);
    assert.equal(r.bypassed, false);
  });
});

describe('classify — annotation: ambiguous pinning', () => {
  it('classify=additive pins ambiguous to additive', () => {
    const sql = '-- @autopilot: classify=additive\nGRANT SELECT ON t TO authenticated;';
    const r = classify(sql);
    assert.equal(r.classification, 'ambiguous');
    assert.equal(r.pinned, true);
    assert.equal(r.pinnedAs, 'additive');
  });
  it('classify=expand pins ambiguous to expand', () => {
    const sql = '-- @autopilot: classify=expand\nCREATE INDEX idx ON t(c);';
    const r = classify(sql);
    assert.equal(r.pinnedAs, 'expand');
  });
  it('classify=destructive pins ambiguous to destructive', () => {
    const sql = '-- @autopilot: classify=destructive\nGRANT SELECT ON t TO authenticated;';
    const r = classify(sql);
    assert.equal(r.pinnedAs, 'destructive');
  });
  it('classify=contract pins ambiguous to contract', () => {
    const sql = '-- @autopilot: classify=contract\nGRANT SELECT ON t TO authenticated;';
    const r = classify(sql);
    assert.equal(r.pinnedAs, 'contract');
  });
  it('classify=contract also pins DESTRUCTIVE files (Phase 4 sanctioned path)', () => {
    const sql =
      '-- @autopilot: classify=contract\n' +
      '-- @autopilot: contract_after=2026-06-15\n' +
      '-- @autopilot: contract_reason=Removing widgets.kind after v8.5.0 cutover\n' +
      'ALTER TABLE widgets DROP COLUMN kind;';
    const r = classify(sql);
    assert.equal(r.classification, 'destructive', 'file reduce stays destructive (truthful)');
    assert.equal(r.pinned, true);
    assert.equal(r.pinnedAs, 'contract');
    assert.equal(r.annotation?.contractAfter, '2026-06-15');
    assert.ok(r.annotation?.contractReason && r.annotation.contractReason.length > 0);
  });
  it('typo classify=destrcutive is ignored', () => {
    const sql = '-- @autopilot: classify=destrcutive\nGRANT SELECT ON t TO authenticated;';
    const r = classify(sql);
    assert.equal(r.classification, 'ambiguous');
    assert.equal(r.pinned, false);
  });
});

describe('classify — annotation cannot downgrade detected severity', () => {
  it('classify=additive on a DESTRUCTIVE file does NOT pin (file stays destructive)', () => {
    const sql = '-- @autopilot: classify=additive\nDROP TABLE foo;';
    const r = classify(sql);
    assert.equal(r.classification, 'destructive', 'file stays destructive');
    assert.equal(r.pinned, false, 'pin is refused on destructive files');
    assert.equal(r.pinnedAs, null);
    assert.equal(r.bypassed, false);
  });
  it('classify=expand on a DESTRUCTIVE file does NOT pin', () => {
    const sql = '-- @autopilot: classify=expand\nDROP TABLE foo;';
    const r = classify(sql);
    assert.equal(r.classification, 'destructive');
    assert.equal(r.pinned, false);
  });
  it('valid bypass on an additive file is recorded but does not change anything', () => {
    // Pathological case — operator pasted a bypass annotation on a benign file.
    // Should be a no-op: file is already additive.
    const sql =
      '-- @autopilot: classify=destructive_allowed_reason=incident=999 just docs\n' +
      'CREATE TABLE foo (id int);';
    const r = classify(sql);
    assert.equal(r.classification, 'additive');
    // bypassed mirrors the annotation (truthful); CLI exit code is still 0.
    assert.equal(r.bypassed, true);
  });
});

describe('classify — lexer-incomplete files refuse bypass and pinning', () => {
  it('unterminated comment forces ambiguous regardless of annotation', () => {
    const sql = '-- @autopilot: classify=additive\n/* never closed\nDROP TABLE foo;';
    const r = classify(sql);
    assert.equal(r.lexerComplete, false);
    assert.equal(r.classification, 'ambiguous', 'forced to ambiguous');
    assert.equal(r.pinned, false, 'pinning refused on lexer-incomplete file');
    assert.equal(r.bypassed, false, 'bypass refused on lexer-incomplete file');
  });
  // Table-driven assertion that EVERY annotation path is refused when
  // lexer is incomplete — regression guard for a future maintainer who
  // might accidentally allow classify=contract or classify=destructive
  // to set `pinned` (the previous patch comment mentioned both).
  const annotationsThatMustNotBypass = [
    'classify=additive',
    'classify=expand',
    'classify=destructive',
    'classify=contract',
    'classify=destructive_allowed_reason=incident=1234 attempt to sneak through',
  ];
  for (const ann of annotationsThatMustNotBypass) {
    it(`unterminated comment + "${ann}" is refused`, () => {
      const sql = `-- @autopilot: ${ann}\n/* never closed\nDROP TABLE foo;`;
      const r = classify(sql);
      assert.equal(r.lexerComplete, false, 'lexer is incomplete');
      assert.equal(r.classification, 'ambiguous', 'classification forced to ambiguous');
      assert.equal(r.pinned, false, 'pinning refused');
      assert.equal(r.pinnedAs, null);
      assert.equal(r.bypassed, false, 'bypass refused');
      assert.equal(r.bypassReason, null);
    });
  }

  it('unterminated string + bypass annotation does not pass', () => {
    const sql =
      '-- @autopilot: classify=destructive_allowed_reason=incident=1234 sneak attempt\n' +
      "CREATE TABLE foo (x text DEFAULT 'never closed";
    const r = classify(sql);
    assert.equal(r.lexerComplete, false);
    assert.equal(r.bypassed, false, 'bypass refused on lexer-incomplete file');
    // The classification MUST stay blocking — the whole point of the
    // lexer-incomplete short-circuit is that a malformed file can't sneak
    // through as additive via an annotation. CLI exit code maps non-pinned
    // ambiguous to 2 (needs annotation) — that's the contract Step 4.5
    // relies on.
    assert.equal(r.classification, 'ambiguous', 'classification stays ambiguous');
    assert.equal(r.pinned, false);
  });
});

describe('classify — RLS edge cases', () => {
  it('CREATE POLICY permissive → ambiguous', () =>
    expectClass(
      'CREATE POLICY p ON t FOR SELECT USING (true);',
      'ambiguous',
      'create-policy',
    ));
  it('CREATE POLICY restrictive → ambiguous', () =>
    expectClass(
      'CREATE POLICY p ON t AS RESTRICTIVE FOR SELECT USING (true);',
      'ambiguous',
      'create-policy-restrictive',
    ));
  it('ENABLE RLS → ambiguous', () =>
    expectClass(
      'ALTER TABLE t ENABLE ROW LEVEL SECURITY;',
      'ambiguous',
      'enable-rls-clause',
    ));
  it('DISABLE RLS → destructive', () =>
    expectClass(
      'ALTER TABLE t DISABLE ROW LEVEL SECURITY;',
      'destructive',
      'disable-rls',
    ));
  it('GRANT → ambiguous', () =>
    expectClass(
      'GRANT SELECT ON t TO authenticated;',
      'ambiguous',
      'grant',
    ));
  it('REVOKE → ambiguous', () =>
    expectClass(
      'REVOKE SELECT ON t FROM authenticated;',
      'ambiguous',
      'revoke',
    ));
});
