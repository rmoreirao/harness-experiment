import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';
import { NativeRuntimeJournal } from '../src/native-runtime-journal.js';
import type { RuntimeOptions } from '../src/contracts.js';
import { resourceFixture } from './resource-fixture.js';

function event(type: SessionEvent['type'], data: Record<string, unknown>, id: string, agentId?: string): SessionEvent {
  return { type, data, id, parentId: null, timestamp: '2026-11-19T09:00:00.000Z',
    ...(agentId ? { agentId } : {}) } as SessionEvent;
}

function journalFixture(overrides: Record<string, unknown> = {}, secrets: string[] = []) {
  const f = resourceFixture(overrides, secrets);
  const signal = new AbortController().signal;
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const options: RuntimeOptions = {
    sessionId: 'sdk-parent', resume: false, directory: f.dataDir, tools: [], signal,
    emit: (type, data) => emitted.push({ type, data: structuredClone(data) }),
    question: async () => 'Synthetic answer.', beforeStop: async () => null,
    permission: async () => ({ kind: 'approve-once', approvedInteractively: false }), permissionMode: 'allow-all', taskMode: 'interactive',
  };
  const journal = new NativeRuntimeJournal(f.config, f.resources, options, () => signal);
  return { ...f, options, journal, emitted,
    input: (sessionId = 'sdk-parent', toolCallId = 'native-call-one', toolName = 'powershell') => ({
      sessionId, toolCallId, toolName, toolArgs: { command: 'Synthetic verification command.' },
      timestamp: new Date('2026-11-19T09:00:00.000Z'), workingDirectory: f.workspace,
    }) };
}

