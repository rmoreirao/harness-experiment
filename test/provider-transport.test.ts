import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CopilotRequestContext, SessionEvent } from '@github/copilot-sdk';
import { ControlledModelTransport } from '../src/provider-transport.js';
import { resourceFixture } from './resource-fixture.js';

class FixtureTransport extends ControlledModelTransport {
  post(request: Request, context: CopilotRequestContext): Promise<Response> { return this.sendRequest(request, context); }
}

function context(requestId: string, url: string, agentId?: string): CopilotRequestContext {
  return { requestId, url, agentId, interactionType: 'conversation-agent', transport: 'http',
    headers: {}, signal: new AbortController().signal };
}
function usage(id: string, input: number, output: number, agentId?: string): Extract<SessionEvent, { type: 'assistant.usage' }> {
  return { id, type: 'assistant.usage', parentId: null, timestamp: '2026-11-19T09:00:00.000Z',
    ...(agentId ? { agentId } : {}), data: {
      model: 'gpt-6.1-sol', inputTokens: input, outputTokens: output, interactionType: 'conversation-agent',
      apiCallId: id, accounting: { sourceSessionId: agentId ?? 'sdk-parent', sequence: 1, usageId: id },
    } } as Extract<SessionEvent, { type: 'assistant.usage' }>;
}
afterEach(() => vi.unstubAllGlobals());

