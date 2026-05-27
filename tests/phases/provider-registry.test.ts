import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_REGISTRY,
  defaultPhaseProvider,
  ROUTED_PHASES,
} from '../../src/core/phases/provider-registry.ts';

describe('provider registry', () => {
  it('every provider has a review default model (spec test #13)', () => {
    for (const [id, cap] of Object.entries(PROVIDER_REGISTRY)) {
      assert.ok(
        cap.defaultModelByPhase.review,
        `provider ${id} missing review default model`,
      );
    }
  });

  it('`installed` reflects actual optional dependency state (spec test #14)', () => {
    // openai is in optionalDependencies — if `npm install` ran successfully,
    // it should be present in this test environment.
    assert.equal(typeof PROVIDER_REGISTRY.openai?.installed, 'boolean');
    // Every provider has an apiKeyEnv name.
    for (const [id, cap] of Object.entries(PROVIDER_REGISTRY)) {
      assert.ok(cap.apiKeyEnv, `provider ${id} missing apiKeyEnv`);
    }
  });

  it('defaultPhaseProvider returns a provider in the registry for every routed phase', () => {
    for (const phase of ROUTED_PHASES) {
      const p = defaultPhaseProvider(phase);
      assert.ok(PROVIDER_REGISTRY[p], `default provider ${p} for ${phase} not in registry`);
    }
  });
});
