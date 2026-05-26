// src/core/migrate/classify.ts
//
// Migration safety classifier — Phase 1 of issue #179.
//
// Classifies a single SQL migration file as `additive`, `destructive`, or
// `ambiguous`. The autopilot Step 4.5 hook (and, in Phase 2, the dispatcher
// pre-flight) consume this result to gate the expand/contract rolling-deploy
// safety pattern.
//
// Design: hand-rolled single-pass lexer + per-statement pattern rules.
// Conservative-by-default — anything we can't classify into `additive`
// falls through to `ambiguous`, which the policy treats as "needs human
// review." See spec at
// docs/superpowers/specs/2026-05-26-issue-179-migration-classifier-design.md.

/** Severity of a single SQL statement (file-level reduces to the max). */
export type StatementClass = 'additive' | 'destructive' | 'ambiguous';

/** Recognised annotation `classify=` labels for ambiguous-pinning / contract. */
export type PinnedAs =
  | 'additive'
  | 'destructive'
  | 'expand'
  | 'contract'
  | null;

export interface StatementClassification {
  /** Trimmed SQL of the statement (no trailing semicolon). */
  sql: string;
  /** 1-based line number of the first non-whitespace token. */
  startLine: number;
  classification: StatementClass;
  rule: string;
  reason: string;
}

export interface FileAnnotation {
  /** Raw value of the `classify=` annotation, if present. */
  classify?: string;
  /** Free-form text following `classify=destructive_allowed_reason=`. */
  destructiveAllowedReason?: string;
  /** Parsed value of `-- @autopilot: contract_after=YYYY-MM-DD`. */
  contractAfter?: string;
  /** Free-form text from `-- @autopilot: contract_reason=...`. */
  contractReason?: string;
}

export interface ClassificationResult {
  classification: StatementClass;
  statements: StatementClassification[];
  annotation: FileAnnotation | null;
  /** True if an `ambiguous`/`destructive` file has a recognised `classify=…` pin. */
  pinned: boolean;
  pinnedAs: PinnedAs;
  /** True if a destructive file has a valid `destructive_allowed_reason`. */
  bypassed: boolean;
  bypassReason: string | null;
  /** Lexer/parser diagnostics (unterminated comments/strings). */
  parseWarnings: string[];
  /** False when any parseWarning forced a best-effort split. */
  lexerComplete: boolean;
}

// ----------------------------------------------------------------------------
// Lexer — single-pass, state-machine. Emits tokens with offsets and lines.
// Used for two things: (1) statement splitting on top-level `;`,
// (2) extracting the leading-comment annotation block before any DDL.
// ----------------------------------------------------------------------------

interface LexToken {
  /** Token category. */
  kind:
    | 'word'           // bare keyword/identifier run in default state
    | 'punct'          // single-char punctuation in default state
    | 'string'         // single-quoted string literal (incl. E'…')
    | 'ident-quoted'   // double-quoted identifier
    | 'dollar-string'  // dollar-quoted body (opaque)
    | 'line-comment'   // -- to \n
    | 'block-comment'  // /* … */
    | 'whitespace';
  /** Raw source text for this token. */
  text: string;
  /** 0-based byte offset into the source. */
  offset: number;
  /** 1-based line number of the start of the token. */
  line: number;
}

interface LexResult {
  tokens: LexToken[];
  warnings: string[];
  complete: boolean;
}

