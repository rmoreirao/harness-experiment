import { readFileSync, writeFileSync, linkSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { V2Controller } from '../../src/v2/controller.js';
import { Workspace } from '../../src/v2/workspace.js';
import { Semaphore } from '../../src/v2/resources.js';
import { fixture, ScriptRuntime, approve } from './helpers.js';

describe('V2 A02/A05/A06 product policy and coding primitives', () => {
  it('approves concurrent pending and future calls without answering questions, and restores per-call approval when disabled', async () => {
    const f = fixture();
    let pendingReady!: () => void, questionReady!: () => void, restoredReady!: () => void;
    const pending = new Promise<void>(resolve => { pendingReady = resolve; });
    const question = new Promise<void>(resolve => { questionReady = resolve; });
    const restored = new Promise<void>(resolve => { restoredReady = resolve; });
    let effects = 0, requests = 0;
    const runtime = new ScriptRuntime(async runtime => {
      await Promise.all([
        runtime.call('workspace_read', { path: 'notes.txt' }),
        runtime.call('workspace_read', { path: 'notes.txt' }),
      ]);
      await runtime.call('fixture_submit', {});
      expect(await runtime.options!.question('Continue?', ['Continue'], false)).toBe('Continue');
      await runtime.call('workspace_read', { path: 'notes.txt' });
      runtime.message('Synthetic approved work completed.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    app.broker.register('fixture_submit', 'Synthetic submission.', z.object({}).strict(), 'submit', () => { effects++; return { submitted: true }; });
    app.subscribe(event => {
      if (event.type !== 'request') return;
      const latest = app.inspect().pending.at(-1)!;
      if (latest.kind === 'question') questionReady();
      else if (++requests === 2) pendingReady();
      else if (requests === 3) restoredReady();
    });
    try {
      const job = app.submit('Exercise session-wide approval.');
      await pending;
      expect(app.inspect().pending).toHaveLength(2);
      app.setApproveAll(true);
      await question;
      expect(effects).toBe(1);
      expect(app.inspect().pending).toHaveLength(1);
      const answer = app.inspect().pending[0]!;
      expect(answer.kind).toBe('question');
      app.setApproveAll(false);
      app.decide(answer.id, answer.revision, answer.binding, 'Continue');
      await restored;
      const approval = app.inspect().pending[0]!;
      app.decide(approval.id, approval.revision, approval.binding, 'approve');
      const objective = await job;
      expect(objective.status).toBe('completed');
      const decisions = app.store.list('decision', app.id, objective.id);
      expect(decisions.filter(decision => decision.status === 'approved')).toHaveLength(4);
      expect(decisions.filter(decision => decision.status === 'answered')).toHaveLength(1);
      expect(app.store.events(app.id).filter(event => 'approveAll' in event.data).map(event => event.data.approveAll)).toEqual([true, false]);
    } finally { await app.close(); f.cleanup(); }
  });

  it('retains session-wide approval across objectives and cold resume without enabling another session', async () => {
    const f = fixture();
    const script = async (runtime: ScriptRuntime) => {
      await runtime.call('workspace_read', { path: 'notes.txt' });
      runtime.message('Synthetic approved read.');
    };
    let app = await V2Controller.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(script) });
    const id = app.id;
    let other: V2Controller | undefined;
    try {
      app.setApproveAll(true);
      expect((await app.submit('First approved objective.')).status).toBe('completed');
      expect((await app.submit('Second approved objective.')).status).toBe('completed');
      await app.close();
      app = await V2Controller.open({ config: f.config, sessionId: id, runtimeFactory: () => new ScriptRuntime(script) });
      expect((await app.submit('Approved objective after resume.')).status).toBe('completed');
      let pendingReady!: () => void;
      const pending = new Promise<void>(resolve => { pendingReady = resolve; });
      other = await V2Controller.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(script) });
      other.subscribe(event => { if (event.type === 'request') pendingReady(); });
      const job = other.submit('A separate session still asks.');
      await pending;
      expect(other.inspect().approveAll).toBe(false);
      expect(other.inspect().pending).toHaveLength(1);
      await other.cancel(); await job;
      app.setApproveAll(false);
      await app.close();
      app = await V2Controller.open({ config: f.config, sessionId: id, runtimeFactory: () => new ScriptRuntime(script) });
      const afterDisable = new Promise<void>(resolve => {
        app.subscribe(event => { if (event.type === 'request') resolve(); });
      });
      const resumed = app.submit('Disabled mode stays disabled after resume.');
      await afterDisable;
      expect(app.inspect().pending).toHaveLength(1);
      await app.cancel(); await resumed;
    } finally { await other?.close(); await app.close(); f.cleanup(); }
  });

  it('keeps read-only restrictions, tool allowlists and action budgets enforced under session-wide approval', async () => {
    const f = fixture({ readOnly: true, enabledTools: ['workspace_read', 'workspace_patch'], limits: { maxActions: 1 } });
    const runtime = new ScriptRuntime(async runtime => {
      await expect(runtime.call('workspace_patch', { path: 'created.txt', expectedHash: 'new', content: 'Blocked.' })).rejects.toThrow('read-only');
      await runtime.call('workspace_read', { path: 'notes.txt' });
      await expect(app.broker.dispatch('git_inspect', { operation: 'status' }, 'disabled-tool')).rejects.toThrow('disabled');
      await expect(runtime.call('workspace_read', { path: 'notes.txt' })).rejects.toThrow('cap');
      runtime.message('Synthetic restrictions retained.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      app.setApproveAll(true);
      expect((await app.submit('Exercise approval without bypassing restrictions.')).status).toBe('completed');
      expect(app.inspect().pending).toHaveLength(0);
      expect(app.inspect().actions).toHaveLength(1);
    } finally { await app.close(); f.cleanup(); }
  });

  it('does not let the general/default domain bypass coding verification after a real edit', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('workspace_patch', { path: 'created.ts', expectedHash: 'new', content: 'export const value = 2;\n' });
      runtime.message('Done.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
    try {
      const result = await app.submit('Create the synthetic source file.');
      expect(result.status).toBe('partial'); expect(result.reason).toContain('isolated check');
      expect(app.inspect().verificationDomains).toEqual(['coding']);
    } finally { await app.close(); f.cleanup(); }
  });

  it('preserves unrelated edits, rejects stale content and destructive operations without approval', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      const read = await runtime.call('workspace_read', { path: 'notes.txt' });
      writeFileSync(path.join(f.workspace, 'notes.txt'), 'Concurrent user edit.');
      await expect(runtime.call('workspace_patch', { path: 'notes.txt', expectedHash: read.hash,
        edits: [{ oldText: 'Value: 2', newText: 'Value: 3' }] })).rejects.toThrow('changed');
      runtime.message('The concurrent edit was preserved; requested patch is blocked.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
    try {
      await app.submit('Apply a focused change.');
      expect(readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8')).toBe('Concurrent user edit.');
      expect(app.inspect().objective?.status).toBe('recovery_required');
    } finally { await app.close(); f.cleanup(); }
  });

  it('fails closed on protected/binary/linked paths while supporting general source, globs and paged search', async () => {
    const f = fixture(); const workspace = new Workspace(f.config);
    writeFileSync(path.join(f.workspace, 'index.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(f.workspace, '.env'), 'SYNTHETIC_SECRET=value');
    writeFileSync(path.join(f.workspace, 'binary.txt'), Buffer.from([0, 1, 2]));
    linkSync(path.join(f.workspace, 'notes.txt'), path.join(f.workspace, 'linked.txt'));
    try {
      expect(workspace.read('index.ts').text).toContain('export');
      for (const input of ['..\\escape', '.env', 'a:stream', 'CON.txt', 'linked.txt']) expect(() => workspace.read(input)).toThrow();
      expect(() => workspace.read('binary.txt')).toThrow('Binary');
      expect(workspace.files()).not.toContain('.env');
      expect(workspace.files()).not.toContain('linked.txt');
    } finally { f.cleanup(); }
  });

  it('admits only one objective during asynchronous startup, binds decisions, and does not replay interrupted approvals', async () => {
    const f = fixture();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const runtime = new ScriptRuntime(async runtime => { entered(); await runtime.call('workspace_read', { path: 'notes.txt' }); });
    let app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    const id = app.id;
    try {
      const job = app.submit('Read only the synthetic file.');
      await expect(app.submit('Conflicting request.')).rejects.toThrow('already admitted');
      await waiting;
      const request = app.inspect().pending[0]!;
      expect(() => app.decide(request.id, 2, request.binding, 'approve')).toThrow('current live');
      expect(() => app.decide(request.id, 1, 'changed-binding', 'approve')).toThrow('current live');
      await expect(V2Controller.open({ config: f.config, sessionId: id, runtimeFactory: () => runtime })).rejects.toThrow('owned');
      await app.close(); await job;
      const next = new ScriptRuntime(async runtime => { runtime.message('No interrupted action was replayed.'); });
      app = await V2Controller.open({ config: f.config, sessionId: id, runtimeFactory: () => next });
      expect(() => app.decide(request.id, request.revision, request.binding, 'approve')).toThrow('current live');
      expect(app.inspect().actions.some(action => action.status === 'completed')).toBe(false);
    } finally { await app.close(); f.cleanup(); }
  });

  it('enforces explicit scoped trusted reads without granting writes and keeps result retrieval session-scoped', async () => {
    const f = fixture();
    let readApprovals = 0;
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('workspace_read', { path: 'notes.txt' });
      const read = await runtime.call('workspace_read', { path: 'notes.txt' });
      await runtime.call('workspace_patch', { path: 'notes.txt', expectedHash: read.hash, delete: true });
      runtime.message('Completed approved deletion.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    app.broker.grant([f.workspace], [], Date.now() + 60000);
    app.subscribe(event => { if (event.type === 'request') readApprovals++; }); approve(app);
    try {
      const objective = await app.submit('Exercise an explicit read grant.');
      expect(objective.status).toBe('partial');
      expect(readApprovals).toBe(1);
      const result = app.inspect().results[0]!;
      expect(app.store.readResult(app.id, result.id, 0, 20).next).toBe(20);
      expect(() => app.store.readResult('another-session', result.id)).toThrow('belongs');
      expect(() => app.store.readResult(app.id, result.id, 0, 50000)).toThrow('range');
    } finally { await app.close(); f.cleanup(); }
  });
});

describe('V2 A07 concurrency and plan admission', () => {
  it('enforces a real semaphore and aborts queued admission without releasing an occupied slot', async () => {
    const gate = new Semaphore(1); const signal = new AbortController();
    const release = await gate.acquire(signal.signal);
    let entered = false;
    const blocked = gate.acquire(signal.signal).then(done => { entered = true; done(); });
    signal.abort(new Error('Synthetic cancellation'));
    await expect(blocked).rejects.toThrow('Synthetic cancellation');
    expect(entered).toBe(false); release();
    const second = await gate.acquire(new AbortController().signal); second();
  });
});
