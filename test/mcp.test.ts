import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionController } from '../src/controller.js';
import { FakeModel } from '../src/model.js';
import { fixture, approveAll } from './helpers.js';
import { httpFixture } from './mcp-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function mcpModel(name: string) {
  return new FakeModel(request => {
    const items = Array.isArray(request.input) ? request.input : [];
    const start = items.findLastIndex(i => 'role' in i && i.role === 'user');
    return items.slice(start + 1).some(i => i.type === 'function_call_result') ? [{
    type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'MCP fixture completed.' }],
    }] : [{ type: 'function_call', name, callId: 'mcp-1', arguments: '{"text":"synthetic"}', status: 'completed' }];
  });
}
it('gates Streamable HTTP MCP invocation on approval through the shared journal', async () => {
  const http = await httpFixture();
  const f = fixture({ mcp: [{ name: 'fixture', transport: 'http', url: http.url, tools: ['echo'], trusted: true }] });
  cleanup.push(f.cleanup);
  let app: SessionController | undefined;
  try {
    app = await SessionController.open({ config: f.config, model: mcpModel('mcp_fixture_echo') });
    const run = await app.submit('use the fixture');
    expect(run.status, run.reason ?? '').toBe('awaiting_approval');
    expect(http.calls()).toBe(0);
    await approveAll(app);
    expect(app.inspect().run?.status, app.inspect().run?.reason ?? '').toBe('completed');
    expect(http.calls()).toBe(1);
    expect(app.store.invocations(run.id)[0]?.status).toBe('completed');
  } finally { await app?.close(); await new Promise<void>(resolve => http.server.close(() => resolve())); }
});
it('does not execute a denied stdio MCP call or leak provider credentials into its process', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const counter = path.join(f.root, 'calls.txt');
  const file = fileURLToPath(new URL('./mcp-fixture.ts', import.meta.url));
  const config = { ...f.config, mcp: [{
    name: 'fixture', transport: 'stdio' as const, command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), file, '--stdio', counter],
    tools: ['echo'], trusted: true as const,
  }] };
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-provider-only-key';
  let app: SessionController | undefined;
  try {
    app = await SessionController.open({ config, model: mcpModel('mcp_fixture_echo') });
    await app.submit('fixture');
    const pending = app.inspect().pending[0]!;
    await app.respond(pending.id, pending.revision, 'reject');
    expect(existsSync(counter)).toBe(false);
    await app.submit('try a new explicitly approved fixture call');
    await approveAll(app);
    expect(readFileSync(counter, 'utf8')).toBe('called\n');
    const result = app.store.invocations(app.inspect().run!.id)[0]?.output;
    expect(result).toContain('"providerKeyInherited":false');
  } finally {
    await app?.close();
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});
it('terminates an owned stdio server on cancellation and can reconnect after explicit reconciliation', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const config = { ...f.config, mcp: [{
    name: 'fixture', transport: 'stdio' as const, command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./mcp-fixture.ts', import.meta.url)), '--stdio'],
    tools: ['slow'], trusted: true as const,
  }] };
  const app = await SessionController.open({ config, model: mcpModel('mcp_fixture_slow') });
  try {
    await app.submit('slow operation');
    const request = app.inspect().pending[0]!;
    let started: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const unsubscribe = app.subscribe(event => { if (event.type === 'tool' && event.data.status === 'started') started?.(); });
    const running = app.respond(request.id, request.revision, 'approve');
    await ready;
    app.cancel();
    const result = await running;
    unsubscribe();
    expect(result.status).toBe('interrupted');
    await app.reconcile('Synthetic operation was cancelled and its server process terminated.');
    const next = await app.submit('new operation');
    expect(next.status, next.reason ?? '').toBe('awaiting_approval');
  } finally { await app.close(); }
});
