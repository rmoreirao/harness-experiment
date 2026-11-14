import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SessionController } from '../src/controller.js';
import { parseConfig } from '../src/config.js';
import { record } from '../src/contracts.js';
import { fixture, approveAll } from './helpers.js';
import { complete, message, provider, providerKey as key } from './provider-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function credentials(): () => void {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = key;
  return () => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; };
}
it('uses the real OpenAI Responses client for streaming tool calls, checkpoint restart and separate approvals', async () => {
  const restore = credentials();
  const endpoint = await provider((res, _body, count) => {
    if (count === 1) complete(res, 'resp_read', [{ id: 'fc_read', type: 'function_call', status: 'completed',
      call_id: 'wire-read', name: 'read_documents', arguments: '{"paths":["notes.md"]}' }]);
    else if (count === 2) complete(res, 'resp_write', [{ id: 'fc_write', type: 'function_call', status: 'completed',
      call_id: 'wire-write', name: 'write_file', arguments: JSON.stringify({
        path: 'summary.md', content: 'Launch: Monday. Source: notes.md.', expectedHash: 'new',
      }) }]);
    else complete(res, 'resp_final', message('Summary saved with source notes.md.'), 'Summary saved with source notes.md.');
  });
  const f = fixture(); cleanup.push(f.cleanup);
  const config = parseConfig({ ...f.config, mode: 'openai', model: 'wire-fixture', baseURL: endpoint.baseURL });
  let app = await SessionController.open({ config });
  const streamed: string[] = [];
  try {
    const run = await app.submit('Read notes.md and save a summary.');
    expect(run.status, run.reason ?? '').toBe('awaiting_approval');
    expect(app.inspect().pending[0]?.tool).toBe('read_documents');
    const id = app.id;
    await app.close();
    app = await SessionController.open({ config, sessionId: id });
    app.subscribe(e => { if (e.type === 'text') streamed.push(String(e.data.delta)); });
    const read = app.inspect().pending[0]!;
    await app.respond(read.id, read.revision, 'approve');
    expect(app.inspect().pending[0]?.tool).toBe('write_file');
    expect(existsSync(path.join(config.workspace, 'summary.md'))).toBe(false);
    await approveAll(app);
    expect(app.inspect().run?.status, app.inspect().run?.reason ?? '').toBe('completed');
    expect(readFileSync(path.join(config.workspace, 'summary.md'), 'utf8')).toContain('Monday');
    expect(streamed.join('')).toContain('Summary saved');
    expect(endpoint.requests).toHaveLength(3);
    expect(endpoint.requests.every(r => r.store === false && r.stream === true)).toBe(true);
    expect(endpoint.requests.slice(1).every(r => Array.isArray(r.input) && r.input.some(i => record(i) && i.type === 'function_call_output'))).toBe(true);
    expect(JSON.stringify(app.store.trace(run.id))).not.toContain(key);
  } finally { await app.close(); await endpoint.close(); restore(); }
});
it('does not silently retry authentication failures or treat them as successful output', async () => {
  const restore = credentials();
  const endpoint = await provider(res => { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    error: { message: 'Synthetic authentication failure', type: 'authentication_error' },
  })); });
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: parseConfig({ ...f.config, mode: 'openai', model: 'wire-fixture', baseURL: endpoint.baseURL }) });
  try {
    const run = await app.submit('hello');
    expect(run.status).toBe('interrupted');
    expect(run.reason).toContain('401');
    expect(endpoint.requests).toHaveLength(1);
    expect(run.finalOutput).toBeNull();
  } finally { await app.close(); await endpoint.close(); restore(); }
});
it('fails closed when the provider omits token accounting', async () => {
  const restore = credentials();
  const endpoint = await provider(res => complete(res, 'resp_no_usage', message('Unaccounted output.'), 'Unaccounted output.', false));
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: parseConfig({ ...f.config, mode: 'openai', model: 'wire-fixture', baseURL: endpoint.baseURL }) });
  try {
    const run = await app.submit('hello');
    expect(run.status).toBe('interrupted');
    expect(run.usage.unknown).toBe(true);
    expect(run.reason).toMatch(/token accounting/i);
  } finally { await app.close(); await endpoint.close(); restore(); }
});
it('closes a cancelled approval call in provider history before accepting the next request', async () => {
  const restore = credentials();
  const endpoint = await provider((res, body, count) => {
    if (count === 1) complete(res, 'resp_wait', [{
      id: 'fc_wait', type: 'function_call', status: 'completed', call_id: 'cancelled-read',
      name: 'read_documents', arguments: '{"paths":["notes.md"]}',
    }]);
    else {
      const items = Array.isArray(body.input) ? body.input : [];
      const result = items.find(i => record(i) && i.type === 'function_call_output' && i.call_id === 'cancelled-read');
      if (!record(result) || !JSON.stringify(result.output).includes('cancelled')) {
        res.writeHead(400).end('Unanswered function call in history.'); return;
      }
      complete(res, 'resp_followup', message('The cancelled read was not executed.'), 'The cancelled read was not executed.');
    }
  });
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: parseConfig({ ...f.config, mode: 'openai', model: 'wire-fixture', baseURL: endpoint.baseURL }) });
  try {
    const first = await app.submit('Read notes.md.');
    expect(first.status).toBe('awaiting_approval');
    app.cancel();
    const run = await app.submit('Acknowledge cancellation without reading any files.');
    expect(run.status, run.reason ?? '').toBe('completed');
    expect(app.store.invocations(first.id)).toHaveLength(0);
    expect(app.inspect().pending).toHaveLength(0);
  } finally { await app.close(); await endpoint.close(); restore(); }
});
