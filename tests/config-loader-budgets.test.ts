// tests/config-loader-budgets.test.ts
//
// v8.1.1 — issue #210 acceptance tests. Two behaviors:
//
//   1. Schema validation: unknown `budgets.*` keys (e.g. case typos like
//      `perSubAgentUsd`) FAIL `loadConfig` with `code: invalid_config`.
//   2. Loader emits a `console.warn` BEFORE schema validation that names
//      the offending key and suggests the recognized spelling. Doctor
//      surfaces the same warning via `findUnknownBudgetKeys`.

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConfig,
  findUnknownBudgetKeys,
  formatBudgetWarnings,
  KNOWN_BUDGET_KEYS,
} from '../src/core/config/loader.ts';
import { GuardrailError } from '../src/core/errors.ts';

describe('findUnknownBudgetKeys (pure)', () => {
  it('returns empty for configs without a budgets block', () => {
    assert.deepEqual(findUnknownBudgetKeys({ configVersion: 1 }), []);
    assert.deepEqual(findUnknownBudgetKeys(null), []);
    assert.deepEqual(findUnknownBudgetKeys('not an object'), []);
  });

  it('returns empty when every key is recognized', () => {
    assert.deepEqual(
      findUnknownBudgetKeys({
        budgets: {
          perRunUSD: 1,
          perPhaseUSD: 2,
          perSubagentUSD: 3,
          conservativePhaseReserveUSD: 0.5,
        },
      }),
      [],
    );
  });

  it('flags case-typo keys with a didYouMean suggestion', () => {
    const out = findUnknownBudgetKeys({
      budgets: { perRunUSD: 1, perSubAgentUsd: 2 },
    });
    assert.deepEqual(out, [{ key: 'perSubAgentUsd', didYouMean: 'perSubagentUSD' }]);
  });

  it('flags unrelated keys without a suggestion', () => {
    const out = findUnknownBudgetKeys({
      budgets: { perRunUSD: 1, legacyBudgetKey: 9 },
    });
    assert.deepEqual(out, [{ key: 'legacyBudgetKey' }]);
  });

  it('ignores array-shaped budgets (defensive — schema rejects elsewhere)', () => {
    assert.deepEqual(findUnknownBudgetKeys({ budgets: [1, 2, 3] }), []);
  });
});

describe('formatBudgetWarnings', () => {
  it('formats case-typo with did-you-mean suggestion', () => {
    const lines = formatBudgetWarnings([
      { key: 'perSubAgentUsd', didYouMean: 'perSubagentUSD' },
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /perSubAgentUsd/);
    assert.match(lines[0]!, /did you mean "perSubagentUSD"\?/);
  });

  it('formats unknown keys with recognized-set hint', () => {
    const lines = formatBudgetWarnings([{ key: 'legacyBudgetKey' }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /legacyBudgetKey/);
    for (const k of KNOWN_BUDGET_KEYS) {
      assert.match(lines[0]!, new RegExp(k));
    }
  });
});

describe('loadConfig + budgets schema', () => {
  it('valid budgets keys parse cleanly with no warnings', async t => {
    const warnSpy = t.mock.method(console, 'warn');
    const cfg = await loadConfig('tests/fixtures/configs/budgets-valid.yaml');
    assert.equal(cfg.configVersion, 1);
    assert.equal(warnSpy.mock.callCount(), 0, 'no warnings for recognized keys');
  });

  it('case-typo `perSubAgentUsd` FAILS schema validation', async () => {
    await assert.rejects(
      () => loadConfig('tests/fixtures/configs/budgets-typo.yaml'),
      (err: unknown) => {
        assert.ok(err instanceof GuardrailError);
        assert.equal(err.code, 'invalid_config');
        const details = (err as GuardrailError).details as
          | { errors?: string[] }
          | undefined;
        assert.ok(
          details?.errors?.some(e => e.includes('perSubAgentUsd')),
          `expected an error mentioning perSubAgentUsd, got: ${JSON.stringify(details?.errors)}`,
        );
        return true;
      },
    );
  });

  it('emits a `console.warn` BEFORE the schema error fires', async t => {
    const warnSpy = t.mock.method(console, 'warn');
    await assert.rejects(() => loadConfig('tests/fixtures/configs/budgets-typo.yaml'));
    const warnCalls = warnSpy.mock.calls.map(c => String(c.arguments[0]));
    assert.ok(
      warnCalls.some(line => line.includes('perSubAgentUsd') && line.includes('did you mean')),
      `expected a budgets warning, got: ${JSON.stringify(warnCalls)}`,
    );
  });

  it('unrelated `legacyBudgetKey` ALSO fails schema validation (no historical opt-out)', async t => {
    const warnSpy = t.mock.method(console, 'warn');
    await assert.rejects(
      () => loadConfig('tests/fixtures/configs/budgets-legacy.yaml'),
      (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
    );
    const warnCalls = warnSpy.mock.calls.map(c => String(c.arguments[0]));
    assert.ok(
      warnCalls.some(line => line.includes('legacyBudgetKey')),
      `expected a warning for legacyBudgetKey, got: ${JSON.stringify(warnCalls)}`,
    );
  });
});

// Mark `mock` as used so the lint pass doesn't flag the import.
void mock;