describe('Native provider transport accounting', () => {
  it('counts BYOK wire usage once and ignores duplicate SDK observations for parent and workers', async () => {
    const f = resourceFixture({ limits: { inputPerMillion: 1, outputPerMillion: 2 },
      models: [{ id: 'worker-model', wire: 'worker-wire', inputPerMillion: 3, outputPerMillion: 4 }] });
    const reports = [{ input: 100, output: 20 }, { input: 30, output: 4 }, { input: 50, output: 6 }];
    let responseIndex = 0;
    const fetch = vi.fn(async () => {
      const report = reports[responseIndex++]!;
      return Response.json({ usage: { input_tokens: report.input, output_tokens: report.output } });
    });
    vi.stubGlobal('fetch', fetch);
    const transport = new FixtureTransport(f.config, 'SYNTHETIC_KEY', f.resources, () => new AbortController().signal, () => {});
    try {
      const url = 'http://127.0.0.1:9/v1/responses';
      for (let index = 0; index < 3; index++) {
        const actor = index === 0 ? undefined : `worker-${index}`;
        const response = await transport.post(new Request(url, { method: 'POST',
          body: JSON.stringify({ model: index === 0 ? 'synthetic-deployment' : 'worker-wire', input: [] }) }),
        context(`request-${index}`, url, actor));
        await response.text();
        transport.observeUsage(usage(`duplicate-${index}`, 999, 999, actor));
      }
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(f.resources.current().usage).toMatchObject({ input: 180, output: 30, requests: 3, reserved: 0, unknown: false });
      expect(f.resources.current().usage.cost).toBeCloseTo(0.00042, 12);
      expect(f.store.list('model', f.sessionId).map(request => [request.actorId, request.model, request.status])).toEqual([
        [undefined, 'gpt-6.1-sol', 'completed'], ['worker-1', 'worker-model', 'completed'], ['worker-2', 'worker-model', 'completed'],
      ]);
    } finally { transport.reconcile('Fixture cleanup.'); f.cleanup(); }
  });

  it('deduplicates Copilot accounting identities without settling the next worker request', async () => {
    const f = resourceFixture({ provider: { kind: 'copilot' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ output: [] })));
    const transport = new FixtureTransport(f.config, '', f.resources, () => new AbortController().signal, () => {});
    const url = 'https://copilot.example.invalid/responses';
    const send = async (id: string, actor?: string) => {
      const response = await transport.post(new Request(url, { method: 'POST',
        body: JSON.stringify({ model: 'synthetic-deployment', input: [] }) }), context(id, url, actor));
      await response.text();
    };
    try {
      await send('parent');
      await send('worker-one', 'worker');
      const firstWorker = usage('worker-accounting-one', 30, 4, 'worker');
      transport.observeUsage(firstWorker);
      await send('worker-two', 'worker');
      transport.observeUsage({ ...firstWorker, id: 'different-delivery-id' });
      expect(f.resources.pending()).toHaveLength(2);
      expect(f.resources.current().usage).toMatchObject({ input: 30, output: 4, requests: 3 });
      transport.observeUsage(usage('parent-accounting', 100, 20));
      transport.observeUsage(usage('worker-accounting-two', 50, 6, 'worker'));
      expect(f.resources.current().usage).toMatchObject({ input: 180, output: 30, requests: 3, cost: null, unknown: false });
      expect(f.resources.pending()).toEqual([]);
    } finally { transport.reconcile('Fixture cleanup.'); f.cleanup(); }
  });

  it('does not attribute unmatched worker usage to the parent or invent missing consumption', async () => {
    const f = resourceFixture({ provider: { kind: 'copilot' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ output: [] })));
    const transport = new FixtureTransport(f.config, '', f.resources, () => new AbortController().signal, () => {});
    const url = 'https://copilot.example.invalid/responses';
    try {
      const response = await transport.post(new Request(url, { method: 'POST',
        body: '{"model":"synthetic-deployment","input":[]}' }), context('parent', url));
      await response.text();
      transport.observeUsage(usage('unmatched-worker', 100, 20, 'wrong-worker'));
      expect(f.resources.pending()).toHaveLength(1);
      expect(f.resources.current().usage).toMatchObject({ input: 0, output: 0, requests: 1 });
      transport.reconcile('Runtime ended without reporting this request usage.');
      expect(f.resources.current().usage).toMatchObject({ unknown: true, cost: null, reserved: 0 });
      expect(f.store.list('model', f.sessionId)[0]).toMatchObject({ status: 'unknown', reportedUsage: false });
    } finally { f.cleanup(); }
  });

  it.each(['wrong destination', 'unknown wire model'])('rejects BYOK %s before any fallback dispatch', async invalid => {
    const f = resourceFixture();
    const fetch = vi.fn(async () => Response.json({ usage: { input_tokens: 100, output_tokens: 20 } }));
    vi.stubGlobal('fetch', fetch);
    const transport = new FixtureTransport(f.config, 'SYNTHETIC_KEY', f.resources, () => new AbortController().signal, () => {});
    const url = invalid === 'wrong destination' ? 'https://other.example.invalid/responses' : 'http://127.0.0.1:9/v1/responses';
    try {
      const response = await transport.post(new Request(url, { method: 'POST',
        body: JSON.stringify({ model: invalid === 'unknown wire model' ? 'unconfigured-model' : 'synthetic-deployment', input: [] }) }),
      context('rejected', url));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: {
        code: invalid === 'wrong destination' ? 'MODEL_DESTINATION' : 'MODEL_IDENTITY',
      } });
      expect(fetch).not.toHaveBeenCalled();
      expect(f.resources.current().usage.requests).toBe(0);
    } finally { f.cleanup(); }
  });

  it('reads compressed Copilot admission metadata while preserving the original wire body', async () => {
    const f = resourceFixture({ provider: { kind: 'copilot' } });
    const encoded = gzipSync(Buffer.from('{"model":"synthetic-deployment","input":[]}'));
    const received: Buffer[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      received.push(Buffer.from(await request.arrayBuffer()));
      expect(request.headers.get('content-encoding')).toBe('gzip');
      return Response.json({ output: [] });
    }));
    const transport = new FixtureTransport(f.config, '', f.resources, () => new AbortController().signal, () => {});
    const url = 'https://copilot.example.invalid/responses';
    try {
      const response = await transport.post(new Request(url, { method: 'POST', body: encoded,
        headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' } }), context('compressed', url));
      await response.text();
      expect(received).toEqual([encoded]);
      expect(f.store.list('model', f.sessionId)[0]).toMatchObject({
        model: 'gpt-6.1-sol', wireModel: 'synthetic-deployment', provider: 'copilot', status: 'started',
      });
    } finally { transport.reconcile('Fixture cleanup.'); f.cleanup(); }
  });

  it('parses multiline SSE usage without inventing zero output for incomplete reports', async () => {
    const f = resourceFixture();
    const complete = 'data: {"type":"response.completed",\ndata: "response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n';
    const incomplete = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10}}}\n\n';
    const fetch = vi.fn().mockResolvedValueOnce(new Response(complete, { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(incomplete, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const transport = new FixtureTransport(f.config, 'SYNTHETIC_KEY', f.resources, () => new AbortController().signal, () => {});
    const url = 'http://127.0.0.1:9/v1/responses';
    try {
      for (const id of ['complete', 'incomplete']) {
        const response = await transport.post(new Request(url, { method: 'POST',
          body: '{"model":"synthetic-deployment","input":[]}' }), context(id, url));
        await response.text();
      }
      expect(f.resources.current().usage).toMatchObject({ input: 10, output: 2, requests: 2, cost: null, unknown: true });
      expect(f.store.list('model', f.sessionId).map(request => [request.status, request.reportedUsage])).toEqual([
        ['completed', true], ['unknown', false],
      ]);
    } finally { f.cleanup(); }
  });
});