function lex(sql: string): LexResult {
  const tokens: LexToken[] = [];
  const warnings: string[] = [];
  let i = 0;
  let line = 1;
  const n = sql.length;

  const peek = (k: number = 0): string => (i + k < n ? sql[i + k]! : '');

  while (i < n) {
    const tokStart = i;
    const tokLine = line;
    const ch = sql[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      let s = '';
      while (i < n) {
        const c = sql[i]!;
        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') break;
        if (c === '\n') line++;
        s += c;
        i++;
      }
      tokens.push({ kind: 'whitespace', text: s, offset: tokStart, line: tokLine });
      continue;
    }

    // Line comment
    if (ch === '-' && peek(1) === '-') {
      let s = '';
      while (i < n && sql[i] !== '\n') { s += sql[i]!; i++; }
      tokens.push({ kind: 'line-comment', text: s, offset: tokStart, line: tokLine });
      continue;
    }

    // Block comment (Postgres supports nesting)
    if (ch === '/' && peek(1) === '*') {
      let depth = 1;
      let s = '/*';
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '\n') line++;
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; s += '/*'; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; s += '*/'; i += 2; continue; }
        s += sql[i];
        i++;
      }
      if (depth > 0) warnings.push(`Unterminated /* block */ comment starting at line ${tokLine}`);
      tokens.push({ kind: 'block-comment', text: s, offset: tokStart, line: tokLine });
      continue;
    }

    // Dollar-quoted string: $tag$ … $tag$, tag is optional identifier
    if (ch === '$') {
      let tagEnd = i + 1;
      while (tagEnd < n && /[A-Za-z0-9_]/.test(sql[tagEnd]!)) tagEnd++;
      if (tagEnd < n && sql[tagEnd] === '$') {
        const tag = sql.slice(i, tagEnd + 1);
        let s = tag;
        i = tagEnd + 1;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          warnings.push(`Unterminated dollar-quoted body ${tag} starting at line ${tokLine}`);
          while (i < n) {
            if (sql[i] === '\n') line++;
            s += sql[i++];
          }
        } else {
          for (; i < closeIdx; i++) {
            if (sql[i] === '\n') line++;
            s += sql[i];
          }
          s += tag;
          i = closeIdx + tag.length;
        }
        tokens.push({ kind: 'dollar-string', text: s, offset: tokStart, line: tokLine });
        continue;
      }
    }

    // Single-quoted string, including E'…' (C-style escapes)
    if (ch === "'" || ((ch === 'E' || ch === 'e') && peek(1) === "'")) {
      let s = '';
      let escapeMode = false;
      if (ch === 'E' || ch === 'e') { s += sql[i]!; i++; escapeMode = true; }
      s += sql[i]!; i++;
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (c === '\n') line++;
        if (escapeMode && c === '\\' && i + 1 < n) {
          s += c + sql[i + 1]!;
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            s += "''";
            i += 2;
            continue;
          }
          s += c;
          i++;
          closed = true;
          break;
        }
        s += c;
        i++;
      }
      if (!closed) warnings.push(`Unterminated string literal starting at line ${tokLine}`);
      tokens.push({ kind: 'string', text: s, offset: tokStart, line: tokLine });
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      let s = '"';
      i++;
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (c === '\n') line++;
        if (c === '"') {
          if (sql[i + 1] === '"') { s += '""'; i += 2; continue; }
          s += '"'; i++; closed = true; break;
        }
        s += c; i++;
      }
      if (!closed) warnings.push(`Unterminated quoted identifier starting at line ${tokLine}`);
      tokens.push({ kind: 'ident-quoted', text: s, offset: tokStart, line: tokLine });
      continue;
    }

    // Word: identifier or keyword
    if (/[A-Za-z_]/.test(ch)) {
      let s = '';
      while (i < n && /[A-Za-z0-9_.]/.test(sql[i]!)) { s += sql[i]!; i++; }
      tokens.push({ kind: 'word', text: s, offset: tokStart, line: tokLine });
      continue;
    }

    // Default: single-char punctuation
    tokens.push({ kind: 'punct', text: ch, offset: tokStart, line: tokLine });
    i++;
  }

  return { tokens, warnings, complete: warnings.length === 0 };
}

// ----------------------------------------------------------------------------
// Statement splitter
// ----------------------------------------------------------------------------

interface SplitStatement {
  raw: string;
  normalized: string;
  startLine: number;
}

