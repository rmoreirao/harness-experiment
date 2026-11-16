import { z } from 'zod';
import { describe, it, expect, vi } from 'vitest';
import { V2Controller } from '../../src/v2/controller.js';
import { ProtectedNetwork } from '../../src/v2/network.js';
import { parseV2Config } from '../../src/v2/config.js';
import { fixture, ScriptRuntime, approve } from './helpers.js';
import { httpFixture } from '../mcp-fixture.js';

describe('V2 A01/A06 integration trust and A07 paid tool admission', () => {
  it.each(['https://example.com', '*'])('does not turn an allowed public-read origin into automatic query/export approval (%s)', async allowed => {
    const f = fixture({ network: { origins: [allowed] } });
    let effects = 0; let decisions = 0;
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('fixture_fetch', { url: 'https://example.com/document' });
      await expect(runtime.call('fixture_fetch', { url: 'https://example.com/collect?data=synthetic' })).rejects.toThrow('denied');
      runtime.message('The query/export action was denied; only the scoped retrieval executed.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    app.broker.register('fixture_fetch', 'Synthetic protected-origin policy fixture.', z.object({ url: z.string().url() }).strict(),
      'network', () => { effects++; return { synthetic: true }; }, args => ({ origins: [new URL(String(args.url)).origin] }));
    app.broker.grant([], ['https://example.com'], Date.now() + 60000);
    app.subscribe(event => { if (event.type === 'request') decisions++; }); approve(app, 'deny');
    try {
      expect((await app.submit('Exercise the exact synthetic read/export boundary.')).status).toBe('partial');
      expect(effects).toBe(1); expect(decisions).toBe(1);
    } finally { await app.close(); f.cleanup(); }
  });

  it('keeps tool approvals and exact trusted-read grants separate from wildcard reachability', async () => {
    const f = fixture({ network: { origins: ['*'] } });
    let effects = 0; let decisions = 0;
    const runtime = new ScriptRuntime(async runtime => {
      await expect(runtime.call('fixture_fetch', { url: 'https://example.com/document' })).rejects.toThrow('denied');
      runtime.message('Wildcard reachability did not authorize the action.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    app.broker.register('fixture_fetch', 'Synthetic wildcard approval fixture.', z.object({ url: z.string().url() }).strict(),
      'network', () => { effects++; return { synthetic: true }; }, args => ({ origins: [new URL(String(args.url)).origin] }));
    app.subscribe(event => { if (event.type === 'request') decisions++; }); approve(app, 'deny');
    try {
      expect(() => app.broker.grant([], ['*'], Date.now() + 60000)).toThrow('exact');
      expect((await app.submit('Exercise explicit authorization under wildcard reachability.')).status).toBe('partial');
      expect(effects).toBe(0); expect(decisions).toBe(1); expect(app.inspect().grants).toHaveLength(0);
    } finally { await app.close(); f.cleanup(); }
  });

  it('approves exact no-auth MCP calls through the V2 broker and denies calls without connecting or executing', async () => {
    const http = await httpFixture(); const origin = new URL(http.url).origin;
    const f = fixture({ network: { localFixtureOrigins: [origin] }, mcp: [{ name: 'fixture', url: http.url, tools: ['echo'], trusted: true }] });
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('mcp_fixture_echo', { arguments: { text: 'Synthetic V2 MCP evidence.' } });
      runtime.message('The exact approved no-auth call returned its result.');
    });
    let app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime }); approve(app, 'deny');
    try {
      await app.submit('Deny the synthetic MCP action.'); expect(http.calls()).toBe(0);
      await app.close();
      app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
      const result = await app.submit('Approve the synthetic MCP action.');
      expect(result.status, result.reason ?? '').toBe('completed'); expect(http.calls()).toBe(1);
      expect(app.inspect().actions.find(action => action.tool === 'mcp_fixture_echo')?.status).toBe('completed');
    } finally { await app.close(); http.server.closeAllConnections(); await new Promise<void>(resolve => http.server.close(() => resolve())); f.cleanup(); }
  });
  it('enforces dispatch concurrency and revokes queued trusted reads before effects', async () => {
    const f = fixture({ limits: { concurrency: 1 } });
    let active = 0; let maximum = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const runtime = new ScriptRuntime(async runtime => {
      const first = runtime.call('fixture_read', { number: 1 });
      await firstEntered;
      const second = runtime.call('fixture_read', { number: 2 });
      app.broker.revoke(grant); release();
      await first; await expect(second).rejects.toThrow('revoked');
      runtime.message('The occupied slot completed; the queued revoked read did not execute.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    const grant = app.broker.grant([f.workspace], [], Date.now() + 60000);
    app.broker.register('fixture_read', 'Synthetic bounded concurrency fixture.', z.object({ number: z.number() }).strict(), 'read',
      async args => { active++; maximum = Math.max(maximum, active); entered(); await blocked; active--; return args; },
      () => ({ paths: ['notes.txt'] }));
    try {
      expect((await app.submit('Exercise real dispatch admission.')).status).toBe('partial');
      expect(maximum).toBe(1);
      expect(app.inspect().actions.filter(action => action.status === 'completed')).toHaveLength(1);
    } finally { await app.close(); f.cleanup(); }
  });
  it('reserves an explicit search charge before dispatch and refuses unknown/excess charges without any request', async () => {
    const f = fixture({
      network: { origins: ['https://api.search.brave.com'] },
      search: { provider: 'brave', costPerRequest: 0.02 },
      limits: { maxCost: 0.03, inputPerMillion: 1, outputPerMillion: 1 },
    });
    let requests = 0;
    const fetch = vi.spyOn(ProtectedNetwork.prototype, 'retrieve').mockImplementation(async url => {
      requests++; expect(url).toContain('q=Synthetic');
      return { url, finalUrl: url, status: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ web: { results: [{ title: 'Synthetic search hit', url: 'https://example.com', description: 'Unretrieved snippet.' }] } })), redirects: [] };
    });
    const runtime = new ScriptRuntime(async runtime => {
      const first = await runtime.call('web_search', { query: 'Synthetic' });
      expect(first.evidence).toBe(false); expect(app.inspect().objective?.usage.cost).toBe(0.02);
      await expect(runtime.call('web_search', { query: 'Synthetic again' })).rejects.toThrow('remaining currency');
      runtime.message('One explicitly priced synthetic search; no fabricated retrieved evidence.');
    });
    const app = await V2Controller.open({ config: f.config, searchKey: 'synthetic-search-key', runtimeFactory: () => runtime }); approve(app);
    let unknown: V2Controller | undefined;
    try {
      expect((await app.submit('Exercise synthetic search charge admission.')).status).toBe('partial');
      expect(requests).toBe(1);
      const noPrice = new ScriptRuntime(async runtime => {
        await expect(runtime.call('web_search', { query: 'Synthetic unknown price' })).rejects.toThrow('explicit upper-bound');
        runtime.message('The unknown-priced tool did not run.');
      });
      unknown = await V2Controller.open({ config: { ...f.config, search: { provider: 'brave' } }, searchKey: 'synthetic-search-key', runtimeFactory: () => noPrice });
      approve(unknown);
      expect((await unknown.submit('Refuse an unknown tool charge.')).status).toBe('partial');
      expect(requests).toBe(1);
    } finally { await unknown?.close(); await app.close(); fetch.mockRestore(); f.cleanup(); }
  });
  it.each([true, false])('reconciles model billing without losing priced searches or inventing unknown tool charges (priced: %s)', async priced => {
    const f = fixture({
      version: 3, network: { origins: ['https://api.search.brave.com'] },
      search: { provider: 'brave', ...(priced ? { costPerRequest: 0.02 } : {}) },
      limits: { ...(priced ? { maxCost: 1 } : { maxTokens: 100000 }), inputPerMillion: 2, outputPerMillion: 3 },
    });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, outputTokens: 128 } });
    const fetch = vi.spyOn(ProtectedNetwork.prototype, 'retrieve').mockImplementation(async url => ({
      url, finalUrl: url, status: 200, headers: {}, body: Buffer.from('{"web":{"results":[]}}'), redirects: [],
    }));
    const runtime = new ScriptRuntime(async runtime => {
      app.resources.settle(app.resources.beginModelRequest(100, 'known'), { input: 10, output: 2 });
      await runtime.call('web_search', { query: 'Synthetic charge accounting' });
      app.resources.settle(app.resources.beginModelRequest(100, 'missing'));
      runtime.message('Model billing requires explicit reconciliation.');
    });
    const app = await V2Controller.open({ config, searchKey: 'synthetic-search-key', runtimeFactory: () => runtime }); approve(app);
    try {
      const objective = await app.submit('Preserve known and unknown tool charges.');
      expect(objective.status).toBe('recovery_required');
      expect(objective.usage.cost).toBeNull();
      const request = app.store.list('model', app.id, objective.id).find(request => request.status === 'unknown')!;
      await app.reconcile({ note: 'Provider confirms the missing model usage.', usage: [{ id: request.id, input: 20, output: 4 }] });
      const usage = app.inspect().objective!.usage;
      expect(usage).toMatchObject({ input: 30, output: 6, unknown: false });
      if (priced) expect(usage.cost).toBeCloseTo(0.020078, 10);
      else expect(usage.cost).toBeNull();
      expect(app.inspect().actions.find(action => action.tool === 'web_search')?.cost).toBe(priced ? 0.02 : null);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await app.close(); fetch.mockRestore(); f.cleanup(); }
  });
});