describe('Native SDK activity journal', () => {
  it.each(['admitted', 'completed'])('rejects changed native arguments after an invocation is %s', async phase => {
    const f = journalFixture();
    try {
      const hooks = f.journal.hooks();
      await hooks.onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      if (phase === 'completed') f.journal.event(event('tool.execution_complete', {
        toolCallId: 'native-call-one', success: true, shellExecution: { exitCode: 0 },
      }, 'original-complete'));
      const changed = { ...f.input(), toolArgs: { command: 'Different command must not execute.' } };
      expect(await hooks.onPreToolUse!(changed, { sessionId: 'sdk-parent' })).toMatchObject({
        permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('changed arguments'),
      });
      expect(f.resources.current().actions).toBe(1);
      expect(f.store.list('action', f.sessionId)).toHaveLength(1);
      expect(f.store.list('action', f.sessionId)[0]!.args).toEqual({ command: 'Synthetic verification command.' });
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('scopes reused native tool call identities to each new objective', async () => {
    const f = journalFixture();
    try {
      const hooks = f.journal.hooks();
      await hooks.onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_complete', { toolCallId: 'native-call-one', success: true,
        shellExecution: { exitCode: 0 }, result: { content: 'FIRST_OBJECTIVE_RESULT' } }, 'first-objective-complete'));
      const firstObjective = f.resources.current();
      firstObjective.status = 'completed'; f.store.put('objective', firstObjective);
      f.objective.id = 'second-objective';
      f.store.put('objective', { ...firstObjective, id: f.objective.id, status: 'running', actions: 0, output: '',
        usage: { input: 0, output: 0, requests: 0, reserved: 0, unknown: false, cost: null } });
      expect(await hooks.onPreToolUse!(f.input(), { sessionId: 'sdk-parent' })).toBeUndefined();
      f.journal.event(event('tool.execution_complete', { toolCallId: 'native-call-one', success: true,
        shellExecution: { exitCode: 0 }, result: { content: 'SECOND_OBJECTIVE_RESULT' } }, 'second-objective-complete'));
      const actions = f.store.list('action', f.sessionId);
      expect(actions.map(action => [action.objectiveId, action.callId, action.status])).toEqual([
        [firstObjective.id, 'native-call-one', 'completed'], ['second-objective', 'native-call-one', 'completed'],
      ]);
      expect(actions[0]!.id).not.toBe(actions[1]!.id);
      expect(f.store.readResult(f.sessionId, actions[1]!.resultId!).text).toContain('SECOND_OBJECTIVE_RESULT');
      expect(f.resources.current().actions).toBe(1);
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('throws an explicit result limit without marking unrecorded native output completed', async () => {
    const f = journalFixture({ limits: { maxResultBytes: 1024 } });
    try {
      f.store.result(f.sessionId, f.objective.id, 'existing-result', 'x'.repeat(1024), { origin: 'fixture' });
      await f.journal.hooks().onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      let failure: unknown;
      try {
        f.journal.event(event('tool.execution_complete', { toolCallId: 'native-call-one', success: true,
          shellExecution: { exitCode: 0 }, result: { content: 'Output cannot be stored.' } }, 'no-result-capacity'));
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'RESULT_LIMIT' });
      expect(f.store.list('action', f.sessionId)[0]).toMatchObject({ status: 'started', resultId: null });
      expect(f.store.list('result', f.sessionId)).toHaveLength(1);
      expect(f.journal.unfinished()).toBe(true);
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('refuses excess worker spawning instead of queueing a nested worker behind its parent', async () => {
    const f = journalFixture({ limits: { workerConcurrency: 1 } });
    try {
      const hooks = f.journal.hooks();
      await hooks.onPreToolUse!(f.input('sdk-parent', 'delegation-one', 'task'), { sessionId: 'sdk-parent' });
      const denied = await hooks.onPreToolUse!(f.input('sdk-parent', 'delegation-two', 'task'), { sessionId: 'sdk-parent' });
      expect(denied).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('Worker capacity is full') });
      expect(f.store.list('action', f.sessionId).find(action => action.callId === 'delegation-two'))
        .toMatchObject({ status: 'denied', errorCode: 'WORKER_LIMIT' });
      f.journal.event(event('tool.execution_complete', { toolCallId: 'delegation-one', success: true,
        result: { content: 'First worker delegation settled.' } }, 'delegation-one-complete'));
      expect(await hooks.onPreToolUse!(f.input('sdk-parent', 'delegation-three', 'task'), { sessionId: 'sdk-parent' })).toBeUndefined();
      expect(f.store.list('action', f.sessionId).find(action => action.callId === 'delegation-three')!.status).toBe('started');
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('keeps async commands active until terminal evidence while releasing only finished process admission', async () => {
    const f = journalFixture({ limits: { concurrency: 1 } });
    try {
      const hooks = f.journal.hooks();
      const input = { ...f.input(), toolArgs: { command: 'Synthetic background process.', mode: 'async' } };
      await hooks.onPreToolUse!(input, { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_complete', {
        toolCallId: 'native-call-one', success: true,
        result: { content: 'Command is still running. shellId: background-shell' },
      }, 'background-return'));
      expect(f.store.list('action', f.sessionId)[0]).toMatchObject({ status: 'started', resultId: null });
      expect(f.journal.unfinished()).toBe(true);
      await hooks.onPreToolUse!({ ...f.input('sdk-parent', 'background-poll', 'read_powershell'),
        toolArgs: { shellId: 'background-shell', delay: 0 } }, { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_complete', { toolCallId: 'background-poll', success: true,
        result: { content: 'shellId: background-shell is still running.' } }, 'background-poll-complete'));
      const poll = f.store.list('action', f.sessionId).find(action => action.callId === 'background-poll')!;
      expect(['read', 'internal']).toContain(poll.effect);
      expect(poll.status).toBe('completed');
      expect(f.store.list('action', f.sessionId)[0]!.status).toBe('started');
      f.journal.releaseFinishedCommand('background-shell');
      expect(f.store.list('action', f.sessionId)[0]!.status).toBe('started');
      await hooks.onPreToolUse!(f.input('sdk-parent', 'foreground-two'), { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_complete', {
        toolCallId: 'foreground-two', success: true, shellExecution: { exitCode: 0 }, result: { content: 'Second command completed.' },
      }, 'foreground-two-complete'));
      f.journal.event(event('system.notification', { kind: {
        type: 'shell_completed', shellId: 'background-shell', exitCode: 0,
      } }, 'background-terminal'));
      const background = f.store.list('action', f.sessionId).find(action => action.callId === 'native-call-one')!;
      expect(background.status).toBe('completed');
      expect(JSON.parse(f.store.readResult(f.sessionId, background.resultId!).text)).toMatchObject({
        shellId: 'background-shell', exitCode: 0, success: true,
      });
      expect(f.journal.unfinished()).toBe(false);
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('does not double-admit a repeated native pre-tool callback', async () => {
    const f = journalFixture({ limits: { concurrency: 1 } });
    try {
      const hooks = f.journal.hooks();
      await hooks.onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      await hooks.onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      expect(f.resources.current().actions).toBe(1);
      expect(f.store.list('action', f.sessionId)).toHaveLength(1);
      f.journal.event(event('tool.execution_complete', {
        toolCallId: 'native-call-one', success: true, shellExecution: { exitCode: 0 },
      }, 'deduplicated-complete'));
      expect(f.journal.unfinished()).toBe(false);
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('journals native success once by SDK invocation identity without Docker fields', async () => {
    const f = journalFixture();
    try {
      await f.journal.hooks().onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_start', {
        toolCallId: 'native-call-one', toolName: 'powershell', arguments: { command: 'Synthetic verification command.' },
      }, 'event-start'));
      const completed = event('tool.execution_complete', { toolCallId: 'native-call-one', success: true,
        shellExecution: { exitCode: 0 }, result: { content: 'CHECK_PASSED' } }, 'event-complete');
      f.journal.event(completed); f.journal.event(completed);
      f.journal.event({ ...completed, id: 'event-complete-duplicate' });
      const actions = f.store.list('action', f.sessionId);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ origin: 'native', callId: 'native-call-one',
        runtimeSessionId: 'sdk-parent', tool: 'powershell', effect: 'execute', status: 'completed', error: null });
      for (const field of ['container', 'directory', 'baseline']) expect(actions[0]).not.toHaveProperty(field);
      expect(f.store.list('result', f.sessionId)).toHaveLength(1);
      expect(JSON.parse(f.store.readResult(f.sessionId, actions[0]!.resultId!).text)).toMatchObject({
        success: true, exitCode: 0, content: 'CHECK_PASSED', toolCallId: 'native-call-one', runtimeSessionId: 'sdk-parent',
      });
      expect(f.resources.current().actions).toBe(1);
      expect(f.journal.unfinished()).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each([
    ['nonzero exit', true, 7, undefined, 'failed'],
    ['runtime failure', false, undefined, { code: 'NATIVE_FAILURE', message: 'Actual command failed.' }, 'failed'],
    ['managed denial', false, undefined, { code: 'PERMISSION_DENIED', message: 'Managed policy denied.' }, 'denied'],
    ['timeout', false, undefined, { code: 'TIMEOUT', message: 'Command timed out.' }, 'failed'],
  ] as const)('records %s from authoritative execution-complete events', async (_label, success, exitCode, error, status) => {
    const f = journalFixture();
    try {
      await f.journal.hooks().onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_complete', {
        toolCallId: 'native-call-one', success,
        ...(exitCode !== undefined ? { shellExecution: { exitCode } } : {}),
        ...(error ? { error } : {}),
        result: { content: 'Actual terminal output.' },
      }, 'event-terminal'));
      const action = f.store.list('action', f.sessionId)[0]!;
      expect(action.status).toBe(status);
      expect(action.error).toBe(error?.message ?? 'Command exited with code 7.');
      expect(f.store.readResult(f.sessionId, action.resultId!).text).toContain('Actual terminal output.');
      expect(f.journal.unfinished()).toBe(false);
    } finally { f.cleanup(); }
  });

  it('keeps native and retained custom tool ledgers from double counting', async () => {
    const f = journalFixture();
    try {
      await f.journal.hooks().onPreToolUse!(f.input('sdk-parent', 'custom-one', 'harness_web_fetch'), { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_start', {
        toolCallId: 'custom-one', toolName: 'harness_web_fetch', arguments: { url: 'https://example.invalid' },
      }, 'custom-start'));
      f.journal.event(event('tool.execution_complete', {
        toolCallId: 'custom-one', success: true, result: { content: 'Handled by the domain broker.' },
      }, 'custom-complete'));
      expect(f.store.list('action', f.sessionId)).toEqual([]);
      expect(f.store.list('result', f.sessionId)).toEqual([]);
      expect(f.resources.current().actions).toBe(0);
    } finally { f.cleanup(); }
  });

  it('attributes identical tool call IDs to the correct worker session', async () => {
    const f = journalFixture();
    try {
      const hooks = f.journal.hooks();
      for (const actor of ['one', 'two']) {
        await hooks.onSubagentStart!({
          sessionId: 'sdk-parent', timestamp: new Date(), workingDirectory: f.workspace,
          transcriptPath: `transcript-${actor}`, agentName: `writer-${actor}`,
        }, { sessionId: `child-${actor}` });
        f.journal.event(event('subagent.started', { agentName: `writer-${actor}`, toolCallId: `delegation-${actor}`,
          parentId: 'sdk-parent', model: `model-${actor}` }, `worker-start-${actor}`, `actor-${actor}`));
        await hooks.onPreToolUse!(f.input(`child-${actor}`, 'same-call-id'), { sessionId: `child-${actor}` });
      }
      f.journal.event(event('tool.execution_complete', { toolCallId: 'same-call-id', success: true,
        result: { content: 'WORKER_TWO_OUTPUT' } }, 'two-complete', 'actor-two'));
      f.journal.event(event('tool.execution_complete', { toolCallId: 'same-call-id', success: false,
        error: { code: 'FAILED', message: 'WORKER_ONE_FAILURE' } }, 'one-complete', 'actor-one'));
      const actions = f.store.list('action', f.sessionId);
      expect(actions).toHaveLength(2);
      expect(actions.find(action => action.runtimeSessionId === 'child-one')).toMatchObject({
        actorId: 'actor-one', callId: 'same-call-id', status: 'failed', error: 'WORKER_ONE_FAILURE',
      });
      const second = actions.find(action => action.runtimeSessionId === 'child-two')!;
      expect(second).toMatchObject({ actorId: 'actor-two', status: 'completed' });
      expect(f.store.readResult(f.sessionId, second.resultId!).text).toContain('WORKER_TWO_OUTPUT');
      for (const actor of ['one', 'two']) f.journal.event(event('subagent.completed', {
        agentName: `writer-${actor}`, toolCallId: `delegation-${actor}`, model: `model-${actor}`,
      }, `worker-complete-${actor}`, `actor-${actor}`));
      expect(f.store.list('worker', f.sessionId).map(worker => [worker.id, worker.model, worker.status])).toEqual([
        ['actor-one', 'model-one', 'completed'], ['actor-two', 'model-two', 'completed'],
      ]);
      expect(f.journal.unfinished()).toBe(false);
    } finally { f.journal.interrupt('Fixture cleanup.'); f.cleanup(); }
  });

  it('bounds native output references without leaking configured secrets', async () => {
    const f = journalFixture({ limits: { maxOutputBytes: 128 } }, ['SYNTHETIC_NATIVE_SECRET']);
    try {
      await f.journal.hooks().onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      f.journal.event(event('tool.execution_partial_result', {
        toolCallId: 'native-call-one', partialOutput: 'SYNTHETIC_NATIVE_SECRET' + '\u20ac'.repeat(100),
      }, 'partial-one'));
      f.journal.event(event('tool.execution_complete', { toolCallId: 'native-call-one', success: true,
        result: { content: 'SYNTHETIC_NATIVE_SECRET' + '\u20ac'.repeat(100) } }, 'bounded-complete'));
      const action = f.store.list('action', f.sessionId)[0]!;
      const result = f.store.readResult(f.sessionId, action.resultId!);
      expect(result.result.bytes).toBeLessThanOrEqual(128);
      expect(result.text).toContain('[output truncated]');
      expect(result.text).not.toContain('SYNTHETIC_NATIVE_SECRET');
      expect(result.text).not.toContain('\ufffd');
    } finally { f.cleanup(); }
  });

  it('marks interrupted native effects and workers unknown instead of claiming rollback', async () => {
    const f = journalFixture();
    try {
      await f.journal.hooks().onPreToolUse!(f.input(), { sessionId: 'sdk-parent' });
      f.journal.event(event('subagent.started', {
        toolCallId: 'delegation-one', agentName: 'writer', model: 'worker-model',
      }, 'worker-start', 'worker-one'));
      f.journal.interrupt('Native cancellation did not confirm external effects.');
      expect(f.journal.cancelled).toBe(true);
      expect(f.store.list('action', f.sessionId)[0]).toMatchObject({ status: 'unknown', errorCode: 'NATIVE_EFFECT_UNKNOWN' });
      expect(f.store.list('worker', f.sessionId)[0]).toMatchObject({ status: 'unknown' });
      expect(f.journal.unfinished()).toBe(true);
    } finally { f.cleanup(); }
  });

  it('rejects native effects without invocation identities before execution', async () => {
    const f = journalFixture();
    try {
      const input = { ...f.input(), toolCallId: undefined };
      expect(await f.journal.hooks().onPreToolUse!(input, { sessionId: 'sdk-parent' })).toMatchObject({
        permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('invocation identity'),
      });
      expect(f.store.list('action', f.sessionId)).toEqual([]);
    } finally { f.cleanup(); }
  });
});
