import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { fixture } from './helpers.js';

describe('Native v4 configuration contracts', () => {
  it('defaults native sessions to allow-all permissions and interactive tasks', () => {
    const f = fixture();
    try {
      expect(f.config).toMatchObject({
        version: 4, permissionMode: 'allow-all', taskMode: 'interactive',
        provider: { kind: 'byok', apiKeyEnv: 'OPENAI_API_KEY' },
        model: { canonical: 'gpt-6.1-sol', wire: 'synthetic-deployment' },
        limits: { concurrency: 4, modelConcurrency: 4, workerConcurrency: 4,
          maxRequests: 1000, maxActions: 1000, timeoutMs: 3600000, toolTimeoutMs: 300000 },
      });

      expect(f.config.limits.maxTokens).toBeUndefined();
      expect(f.config.limits.maxCost).toBeUndefined();
      expect(f.config.model.contextTokens).toBeUndefined();
      expect(f.config.model.outputTokens).toBeUndefined();
    } finally { f.cleanup(); }
  });

  it('accepts explicit safe request and action limits above the old fixed ceiling', () => {
    const f = fixture();
    try {
      expect(parseConfig({ ...f.config, limits: { maxRequests: 1001, maxActions: 1001, toolTimeoutMs: 86400000 } }).limits)
        .toMatchObject({ maxRequests: 1001, maxActions: 1001, toolTimeoutMs: 86400000 });
    } finally { f.cleanup(); }
  });

  it.each(['manual', 'assisted', 'allow-all'] as const)(
    'keeps permission mode %s independent from every task mode', permissionMode => {
      const f = fixture();
      try {
        for (const taskMode of ['interactive', 'plan', 'autopilot'] as const) {
          expect(parseConfig({ ...f.config, permissionMode, taskMode })).toMatchObject({ permissionMode, taskMode });
        }
      } finally { f.cleanup(); }
    },
  );

  it.each([2, 3])('rejects version %i configurations without reinterpretation', version => {
    const f = fixture();
    try {
      expect(() => parseConfig({ ...f.config, version })).toThrow('Only native configuration version 4 is supported');
      expect(f.config.version).toBe(4);
    } finally { f.cleanup(); }
  });

  it('keeps Copilot authentication separate from BYOK transport configuration', () => {
    const f = fixture();
    try {
      expect(parseConfig({ ...f.config, provider: { kind: 'copilot' } }).provider).toEqual({ kind: 'copilot' });
      expect(parseConfig({ ...f.config, provider: {
        kind: 'byok', baseURL: 'https://models.example.invalid/v1',
      } }).provider).toEqual({
        kind: 'byok', baseURL: 'https://models.example.invalid/v1', apiKeyEnv: 'OPENAI_API_KEY',
      });
      expect(() => parseConfig({ ...f.config, provider: {
        kind: 'copilot', baseURL: 'https://models.example.invalid/v1',
      } })).toThrow();
      expect(() => parseConfig({ ...f.config, provider: {
        kind: 'byok', baseURL: 'https://models.example.invalid/v1', apiKey: 'not-config-data',
      } })).toThrow();
    } finally { f.cleanup(); }
  });

  it.each([
    { label: 'public HTTP', baseURL: 'http://public.example.invalid/v1' },
    { label: 'embedded credentials', baseURL: 'https://user:password@models.example.invalid/v1' },
    { label: 'response route instead of base', baseURL: 'https://models.example.invalid/v1/responses' },
    { label: 'query credentials', baseURL: 'https://models.example.invalid/v1?token=private' },
    { label: 'fragment', baseURL: 'https://models.example.invalid/v1#fragment' },
  ])('rejects unsafe BYOK endpoint $label before dispatch', ({ baseURL }) => {
    const f = fixture();
    try { expect(() => parseConfig({ ...f.config, provider: { kind: 'byok', baseURL } })).toThrow(); }
    finally { f.cleanup(); }
  });

  it('inherits worker models and requires explicit known same-provider overrides', () => {
    const f = fixture();
    try {
      const config = parseConfig({ ...f.config,
        models: [{ id: 'worker-model', wire: 'worker-deployment' }],
        agents: [
          { name: 'inherited', prompt: 'Use the parent model.' },
          { name: 'explicit', prompt: 'Use the selected worker model.', model: 'worker-model' },
        ],
      });
      expect(config.agents).toEqual([
        { name: 'inherited', prompt: 'Use the parent model.' },
        { name: 'explicit', prompt: 'Use the selected worker model.', model: 'worker-model', modelPolicy: 'required' },
      ]);
      expect(config.models).toEqual([{ id: 'worker-model', wire: 'worker-deployment' }]);
      expect(() => parseConfig({ ...f.config,
        agents: [{ name: 'wrong-provider', prompt: 'Do not fall back.', model: 'unselected-provider/model' }],
      })).toThrow('Unknown model');
      expect(() => parseConfig({ ...f.config,
        models: [{ id: 'duplicate', wire: 'one' }, { id: 'duplicate', wire: 'two' }],
      })).toThrow('Duplicate worker model identifier');
      expect(() => parseConfig({ ...f.config,
        models: [{ id: f.config.model.canonical, wire: 'different-parent-wire' }],
      })).toThrow('one unambiguous wire identifier');
    } finally { f.cleanup(); }
  });

  it.each([
    ['token budget', { maxTokens: 10000 }],
    ['cost budget', { maxCost: 1, inputPerMillion: 1, outputPerMillion: 2 }],
    ['BYOK pricing', { inputPerMillion: 1, outputPerMillion: 2 }],
  ])('rejects unsupported Copilot %s rather than promising enforcement', (_label, limits) => {
    const f = fixture();
    try {
      expect(() => parseConfig({ ...f.config, provider: { kind: 'copilot' }, limits }))
        .toThrow('Copilot token/cost hard budgets and BYOK token prices are unsupported');
    } finally { f.cleanup(); }
  });

  it('requires complete worker prices when enforcing a BYOK currency budget', () => {
    const f = fixture();
    try {
      const input = { ...f.config,
        limits: { maxCost: 1, inputPerMillion: 1, outputPerMillion: 2 },
        models: [{ id: 'worker', wire: 'deployment' }],
      };
      expect(() => parseConfig(input)).toThrow('Cost budgets require prices');
      expect(parseConfig({ ...input, models: [
        { id: 'worker', wire: 'deployment', inputPerMillion: 3, outputPerMillion: 4 },
      ] }).models[0]).toEqual({
        id: 'worker', wire: 'deployment', inputPerMillion: 3, outputPerMillion: 4,
      });
    } finally { f.cleanup(); }
  });

  it.each([0, -1, null, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid explicit token and concurrency bounds labeled %s', invalid => {
      const f = fixture();
      try {
        for (const key of ['maxTokens', 'modelConcurrency', 'workerConcurrency', 'concurrency']) {
          expect(() => parseConfig({ ...f.config, limits: { [key]: invalid } }), key).toThrow();
        }
        expect(() => parseConfig({ ...f.config, model: { ...f.config.model, contextTokens: invalid } })).toThrow();
        expect(() => parseConfig({ ...f.config, model: { ...f.config.model, outputTokens: invalid } })).toThrow();
      } finally { f.cleanup(); }
    },
  );
});
