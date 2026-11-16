import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SessionController } from '../src/controller.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { fixture, ScriptRuntime, approve } from './helpers.js';
import { complete, message, provider } from './provider-fixture.js';
import { Workspace } from '../src/workspace.js';
import { hash } from '../src/config.js';

describe('A07 hard admission, accounting and explicit stop states', () => {
  it.each([2, 3])('retains model HTTP status and provider request IDs without storing the rejected response body (version %i)', async version => {
    const endpoint = await provider(response => response.writeHead(401, {
      'Content-Type': 'application/json', 'x-request-id': 'v2-auth-request',
    }).end(JSON.stringify({ error: { message: 'PRIVATE_RESPONSE_BODY' } })));
    const f = fixture({ version });
    const config = parseConfig({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const objective = await app.submit('PRIVATE_USER_PROMPT');
      expect(objective.status).toBe(version === 2 ? 'recovery_required' : 'failed');
      const error = app.store.errors(app.id).errors.find(error => error.source === 'model' && error.httpStatus === 401)!;
      expect(error).toMatchObject({
        httpStatus: 401, providerRequestId: 'v2-auth-request', code: 'MODEL_HTTP', streamStarted: false,
      });

      expect(error.callId).toBeTruthy();
      expect(JSON.stringify(error)).not.toContain('PRIVATE_RESPONSE_BODY');
      expect(JSON.stringify(error)).not.toContain('PRIVATE_USER_PROMPT');
      expect(JSON.stringify(error)).not.toContain('synthetic-provider-wire-key');
      expect(app.store.error(app.id, error.id)).toEqual(error);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);
  it('refuses token/currency admission before the actual SDK can contact its selected model', async () => {
    const endpoint = await provider(response => complete(response, 'unexpected', message('Should not be called.'), 'Should not be called.'));
    const f = fixture();
    try {
      for (const limits of [{ maxTokens: 128 }, { maxTokens: 100000, maxCost: 0.0001, inputPerMillion: 1, outputPerMillion: 3 }]) {
        const config = parseConfig({ ...f.config, limits, model: { ...f.config.model, baseURL: endpoint.baseURL } });
        const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
        try {
          const result = await app.submit('Synthetic admission test.');
          expect(result.status).toBe('failed'); expect(result.reason).toMatch(/Insufficient/);
          expect(result.reason).not.toContain('retried 5 times');
          expect(result.usage.requests).toBe(0);
          expect(app.store.events(app.id).filter(event => event.type === 'error' && event.data.operation === 'Responses request')).toHaveLength(1);
        } finally { await app.close(); }
      }
      expect(endpoint.requests).toHaveLength(0);
    } finally { await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('uses confirmed unchanged-prefix accounting without copying history, rejects changed frames/prefixes, and still enforces the same token cap', async () => {
    const f = fixture();
    const frame = { model: 'synthetic', tools: [{ description: 'd'.repeat(80000) }] };
    const original = [{ role: 'system', content: 'Fixture system message prefix' }];
    const request = (items: unknown[], settings = frame) => ({
      bytes: Buffer.byteLength(JSON.stringify({ ...settings, input: items })),
      input: { frameHash: hash(settings), items },
    });
    const runtime = new ScriptRuntime(async runtime => {
      const first = request(original);
      const reserved = app.resources.reserve(first.bytes, 'conversation-agent', first.input);
      app.resources.settle(reserved, { input: 20000, output: 200 });
      const changed = request([{ role: 'system', content: 'Different same-sized prompt' }]);
      expect(() => app.resources.reserve(changed.bytes, 'conversation-agent', changed.input)).toThrow('Insufficient tokens');
      const differentFrame = request(original, { ...frame, model: 'different' });
      expect(() => app.resources.reserve(differentFrame.bytes, 'conversation-agent', differentFrame.input)).toThrow('Insufficient tokens');
      expect(() => app.resources.reserve(first.bytes, 'compaction', first.input)).toThrow('Insufficient tokens');
      const next = request([...original, { role: 'user', content: 'A new short input' }]);
      for (let count = 0; count < 3; count++) {
        const admitted = app.resources.reserve(next.bytes, 'conversation-agent', next.input);
        expect(admitted.inputBound!).toBeLessThan(next.bytes);
        app.resources.settle(admitted, { input: 21000, output: 200 });
      }
      expect(() => app.resources.reserve(next.bytes, 'conversation-agent', next.input)).toThrow('Insufficient tokens');
      expect(JSON.stringify(app.store.list('model', app.id, app.inspect().objective!.id))).not.toContain('Fixture system message prefix');
      runtime.message('Confirmed prefix accounting is bounded and the unchanged token cap still stops new work.');
    });
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); const id = app.id;
    try {
      const result = await app.submit('Exercise conservative incremental model admission.');
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(result.usage).toMatchObject({ input: 83000, output: 800, requests: 4, unknown: false, reserved: 0 });
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => new ScriptRuntime(async runtime => {
        const next = request([...original, { role: 'user', content: 'A new short input' }]);
        const admitted = app.resources.reserve(next.bytes, 'conversation-agent', next.input);
        expect(admitted.inputBound!).toBeLessThan(next.bytes);
        app.resources.settle(admitted, { input: 21000, output: 200 });
        runtime.message('The compact accounting anchor survived restart.');
      }) });
      expect((await app.submit('Verify restored accounting anchors.')).status).toBe('completed');
    } finally { await app.close(); f.cleanup(); }
  });

  it('lets the real SDK continue an append-only tool turn when serialized transport bytes exceed the remaining token budget', async () => {
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'prefix_response', [{
        id: 'prefix_function', type: 'function_call', call_id: 'prefix_function',
        name: 'harness_fixture_prefix', arguments: JSON.stringify({ padding: 'A'.repeat(15000) }), status: 'completed',
      }])
      : complete(response, 'prefix_answer', message('Synthetic prefix-bound workflow completed.'), 'Synthetic prefix-bound workflow completed.'));
    const f = fixture({ limits: { maxReplans: 0 } });
    const config = parseConfig({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const { z } = await import('zod');
    app.broker.register('fixture_prefix', 'Synthetic static tool documentation. '.repeat(2000), z.object({ padding: z.string().max(20000) }).strict(),
      'internal', () => ({ verified: true }));
    try {
      const result = await app.submit('Exercise a synthetic unchanged request prefix.');
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(endpoint.requests).toHaveLength(2);
      const records = app.store.list('model', app.id, result.id);
      expect(records[1]!.requestBytes!).toBeGreaterThan(100000);
      expect(records[1]!.reservation).toBeLessThan(100000 - 140);
      expect(config.limits.maxTokens).toBe(100000);
      expect(result.usage).toMatchObject({ input: 200, output: 80, requests: 2, reserved: 0, unknown: false });
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('stops on reported usage exceeding an incremental reservation instead of treating the extra work as free or retrying it', async () => {
    const f = fixture();
    const input = { frameHash: hash('unchanged model frame'), items: [{ role: 'system', content: 'Known prefix' }] };
    const runtime = new ScriptRuntime(async runtime => {
      const first = app.resources.reserve(80000, 'conversation-agent', input);
      app.resources.settle(first, { input: 20000, output: 200 });
      const next = app.resources.reserve(81000, 'conversation-agent', input);
      app.resources.settle(next, { input: 33000, output: 200 });
      expect(() => app.resources.check()).toThrow('reconciliation');
      runtime.message('Provider usage exceeded its conservative reservation; further work is blocked.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      const result = await app.submit('Exercise reported incremental-budget overshoot.');
      expect(result.status).toBe('recovery_required');
      expect(result.usage).toMatchObject({ input: 53000, output: 400, requests: 2, unknown: true, reserved: 0 });
    } finally { await app.close(); f.cleanup(); }
  });

  it('treats missing wire usage as unknown, blocks retries and preserves the exact ledger across restart', async () => {
    const endpoint = await provider(response => complete(response, 'resp_no_usage', message('Synthetic unknown usage.'), 'Synthetic unknown usage.', false));
    const f = fixture();
    const config = parseConfig({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    try {
      const objective = await app.submit('Synthetic missing-usage test.');
      expect(objective.status).toBe('recovery_required'); expect(objective.usage.unknown).toBe(true);
      expect(endpoint.requests).toHaveLength(1);
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective?.usage.unknown).toBe(true);
      const request = app.store.list('model', id, objective.id).find(request => request.status === 'unknown')!;
      await expect(app.reconcile({ note: 'Insufficient accounting.' })).rejects.toThrow('Every unknown');
      await app.reconcile({ note: 'Synthetic fixture confirms the exact missing usage.', usage: [{ id: request.id, input: 100, output: 40 }] });
      expect(app.inspect().objective?.usage).toMatchObject({ input: 100, output: 40, unknown: false, requests: 1 });
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('caps actions and plan revisions, rejects cyclic/evidence-free done steps, and does not report partial work complete', async () => {
    const f = fixture({ limits: { maxActions: 5, maxReplans: 0 } });
    const runtime = new ScriptRuntime(async runtime => {
      await expect(runtime.call('work_plan', { steps: [{ id: 'a', title: 'Cycle', expected: 'Nothing', dependencies: ['a'], status: 'pending' }] })).rejects.toThrow('Cyclic');
      await expect(runtime.call('work_plan', { steps: [{ id: 'a', title: 'Unsupported done', expected: 'Evidence', status: 'done' }] })).rejects.toThrow('evidence');
      await runtime.call('work_plan', { steps: [{ id: 'a', title: 'Unfinished', expected: 'Real verification', status: 'blocked', blocker: 'Synthetic missing prerequisite' }] });
      await expect(runtime.call('work_plan', { steps: [{ id: 'b', title: 'Unbounded revision', expected: 'Nothing', status: 'pending' }] })).rejects.toThrow('revision cap');
      await runtime.call('work_inspect', {});
      await expect(runtime.call('work_inspect', {})).rejects.toThrow('Action cap');
      runtime.message('The objective is blocked, not complete.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try { expect((await app.submit('Exercise deterministic control limits.')).status).toBe('partial'); }
    finally { await app.close(); f.cleanup(); }
  });

  it('bounds result storage/output, preserves Unicode byte-page boundaries, and makes trusted grants revocable', async () => {
    const f = fixture({ limits: { maxResultBytes: 1024, maxOutputBytes: 128 } });
    const runtime = new ScriptRuntime(async runtime => {
      await expect(runtime.call('workspace_read', { path: 'notes.txt' })).rejects.toThrow('output');
      runtime.message('Bounded output was refused.');
    });

    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
    try {
      await app.submit('Bound synthetic output.');
      const objective = app.inspect().objective!;
      const result = app.store.result(app.id, objective.id, 'synthetic', 'a\u20acb', { kind: 'unicode-fixture' }, 'text/plain');
      const first = app.store.readResult(app.id, result.id, 0, 3);
      expect(first.text).toBe('a'); expect(first.next).toBe(1);
      expect(app.store.readResult(app.id, result.id, 1, 3).text).toBe('\u20ac');
      expect(() => app.store.readResult(app.id, result.id, 2, 3)).toThrow('splits');
      expect(() => app.store.result(app.id, objective.id, 'synthetic', 'x'.repeat(1025), {})).toThrow('storage limit');
      const grant = app.broker.grant([f.workspace], [], Date.now() + 60000);
      app.broker.revoke(grant); expect(app.inspect().grants).toHaveLength(0);
    } finally { await app.close(); f.cleanup(); }
  });

  it('enforces exact file/mirror-count/byte thresholds and rejects disabled or unknown tool dispatch', async () => {
    const f = fixture({ limits: { maxFileBytes: 128, maxWorkspaceBytes: 1024, maxFiles: 10 }, enabledTools: ['workspace_list'] });
    writeFileSync(path.join(f.workspace, 'boundary.txt'), 'a'.repeat(128));
    const workspace = new Workspace(f.config);
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async runtime => runtime.message('No disabled tool ran.')) });
    try {
      expect(workspace.read('boundary.txt').text).toHaveLength(128);
      writeFileSync(path.join(f.workspace, 'boundary.txt'), 'a'.repeat(129));
      expect(() => workspace.read('boundary.txt')).toThrow('size');
      await expect(app.broker.dispatch('workspace_read', { path: 'notes.txt' }, 'disabled')).rejects.toThrow('disabled');
      await expect(app.broker.dispatch('unknown_shell', {}, 'unknown')).rejects.toThrow('disabled');
      expect(app.store.errors(app.id).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'tool', code: 'TOOL_DENIED', callId: 'disabled', status: 'not_started' }),
        expect.objectContaining({ source: 'tool', code: 'TOOL_DENIED', callId: 'unknown', status: 'not_started' }),
      ]));
      expect(app.store.list('action', app.id)).toHaveLength(0);
      for (let index = 0; index < 11; index++) writeFileSync(path.join(f.workspace, `file-${index}.txt`), 'x');
      expect(() => workspace.files()).toThrow('file count');
    } finally { await app.close(); f.cleanup(); }
    const mirror = fixture({ limits: { maxFileBytes: 2048, maxWorkspaceBytes: 1024 } });
    try {
      writeFileSync(path.join(mirror.workspace, 'large.txt'), 'x'.repeat(1024));
      expect(() => new Workspace(mirror.config).mirror(path.join(mirror.directory, 'mirror'))).toThrow('byte limit');
    } finally { mirror.cleanup(); }
  });

  it('bounds actual model request count without retrying an external action or silently changing providers', async () => {
    const endpoint = await provider(response => complete(response, 'request_cap', [{
      id: 'fc_request_cap', type: 'function_call', call_id: 'call_request_cap', name: 'harness_workspace_read',
      arguments: '{"path":"notes.txt"}', status: 'completed',
    }]));
    const f = fixture();
    const config = parseConfig({ ...f.config, limits: { ...f.config.limits, maxRequests: 1 }, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); approve(app);
    try {
      const result = await app.submit('Exercise the exact synthetic model request cap.');
      expect(result.status).toBe('failed'); expect(result.reason).toContain('request cap');
      expect(endpoint.requests).toHaveLength(1);
      expect(app.inspect().actions.filter(action => action.tool === 'workspace_read')).toHaveLength(1);
      expect(result.usage.requests).toBe(1);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);
});

describe('SDK-first configuration and optional accounting', () => {
  it('omits task and provider token limits for new launches and rejects ambiguous limit sentinels', () => {
    const f = fixture({ version: 3 });
    try {
      const config = loadConfig(undefined, { workspace: f.workspace, dataDir: f.dataDir, model: f.config.model });
      expect(config.version).toBe(3);
      expect(config.model.contextTokens).toBeUndefined();
      expect(config.model.outputTokens).toBeUndefined();
      expect(config.limits.maxTokens).toBeUndefined();
      expect(config.limits.maxCost).toBeUndefined();
      for (const value of [0, null, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parseConfig({ ...config, limits: { ...config.limits, maxTokens: value } })).toThrow();
        expect(() => parseConfig({ ...config, model: { ...config.model, contextTokens: value } })).toThrow();
        expect(() => parseConfig({ ...config, model: { ...config.model, outputTokens: value } })).toThrow();
      }
    } finally { f.cleanup(); }
  });
  it.each([2, 3])('preserves version-%i saved policy and digest across cold resume and rejects tampering', async version => {
    const f = fixture({ version });
    const runtimeFactory = () => new ScriptRuntime(async runtime => runtime.message('Saved policy preserved.'));
    let app = await SessionController.open({ config: f.config, runtimeFactory }); const id = app.id;
    try {
      await app.submit('Preserve the saved configuration.');
      if (version === 2) {
        expect(app.config.model).toMatchObject({ contextTokens: 32000, outputTokens: 2048 });
        expect(app.config.limits.maxTokens).toBe(100000);
      }
      const digest = hash(app.config);
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory });
      expect(hash(app.store.session(id).config)).toBe(digest);
      const saved = app.store.db.prepare<[string], { config: string; digest: string }>('SELECT config,digest FROM sessions WHERE id=?').get(id)!;
      expect(saved.digest).toBe(digest);
      app.store.db.prepare('UPDATE sessions SET config=? WHERE id=?').run(JSON.stringify({ ...f.config, readOnly: !f.config.readOnly }), id);
      expect(() => app.store.session(id)).toThrow('incompatible');
    } finally { await app.close(); f.cleanup(); }
  });
  it('accounts above 100,000 without hashing input, consulting prefix anchors or reserving tokens', async () => {
    const f = fixture({ version: 3 });
    const runtime = new ScriptRuntime(async runtime => {
      for (let index = 0; index < 2; index++) {
        const request = app.resources.beginModelRequest(2000000, 'conversation-agent', {
          frameHash: 'not-an-accounting-anchor',
          items: [{ toJSON: () => { throw new Error('Uncapped input must not be fingerprinted.'); } }],
        }, null);
        expect(request).toMatchObject({ reservation: 0, status: 'started', budgetScope: 'none' });
        expect(request.inputBound).toBeUndefined();
        expect(request.inputFingerprint).toBeUndefined();
        expect(app.inspect().pendingModelRequests).toBe(1);
        app.resources.settle(request, { input: 64000, output: 4000 });
        app.resources.settle(request, { input: 64000, output: 4000 });
      }
      runtime.message('Actual usage is counted once without a cumulative quota.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const anchor = vi.spyOn(app.store, 'reportedModelAnchor').mockImplementation(() => { throw new Error('No prefix lookup is permitted.'); });
    try {
      const objective = await app.submit('Exercise uncapped accounting.');
      expect(objective.status, objective.reason ?? '').toBe('completed');
      expect(objective.usage).toMatchObject({ input: 128000, output: 8000, reserved: 0, requests: 2, unknown: false });
      expect(anchor).not.toHaveBeenCalled();
      expect(app.inspect().pendingModelRequests).toBe(0);
    } finally { anchor.mockRestore(); await app.close(); f.cleanup(); }
  });
  it('blocks pending uncapped requests, recovers them on restart and keeps billing uncertainty after explicit effect reconciliation', async () => {
    const f = fixture({ version: 3, limits: { inputPerMillion: 1, outputPerMillion: 2 } });
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async runtime => {
      app.resources.beginModelRequest(100, 'interrupted', undefined, null);
      runtime.message('An unfinished request cannot count as completion.');
    }) });
    const id = app.id;
    try {
      const first = await app.submit('Recover the same interrupted objective.');
      expect(first.status).toBe('recovery_required');
      expect(first.usage.reserved).toBe(0);
      expect(app.inspect().pendingModelRequests).toBe(1);
      await expect(app.reconcile({ note: 'Still pending.' })).rejects.toThrow('Pending model');
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id,
        runtimeFactory: () => new ScriptRuntime(async runtime => runtime.message('External state was inspected; billing remains unknown.')) });
      expect(app.inspect().pendingModelRequests).toBe(0);
      expect(app.inspect().objective?.usage).toMatchObject({ unknown: true, cost: null, requests: 1 });
      expect(app.store.list('model', id, first.id)[0]?.status).toBe('unknown');
      await app.reconcile({ note: 'No external effects require replay; the provider did not report billing.' });
      const continued = await app.continueObjective();
      expect(continued).toMatchObject({ id: first.id, deadline: first.deadline, status: 'completed',
        usage: { unknown: true, cost: null, requests: 1 } });
    } finally { await app.close(); f.cleanup(); }
  });
});