function splitStatements(lexResult: LexResult): SplitStatement[] {
  const out: SplitStatement[] = [];
  let raw = '';
  let normalized = '';
  let startLine = 0;
  let parenDepth = 0;
  let hasContent = false;

  const flush = () => {
    const trimmed = raw.trim();
    const normalizedTrimmed = normalizeWhitespace(normalized.trim());
    if (trimmed.length === 0 || normalizedTrimmed.length === 0) {
      // Pure whitespace OR pure comments — not a statement.
      raw = '';
      normalized = '';
      hasContent = false;
      return;
    }
    out.push({
      raw: trimmed,
      normalized: normalizedTrimmed,
      startLine: startLine || 1,
    });
    raw = '';
    normalized = '';
    hasContent = false;
  };

  for (const tok of lexResult.tokens) {
    if (!hasContent && tok.kind !== 'whitespace' && tok.kind !== 'line-comment' && tok.kind !== 'block-comment') {
      startLine = tok.line;
      hasContent = true;
    }
    if (tok.kind === 'punct') {
      if (tok.text === '(') parenDepth++;
      else if (tok.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (tok.text === ';' && parenDepth === 0) {
        flush();
        continue;
      }
    }
    raw += tok.text;
    if (tok.kind === 'whitespace') {
      normalized += ' ';
    } else if (tok.kind === 'line-comment' || tok.kind === 'block-comment') {
      // skip
    } else {
      normalized += tok.text;
    }
  }
  flush();
  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// Annotation extraction
// ----------------------------------------------------------------------------

function extractAnnotation(lexResult: LexResult): FileAnnotation | null {
  const ann: FileAnnotation = {};
  let found = false;
  for (const tok of lexResult.tokens) {
    if (tok.kind === 'whitespace' || tok.kind === 'line-comment') {
      if (tok.kind === 'line-comment') {
        const m = /^--\s*@autopilot\s*:\s*([A-Za-z_]+)\s*=\s*(.*)$/i.exec(tok.text);
        if (m) {
          const key = m[1]!.toLowerCase();
          const value = m[2]!.trim();
          if (key === 'classify') {
            ann.classify = value;
            if (value.toLowerCase().startsWith('destructive_allowed_reason=')) {
              ann.destructiveAllowedReason = value.slice('destructive_allowed_reason='.length).trim();
            }
            found = true;
          } else if (key === 'contract_after') {
            ann.contractAfter = value;
            found = true;
          } else if (key === 'contract_reason') {
            ann.contractReason = value;
            found = true;
          }
        }
      }
      continue;
    }
    break;
  }
  return found ? ann : null;
}

// ----------------------------------------------------------------------------
// Rule matchers
// ----------------------------------------------------------------------------

interface RuleHit {
  classification: StatementClass;
  rule: string;
  reason: string;
}

function stripOptionalTargetModifiers(s: string): string {
  return s
    .replace(/^\s*IF\s+NOT\s+EXISTS\s+/i, '')
    .replace(/^\s*IF\s+EXISTS\s+/i, '')
    .replace(/^\s*ONLY\s+/i, '');
}

const IDENT_REGEX_SRC = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?';

const IMMUTABLE_LITERAL_REGEX =
  /^(NULL|TRUE|FALSE|-?[0-9]+(\.[0-9]+)?|'[^']*'|E'[^']*')$/i;

function classifyStatement(stmt: SplitStatement): RuleHit {
  const text = stmt.normalized;

  if (/^ALTER\s+TABLE\b/i.test(text)) {
    return classifyAlterTable(text);
  }

  if (/^DROP\s+TABLE\b/i.test(text)) return d('drop-table', 'DROP TABLE removes a table and all its data');
  if (/^DROP\s+INDEX\b/i.test(text)) return d('drop-index', 'DROP INDEX removes a query-acceleration structure');
  if (/^DROP\s+MATERIALIZED\s+VIEW\b/i.test(text)) return d('drop-materialized-view', 'DROP MATERIALIZED VIEW removes a cached query result');
  if (/^DROP\s+VIEW\b/i.test(text)) return d('drop-view', 'DROP VIEW removes a queryable view');
  if (/^DROP\s+FUNCTION\b/i.test(text)) return d('drop-function', 'DROP FUNCTION removes a callable function');
  if (/^DROP\s+PROCEDURE\b/i.test(text)) return d('drop-procedure', 'DROP PROCEDURE removes a callable procedure');
  if (/^DROP\s+POLICY\b/i.test(text)) return d('drop-policy', 'DROP POLICY removes an RLS policy; could expose or deny existing traffic');
  if (/^DROP\s+TRIGGER\b/i.test(text)) return d('drop-trigger', 'DROP TRIGGER removes a row-level hook');
  if (/^DROP\s+SCHEMA\b/i.test(text)) return d('drop-schema', 'DROP SCHEMA removes an entire namespace');
  if (/^DROP\s+TYPE\b/i.test(text)) return d('drop-type', 'DROP TYPE removes a user-defined type');
  if (/^DROP\s+SEQUENCE\b/i.test(text)) return d('drop-sequence', 'DROP SEQUENCE removes an ID generator');
  if (/^DROP\s+EXTENSION\b/i.test(text)) return d('drop-extension', 'DROP EXTENSION removes a Postgres extension and its objects');
  if (/^DROP\s+DOMAIN\b/i.test(text)) return d('drop-domain', 'DROP DOMAIN removes a constrained type');

  if (/^TRUNCATE\b/i.test(text)) return d('truncate', 'TRUNCATE deletes all rows in a table');
  if (/^DELETE\s+FROM\b/i.test(text)) return d('delete-from', 'DELETE FROM in a migration is data-destructive (DML in DDL)');

  // CREATE INDEX — ordered grammar:
  //   CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ...
  const createIndexMatch = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?/i.exec(text);
  if (createIndexMatch) {
    const isUnique = !!createIndexMatch[1];
    const isConcurrent = !!createIndexMatch[2];
    if (isUnique && isConcurrent) {
      return amb('create-unique-index-concurrent', 'Concurrent unique index can fail if duplicates exist; needs manual VALIDATE');
    }
    if (isUnique && !isConcurrent) {
      return d('create-unique-index', 'Non-concurrent CREATE UNIQUE INDEX takes a write lock and can fail on duplicates');
    }
    if (!isUnique && isConcurrent) {
      return a('create-index-concurrently', 'CREATE INDEX CONCURRENTLY is safe for live traffic');
    }
    return amb('create-index-nonconcurrent', 'Non-concurrent CREATE INDEX holds a write lock; long on large tables');
  }

  if (/^CREATE\s+OR\s+REPLACE\s+FUNCTION\b/i.test(text)) {
    return amb('create-or-replace-function', 'CREATE OR REPLACE FUNCTION can change behaviour relied on by old code, triggers, or policies');
  }
  if (/^CREATE\s+OR\s+REPLACE\s+PROCEDURE\b/i.test(text)) {
    return amb('create-or-replace-procedure', 'CREATE OR REPLACE PROCEDURE can change behaviour relied on by old callers');
  }
  if (/^CREATE\s+OR\s+REPLACE\s+VIEW\b/i.test(text)) {
    return amb('create-or-replace-view', 'CREATE OR REPLACE VIEW can change result shape; existing readers may break');
  }

  if (/^CREATE\s+POLICY\b/i.test(text)) {
    if (/\bAS\s+RESTRICTIVE\b/i.test(text)) {
      return amb('create-policy-restrictive', 'RESTRICTIVE policies AND with existing rules; can reduce access for live traffic');
    }
    return amb('create-policy', 'CREATE POLICY changes RLS semantics; requires human review in an RLS-on-all-tables stack');
  }

  if (/^ALTER\s+POLICY\b/i.test(text)) {
    return amb('alter-policy', 'ALTER POLICY can change tenancy semantics (USING / WITH CHECK)');
  }

  if (/^CREATE\s+TRIGGER\b/i.test(text)) {
    return amb('create-trigger', 'CREATE TRIGGER changes write behaviour for live traffic instantly');
  }

  if (/^GRANT\b/i.test(text)) {
    return amb('grant', 'GRANT broadens access; in an RLS-on-all-tables stack a misissued grant can leak data');
  }
  if (/^REVOKE\b/i.test(text)) {
    return amb('revoke', 'REVOKE removes existing permission; could deny live traffic');
  }
  if (/^ALTER\s+TYPE\b/i.test(text)) {
    return amb('alter-type', 'ALTER TYPE (add/rename enum value, etc.) can break old readers depending on the change');
  }

  if (/^CREATE\s+TABLE\b/i.test(text)) return a('create-table', 'CREATE TABLE adds a new table');
  if (/^CREATE\s+MATERIALIZED\s+VIEW\b/i.test(text)) return a('create-materialized-view', 'CREATE MATERIALIZED VIEW adds a cached query result');
  if (/^CREATE\s+VIEW\b/i.test(text)) return a('create-view', 'CREATE VIEW adds a queryable view');
  if (/^CREATE\s+FUNCTION\b/i.test(text)) return a('create-function', 'CREATE FUNCTION adds a callable function');
  if (/^CREATE\s+PROCEDURE\b/i.test(text)) return a('create-procedure', 'CREATE PROCEDURE adds a callable procedure');
  if (/^CREATE\s+SCHEMA\b/i.test(text)) return a('create-schema', 'CREATE SCHEMA adds a namespace');
  if (/^CREATE\s+EXTENSION\b/i.test(text)) return a('create-extension', 'CREATE EXTENSION adds a Postgres extension');
  if (/^CREATE\s+TYPE\b/i.test(text)) return a('create-type', 'CREATE TYPE adds a user-defined type');
  if (/^CREATE\s+SEQUENCE\b/i.test(text)) return a('create-sequence', 'CREATE SEQUENCE adds an ID generator');
  if (/^CREATE\s+DOMAIN\b/i.test(text)) return a('create-domain', 'CREATE DOMAIN adds a constrained type');

  if (/^COMMENT\s+ON\b/i.test(text)) return a('comment-on', 'COMMENT ON sets metadata only');

  return amb('unknown-statement', 'Unrecognised DDL — classify=additive or destructive annotation required to proceed');
}

function d(rule: string, reason: string): RuleHit {
  return { classification: 'destructive', rule, reason };
}
function a(rule: string, reason: string): RuleHit {
  return { classification: 'additive', rule, reason };
}
function amb(rule: string, reason: string): RuleHit {
  return { classification: 'ambiguous', rule, reason };
}

// ALTER TABLE pipeline ----------------------------------------------------

function classifyAlterTable(text: string): RuleHit {
  const prefixRe = new RegExp(
    `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT_REGEX_SRC}\\s*`,
    'i',
  );
  const m = prefixRe.exec(text);
  if (!m) {
    return amb('alter-table-unrecognized', 'ALTER TABLE form not recognised');
  }
  const remainder = text.slice(m[0].length);

  if (/^RENAME\s+TO\b/i.test(remainder)) {
    return d('alter-table-rename-to', 'RENAME TABLE breaks all references to the old name');
  }

  // Single-clause whole-statement RLS toggles
  if (/^DISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(remainder)) {
    return d('disable-rls', 'DISABLE RLS exposes a previously-protected table — direct security regression in an RLS-by-default stack');
  }
  if (/^ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(remainder)) {
    return amb('enable-rls-clause', 'ENABLE RLS can deny live traffic if policies are incomplete');
  }
  if (/^FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(remainder)) {
    return amb('force-rls-clause', 'FORCE RLS changes RLS bypass behaviour for table owners');
  }

  const clauses = splitTopLevelCommas(remainder);
  let worst: StatementClass = 'additive';
  let worstHit: RuleHit | null = null;
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (clause.length === 0) continue;
    const hit = classifyAlterTableClause(clause);
    // Keep the FIRST hit at the worst severity (so reduce returns the
    // load-bearing clause, not the placeholder).
    if (worstHit === null || severity(hit.classification) > severity(worst)) {
      worst = hit.classification;
      worstHit = hit;
    }
  }
  if (worstHit === null) {
    return amb('alter-table-empty', 'ALTER TABLE with no recognised clauses');
  }
  return worstHit;
}

function classifyAlterTableClause(clause: string): RuleHit {
  const stripped = stripOptionalTargetModifiers(clause);

  if (/^DROP\s+COLUMN\b/i.test(stripped)) {
    return d('drop-column', 'DROP COLUMN removes a column from existing rows');
  }
  if (/^DROP\s+CONSTRAINT\b/i.test(stripped)) {
    return d('drop-constraint', 'DROP CONSTRAINT removes a check / FK / unique guarantee');
  }
  if (/^ALTER\s+COLUMN\s+\S.*\b(SET\s+DATA\s+)?TYPE\b/i.test(stripped)) {
    return d('alter-column-type', 'ALTER COLUMN ... TYPE changes the shape; old readers/writers will break');
  }
  if (/^ALTER\s+COLUMN\s+\S.*\bDROP\s+NOT\s+NULL\b/i.test(stripped)) {
    return d('alter-column-drop-not-null', 'DROP NOT NULL relaxes a guarantee old readers may rely on');
  }
  if (/^ALTER\s+COLUMN\s+\S.*\bSET\s+NOT\s+NULL\b/i.test(stripped)) {
    return d('alter-column-set-not-null', 'SET NOT NULL on a column with existing nulls aborts; old writers may also fail');
  }
  if (/^ALTER\s+COLUMN\s+\S.*\bDROP\s+DEFAULT\b/i.test(stripped)) {
    return d('alter-column-drop-default', 'DROP DEFAULT can break INSERTs relying on the default');
  }
  if (/^RENAME\s+CONSTRAINT\b/i.test(stripped)) {
    return d('rename-constraint', 'RENAME CONSTRAINT breaks references by name');
  }
  if (/^RENAME\s+(COLUMN\s+)?\S+\s+TO\s+/i.test(stripped)) {
    return d('rename-column', 'RENAME COLUMN breaks references to the old name');
  }
  if (/^SET\s+SCHEMA\b/i.test(stripped)) {
    return d('set-schema', 'SET SCHEMA moves the table to another namespace; old refs break');
  }
  if (/^DISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(stripped)) {
    return d('disable-rls', 'DISABLE RLS exposes a previously-protected table');
  }
  if (/^ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(stripped)) {
    return amb('enable-rls-clause', 'ENABLE RLS can deny live traffic if policies are incomplete');
  }
  if (/^FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(stripped)) {
    return amb('force-rls-clause', 'FORCE RLS changes RLS bypass behaviour for table owners');
  }

  if (/^ADD\s+COLUMN\b/i.test(stripped)) {
    return classifyAddColumnClause(stripped);
  }

  if (/^ADD\s+CONSTRAINT\b/i.test(stripped)) {
    if (/\bNOT\s+VALID\b/i.test(stripped)) {
      return a('add-constraint-not-valid', 'ADD CONSTRAINT NOT VALID skips validation; safe to add');
    }
    return amb('add-constraint', 'Validated ADD CONSTRAINT can fail on existing data and is lock-heavy; prefer NOT VALID + later VALIDATE');
  }
  if (/^VALIDATE\s+CONSTRAINT\b/i.test(stripped)) {
    return amb('validate-constraint', 'VALIDATE CONSTRAINT can be slow on large tables');
  }
  if (/^ATTACH\s+PARTITION\b/i.test(stripped)) {
    return a('attach-partition', 'ATTACH PARTITION is additive');
  }

  return amb('alter-table-unknown-clause', 'Unrecognised ALTER TABLE clause');
}

function classifyAddColumnClause(clause: string): RuleHit {
  const stripped = clause.replace(/^ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?/i, '');

  if (/\bGENERATED\s+ALWAYS\s+AS\b.*\bSTORED\b/i.test(stripped)) {
    return a('add-column-generated-stored', 'ADD COLUMN GENERATED ALWAYS … STORED is additive');
  }

  const hasNotNull = /\bNOT\s+NULL\b/i.test(stripped);
  if (!hasNotNull) {
    return a('add-column-nullable', 'ADD COLUMN (nullable) is additive');
  }

  const defaultMatch = /\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|REFERENCES|CHECK|GENERATED|COLLATE|UNIQUE|PRIMARY\s+KEY)\b|$)/i.exec(stripped);
  if (!defaultMatch) {
    return amb('add-column-not-null-no-default', 'ADD COLUMN NOT NULL without DEFAULT aborts on non-empty tables; requires backfill plan');
  }
  const defaultExpr = defaultMatch[1]!.trim();
  if (IMMUTABLE_LITERAL_REGEX.test(defaultExpr)) {
    return a('add-column-not-null-literal-default', 'ADD COLUMN NOT NULL with an immutable-literal DEFAULT is safe');
  }
  return amb('add-column-not-null-volatile-default', `ADD COLUMN NOT NULL with non-literal DEFAULT (${defaultExpr}) may rewrite the table or block writes`);
}

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inSingle) {
      buf += c;
      if (c === "'" && s[i + 1] !== "'") inSingle = false;
      else if (c === "'" && s[i + 1] === "'") { buf += "'"; i++; }
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; buf += c; continue; }
    if (c === '"') { inDouble = true; buf += c; continue; }
    if (c === '(') { depth++; buf += c; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); buf += c; continue; }
    if (c === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim().length > 0) parts.push(buf);
  return parts;
}

