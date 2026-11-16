import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { CopilotClient } from '@github/copilot-sdk';
import { V2Controller } from '../../src/v2/controller.js';
import { parseV2Config } from '../../src/v2/config.js';
import { provider, complete, message } from '../provider-fixture.js';
import { fixture, skillFile, approve, ScriptRuntime } from './helpers.js';
import { HarnessError } from '../../src/contracts.js';
import { CopilotRuntime } from '../../src/v2/runtime.js';

describe('V2 A01 real pinned Copilot SDK/runtime over synthetic Responses', () => {
  it('starts an isolated SDK conversation after clear and cold resume without replaying prior prompts, answers or tool results', async () => {
    const oldPrompt = 'OLD_CONTEXT_USER_96b13';
    const oldAnswer = 'OLD_CONTEXT_ASSISTANT_96b13';
    const oldTool = 'OLD_CONTEXT_TOOL_RESULT_96b13';
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'before_clear_tool', [{ id: 'old_context_tool', call_id: 'old_context_tool',
        type: 'function_call', name: 'harness_fixture_context', arguments: '{}', status: 'completed' }])
      : complete(response, `clear_answer_${count}`, message(count === 2 ? oldAnswer : 'Fresh answer.'),
        count === 2 ? oldAnswer : 'Fresh answer.'));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const id = app.id;
    app.broker.register('fixture_context', 'Return synthetic evidence.', z.object({}).strict(), 'internal', () => ({ text: oldTool }));
    try {
      const old = await app.submit(oldPrompt);
      expect(old.status, old.reason ?? '').toBe('completed');
      expect(JSON.stringify(endpoint.requests[1])).toContain(oldTool);
      const oldResults = app.store.list('result', id, old.id);
      const previousRuntime = app.runtimeId;
      const stop = vi.spyOn(CopilotClient.prototype, 'stop').mockResolvedValueOnce([new Error('Injected child shutdown failure.')]);
      await expect(app.clearContext()).rejects.toThrow('did not stop cleanly');
      expect(app.runtimeId).toBe(previousRuntime);
      await expect(app.submit('Blocked until reset succeeds.')).rejects.toThrow('Retry /clear');
      await app.clearContext();
      expect(stop).toHaveBeenCalledTimes(2);
      stop.mockRestore();
      const freshRuntime = app.runtimeId;
      expect(freshRuntime).not.toBe(previousRuntime);
      expect(endpoint.requests).toHaveLength(2);
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective).toBeUndefined();
      const fresh = await app.submit('NEW_CONTEXT_USER_96b13');
      expect(fresh.status, fresh.reason ?? '').toBe('completed');
      const request = JSON.stringify(endpoint.requests[2]);
      expect(request).toContain('NEW_CONTEXT_USER_96b13');
      expect(request).toContain('Use only the supplied controlled capabilities');
      for (const previous of [oldPrompt, oldAnswer, oldTool, old.id]) expect(request).not.toContain(previous);
      expect(app.runtimeId).toBe(freshRuntime);
      expect(app.store.get('objective', old.id, id)).toEqual(old);
      expect(app.store.list('result', id, old.id)).toEqual(oldResults);
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      const resumed = await app.submit('Resume only the fresh context.');
      expect(resumed.status, resumed.reason ?? '').toBe('completed');
      const resumedRequest = JSON.stringify(endpoint.requests[3]);
      expect(resumedRequest).toContain('NEW_CONTEXT_USER_96b13');
      for (const previous of [oldPrompt, oldAnswer, oldTool]) expect(resumedRequest).not.toContain(previous);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('uses SDK defaults and finishes a real tool turn above 100,000 cumulative reported tokens without reservations', async () => {
    const text = 'SDK-owned context and uncapped cumulative usage verified.';
    const usage = { input_tokens: 40000, output_tokens: 2000, total_tokens: 42000 };
    const endpoint = await provider((response, _body, count) => count < 3
      ? complete(response, `auto_tool_${count}`, [{ id: `auto_call_${count}`, call_id: `auto_call_${count}`,
        type: 'function_call', name: 'harness_work_inspect', arguments: '{}', status: 'completed' }], undefined, usage)
      : complete(response, 'auto_answer', message(text), text, usage));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const result = await app.submit('Exercise the actual SDK-first default path.');
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(result.usage).toMatchObject({ input: 120000, output: 6000, requests: 3, reserved: 0, unknown: false });
      expect(endpoint.requests).toHaveLength(3);
      expect(endpoint.requests.every(request => request.max_output_tokens === undefined)).toBe(true);
      expect(app.store.list('model', app.id, result.id).every(request => request.reservation === 0 && request.budgetScope === 'none')).toBe(true);
      expect(app.inspect()).toMatchObject({ budget: { mode: 'none', maxTokens: null, maxCost: null },
        modelLimits: { providerCapacityVerified: false, prompt: { source: 'runtime reported' },
          output: { limit: null, source: 'SDK/provider default' } } });
      expect(app.inspect().modelLimits.prompt.limit).toBeGreaterThan(32000);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('lets the SDK compact reported context pressure and cold-resume without rewriting objective evidence or resetting usage', async () => {
    let app: V2Controller;
    let produced = false;
    const text = 'Synthetic compaction preserved the requested objective.';
    const endpoint = await provider((response, _body, count) => {
      const request = app.store.list('model', app.id, app.inspect().objective!.id).at(-1)!;
      if (request.interaction.includes('compaction')) {
        complete(response, `compact_${count}`, message('Synthetic summary: the generated-context tool completed; preserve the original objective and recorded product evidence.'),
          'Synthetic summary: the generated-context tool completed; preserve the original objective and recorded product evidence.');
      } else if (!produced) {
        produced = true;
        complete(response, 'large_context', [{ id: 'large_context_call', call_id: 'large_context_call', type: 'function_call',
          name: 'harness_fixture_context', arguments: '{}', status: 'completed' }], undefined,
        { input_tokens: 110000, output_tokens: 1000, total_tokens: 111000 });
      } else complete(response, `after_compaction_${count}`, message(text), text);
    });
    const f = fixture({ version: 3, limits: { maxRequests: 8 } });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    app.broker.register('fixture_context', 'Generate disposable synthetic context.', z.object({}).strict(), 'internal',
      () => ({ generated: 'Synthetic context-pressure fixture.' }));
    try {
      const first = await app.submit('Preserve this exact synthetic objective through SDK compaction.');
      expect(first.status, first.reason ?? '').toBe('completed');
      const events = app.store.events(id);
      const records = app.store.list('model', id, first.id);
      expect(events.some(event => event.type === 'runtime' && event.data.state === 'session.compaction_summarized' && event.data.success),
        JSON.stringify({ states: events.filter(event => event.type === 'runtime').map(event => event.data.state),
          limits: app.inspect().modelLimits, interactions: records.map(request => request.interaction) })).toBe(true);
      expect(records.some(request => request.interaction.includes('compaction'))).toBe(true);
      expect(first.usage.requests).toBe(records.length);
      expect(first.usage.input).toBe(records.reduce((sum, request) => sum + request.input, 0));
      expect(first.usage.output).toBe(records.reduce((sum, request) => sum + request.output, 0));
      expect(app.inspect().pendingModelRequests).toBe(0);
      const second = await app.submit('Let the SDK apply its settled background summary.');
      expect(second.status, second.reason ?? '').toBe('completed');
      expect(app.store.events(id).some(event => event.type === 'runtime' && event.data.state === 'session.compaction_complete' && event.data.success)).toBe(true);
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective).toEqual(second);
      expect((await app.submit('Continue with the native compacted conversation.')).status).toBe('completed');
      expect(app.store.get('objective', first.id, id)).toEqual(first);
      expect(app.store.list('model', id, first.id)).toEqual(records);
      expect(app.inspect().modelLimits.prompt.source).toBe('runtime reported');
      await app.clearContext();
      const requestCount = endpoint.requests.length;
      const fresh = await app.submit('Fresh context after native compaction.');
      expect(fresh.status, fresh.reason ?? '').toBe('completed');
      const freshRequests = JSON.stringify(endpoint.requests.slice(requestCount));
      expect(freshRequests).not.toContain('Synthetic summary:');
      expect(freshRequests).not.toContain(first.original);
      expect(freshRequests).not.toContain(second.original);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('cancels owned model work while waiting for background compaction instead of hanging or completing early', async () => {
    let compacting = false;
    const endpoint = await provider((response, _body, count) => {
      const request = app.store.list('model', app.id, app.inspect().objective!.id).at(-1)!;
      if (request.interaction.includes('compaction')) {
        compacting = true; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
      } else if (count === 1) {
        complete(response, 'cancel_context', [{ id: 'cancel_context_call', call_id: 'cancel_context_call', type: 'function_call',
          name: 'harness_work_inspect', arguments: '{}', status: 'completed' }], undefined,
        { input_tokens: 110000, output_tokens: 1000, total_tokens: 111000 });
      } else complete(response, 'cancel_wait', message('Wait for the owned compaction request.'), 'Wait for the owned compaction request.');
    });
    const f = fixture({ version: 3, limits: { toolTimeoutMs: 10000 } });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const work = app.submit('Cancel safely while background compaction is pending.');
      await vi.waitFor(() => expect(compacting).toBe(true), { timeout: 5000 });
      expect(app.inspect().busy).toBe(true);
      expect(app.inspect().pendingModelRequests).toBe(1);
      await app.cancel();
      const objective = await work;
      expect(objective.status).toBe('cancelled');
      expect(objective.usage).toMatchObject({ reserved: 0, unknown: true, cost: null });
      expect(app.inspect().pendingModelRequests).toBe(0);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('labels unknown-model fallback metadata as runtime-reported, never provider-verified capacity', async () => {
    const endpoint = await provider(response => complete(response, 'unknown_model', message('Synthetic unknown-model answer.'), 'Synthetic unknown-model answer.'));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, canonical: 'harness-unknown-model', baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      expect((await app.submit('Use the selected synthetic unknown model.')).status).toBe('completed');
      expect(app.inspect().modelLimits).toMatchObject({ model: 'harness-unknown-model', providerCapacityVerified: false,
        prompt: { source: 'runtime reported' }, output: { limit: null, source: 'SDK/provider default' } });
      expect(endpoint.requests[0]).toMatchObject({ model: 'synthetic-deployment' });
      expect(endpoint.requests[0]).not.toHaveProperty('max_output_tokens');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it.each(['missing', 'failed'])('keeps %s cached context metadata nonfatal and explicitly unavailable', async mode => {
    const original = CopilotClient.prototype.createSession;
    const spy = vi.spyOn(CopilotClient.prototype, 'createSession').mockImplementation(async function(this: CopilotClient, config) {
      const session = await original.call(this, config);
      session.rpc.metadata.contextInfo = async () => {
        if (mode === 'failed') throw new Error('Synthetic context metadata unavailable.');
        return { contextInfo: null };
      };
      return session;
    });
    const endpoint = await provider(response => complete(response, 'metadata_unknown', message('Metadata is optional.'), 'Metadata is optional.'));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const result = await app.submit('Complete without capacity metadata.');
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(app.inspect().modelLimits.prompt).toEqual({ limit: null, used: null, source: 'unavailable' });
      if (mode === 'failed') expect(app.store.events(app.id).some(event => event.data.state === 'context_unavailable' && event.data.diagnostic)).toBe(true);
    } finally { await app.close(); spy.mockRestore(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('allows verified uncapped answers with unknown billing across cold resume without converting uncertainty to zero', async () => {
    const endpoint = await provider(response => complete(response, 'uncapped_no_usage', message('Synthetic answer with missing billing.'), 'Synthetic answer with missing billing.', false));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    try {
      const first = await app.submit('Complete an uncapped objective with missing billing.');
      expect(first).toMatchObject({ status: 'completed', usage: { unknown: true, cost: null, requests: 1 } });
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective?.usage).toMatchObject({ unknown: true, cost: null });
      const second = await app.submit('Start another objective without inventing prior billing.');
      expect(second).toMatchObject({ status: 'completed', usage: { unknown: true, cost: null, requests: 1 } });
      expect(endpoint.requests).toHaveLength(2);
      expect(app.store.list('model', id, first.id)).toHaveLength(1);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('restores deliberate prompt/output overrides on cold resume without adding a task budget', async () => {
    const endpoint = await provider((response, _body, count) => complete(response, `explicit_${count}`, message('Explicit SDK limits retained.'), 'Explicit SDK limits retained.'));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL, contextTokens: 48000, outputTokens: 1536 } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    try {
      expect((await app.submit('Use explicit request settings.')).status).toBe('completed');
      expect(app.inspect().modelLimits).toMatchObject({ prompt: { limit: 48000, source: 'explicit override' },
        output: { limit: 1536, source: 'explicit override' } });
      await app.close();
      await expect(V2Controller.open({ config: parseV2Config({ ...config, model: { ...config.model, contextTokens: 64000 } }), sessionId: id }))
        .rejects.toThrow('exact saved');
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect((await app.submit('Retain the same explicit settings after restart.')).status).toBe('completed');
      expect(app.inspect().modelLimits.prompt).toMatchObject({ limit: 48000, source: 'explicit override' });
      expect(endpoint.requests).toHaveLength(2);
      expect(endpoint.requests.every(request => request.max_output_tokens === 1536)).toBe(true);
      expect(app.inspect().budget.mode).toBe('none');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it.each([
    { maxTokens: 100000 },
    { maxCost: 1, inputPerMillion: 1, outputPerMillion: 2 },
  ])('refuses an explicit budget without a finite SDK output bound before provider dispatch: %j', async limits => {
    const endpoint = await provider(response => complete(response, 'not_admitted', message('Unexpected dispatch.')));
    const f = fixture({ version: 3, limits });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const result = await app.submit('Do not invent an output limit to enforce a budget.');
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('finite request output bound');
      expect(result.usage.requests).toBe(0);
      expect(endpoint.requests).toHaveLength(0);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('keeps operator verification ceilings outside product policy and refuses an exhausted verifier before dispatch', async () => {
    const endpoint = await provider(response => complete(response, 'verified_default', message('Bounded verification only.'), 'Bounded verification only.'));
    const f = fixture({ version: 3 });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    try {
      for (const maxTokens of [100000, 128]) {
        const verification = { maxTokens, outputTokens: 128 };
        const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key',
          runtimeFactory: (resources, signal) => new CopilotRuntime(config, 'synthetic-provider-wire-key', resources, signal, verification) });
        try {
          const result = await app.submit('Exercise the separate operator spending guard.');
          expect(result.status).toBe(maxTokens === 128 ? 'failed' : 'completed');
          expect(app.inspect().budget).toEqual({ mode: 'none', maxTokens: null, maxCost: null });
          expect(app.config.model.outputTokens).toBeUndefined();
          expect(app.inspect().modelLimits).toMatchObject({ verification, output: { limit: null, source: 'SDK/provider default' } });
          if (maxTokens !== 128) expect(app.store.list('model', app.id, result.id)[0]).toMatchObject({ budgetScope: 'verification' });
          else expect(result.reason).toContain('Insufficient tokens');
        } finally { await app.close(); }
      }
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]?.max_output_tokens).toBe(128);
      expect(config.limits.maxTokens).toBeUndefined();
    } finally { await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('retrieves custom skills through the real runtime and observes a reload without reopening the session', async () => {
    const endpoint = await provider((response, _body, count) => count === 1 || count === 3
      ? complete(response, `resp_skill_${count}`, [{
        id: `fc_skill_${count}`, type: 'function_call', call_id: `call_skill_${count}`,
        name: 'harness_workflow_skill', arguments: '{"name":"review-notes"}', status: 'completed',
      }])
      : complete(response, `resp_skill_answer_${count}`, message('Synthetic skill retrieval completed.'), 'Synthetic skill retrieval completed.'));
    const f = fixture();
    skillFile(f.workspace, 'review-notes', 'Original synthetic skill instructions.');
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      expect((await app.submit('Read the custom skill.')).status).toBe('completed');
      expect(JSON.stringify(endpoint.requests[0])).toContain('Synthetic review-notes workflow guidance.');
      expect(JSON.stringify(endpoint.requests[1])).toContain('Original synthetic skill instructions.');
      skillFile(f.workspace, 'review-notes', 'Reloaded synthetic skill instructions.');
      app.reloadSkills();
      expect((await app.submit('Read the updated custom skill.')).status).toBe('completed');
      expect(JSON.stringify(endpoint.requests[3])).toContain('Reloaded synthetic skill instructions.');
      expect(app.store.events(app.id).filter(event => event.type === 'runtime' && event.data.state === 'creating')).toHaveLength(1);
      expect(app.inspect().pending).toEqual([]);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);
  it('returns the specific network-policy failure to the model and makes earlier errors inspectable after cold resume without refetching', async () => {
    const endpoint = await provider((response, _body, count) => {
      if (count === 1) complete(response, 'resp_blocked_fetch', [{
        id: 'fc_blocked_fetch', type: 'function_call', call_id: 'call_blocked_fetch',
        name: 'harness_web_fetch', arguments: '{"url":"https://blocked.example/"}', status: 'completed',
      }]);
      else if (count === 3) complete(response, 'resp_inspect_error', [{
        id: 'fc_inspect_error', type: 'function_call', call_id: 'call_inspect_error',
        name: 'harness_work_inspect', arguments: '{}', status: 'completed',
      }]);
      else complete(response, `resp_error_${count}`, message('The configured network policy blocked the destination.'), 'The configured network policy blocked the destination.');
    });
    const f = fixture({ limits: { maxReplans: 0 } });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id; approve(app);
    try {
      const failed = await app.submit('Retrieve the synthetic blocked destination.');
      expect(failed.status).toBe('partial');
      const output = JSON.stringify(endpoint.requests[1]);
      expect(output).toContain('DESTINATION');
      expect(output).toContain('https://blocked.example');
      expect(output).toContain('not configured');
      expect(app.inspect().actions[0]).toMatchObject({ status: 'failed', errorCode: 'DESTINATION' });
      const peer = await V2Controller.open({ config, runtimeFactory: () => new ScriptRuntime(async runtime => {
        await runtime.call('peer_failure', {});
      }) });
      try {
        peer.broker.register('peer_failure', 'Synthetic other-session error.', z.object({}).strict(), 'internal',
          () => { throw new HarnessError('PEER_PRIVATE', 'Other-session-only diagnostic.'); });
        await peer.submit('Record a separate-session diagnostic.');
      } finally { await peer.close(); }
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      await app.submit('Explain the earlier tool error without retrying the destination.');
      const recent = app.inspect().recentErrors;
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({ objectiveId: failed.id, tool: 'web_fetch', code: 'DESTINATION', origin: 'https://blocked.example' });
      expect(JSON.stringify(endpoint.requests[3])).toContain('recentErrors');
      expect(JSON.stringify(endpoint.requests[3])).toContain('DESTINATION');
      expect(JSON.stringify(endpoint.requests[3])).not.toContain('Other-session-only diagnostic.');
      expect(app.store.list('action', id).filter(action => action.tool === 'web_fetch')).toHaveLength(1);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('returns explicit redacted SDK failure results instead of masking them or exposing credentials/control sequences', async () => {
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'resp_redacted_failure', [{
        id: 'fc_redacted_failure', type: 'function_call', call_id: 'call_redacted_failure',
        name: 'harness_fixture_failure', arguments: '{}', status: 'completed',
      }])
      : complete(response, 'resp_explained_failure', message('The synthetic tool failed.'), 'The synthetic tool failed.'));
    const f = fixture({ limits: { maxReplans: 0 } });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    app.broker.register('fixture_failure', 'Synthetic failure with sensitive error content.', z.object({}).strict(), 'internal',
      () => { throw new HarnessError('FIXTURE_FAILURE', 'Sensitive diagnostic synthetic-provider-wire-key\u001b[31m' + 'x'.repeat(10000) + 'TRUNCATED_DIAGNOSTIC_TAIL'); });
    try {
      await app.submit('Explain the synthetic controlled failure.');
      const output = JSON.stringify(endpoint.requests[1]);
      expect(output).toContain('FIXTURE_FAILURE');
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('synthetic-provider-wire-key');
      expect(output).not.toContain('\\u001b');
      expect(output).toContain('[truncated]');
      expect(output).not.toContain('TRUNCATED_DIAGNOSTIC_TAIL');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('uses BYOK identity, streaming, exact custom-tool policy, usage and a cold runtime resume without journal secrets', async () => {
    const endpoint = await provider((response, _body, count) => {
      if (count === 1 || count === 3) complete(response, `resp_v2_read_${count}`, [{
        id: `fc_v2_read_${count}`, type: 'function_call', call_id: `call_v2_read_${count}`,
        name: 'harness_workspace_read', arguments: JSON.stringify({ path: 'notes.txt', start: 1, lines: 20 }), status: 'completed',
      }]);
      else complete(response, `resp_v2_${count}`, message('Synthetic Copilot runtime result with recorded source evidence.'), 'Synthetic Copilot runtime result with recorded source evidence.');
    });
    const f = fixture();
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const id = app.id; const runtimeId = app.runtimeId;
    const events: string[] = []; app.subscribe(event => events.push(event.type));
    approve(app);
    try {
      const first = await app.submit('Read the synthetic notes using workspace_read, then answer.');
      expect(first.status, first.reason ?? '').toBe('completed');
      expect(first.usage.requests).toBe(2);
      expect(first.usage.input).toBe(200);
      expect(first.usage.output).toBe(80);
      expect(first.usage.reserved).toBe(0);
      expect(events).toContain('text');
      expect(app.inspect().actions.find(action => action.tool === 'workspace_read')?.status).toBe('completed');
      expect(endpoint.requests.every(request => request.model === 'synthetic-deployment')).toBe(true);
      const encoded = JSON.stringify(endpoint.requests);
      expect(encoded).toContain('workspace_read');
      expect(encoded).not.toContain('"name":"powershell"');
      expect(encoded).not.toContain('"name":"bash"');
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      approve(app);
      const second = await app.submit('Answer using the same synthetic session.');
      expect(second.status, second.reason ?? '').toBe('completed');
      expect(second.usage.requests).toBe(2);
      expect(app.inspect().actions.find(action => action.tool === 'workspace_read')?.status).toBe('completed');
      expect(app.runtimeId).toBe(runtimeId);
      await app.close();
      const scan = (directory: string): string => readdirSync(directory).map(name => {
        const file = path.join(directory, name);
        return statSync(file).isDirectory() ? scan(file) : readFileSync(file).toString('utf8');
      }).join('');
      expect(scan(f.dataDir)).not.toContain('synthetic-provider-wire-key');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('denies a real runtime custom call without reading content or falling back to host tools', async () => {
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'resp_denied', [{ id: 'fc_denied', type: 'function_call', call_id: 'call_denied',
        name: 'harness_workspace_read', arguments: '{"path":"notes.txt"}', status: 'completed' }])
      : complete(response, 'resp_after_denial', message('The content read was denied.'), 'The content read was denied.'));
    const f = fixture();
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); approve(app, 'deny');
    try {
      await app.submit('Attempt the synthetic read.');
      expect(app.inspect().actions.find(action => action.tool === 'workspace_read')?.status).toBe('denied');
      expect(JSON.stringify(endpoint.requests)).not.toContain('Synthetic reference evidence.');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);
});
