/**
 * Tests for the protocol semver utilities (normalize / parse / compare).
 *
 * The contract: full triplets internally; reject anything that doesn't
 * parse as MAJOR[.MINOR[.PATCH]] integers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compare, normalize, parse, sameMajor } from '../../src/core/protocol/semver.ts';
import { ProtocolError } from '../../src/core/protocol/errors.ts';

describe('semver — normalize', () => {
  it('fills missing segments', () => {
    assert.equal(normalize('1'), '1.0.0');
    assert.equal(normalize('1.2'), '1.2.0');
    assert.equal(normalize('1.2.3'), '1.2.3');
  });

  it('preserves zero segments', () => {
    assert.equal(normalize('0.0.0'), '0.0.0');
    assert.equal(normalize('0'), '0.0.0');
  });

  it('rejects empty / non-string', () => {
    assert.throws(() => normalize(''), /Invalid protocol version/);
    // @ts-expect-error testing runtime guard
    assert.throws(() => normalize(undefined), /Invalid protocol version/);
  });

  it('rejects non-numeric segments', () => {
    assert.throws(() => normalize('1.2.x'), ProtocolError);
    assert.throws(() => normalize('v1.2.3'), ProtocolError);
    assert.throws(() => normalize('1.0.0-alpha'), ProtocolError);
  });

  it('rejects 4+ segments', () => {
    assert.throws(() => normalize('1.2.3.4'), ProtocolError);
  });
});

describe('semver — parse', () => {
  it('returns numeric triplet', () => {
    assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parse('10.20.30'), { major: 10, minor: 20, patch: 30 });
  });
});

describe('semver — compare', () => {
  it('returns 0 for equal', () => {
    assert.equal(compare('1.2.3', '1.2.3'), 0);
    assert.equal(compare('1.2', '1.2.0'), 0);
  });

  it('orders by major then minor then patch', () => {
    assert.equal(compare('1.0.0', '2.0.0'), -1);
    assert.equal(compare('2.0.0', '1.0.0'), 1);
    assert.equal(compare('1.0.0', '1.1.0'), -1);
    assert.equal(compare('1.1.0', '1.0.5'), 1);
    assert.equal(compare('1.0.0', '1.0.1'), -1);
  });

  it('treats double-digit segments numerically (not lexicographically)', () => {
    assert.equal(compare('1.10.0', '1.2.0'), 1);
    assert.equal(compare('1.0.10', '1.0.2'), 1);
  });
});

describe('semver — sameMajor', () => {
  it('returns true for matching majors', () => {
    assert.equal(sameMajor('1.0.0', '1.99.99'), true);
    assert.equal(sameMajor('0.0.0', '0.1.2'), true);
  });
  it('returns false for differing majors', () => {
    assert.equal(sameMajor('1.0.0', '2.0.0'), false);
    assert.equal(sameMajor('0.99.99', '1.0.0'), false);
  });
});
