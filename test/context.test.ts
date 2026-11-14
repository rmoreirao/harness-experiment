import { afterEach, expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents';
import { compactInput, modelInputUnits } from '../src/context.js';
import { SessionController } from '../src/controller.js';
import { FakeModel, inputText, type FakeHandler } from '../src/model.js';
import { record } from '../src/contracts.js';
import { fixture, approveAll } from './helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function assertPairs(input: AgentInputItem[]): void {
  const calls = new Set(input.filter(i => i.type === 'function_call').map(i => i.callId));
  for (const item of input) if (item.type === 'function_call_result') expect(calls.has(item.callId)).toBe(true);
}
it('compacts a long active tool loop and resumes its exact approval checkpoint without replay', async () => {
  const f = fixture({ limits: { contextTokens: 9000, maxOutputTokens: 128, maxTokens: 100000 } });
  cleanup.push(f.cleanup);
  const original = 'Complete fifteen progress steps; preserve this exact request.';
  const requests: AgentInputItem[][] = [];
  const handler: FakeHandler = request => {
    if (typeof request.input === 'string') throw new Error('SDK model input should contain items.');
    requests.push(request.input);
    expect(request.input.some(i => 'role' in i && i.role === 'user' && inputText(i) === original)).toBe(true);
    expect(request.systemInstructions).toContain('Authoritative task state');
    expect(request.systemInstructions).toContain('preserved-task');
    expect(modelInputUnits(request.input, request.systemInstructions, request.tools) + 128).toBeLessThanOrEqual(9000);
    assertPairs(request.input);
    const last = request.input.filter(i => i.type === 'function_call_result').at(-1);
    const output = last ? typeof last.output === 'string' ? last.output : 'text' in last.output ? last.output.text : '' : '';
    const parsed: unknown = output ? JSON.parse(output) : { step: -1 };
    if (!record(parsed) || typeof parsed.step !== 'number') throw new Error('Missing latest tool result.');
    const step = parsed.step + 1;
    return step === 15 ? [{
      type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'All fifteen steps completed.' }],
    }] : [{
      type: 'function_call', name: step === 7 ? 'confirm_progress' : 'progress',
      arguments: JSON.stringify({ step }), callId: `step-${step}`, status: 'completed',
    }];
  };
  const executed: number[] = [];
  const tools = ['progress', 'confirm_progress'].map(name => ({
    name, description: 'Synthetic progress operation',
    parameters: { type: 'object' as const, properties: { step: { type: 'integer' } }, required: ['step'], additionalProperties: false as const },
    effect: name === 'progress' ? 'internal' as const : 'read' as const, approval: false,
    execute: (args: Record<string, unknown>) => {
      if (typeof args.step !== 'number') throw new Error('Invalid step.');
      executed.push(args.step);
      return { step: args.step, payload: 'Long synthetic progress output. '.repeat(24) };
    },
  }));
  let app = await SessionController.open({ config: f.config, model: new FakeModel(handler), tools });
  try {
    app.store.setTasks(app.id, [{ id: 'preserved-task', title: 'Preserve structured progress', status: 'done' }]);
    const run = await app.submit(original);
    expect(run.status, run.reason ?? '').toBe('awaiting_approval');
    expect(executed).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(app.store.trace(run.id).some(e => e.type === 'compaction')).toBe(true);
    const id = app.id;
    const callsBefore = run.usage.requests;
    await app.close();
    app = await SessionController.open({ config: f.config, sessionId: id, model: new FakeModel(handler), tools });
    await approveAll(app);
    const final = app.inspect().run!;
    expect(final.status, final.reason ?? '').toBe('completed');
    expect(final.usage.requests).toBe(16);
    expect(final.usage.requests).toBeGreaterThan(callsBefore);
    expect(executed).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(app.store.toolResult(`${run.id}:step-0`, id)).toContain('Long synthetic progress output.');
    expect(app.store.transcript(id).some(e => e.text === original)).toBe(true);
    assertPairs(await app.session.getItems());
    expect(requests.at(-1)!.length).toBeLessThan(20);
  } finally { await app.close(); }
});
it('keeps the complete latest parallel call/result batch, user goal, and authoritative messages unchanged', () => {
  const input: AgentInputItem[] = [
    { type: 'message', role: 'system', content: 'Do not change these authoritative instructions.' },
    { type: 'message', role: 'user', content: 'Old request '.repeat(200) },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Old response '.repeat(200) }] },
    { type: 'message', role: 'user', content: 'Current exact goal' },
    { type: 'reasoning', id: 'latest-reasoning', content: [], providerData: { encrypted_content: 'opaque-replay-state' } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Using both tools in this exchange.' }] },
    { type: 'function_call', name: 'first', callId: 'first', arguments: '{}', status: 'completed' },
    { type: 'function_call', name: 'second', callId: 'second', arguments: '{}', status: 'completed' },
    { type: 'function_call_result', name: 'first', callId: 'first', output: { type: 'text', text: 'first-result' }, status: 'completed' },
    { type: 'function_call_result', name: 'second', callId: 'second', output: { type: 'text', text: 'second-result' }, status: 'completed' },
  ];
  const compacted = compactInput(input, 2200);
  expect(compacted.droppedItems).toBeGreaterThan(0);
  expect(compacted.retainedBytes).toBeLessThanOrEqual(2200);
  for (const item of [input[0], ...input.slice(3)]) expect(compacted.input).toContain(item);
  assertPairs(compacted.input);
});
it('refuses irreducible oversized current input before any inference or permission is granted', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  let called = false;
  const app = await SessionController.open({ config: f.config, model: new FakeModel(() => {
    called = true; throw new Error('Must not call inference.');
  }) });
  try {
    const run = await app.submit('Oversized user request: ' + 'x'.repeat(20000));
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('cannot fit safely');
    expect(run.usage.requests).toBe(0);
    expect(run.usage.unknown).toBe(false);
    expect(called).toBe(false);
  } finally { await app.close(); }
});
it('does not rewrite stored history behind a pending SDK approval', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config });
  try {
    await app.submit('Summarize documents and save.');
    const before = await app.session.getItems();
    await expect(app.compact()).rejects.toThrow('logical run is pending');
    expect(await app.session.getItems()).toEqual(before);
  } finally { await app.close(); }
});
it('compacts against the remaining token budget even with spare model context', async () => {
  const f = fixture({ limits: { contextTokens: 16000, maxOutputTokens: 128, maxTokens: 11000 } });
  cleanup.push(f.cleanup);
  let step = 0;
  const model = new FakeModel(() => {
    const current = step++;
    return current === 4 ? [{
      type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Bounded task completed.' }],
    }] : [{
      type: 'function_call', name: 'budget_progress', callId: `budget-${current}`, status: 'completed',
      arguments: '{}',
    }];
  });
  const app = await SessionController.open({ config: f.config, model, tools: [{
    name: 'budget_progress', description: 'Synthetic budget-sensitive progress', effect: 'internal', approval: false,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ progress: 'Synthetic result data. '.repeat(60) }),
  }] });
  try {
    const run = await app.submit('Finish four steps with the given budget.');
    expect(run.status, run.reason ?? '').toBe('completed');
    expect(run.usage.input + run.usage.output).toBeLessThanOrEqual(11000);
    expect(app.store.trace(run.id).filter(e => e.type === 'compaction').length).toBeGreaterThan(0);
  } finally { await app.close(); }
});
