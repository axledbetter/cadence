export const GUARDRAIL_CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['configVersion'],
  additionalProperties: false,
  properties: {
    configVersion: { const: 1 },
    preset: { type: 'string' },
    reviewEngine: { $ref: '#/definitions/adapterRef' },
    vcsHost: { $ref: '#/definitions/adapterRef' },
    migrationRunner: { $ref: '#/definitions/adapterRef' },
    reviewBot: { $ref: '#/definitions/adapterRef' },
    adapterAllowlist: { type: 'array', items: { type: 'string' } },
    protectedPaths: { type: 'array', items: { type: 'string' } },
    staticRules: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object', required: ['adapter'], properties: { adapter: { type: 'string' }, options: { type: 'object' } } },
        ],
      },
    },
    staticRulesParallel: { type: 'boolean' },
    stack: { type: 'string' },
    testCommand: { type: ['string', 'null'] },
    thresholds: {
      type: 'object',
      properties: {
        bugbotAutoFix: { type: 'number' },
        bugbotProposePatch: { type: 'number' },
        maxValidateRetries: { type: 'number' },
        maxCodexRetries: { type: 'number' },
        maxBugbotRounds: { type: 'number' },
      },
      additionalProperties: false,
    },
    ignore: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            required: ['path'],
            properties: {
              rule: { type: 'string' },
              path: { type: 'string' },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    reviewStrategy: { enum: ['auto', 'single-pass', 'file-level', 'diff', 'auto-diff'] },
    chunking: {
      type: 'object',
      properties: {
        smallTierMaxTokens: { type: 'number' },
        partialReviewTokens: { type: 'number' },
        perFileMaxTokens: { type: 'number' },
        parallelism: { type: 'number' },
        rateLimitBackoff: { enum: ['exp', 'linear', 'none'] },
      },
      additionalProperties: false,
    },
    policy: {
      type: 'object',
      properties: {
        failOn: { enum: ['critical', 'warning', 'note', 'none'] },
        newOnly: { type: 'boolean' },
        baselinePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    pipeline: {
      type: 'object',
      properties: {
        runReviewOnStaticFail: { type: 'boolean' },
        runReviewOnTestFail: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    cost: {
      type: 'object',
      properties: {
        maxPerRun: { type: 'number' },
        estimateBeforeRun: { type: 'boolean' },
        pricing: { type: 'object' },
      },
      additionalProperties: false,
    },
    brand: {
      type: 'object',
      properties: {
        colorsFrom: { type: 'string' },
        colors: { type: 'array', items: { type: 'string' } },
        fonts: { type: 'array', items: { type: 'string' } },
        componentLibrary: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                tokens: { type: 'string' },
                guide: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
    deploy: {
      type: 'object',
      required: ['adapter'],
      additionalProperties: false,
      properties: {
        adapter: { enum: ['vercel', 'generic'] },
        project: { type: 'string' },
        team: { type: 'string' },
        target: { enum: ['production', 'preview'] },
        deployCommand: { type: 'string' },
        watchBuildLogs: { type: 'boolean' },
        rollbackOn: {
          type: 'array',
          items: { enum: ['healthCheckFailure', 'smokeTestFailure'] },
        },
        healthCheckUrl: { type: 'string' },
      },
    },
    'schema-alignment': {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        migrationGlobs: { type: 'array', items: { type: 'string', minLength: 1 } },
        layerRoots: {
          type: 'object',
          properties: {
            types: { type: 'array', items: { type: 'string' }, minItems: 1 },
            api: { type: 'array', items: { type: 'string' }, minItems: 1 },
            ui: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          additionalProperties: false,
        },
        llmCheck: { type: 'boolean' },
        severity: { enum: ['warning', 'error'] },
      },
      additionalProperties: false,
    },
    cache: { type: 'object' },
    persistence: { type: 'object' },
    concurrency: { type: 'object' },
    /**
     * Cost caps (USD) for the run. v8.1.1 enumerated the full set and
     * tightened to `additionalProperties: false` so case typos like
     * `perSubAgentUsd` fail schema validation instead of silently
     * disabling the per-subagent cap. The loader ALSO emits a
     * `console.warn` for any unknown `budgets.*` keys BEFORE schema
     * validation, which surfaces in `cadence doctor`. Issue #210.
     * Source of truth: presets/schemas/guardrail.config.schema.json
     * (the JSON-schema-authoritative shape — keep both in sync).
     */
    budgets: {
      type: 'object',
      additionalProperties: false,
      properties: {
        perRunUSD: { type: 'number', minimum: 0 },
        perPhaseUSD: { type: 'number', minimum: 0 },
        perSubagentUSD: { type: ['number', 'null'], minimum: 0 },
        conservativePhaseReserveUSD: { type: 'number', minimum: 0 },
      },
    },
    engine: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
      },
    },
    council: {
      type: 'object',
      required: ['models', 'synthesizer'],
      additionalProperties: false,
      properties: {
        models: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['adapter', 'model', 'label'],
            additionalProperties: false,
            properties: {
              adapter: { type: 'string' },
              model: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
        synthesizer: {
          type: 'object',
          required: ['adapter', 'model', 'label'],
          additionalProperties: false,
          properties: {
            adapter: { type: 'string' },
            model: { type: 'string' },
            label: { type: 'string' },
          },
        },
        timeout_ms: { type: 'number' },
        min_successful_responses: { type: 'number' },
        parallel_input_max_tokens: { type: 'number' },
        synthesis_input_max_tokens: { type: 'number' },
      },
    },
  },
  definitions: {
    adapterRef: {
      oneOf: [
        { type: 'string' },
        { type: 'object', required: ['adapter'], properties: { adapter: { type: 'string' }, options: { type: 'object' } } },
      ],
    },
  },
} as const;