function severity(c: StatementClass): number {
  switch (c) {
    case 'additive': return 0;
    case 'ambiguous': return 1;
    case 'destructive': return 2;
  }
}

// ----------------------------------------------------------------------------
// Bypass validation
// ----------------------------------------------------------------------------

const BYPASS_MIN_LEN = 10;
const BYPASS_TOKEN_REGEX = /\b(incident|PR)\s*=\s*\S+/i;

function isValidBypass(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason.trim().length < BYPASS_MIN_LEN) return false;
  return BYPASS_TOKEN_REGEX.test(reason);
}

// ----------------------------------------------------------------------------
// Public entry point.
// ----------------------------------------------------------------------------

export function classify(sql: string): ClassificationResult {
  const lexResult = lex(sql);
  const annotation = extractAnnotation(lexResult);
  const stmts = splitStatements(lexResult);

  let fileClass: StatementClass = 'additive';
  const statements: StatementClassification[] = [];
  for (const s of stmts) {
    const hit = classifyStatement(s);
    statements.push({
      sql: s.raw,
      startLine: s.startLine,
      classification: hit.classification,
      rule: hit.rule,
      reason: hit.reason,
    });
    if (severity(hit.classification) > severity(fileClass)) {
      fileClass = hit.classification;
    }
  }

  if (!lexResult.complete && severity(fileClass) < severity('ambiguous')) {
    fileClass = 'ambiguous';
  }

  let pinned = false;
  let pinnedAs: PinnedAs = null;
  let bypassed = false;

  // Lexer-incomplete files cannot be safely bypassed or pinned — a
  // malformed migration could be hiding destructive tokens from the
  // pattern matcher behind an unterminated comment or string. Short-circuit
  // before annotation interpretation; ALL annotation effects
  // (additive/expand/destructive/contract pinning AND
  // destructive_allowed_reason bypass) are refused. The annotation field
  // itself is still returned so the operator can inspect it, but
  // pinned/bypassed are forced to false. File-level classification is
  // already ambiguous via the lexerComplete guard above, so the CLI exit
  // code stays in the "needs annotation" / "blocked" range.
  if (!lexResult.complete) {
    return {
      classification: fileClass,
      statements,
      annotation,
      pinned: false,
      pinnedAs: null,
      bypassed: false,
      bypassReason: null,
      parseWarnings: lexResult.warnings,
      lexerComplete: false,
    };
  }

  let bypassReason: string | null = null;

  if (annotation) {
    const cls = (annotation.classify ?? '').toLowerCase();
    if (cls.startsWith('destructive_allowed_reason=')) {
      if (isValidBypass(annotation.destructiveAllowedReason)) {
        bypassed = true;
        bypassReason = annotation.destructiveAllowedReason!.trim();
      }
    } else if (cls === 'additive' || cls === 'expand') {
      if (fileClass === 'ambiguous') {
        pinned = true;
        pinnedAs = cls as PinnedAs;
      }
    } else if (cls === 'destructive') {
      if (fileClass === 'ambiguous') {
        pinned = true;
        pinnedAs = 'destructive';
      }
    } else if (cls === 'contract') {
      if (fileClass === 'ambiguous' || fileClass === 'destructive') {
        pinned = true;
        pinnedAs = 'contract';
      }
    }
  }

  return {
    classification: fileClass,
    statements,
    annotation,
    pinned,
    pinnedAs,
    bypassed,
    bypassReason,
    parseWarnings: lexResult.warnings,
    lexerComplete: lexResult.complete,
  };
}
