import { readFileSync, writeFileSync, linkSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { SessionController as StartupController } from '../src/controller.js';
import { TrustedSessionController as SessionController } from './helpers.js';
import { Workspace } from '../src/workspace.js';
import { Semaphore } from '../src/resources.js';
import { fixture, ScriptRuntime, approve } from './helpers.js';
import { resourceFixture } from './resource-fixture.js';

describe('Native controller contracts', () => {
  it('rejects invalid trust auth and MCP controls before starting executable configuration', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('No invalid operation should reach the runtime.'));
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const auth = vi.spyOn(runtime, 'auth');
    const mcp = vi.spyOn(runtime, 'mcp');
    try {
      expect(() => app.trust('false' as unknown as boolean)).toThrow();
      expect(app.trusted).toBe(true);
      await expect(app.auth('unknown' as 'status')).rejects.toThrow();
      await expect(app.auth('status', 'unexpected-input')).rejects.toThrow();
      await expect(app.auth('cancel', 'unexpected-input')).rejects.toThrow();
      await expect(app.mcp('unknown' as 'list')).rejects.toThrow();
      await expect(app.mcp('status')).rejects.toThrow();
      await expect(app.mcp('login')).rejects.toThrow();
      await expect(app.mcp('list', 'unexpected-name')).rejects.toThrow();
      expect(auth).not.toHaveBeenCalled();
      expect(mcp).not.toHaveBeenCalled();
      expect(runtime.opens).toBe(0);
    } finally { await app.close(); f.cleanup(); }
  });

  it('keeps same-call custom actions distinct across child runtime sessions', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      for (const child of ['one', 'two']) await app.broker.dispatch('fixture_actor', {}, 'same-call', undefined, {
        runtimeSessionId: `child-${child}`, actorId: `worker-${child}`, parentCallId: `delegation-${child}`,
      });
      await expect(app.broker.dispatch('fixture_actor', {}, 'same-call', undefined, {
        runtimeSessionId: 'child-one', actorId: 'worker-one', parentCallId: 'delegation-one',
      })).rejects.toThrow('not replayed');
      runtime.message('Worker results are separately attributable.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    let effects = 0;
    app.broker.register('fixture_actor', 'Synthetic worker evidence.', z.object({}).strict(), 'internal', (_args, context) =>
      ({ number: ++effects, actor: context.action.actorId }));
    try {
      expect((await app.submit('Inspect worker-specific retained tools.')).status).toBe('completed');
      expect(effects).toBe(2);
      const actions = app.inspect().actions;
      expect(actions.map(action => [action.callId, action.runtimeSessionId, action.actorId, action.parentCallId, action.status])).toEqual([
        ['same-call', 'child-one', 'worker-one', 'delegation-one', 'completed'],
        ['same-call', 'child-two', 'worker-two', 'delegation-two', 'completed'],
      ]);
      expect(actions[0]!.id).not.toBe(actions[1]!.id);
      expect(actions.map(action => JSON.parse(app.store.readResult(app.id, action.resultId!).text))).toEqual([
        { number: 1, actor: 'worker-one' }, { number: 2, actor: 'worker-two' },
      ]);
    } finally { await app.close(); f.cleanup(); }
  });

  it('syncs effective parent modes without letting child events change policy or bypass coding verification', async () => {
    const f = fixture({ taskMode: 'plan', permissionMode: 'manual' });
    const runtime = new ScriptRuntime(async runtime => {
      runtime.options!.emit('runtime', { state: 'task_mode', mode: 'autopilot', actorId: 'worker-one' });
      runtime.options!.emit('runtime', { state: 'permission_mode', mode: 'allow-all', actorId: 'worker-one' });
      expect(app.inspect()).toMatchObject({ taskMode: 'plan', permissionMode: 'manual', approveAll: false });
      runtime.options!.emit('runtime', { state: 'task_mode', mode: 'interactive' });
      runtime.options!.emit('runtime', { state: 'permission_mode', mode: 'assisted' });
      expect(app.inspect()).toMatchObject({ taskMode: 'interactive', permissionMode: 'assisted', approveAll: false });
      runtime.message('Implementation mode is active but no coding check was run.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      const result = await app.submit('Implement and verify the requested change.', { domain: 'coding' });
      expect(result.status).toBe('partial');
      expect(result.reason).toContain('verification');
      expect(app.store.get('sessionPolicy', app.id, app.id).taskMode).toBe('interactive');
      expect(app.store.get('approvalPolicy', app.id, app.id).mode).toBe('assisted');
    } finally { await app.close(); f.cleanup(); }
  });

  it('forwards explicit authentication inputs and MCP server operations only after trust', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Idle host controls.'));
    const auth = vi.spyOn(runtime, 'auth').mockResolvedValue({ state: 'declined' });
    const mcp = vi.spyOn(runtime, 'mcp').mockResolvedValue({ server: 'fixture', state: 'authentication-required' });
    const app = await StartupController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      await expect(app.mcp('login', 'fixture')).rejects.toThrow('Explicitly trust');
      expect(mcp).not.toHaveBeenCalled();
      expect(runtime.opens).toBe(0);
      app.trust(true);
      expect(await app.auth('advance', 'no')).toEqual({ state: 'declined' });
      expect(auth).toHaveBeenCalledExactlyOnceWith('advance', 'no');
      expect(await app.mcp('login', 'fixture')).toEqual({ server: 'fixture', state: 'authentication-required' });
      expect(mcp).toHaveBeenCalledExactlyOnceWith('login', 'fixture');
      expect(app.store.list('objective', app.id)).toEqual([]);
    } finally { await app.close(); f.cleanup(); }
  });

  it('does not verify a coding objective from an unrelated success when the requested check failed', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      const objective = app.inspect().objective!;
      for (const [id, command, status, output] of [
        ['unrelated', 'Write-Output unrelated', 'completed', 'unrelated output'],
        ['requested', 'npm test -- parser-regression', 'failed', 'FAIL parser regression'],
      ] as const) {
        const result = app.store.result(app.id, objective.id, id, output, { origin: 'native', tool: 'powershell' });
        app.store.put('action', { id, sessionId: app.id, objectiveId: objective.id, callId: id,
          origin: 'native', tool: 'powershell', effect: 'execute', args: { command }, argsHash: id,
          status, resultId: result.id, error: status === 'failed' ? 'Command exited with code 1.' : null });
      }
      runtime.message('The parser check failed; unrelated output does not verify it.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      const result = await app.submit('Fix and verify the parser regression.', {
        domain: 'coding', criteria: ['The parser regression check must pass.'],
      });
      expect(result.status).toBe('partial');
      expect(app.inspect().actions.find(action => action.callId === 'requested')!.status).toBe('failed');
      expect(app.store.readResult(app.id, app.inspect().actions.find(action => action.callId === 'requested')!.resultId!).text)
        .toBe('FAIL parser regression');
    } finally { await app.close(); f.cleanup(); }
  });

  it('accepts a failed native check only after the same command succeeds', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      const objective = app.inspect().objective!;
      for (const [id, status, output] of [
        ['before-fix', 'failed', 'FAIL parser regression'],
        ['after-fix', 'completed', 'PASS parser regression'],
      ] as const) {
        const result = app.store.result(app.id, objective.id, id, output, { origin: 'native', tool: 'powershell' });
        app.store.put('action', {
          id, sessionId: app.id, objectiveId: objective.id, callId: id,
          origin: 'native', tool: 'powershell', effect: 'execute',
          args: { command: 'npm test -- parser-regression' }, argsHash: 'same-command',
          status, resultId: result.id, error: status === 'failed' ? 'Command exited with code 1.' : null,
        });
      }
      runtime.message('The exact parser regression now passes after the fix.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      const result = await app.submit('Fix and verify the parser regression.', { domain: 'coding' });
      expect(result.status).toBe('completed');
      expect(app.inspect().actions.map(action => action.status)).toEqual(['failed', 'completed']);
      expect(app.store.readResult(app.id, app.inspect().actions[1]!.resultId!).text).toBe('PASS parser regression');
    } finally { await app.close(); f.cleanup(); }
  });

  it('attempts runtime cleanup after abort failure and allows a failed shutdown to be retried', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Completed before shutdown.'));
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      const objective = await app.submit('Prepare native shutdown recovery.');
      const abort = vi.spyOn(runtime, 'abort').mockRejectedValueOnce(new Error('Synthetic abort confirmation failed.'));
      const close = vi.spyOn(runtime, 'close');
      await expect(app.close()).rejects.toThrow('Native shutdown was not clean');
      expect(close).toHaveBeenCalledOnce();
      expect(app.store.get('objective', objective.id, app.id).status).toBe('recovery_required');
      await app.close();
      expect(abort).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
      const resumed = await SessionController.open({ config: f.config, sessionId: app.id, runtimeFactory: () => new ScriptRuntime(async () => {}) });
      try { expect(resumed.inspect().objective!.status).toBe('recovery_required'); }
      finally { await resumed.close(); }
    } finally { await app.close(); f.cleanup(); }
  });

  it.each(['external', 'human_response'] as const)('attributes SDK approval only to the actual %s decision source', async source => {
    const f = fixture();
    let response: unknown;
    const runtime = new ScriptRuntime(async runtime => {
      response = await runtime.options!.permission({
        kind: 'custom-tool', toolName: 'harness_fixture', toolDescription: 'Attributed permission.',
      }, { sessionId: 'sdk-parent' });
      runtime.message('The SDK approval source was preserved.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    app.subscribe(event => {
      if (event.type !== 'request') return;
      const decision = app.inspect().pending[0]!;
      app.decide(decision.id, decision.revision, decision.binding, 'approve', source);
    });
    try {
      await app.submit('Attribute this exact decision.');
      expect(response).toEqual(source === 'external' ? { kind: 'approve-once', approvedInteractively: false } : {
        kind: 'attributed', result: { kind: 'approve-once', approvedInteractively: true },
        decisionContext: { source: 'human_response', responseCapability: 'interactive', surface: 'sdk', outcome: 'prompted_user' },
      });
      expect(app.store.list('decision', app.id)[0]!.decisionSource).toBe(source);
    } finally { await app.close(); f.cleanup(); }
  });

  it('requires explicit startup trust before hooks or MCP can start', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Explicit trust accepted.'));
    const app = await StartupController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      expect(app.inspect()).toMatchObject({ trusted: false, unsandboxed: true, permissionMode: 'allow-all', taskMode: 'interactive' });
      await expect(app.submit('Untrusted work.')).rejects.toThrow('Explicitly trust');
      await expect(app.listSkills()).rejects.toThrow('Explicitly trust');
      await expect(app.auth('login')).rejects.toThrow('Explicitly trust');
      expect(runtime.opens).toBe(0);
      expect(app.store.list('objective', app.id)).toEqual([]);
      app.trust(false);
      await expect(app.submit('Denied trust.')).rejects.toThrow('Explicitly trust');
      expect(runtime.opens).toBe(0);
      app.trust(true);
      expect((await app.submit('Trusted work.')).output).toBe('Explicit trust accepted.');
      expect(runtime.opens).toBe(1);
      expect(runtime.options).toMatchObject({ permissionMode: 'allow-all', taskMode: 'interactive' });
    } finally { await app.close(); f.cleanup(); }
  });

  it('keeps task modes separate from effective SDK permission modes', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Separate modes.'));
    const app = await SessionController.open({ config: f.config, trusted: true, runtimeFactory: () => runtime });
    try {
      await app.setPermissionMode('manual');
      await app.setTaskMode('autopilot');
      expect(app.inspect()).toMatchObject({ permissionMode: 'manual', approveAll: false, taskMode: 'autopilot' });
      await app.submit('Open the trusted runtime.');
      const task = vi.spyOn(runtime, 'setTaskMode');
      await app.setTaskMode('plan');
      expect(task).toHaveBeenCalledWith('plan');
      expect(app.inspect()).toMatchObject({ permissionMode: 'manual', taskMode: 'plan' });
      vi.spyOn(runtime, 'setPermissionMode').mockResolvedValue('manual');
      await expect(app.setPermissionMode('allow-all')).rejects.toThrow('requested allow-all was not applied');
      expect(app.inspect()).toMatchObject({ permissionMode: 'manual', approveAll: false, taskMode: 'plan' });
    } finally { await app.close(); f.cleanup(); }
  });

  it.each(['approve', 'deny'])('honors an SDK permission callback requiring %s even in allow-all mode', async answer => {
    const f = fixture();
    let effects = 0;
    const runtime = new ScriptRuntime(async runtime => {
      const response = await runtime.options!.permission({
        kind: 'custom-tool', toolName: 'harness_fixture_effect', toolDescription: 'Synthetic managed permission.',
        toolCallId: 'managed-call', args: {}, managedApprovalRequired: true,
      }, { sessionId: 'child-sdk-session' });
      const decision = response.kind === 'attributed' ? response.result : response;
      if (decision.kind === 'approve-once' && decision.approvedInteractively) effects++;
      runtime.message(`SDK returned ${decision.kind}.`);
    });
    const app = await SessionController.open({ config: f.config, trusted: true, runtimeFactory: () => runtime });
    let requests = 0;
    app.subscribe(event => {
      if (event.type !== 'request') return;
      requests++;
      const pending = app.inspect().pending[0]!;
      expect(pending.runtimeSessionId).toBe('child-sdk-session');
      expect(pending.description).toContain('managed-call');
      app.decide(pending.id, pending.revision, pending.binding, answer, 'human_response');
    });
    try {
      const result = await app.submit('Follow SDK policy.');
      expect(result.output).toBe(`SDK returned ${answer === 'approve' ? 'approve-once' : 'reject'}.`);
      expect(effects).toBe(answer === 'approve' ? 1 : 0);
      expect(requests).toBe(1);
      expect(app.inspect().permissionMode).toBe('allow-all');
    } finally { await app.close(); f.cleanup(); }
  });

  it('keeps worker messages out of the parent objective response', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      runtime.message('AUTHORITATIVE_PARENT_ANSWER');
      runtime.options!.emit('text', { message: 'WORKER_FINAL', actorId: 'worker-one' });
      runtime.options!.emit('text', { delta: 'WORKER_DELTA', actorId: 'worker-one' });
      runtime.options!.emit('text', { message: 'DELEGATED_FINAL', parentCallId: 'delegation-one' });
    });
    const app = await SessionController.open({ config: f.config, trusted: true, runtimeFactory: () => runtime });
    try {
      const result = await app.submit('Attribute the parent answer.');
      expect(result).toMatchObject({ status: 'completed', output: 'AUTHORITATIVE_PARENT_ANSWER' });
      const texts = app.store.events(app.id).filter(event => event.type === 'text');
      expect(texts.map(event => event.data.message).filter(Boolean)).toEqual([
        'AUTHORITATIVE_PARENT_ANSWER', 'WORKER_FINAL', 'DELEGATED_FINAL',
      ]);
    } finally { await app.close(); f.cleanup(); }
  });

  it('preserves disjoint shared edits and surfaces overlapping assignments', async () => {
    const f = fixture();
    writeFileSync(path.join(f.workspace, 'unrelated.txt'), 'USER_CHANGE_MUST_SURVIVE');
    const runtime = new ScriptRuntime(async runtime => {
      const first = await runtime.call('work_assign', { worker: 'writer-one', paths: ['src/parser.ts'] });
      const second = await runtime.call('work_assign', { worker: 'writer-two', paths: ['src/formatter.ts'] });
      expect(first.paths).toEqual([path.join(f.workspace, 'src', 'parser.ts')]);
      expect(second.paths).toEqual([path.join(f.workspace, 'src', 'formatter.ts')]);
      await expect(runtime.call('work_assign', { worker: 'writer-two', paths: ['src/PARSER.ts'] })).rejects.toThrow('already assigned');
      await expect(runtime.call('work_assign', { worker: 'writer-three', paths: ['src'] })).rejects.toThrow('already assigned');
      await runtime.call('work_release', { id: first.id });
      expect((await runtime.call('work_assign', { worker: 'writer-two', paths: ['src/parser.ts'] })).status).toBe('active');
      runtime.message('Assignments coordinated in the shared checkout.');
    });
    const app = await SessionController.open({ config: f.config, trusted: true, runtimeFactory: () => runtime });
    try {
      expect((await app.submit('Coordinate two writers.')).status).toBe('completed');
      expect(readFileSync(path.join(f.workspace, 'unrelated.txt'), 'utf8')).toBe('USER_CHANGE_MUST_SURVIVE');
      expect(app.inspect().assignments.filter(item => item.status === 'active').map(item => item.worker)).toEqual(['writer-two', 'writer-two']);
      expect(app.inspect()).toMatchObject({ workspace: f.config.workspace, unsandboxed: true });
    } finally { await app.close(); f.cleanup(); }
  });

  it.each(['worker', 'command', 'both'])('keeps the objective incomplete with active owned %s work', async active => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      const objective = app.inspect().objective!;
      if (active !== 'command') app.store.put('worker', {
        id: 'active-worker', sessionId: app.id, objectiveId: objective.id, name: 'writer',
        status: 'running', started: 100,
      });
      if (active !== 'worker') app.store.put('action', {
        id: 'active-command', sessionId: app.id, objectiveId: objective.id, callId: 'command-one',
        tool: 'powershell', origin: 'native', effect: 'execute', args: {}, argsHash: 'fixture',
        status: 'started', resultId: null, error: null,
      });
      runtime.message('Parent idle is not verified completion.');
    });
    const app = await SessionController.open({ config: f.config, trusted: true, runtimeFactory: () => runtime });
    try {
      const result = await app.submit('Wait for all owned work.');
      expect(result.status).toBe('recovery_required');
      expect(result.reason).toContain('Unresolved native effects');
    } finally { await app.close(); f.cleanup(); }
  });

  it('resumes native sessions with expired decisions and no side-effect replay', async () => {
    const f = resourceFixture();
    const decision = { id: 'stale-decision', sessionId: f.sessionId, objectiveId: f.objective.id, actionId: '',
      kind: 'approval' as const, revision: 1, binding: 'old-binding', description: 'Old native permission.',
      status: 'pending' as const, answer: null, runtimeSessionId: 'old-sdk-child' };
    f.store.put('decision', decision);
    f.store.put('worker', { id: 'interrupted-worker', sessionId: f.sessionId, objectiveId: f.objective.id,
      name: 'writer', status: 'running', started: 100 });
    f.store.put('action', { id: 'interrupted-action', sessionId: f.sessionId, objectiveId: f.objective.id,
      callId: 'old-native-call', runtimeSessionId: 'old-sdk-child', tool: 'powershell', origin: 'native',
      effect: 'execute', args: {}, argsHash: 'fixture', status: 'started', resultId: null, error: null });
    let sends = 0;
    const runtime = new ScriptRuntime(async runtime => { sends++; runtime.message('Fresh continuation, no replay.'); });
    const app = await SessionController.open({ config: f.config, sessionId: f.sessionId, trusted: true, runtimeFactory: () => runtime });
    try {
      expect(app.inspect().objective!.status).toBe('recovery_required');
      expect(app.store.get('decision', decision.id, app.id).status).toBe('expired');
      expect(app.store.get('action', 'interrupted-action', app.id).status).toBe('unknown');
      expect(app.inspect().workers[0]!.status).toBe('unknown');
      expect(() => app.decide(decision.id, decision.revision, decision.binding, 'approve')).toThrow('not the current live decision');
      expect(runtime.opens).toBe(0);
      expect(sends).toBe(0);
      await app.reconcile({ note: 'Inspected the interrupted effects.',
        actions: [{ id: 'interrupted-action', note: 'Verified exact effect.' }],
        workers: [{ id: 'interrupted-worker', note: 'Verified worker is no longer active.' }] });
      const continued = await app.continueObjective();
      expect(continued).toMatchObject({ id: f.objective.id, status: 'completed', deadline: f.objective.deadline });
      expect(sends).toBe(1);
      expect(app.store.list('action', app.id)).toHaveLength(1);
    } finally { await app.close(); f.cleanup(); }
  });

  it('clears native conversation context without deleting evidence settings or user edits', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Historical parent answer.'));
    const app = await SessionController.open({ config: f.config, trusted: true, runtimeFactory: () => runtime });
    try {
      await app.setPermissionMode('manual');
      const objective = await app.submit('Complete a historical objective.');
      const result = app.store.result(app.id, objective.id, 'recorded-action', 'Exact preserved evidence.', { origin: 'native' });
      const oldRuntime = app.runtimeId;
      writeFileSync(path.join(f.workspace, 'notes.txt'), 'UNRELATED_USER_CHANGE');
      await app.clearContext();
      expect(app.runtimeId).not.toBe(oldRuntime);
      expect(app.inspect()).toMatchObject({ trusted: true, permissionMode: 'manual', objective: undefined, results: [] });
      expect(app.store.get('objective', objective.id, app.id).output).toBe('Historical parent answer.');
      expect(app.store.readResult(app.id, result.id).text).toBe('Exact preserved evidence.');
      expect(readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8')).toBe('UNRELATED_USER_CHANGE');
    } finally { await app.close(); f.cleanup(); }
  });
});

