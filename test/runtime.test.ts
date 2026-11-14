import { afterEach, expect, it } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SessionController } from '../src/controller.js';
import { FakeModel, type FakeHandler } from '../src/model.js';
import { fixture, approveAll, worker } from './helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const echo: FakeHandler = () => [{ role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Verified output.' }] }];

it('runs independent sessions concurrently and refuses a second owner', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const a = await SessionController.open({ config: f.config });
  const b = await SessionController.open({ config: f.config });
  try {
    await expect(SessionController.open({ config: f.config, sessionId: a.id })).rejects.toThrow('owned');
    const [ra, rb] = await Promise.all([a.submit('alpha'), b.submit('beta')]);
    expect(ra.status).toBe('completed'); expect(rb.status).toBe('completed');
    expect(a.store.transcript(a.id).some(m => m.text.includes('beta'))).toBe(false);
    expect(b.store.transcript(b.id).some(m => m.text.includes('alpha'))).toBe(false);
    expect(b.store.transcript(b.id).some(m => m.text.includes('overlapping'))).toBe(true);
  } finally { await a.close(); await b.close(); }
});
it('restores a clarification question and rejects stale/cross-session decisions', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  let app = await SessionController.open({ config: f.config });
  try {
    await app.submit('Ask me a clarification.');
    const q = app.inspect().pending[0]!;
    const id = app.id;
    expect(app.inspect().run?.status).toBe('awaiting_input');
    await expect(app.respond(q.id, q.revision + 1, { answer: 'launch' })).rejects.toThrow('current');
    await app.close();
    app = await SessionController.open({ config: f.config, sessionId: id });
    await app.respond(q.id, q.revision, { answer: 'launch' });
    expect(app.inspect().run?.status).toBe('completed');
    expect(app.inspect().run?.finalOutput).toContain('launch');
    await expect(app.respond(q.id, q.revision, { answer: 'again' })).rejects.toThrow('current');
  } finally { await app.close(); }
});
it('does not save after save rejection and does not overwrite existing output', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config });
  try {
    await app.submit('Summarize documents and save.');
    let q = app.inspect().pending[0]!;
    await app.respond(q.id, q.revision, 'approve');
    q = app.inspect().pending[0]!;
    await app.respond(q.id, q.revision, 'reject');
    expect(existsSync(path.join(f.config.workspace, 'summary.md'))).toBe(false);
    expect(app.inspect().run?.status).toBe('partial');
  } finally { await app.close(); }
});
it('detects an actual external effect interrupted before its outcome and never repeats it', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const configFile = path.join(f.root, 'config.json');
  const effect = path.join(f.root, 'effect.txt');
  writeFileSync(configFile, JSON.stringify(f.config));
  const { child, line } = await worker(['effect-crash', configFile, effect]);
  if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
  const { sessionId } = JSON.parse(line) as { sessionId: string };
  const app = await SessionController.open({ config: f.config, sessionId });
  try {
    expect(readFileSync(effect, 'utf8')).toBe('one effect');
    expect(app.inspect().run?.status).toBe('interrupted');
    await expect(app.submit('repeat')).rejects.toThrow('Resolve');
    expect(app.store.invocations(app.inspect().run!.id)[0]?.status).toBe('unknown');
    await app.reconcile('Checked the external effect; it completed once.');
    expect((await app.submit('continue with new work')).status).toBe('completed');
    expect(readFileSync(effect, 'utf8')).toBe('one effect');
  } finally { await app.close(); }
});
it('cancels model work and keeps the conversation usable', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config, model: new FakeModel(echo, 80) });
  try {
    const promise = app.submit('hello');
    await new Promise(resolve => setTimeout(resolve, 20));
    app.cancel();
    const run = await promise;
    expect(run.status, run.reason ?? '').toBe('cancelled');
    expect((await app.submit('after cancel')).status).toBe('completed');
  } finally { await app.close(); }
});
it('enforces token and elapsed-time admission with explicit stop reasons', async () => {
  for (const limits of [{ maxTokens: 128 }, { activeTimeoutMs: 100 }]) {
    const f = fixture({ limits }); cleanup.push(f.cleanup);
    const app = await SessionController.open({ config: f.config, model: new FakeModel(echo, 200) });
    try {
      const run = await app.submit('hello');
      expect(['failed', 'cancelled']).toContain(run.status);
      expect(run.reason).toMatch(/budget|timeout/i);
    } finally { await app.close(); }
  }
});
it('validates structured outputs and application-specific completion', async () => {
  const f = fixture({ outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config, model: new FakeModel(echo),
    validators: [() => 'Reference sources were not verified.'] });
  try {
    const run = await app.submit('hello');
    expect(run.status).toBe('partial');
    expect(run.reason).toContain('JSON');
    expect(run.reason).toContain('sources');
  } finally { await app.close(); }
});
it('compacts working history without deleting transcript or authoritative tasks', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config, model: new FakeModel(echo) });
  try {
    for (let i = 0; i < 12; i++) {
      await app.session.addItems([i % 2 ? {
        type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'prior conversation '.repeat(80) }],
      } : { type: 'message', role: 'user', content: 'prior conversation '.repeat(80) }]);
      app.store.addTranscript(app.id, null, 'user', `original ${i}`);
    }
    app.store.setTasks(app.id, [{ id: 'preserved', title: 'Preserve instructions and tasks', status: 'done' }]);
    await app.compact();
    expect((await app.session.getItems()).length).toBeLessThan(12);
    expect(app.store.transcript(app.id)).toHaveLength(12);
    expect(app.store.tasks(app.id)[0]?.id).toBe('preserved');
    expect((await app.submit('continue')).status).toBe('completed');
  } finally { await app.close(); }
});
it('does not expose a credential in transcript or checkpoints', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-key-do-not-store';
  const app = await SessionController.open({ config: f.config });
  try {
    await app.submit('summarize documents synthetic-key-do-not-store');
    await approveAll(app);
    const persisted = JSON.stringify({ history: await app.session.getItems(), run: app.inspect().run, transcript: app.store.transcript(app.id) });
    expect(persisted).not.toContain('synthetic-key-do-not-store');
  } finally { await app.close(); if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
it('replays a durably accepted decision after a crash before SDK continuation', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  let app = await SessionController.open({ config: f.config });
  try {
    await app.submit('Read documents, summarize and save.');
    const pending = app.inspect().pending[0]!;
    app.store.putRequest({ ...pending, status: 'approved' });
    const id = app.id;
    await app.close();
    app = await SessionController.open({ config: f.config, sessionId: id });
    await app.continueRun();
    expect(app.inspect().pending[0]?.tool).toBe('write_file');
    expect(app.store.invocations(app.inspect().run!.id).filter(i => i.tool === 'read_documents')).toHaveLength(1);
  } finally { await app.close(); }
});
it('fails closed on a changed tool checkpoint without recording an approval or reading documents', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config });
  try {
    const run = await app.submit('Read documents, summarize and save.');
    const checkpoint = JSON.parse(run.checkpoint!) as { toolsHash: string };
    checkpoint.toolsHash = 'incompatible-tool-definitions';
    app.store.putRun({ ...run, checkpoint: JSON.stringify(checkpoint) });
    const request = app.inspect().pending[0]!;
    await expect(app.respond(request.id, request.revision, 'approve')).rejects.toThrow('Tool definitions changed');
    expect(app.inspect().pending[0]?.status).toBe('pending');
    expect(app.store.invocations(run.id).some(i => i.tool === 'read_documents')).toBe(false);
  } finally { await app.close(); }
});
it('returns validated structured JSON through the programmatic API', async () => {
  const f = fixture({ outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } });
  cleanup.push(f.cleanup);
  const model = new FakeModel(() => [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '{"summary":"Approved structured result"}' }] }]);
  const app = await SessionController.open({ config: f.config, model });
  try {
    const run = await app.submit('Return a structured result.');
    expect(run.status).toBe('completed');
    expect(run.structuredOutput).toEqual({ summary: 'Approved structured result' });
  } finally { await app.close(); }
});
it('offloads a large result, keeps it inspectable, and does not claim complete source coverage', async () => {
  const f = fixture({ limits: { maxToolBytes: 128 } }); cleanup.push(f.cleanup);
  const model = new FakeModel(request => Array.isArray(request.input) && request.input.some(i => i.type === 'function_call_result') ? echo(request) :
    [{ type: 'function_call', name: 'large', callId: 'large-one', arguments: '{}', status: 'completed' }]);
  const app = await SessionController.open({ config: f.config, model, tools: [{
    name: 'large', description: 'Synthetic large result', effect: 'internal', approval: false,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ text: 'full-content-'.repeat(1000) }),
  }] });
  try {
    const run = await app.submit('inspect large result');
    const invocation = app.store.invocations(run.id)[0]!;
    expect(invocation.outputPath).not.toBeNull();
    expect(app.store.toolResult(invocation.id, app.id)).toContain('full-content-'.repeat(1000));
    expect(run.status).toBe('partial');
    expect(run.reason).toContain('excerpted');
  } finally { await app.close(); }
});
it('does not let a custom read tool opt out of the mandatory approval policy', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  let executed = false;
  const model = new FakeModel(request => Array.isArray(request.input) && request.input.some(i => i.type === 'function_call_result') ? echo(request) :
    [{ type: 'function_call', name: 'custom_read', callId: 'read-one', arguments: '{}', status: 'completed' }]);
  const app = await SessionController.open({ config: f.config, model, tools: [{
    name: 'custom_read', description: 'Custom reader', effect: 'read', approval: false,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executed = true; return 'approved contents'; },
  }] });
  try {
    const run = await app.submit('read');
    expect(run.status).toBe('awaiting_approval');
    expect(executed).toBe(false);
    await approveAll(app);
    expect(executed).toBe(true);
  } finally { await app.close(); }
});
it('rejects concurrent submissions before the first command finishes preparing', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config, model: new FakeModel(echo, 20) });
  try {
    const first = app.submit('first admitted request');
    await expect(app.submit('second competing request')).rejects.toThrow('Interrupt the current run');
    expect((await first).status).toBe('completed');
    expect(app.store.transcript(app.id).filter(e => e.role === 'user').map(e => e.text)).toEqual(['first admitted request']);
  } finally { await app.close(); }
});
it('cancels approval preparation without executing the tool or reviving the cancelled run', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config });
  try {
    const first = await app.submit('Read documents, summarize and save.');
    const request = app.inspect().pending[0]!;
    const deciding = app.respond(request.id, request.revision, 'approve');
    const rejected = expect(deciding).rejects.toThrow('Cancelled before execution');
    await expect(app.respond(request.id, request.revision, 'reject')).rejects.toThrow('Interrupt the current run');
    app.cancel();
    await rejected;
    expect(app.inspect().run?.status).toBe('cancelled');
    expect(app.store.invocations(first.id).some(i => i.tool === 'read_documents')).toBe(false);
    expect((await app.submit('acknowledge cancellation')).status).toBe('completed');
  } finally { await app.close(); }
});
it('waits for pending command preparation before closing storage and releasing ownership', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const app = await SessionController.open({ config: f.config });
  const submitting = app.submit('cancel before admission');
  const rejected = expect(submitting).rejects.toThrow('Cancelled before execution');
  await app.close();
  await rejected;
  const reopened = await SessionController.open({ config: f.config, sessionId: app.id });
  try { expect((await reopened.submit('new owner')).status).toBe('completed'); }
  finally { await reopened.close(); }
});
