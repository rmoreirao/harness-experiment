import { afterEach, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionController } from '../src/controller.js';
import { FakeModel, type FakeHandler } from '../src/model.js';
import { executeWorkflow } from '../src/workflow.js';
import { Usage } from '@openai/agents';
import { fixture } from './helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const echo: FakeHandler = () => [{ role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'okay' }] }];
it('enforces iteration, context, and currency limits independently', async () => {
  const loop: FakeHandler = request => [{
    type: 'function_call', name: 'set_tasks', arguments: '{"tasks":[]}', status: 'completed',
    callId: `loop-${Array.isArray(request.input) ? request.input.length : 0}`,
  }];
  for (const [limits, handler, reason] of [
    [{ maxIterations: 1 }, loop, /turns|Iterations/i],
    [{ contextTokens: 1024, maxOutputTokens: 64 }, echo, /context/i],
    [{ maxCost: 0.000001, inputPerMillion: 1, outputPerMillion: 1 }, echo, /currency/i],
  ] as const) {
    const f = fixture({ limits }); cleanup.push(f.cleanup);
    const app = await SessionController.open({ config: f.config, model: new FakeModel(handler) });
    try { const run = await app.submit('hello'); expect(run.status).toBe('failed'); expect(run.reason).toMatch(reason); }
    finally { await app.close(); }
  }
});
it('bounds SDK function-tool concurrency and does not reset accounting at approval pauses', async () => {
  const f = fixture({ limits: { maxConcurrency: 2 } }); cleanup.push(f.cleanup);
  let active = 0, peak = 0;
  const model = new FakeModel(request => Array.isArray(request.input) && request.input.some(i => i.type === 'function_call_result') ? echo(request) :
    Array.from({ length: 5 }, (_, i) => ({ type: 'function_call' as const, name: 'slow_read', arguments: '{}', status: 'completed' as const, callId: `parallel-${i}` })));
  const app = await SessionController.open({ config: f.config, model, tools: [{
    name: 'slow_read', description: 'Synthetic cooperative tool', effect: 'internal', approval: false,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: async (_a, _runId, signal) => {
      peak = Math.max(peak, ++active);
      try { await delay(25, undefined, { signal }); return 'done'; } finally { active--; }
    },
  }] });
  try {
    const run = await app.submit('parallel');
    expect(run.status, run.reason ?? '').toBe('completed');
    expect(peak).toBe(2);
    expect(run.usage.requests).toBe(2);
    expect(run.usage.input).toBeGreaterThan(0);
  } finally { await app.close(); }
});
it('runs dependency-aware conditional steps with bounded parallelism and rejects cycles', async () => {
  const signal = new AbortController().signal;
  let active = 0, peak = 0;
  const execute = async () => { peak = Math.max(peak, ++active); await delay(10); active--; return 42; };
  const result = await executeWorkflow([
    { id: 'a', execute }, { id: 'b', execute }, { id: 'c', dependsOn: ['a', 'b'], when: () => false, execute },
  ], 2, signal);
  expect(peak).toBe(2);
  expect(result.get('c')).toEqual({ skipped: true });
  await expect(executeWorkflow([{ id: 'cycle', dependsOn: ['cycle'], execute }], 1, signal)).rejects.toThrow('cycle');
});
it('retains unresolved provider usage instead of charging zero or admitting more work', async () => {
  const f = fixture({ mode: 'openai', baseURL: 'https://example.invalid/v1', model: 'synthetic-only' }); cleanup.push(f.cleanup);
  const model = new FakeModel(echo);
  model.getResponse = async () => ({ usage: new Usage({ requests: 1 }), output: [], responseId: 'missing-usage' });
  const app = await SessionController.open({ config: f.config, model });
  try {
    const run = await app.submit('hello');
    expect(run.status).toBe('interrupted');
    expect(run.usage.unknown).toBe(true);
    expect(run.usage.cost).toBeNull();
    await expect(app.submit('another')).rejects.toThrow('Resolve');
    await expect(app.reconcile('No effect')).rejects.toThrow('token usage');
  } finally { await app.close(); }
});
it('times out a noncooperative custom tool and blocks new work until it actually stops', async () => {
  const f = fixture({ limits: { toolTimeoutMs: 50 } }); cleanup.push(f.cleanup);
  const model = new FakeModel(() => [{ type: 'function_call', name: 'slow', callId: 'slow1', arguments: '{}', status: 'completed' }]);
  const app = await SessionController.open({ config: f.config, model, tools: [{
    name: 'slow', description: 'Synthetic uncooperative tool', effect: 'internal', approval: false,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: async () => { await delay(250); return 'eventually stopped'; },
  }] });
  try {
    const run = await app.submit('hello');
    expect(run.reason).toContain('toolTimeoutMs');
    await expect(app.submit('more')).rejects.toThrow('has not stopped');
    await expect(app.close()).rejects.toThrow('ownership is retained');
    await delay(260);
  } finally { await app.close(); }
});
it('restricts model-visible tools and direct dispatch to the configured tool allowlist', async () => {
  const f = fixture({ enabledTools: ['read_documents'] }); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config, model: new FakeModel(request => {
    expect(request.tools.map(t => 'name' in t ? t.name : undefined)).toEqual(['read_documents']);
    return echo(request);
  }) });
  try {
    const run = await app.submit('hello');
    expect(run.status).toBe('completed');
    expect(() => app.gateway.prepare('list_documents', { folder: '.' })).toThrow('not enabled');
  } finally { await app.close(); }
  await expect(SessionController.open({ config: { ...f.config, enabledTools: ['not_a_tool'] } })).rejects.toThrow('unknown or unavailable');
});