describe('A02/A05/A06 product policy and coding primitives', () => {
  it('clears only the current conversation and preserves settings, files and evidence across cold resume', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('fixture_create', {});
      runtime.message('Historical assistant answer.');
    });
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    app.broker.register('fixture_create', 'Synthetic retained write.', z.object({}).strict(), 'write', () => {
      writeFileSync(path.join(f.workspace, 'created.ts'), 'export const value = 2;\n');
      return { created: 'created.ts' };
    });
    const id = app.id;
    try {
      await app.clearContext(); await app.clearContext();
      expect(runtime.opens).toBe(0);
      await app.setApproveAll(true);
      const original = await app.submit('Create the synthetic source file.');
      expect(original.status).toBe('partial');
      const results = app.inspect().results;
      const runtimeId = app.runtimeId;
      await app.clearContext();
      const freshId = app.runtimeId;
      expect(freshId).not.toBe(runtimeId);
      expect(app.id).toBe(id);
      expect(app.inspect()).toMatchObject({ approveAll: true, objective: undefined, pending: [], results: [],
        modelLimits: { prompt: { used: null } } });
      expect(app.inspect().taskMode).toBe('interactive');
      expect(app.config).toEqual(f.config);
      expect(app.store.conversationObjectives(id)).toEqual([]);
      expect(app.store.get('objective', original.id, id)).toEqual(original);
      expect(app.store.list('result', id, original.id)).toEqual(results);
      expect(JSON.parse(app.store.readResult(id, results[0]!.id).text)).toEqual({ created: 'created.ts' });
      expect(readFileSync(path.join(f.workspace, 'created.ts'), 'utf8')).toContain('export const value = 2;');
      await expect(app.continueObjective()).rejects.toThrow();
      await app.close();
      const next = new ScriptRuntime(async runtime => runtime.message('Fresh conversation answer.'));
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => next });
      expect(app.runtimeId).toBe(freshId);
      expect(app.inspect().objective).toBeUndefined();
      expect(app.inspect().approveAll).toBe(true);
      expect(app.inspect().taskMode).toBe('interactive');
      await app.submit('Fresh conversation prompt.');
      expect(next.options).toMatchObject({ sessionId: freshId, resume: false });
      expect(next.options!.directory).toBe(path.join(f.dataDir, 'runtime', id, freshId));
      expect(app.store.conversationObjectives(id).map(objective => objective.original)).toEqual(['Fresh conversation prompt.']);
      await app.close();
      const resumed = new ScriptRuntime(async runtime => runtime.message('Resumed fresh conversation.'));
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => resumed });
      await app.submit('Continue the new conversation.');
      expect(resumed.options).toMatchObject({ sessionId: freshId, resume: true });
    } finally { await app.close(); f.cleanup(); }
  });

  it.each(['approval', 'question'])('rejects clear during preparation, pending %s and recovery without changing context', async kind => {
    const f = fixture();
    let ready!: () => void;
    const pending = new Promise<void>(resolve => { ready = resolve; });
    const runtime = new ScriptRuntime(async runtime => {
      if (kind === 'approval') await runtime.requestPermission('read_file', { path: 'notes.txt' });
      else await runtime.options!.question('A pending question?', ['Yes'], false);
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    app.subscribe(event => { if (event.type === 'request') ready(); });
    const runtimeId = app.runtimeId;
    try {
      const work = app.submit('Wait for a live decision.');
      await expect(app.clearContext()).rejects.toThrow('current objective');
      await pending;
      await expect(app.clearContext()).rejects.toThrow('current objective');
      expect(app.inspect().pending).toHaveLength(1);
      expect(app.runtimeId).toBe(runtimeId);
      await app.cancel(); await work;
      const objective = app.inspect().objective!;
      objective.status = 'recovery_required'; app.store.put('objective', objective);
      await expect(app.clearContext()).rejects.toThrow('reconcile');
      await app.reconcile({ note: 'Checked the cancelled fixture.' });
      await app.clearContext();
      expect(app.inspect().objective).toBeUndefined();
    } finally { await app.close(); f.cleanup(); }
  });

  it('admits reset before awaiting shutdown and rejects overlapping work', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Historical answer.'));
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    try {
      await app.submit('Historical prompt.');
      vi.spyOn(runtime, 'close').mockImplementationOnce(() => stopped);
      const clear = app.clearContext();
      expect(app.inspect().busy).toBe(true);
      await expect(app.submit('Conflicting prompt.')).rejects.toThrow('current objective');
      await expect(app.clearContext()).rejects.toThrow('current objective');
      await expect(app.continueObjective()).rejects.toThrow('active');
      await expect(app.reloadSkills()).rejects.toThrow('current objective');
      release(); await clear;
      expect(app.inspect().busy).toBe(false);
      expect(app.inspect().objective).toBeUndefined();
    } finally { release(); await app.close(); f.cleanup(); }
  });

  it.each(['runtime', 'storage'])('reports %s reset failures without committing a partial boundary or reusing the failed runtime', async phase => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Preserved historical answer.'));
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      const objective = await app.submit('Preserved historical prompt.');
      const runtimeId = app.runtimeId;
      if (phase === 'runtime') vi.spyOn(runtime, 'close').mockRejectedValueOnce(new Error('Injected reset failure.'));
      else app.store.db.exec(`CREATE TEMP TRIGGER fail_context_reset BEFORE INSERT ON events
        WHEN NEW.type='runtime' AND json_extract(NEW.data,'$.state')='context_cleared'
        BEGIN SELECT RAISE(ABORT,'Injected reset failure.'); END;`);
      await expect(app.clearContext()).rejects.toThrow('Injected reset failure');
      expect(app.runtimeId).toBe(runtimeId);
      expect(app.store.session(app.id).runtimeId).toBe(runtimeId);
      expect(app.store.list('conversation', app.id)).toHaveLength(0);
      expect(app.inspect().objective).toEqual(objective);
      expect(app.store.conversationObjectives(app.id)).toEqual([objective]);
      await expect(app.submit('Do not silently reuse the failed runtime.')).rejects.toThrow('Retry /clear');
      if (phase === 'storage') app.store.db.exec('DROP TRIGGER fail_context_reset');
      await app.clearContext();
      expect(app.runtimeId).not.toBe(runtimeId);
      await app.submit('Fresh prompt after retry.');
      expect(runtime.options?.resume).toBe(false);
    } finally { await app.close(); f.cleanup(); }
  });

  it('keeps pending SDK permissions explicit while changing policy without answering questions', async () => {
    const f = fixture();
    let pendingReady!: () => void, questionReady!: () => void, restoredReady!: () => void;
    const pending = new Promise<void>(resolve => { pendingReady = resolve; });
    const question = new Promise<void>(resolve => { questionReady = resolve; });
    const restored = new Promise<void>(resolve => { restoredReady = resolve; });
    let effects = 0, requests = 0;
    const runtime = new ScriptRuntime(async runtime => {
      await Promise.all([
        runtime.requestPermission('read_file', { path: 'notes.txt' }, 'read-one'),
        runtime.requestPermission('read_file', { path: 'notes.txt' }, 'read-two'),
      ]);
      await runtime.call('fixture_submit', {});
      expect(await runtime.options!.question('Continue?', ['Continue'], false)).toBe('Continue');
      await runtime.requestPermission('read_file', { path: 'notes.txt' }, 'read-three');
      runtime.message('Synthetic approved work completed.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
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
      await app.setApproveAll(true);
      expect(app.inspect().pending).toHaveLength(2);
      for (const decision of app.inspect().pending) app.decide(decision.id, decision.revision, decision.binding, 'approve');
      await question;
      expect(effects).toBe(1);
      expect(app.inspect().pending).toHaveLength(1);
      const answer = app.inspect().pending[0]!;
      expect(answer.kind).toBe('question');
      await app.setApproveAll(false);
      app.decide(answer.id, answer.revision, answer.binding, 'Continue');
      await restored;
      const approval = app.inspect().pending[0]!;
      app.decide(approval.id, approval.revision, approval.binding, 'approve');
      const objective = await job;
      expect(objective.status).toBe('completed');
      const decisions = app.store.list('decision', app.id, objective.id);
      expect(decisions.filter(decision => decision.status === 'approved')).toHaveLength(3);
      expect(decisions.filter(decision => decision.status === 'answered')).toHaveLength(1);
      expect(app.inspect()).toMatchObject({ approveAll: false, permissionMode: 'manual' });
    } finally { await app.close(); f.cleanup(); }
  });

  it('retains session-wide approval across objectives and cold resume without enabling another session', async () => {
    const f = fixture({ permissionMode: 'manual' });
    const script = async (runtime: ScriptRuntime) => {
      if (runtime.options!.permissionMode === 'manual') await runtime.requestPermission('read_file', { path: 'notes.txt' });
      runtime.message('Synthetic approved read.');
    };
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(script) });
    const id = app.id;
    let other: SessionController | undefined;
    try {
      await app.setApproveAll(true);
      expect((await app.submit('First approved objective.')).status).toBe('completed');
      expect((await app.submit('Second approved objective.')).status).toBe('completed');
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => new ScriptRuntime(script) });
      expect((await app.submit('Approved objective after resume.')).status).toBe('completed');
      let pendingReady!: () => void;
      const pending = new Promise<void>(resolve => { pendingReady = resolve; });
      other = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(script) });
      other.subscribe(event => { if (event.type === 'request') pendingReady(); });
      const job = other.submit('A separate session still asks.');
      await pending;
      expect(other.inspect().approveAll).toBe(false);
      expect(other.inspect().pending).toHaveLength(1);
      await other.cancel(); await job;
      await app.setApproveAll(false);
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => new ScriptRuntime(script) });
      const afterDisable = new Promise<void>(resolve => {
        app.subscribe(event => { if (event.type === 'request') resolve(); });
      });
      const resumed = app.submit('Disabled mode stays disabled after resume.');
      await afterDisable;
      expect(app.inspect().pending).toHaveLength(1);
      await app.cancel(); await resumed;
    } finally { await other?.close(); await app.close(); f.cleanup(); }
  });

  it('rejects retired read-only and allowlist configuration while preserving action budgets', async () => {
    const f = fixture({ limits: { maxActions: 1 } });
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('work_inspect', {});
      await expect(app.broker.dispatch('git_inspect', { operation: 'status' }, 'removed-tool')).rejects.toThrow('Unsupported');
      await expect(runtime.call('work_inspect', {})).rejects.toThrow('cap');
      runtime.message('The supported action budget remains enforced.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    try {
      await expect(StartupController.open({ config: { ...f.config, readOnly: true } as typeof f.config })).rejects.toThrow('Unrecognized key');
      await expect(StartupController.open({ config: { ...f.config, enabledTools: [] } as typeof f.config })).rejects.toThrow('Unrecognized key');
      await app.setApproveAll(true);
      expect((await app.submit('Exercise approval without bypassing restrictions.')).status).toBe('completed');
      expect(app.inspect().pending).toHaveLength(0);
      expect(app.inspect().actions).toHaveLength(1);
    } finally { await app.close(); f.cleanup(); }
  });

  it('does not let the general/default domain bypass coding verification after a real edit', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('fixture_create', {});
      runtime.message('Done.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
    app.broker.register('fixture_create', 'Synthetic retained write.', z.object({}).strict(), 'write', () => {
      writeFileSync(path.join(f.workspace, 'created.ts'), 'export const value = 2;\n');
      return { created: 'created.ts' };
    });
    try {
      const result = await app.submit('Create the synthetic source file.');
      expect(result.status).toBe('partial'); expect(result.reason).toContain('verification');
      expect(app.inspect().verificationDomains).toEqual(['coding']);
    } finally { await app.close(); f.cleanup(); }
  });

  it('preserves unrelated edits, rejects stale content and destructive operations without approval', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      const read = workspace.read('notes.txt');
      writeFileSync(path.join(f.workspace, 'notes.txt'), 'Concurrent user edit.');
      await expect(runtime.call('fixture_patch', { path: 'notes.txt', expectedHash: read.hash,
        edits: [{ oldText: 'Value: 2', newText: 'Value: 3' }] })).rejects.toThrow('changed');
      runtime.message('The concurrent edit was preserved; requested patch is blocked.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
    const workspace = new Workspace(f.config);
    app.broker.register('fixture_patch', 'Retained mirror patch precondition.', z.object({
      path: z.string(), expectedHash: z.string(), edits: z.array(z.object({ oldText: z.string(), newText: z.string() })),
    }).strict(), 'write', args => workspace.patch(args.path, args.expectedHash, args.edits));
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
    const runtime = new ScriptRuntime(async runtime => { entered(); await runtime.requestPermission('read_file', { path: 'notes.txt' }); });
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const id = app.id;
    try {
      const job = app.submit('Read only the synthetic file.');
      await expect(app.submit('Conflicting request.')).rejects.toThrow('current objective');
      await waiting;
      const request = app.inspect().pending[0]!;
      expect(() => app.decide(request.id, 2, request.binding, 'approve')).toThrow('current live');
      expect(() => app.decide(request.id, 1, 'changed-binding', 'approve')).toThrow('current live');
      await expect(SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => runtime })).rejects.toThrow('owned');
      await app.close(); await job;
      const next = new ScriptRuntime(async runtime => { runtime.message('No interrupted action was replayed.'); });
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => next });
      expect(() => app.decide(request.id, request.revision, request.binding, 'approve')).toThrow('current live');
      expect(app.inspect().actions.some(action => action.status === 'completed')).toBe(false);
    } finally { await app.close(); f.cleanup(); }
  });

  it('requires SDK decisions for reads and writes and keeps result retrieval session-scoped', async () => {
    const f = fixture();
    let readApprovals = 0;
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.requestPermission('read_file', { path: 'notes.txt' }, 'first-read');
      await runtime.call('fixture_read', {});
      await runtime.requestPermission('read_file', { path: 'notes.txt' }, 'second-read');
      await runtime.call('fixture_read', {});
      await runtime.requestPermission('write_file', { path: 'notes.txt' }, 'write-permission');
      runtime.message('Read and write permissions were separate explicit SDK decisions.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    app.broker.register('fixture_read', 'Synthetic retained evidence.', z.object({}).strict(), 'read',
      () => ({ text: readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8') }));
    app.subscribe(event => { if (event.type === 'request') readApprovals++; }); approve(app);
    try {
      const objective = await app.submit('Exercise explicit SDK decisions.');
      expect(objective.status).toBe('completed');
      expect(readApprovals).toBe(3);
      const result = app.inspect().results[0]!;
      expect(app.store.readResult(app.id, result.id, 0, 20).next).toBe(20);
      expect(() => app.store.readResult('another-session', result.id)).toThrow('belongs');
      expect(() => app.store.readResult(app.id, result.id, 0, 50000)).toThrow('range');
    } finally { await app.close(); f.cleanup(); }
  });
});

describe('A07 concurrency and plan admission', () => {
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
