import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { TerminalApp } from '../src/ui.js';
import { TrustedSessionController as SessionController } from './helpers.js';
import { HarnessError } from '../src/contracts.js';
import { z } from 'zod';
import { fixture, ScriptRuntime } from './helpers.js';
import { activityDetail, activityLine, foldActivity, projectActivity } from '../src/activity.js';
import type { Action, ActivityRecord } from '../src/contracts.js';

async function settle() { await new Promise(resolve => setTimeout(resolve, 70)); }
describe('A08 terminal continuity', () => {
  it('renders the stopping state without dereferencing worker state during shutdown', async () => {
    const f = fixture();
    const app = await SessionController.open({ config: f.config,
      runtimeFactory: () => new ScriptRuntime(async runtime => runtime.message('Idle fixture.')) });
    let release!: () => void;
    const closing = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(app, 'close').mockImplementationOnce(() => closing);
    const screen = render(<TerminalApp controller={app} />);
    try {
      await settle();
      screen.stdin.write('\x04');
      await vi.waitFor(() => expect(screen.lastFrame()).toContain('Stopping owned work and saving state'));
      expect(screen.lastFrame()).not.toContain('Cannot read properties');
    } finally { release(); screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('expands trace groups and calls with mouse and keyboard without replaying work or losing the draft', async () => {
    const f = fixture({ version: 4 });
    let calls = 0;
    const runtime = new ScriptRuntime(async runtime => {
      const request = app.resources.beginModelRequest(100, 'fixture-model', undefined, null);
      app.resources.settle(request, { input: 100, output: 40 });
      await runtime.call('trace_click', { path: 'one.txt', secret: 'trace-click-key' });
      await runtime.call('trace_click', { path: 'two.txt', secret: 'trace-click-key' });
      runtime.message('CLICKABLE_TRACE_RESPONSE');
    });
    const app = await SessionController.open({ config: f.config, apiKey: 'trace-click-key', runtimeFactory: () => runtime });
    app.broker.register('trace_click', 'Synthetic click evidence.', z.object({ path: z.string(), secret: z.string() }), 'internal',
      () => ({ value: ++calls }));
    await app.submit('Inspect clickable traces.');
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const click = async (text: string) => {
      const row = screen.lastFrame()!.split('\n').findIndex(line => line.includes(text));
      expect(row, screen.lastFrame()).toBeGreaterThanOrEqual(0);
      screen.stdin.write(`\x1b[<0;2;${row + 1}M\x1b[<0;2;${row + 1}m`); await settle();
    };
    try {
      await settle();
      Object.defineProperties(screen.stdout, { columns: { value: 100, configurable: true }, rows: { value: 40, configurable: true } });
      screen.stdout.emit('resize'); await settle();
      await send('/trace on');
      expect(screen.lastFrame()).toContain('> Trace | 1 model + 2 tool calls');
      expect(screen.lastFrame()).not.toContain('[done] TOOL');
      screen.stdin.write('SAVED_DRAFT'); await settle();
      await click('> Trace |');
      expect(screen.lastFrame()).toContain('v Trace |');
      expect(screen.lastFrame()).toContain('> [done] TOOL');
      await click('> [done] TOOL');
      expect(screen.lastFrame()).toContain('Arguments (redacted)');
      expect(screen.lastFrame()).toContain('[REDACTED]');
      expect(screen.lastFrame()).not.toContain('trace-click-key');
      screen.stdin.write(' '); await settle();
      expect(screen.lastFrame()).not.toContain('Arguments (redacted)');
      screen.stdin.write('\x1b[C'); await settle();
      expect(screen.lastFrame()).toContain('Arguments (redacted)');
      screen.stdin.write('\x1b[D'); await settle();
      expect(screen.lastFrame()).not.toContain('Arguments (redacted)');
      screen.stdin.write('\x1b[A\x1b[C'); await settle();
      expect(screen.lastFrame()).toContain('Input tokens: 100');
      screen.stdin.write('\r'); await settle();
      expect(screen.lastFrame()).not.toContain('Input tokens: 100');
      expect(calls).toBe(2);
      expect(app.store.conversationObjectives(app.id)).toHaveLength(1);
      expect(app.inspect().objective!.usage.requests).toBe(1);
      expect(screen.lastFrame()).toContain('SAVED_DRAFT|');
      screen.stdin.write('\x14'); await settle();
      expect(screen.lastFrame()).not.toContain('TRACE FOCUS');
      screen.stdin.write('\x03'); await settle();
      await send('/trace off');
      expect(screen.lastFrame()).not.toContain('Trace |');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('maps trace clicks after resize and scrolling without letting clicks decide a pending approval', async () => {
    const f = fixture({ version: 4 });
    const runtime = new ScriptRuntime(async runtime => {
      for (let index = 0; index < 8; index++) await runtime.call('work_inspect', {});
      await runtime.requestPermission('read_file', { path: 'notes.txt' });
      runtime.message('MOUSE_APPROVAL_FINISHED');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const work = app.submit('Show pending approval safely.');
    try {
      await vi.waitFor(() => expect(app.inspect().pending).toHaveLength(1));
      const pending = app.inspect().pending[0]!;
      await send('/trace on');
      Object.defineProperties(screen.stdout, { columns: { value: 48, configurable: true }, rows: { value: 26, configurable: true } });
      screen.stdout.emit('resize'); await settle();
      screen.stdin.write('\x14'); await settle();
      expect(screen.lastFrame()).toContain('v Trace |');
      const row = screen.lastFrame()!.split('\n').findIndex(line => line.includes('v Trace |'));
      screen.stdin.write(`\x1b[<0;2;${row + 1}M`); await settle();
      expect(screen.lastFrame()).toContain('> Trace |');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      const approvalRow = screen.lastFrame()!.split('\n').findIndex(line => line.includes('APPROVAL REQUIRED'));
      screen.stdin.write(`\x1b[<0;2;${approvalRow + 1}M`); await settle();
      expect(app.inspect().pending[0]).toEqual(pending);
      expect(screen.lastFrame()).not.toContain('TRACE FOCUS');
      await send('/approve'); await work;
      expect(app.inspect().objective?.status).toBe('completed');
    } finally { screen.unmount(); await app.close(); await work; f.cleanup(); }
  });

  it('wraps the full pending question and choices, prioritizes them over trace history, and pages overflow from the top', async () => {
    const f = fixture({ version: 4 });
    const question = `QUESTION_START ${'Please confirm the intended news website before continuing. '.repeat(7)} QUESTION_TAIL`;
    const choices = ['Use the intended news website', 'Provide a different URL'];
    const runtime = new ScriptRuntime(async runtime => {
      const answer = await runtime.options!.question(question, choices, false);
      expect(answer).toBe(choices[1]);
      runtime.message('QUESTION_ANSWERED');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    await app.setApproveAll(true);
    const screen = render(<TerminalApp controller={app} />);
    const resize = async (columns: number, rows: number) => {
      Object.defineProperties(screen.stdout, { columns: { value: columns, configurable: true }, rows: { value: rows, configurable: true } });
      screen.stdout.emit('resize'); await settle();
    };
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const work = app.submit('Clarify the intended news site.');
    try {
      await vi.waitFor(() => expect(app.inspect().pending[0]?.kind).toBe('question'));
      await resize(86, 40);
      await send('/trace on');
      expect(screen.lastFrame()).toContain('QUESTION_START');
      expect(screen.lastFrame()).toContain('QUESTION_TAIL');
      for (const choice of choices) expect(screen.lastFrame()).toContain(`- ${choice}`);
      expect(screen.lastFrame()).toContain('Waiting for input | /request: full question');
      expect(screen.lastFrame()).not.toContain('[run] TOOL');
      expect(screen.lastFrame()!.split('\n').length).toBeLessThanOrEqual(40);
      const pending = app.inspect().pending[0]!;
      await resize(42, 18);
      expect(screen.lastFrame()).toContain('More: /request');
      expect(screen.lastFrame()!.split('\n').length).toBeLessThanOrEqual(18);
      expect(screen.lastFrame()).toContain('> |');
      await resize(42, 14);
      expect(screen.lastFrame()!.split('\n').length).toBeLessThanOrEqual(14);
      await send('/trace off');
      await send('/request');
      expect(screen.lastFrame()).toContain('INPUT NEEDED');
      expect(screen.lastFrame()).toContain('QUESTION_START');
      expect(screen.lastFrame()).toContain('Request lines 1-');
      expect(screen.lastFrame()).not.toContain('"description"');
      let viewed = screen.lastFrame()!;
      let previousEnd = Number(viewed.match(/Request lines \d+-(\d+)\//)![1]);
      for (let page = 0; page < 12 && !viewed.includes(choices[1]!); page++) {
        screen.stdin.write('\x1b[6~'); await settle();
        viewed += `\n${screen.lastFrame()}`;
        const counter = screen.lastFrame()!.match(/Request lines (\d+)-(\d+)\//)!;
        expect(Number(counter[1])).toBeLessThanOrEqual(previousEnd + 1);
        previousEnd = Number(counter[2]);
        expect(screen.lastFrame()!.split('\n').length).toBeLessThanOrEqual(14);
      }
      expect(viewed).toContain('QUESTION_TAIL');
      for (const choice of choices) expect(viewed).toContain(choice);
      screen.stdin.write('\x1b[5~'); await settle();
      expect(screen.lastFrame()).not.toContain('Request lines 1-');
      await send('/request');
      expect(screen.lastFrame()).toContain('Request lines 1-');
      expect(app.inspect().pending[0]).toEqual(pending);
      expect(app.store.list('action', app.id)).toHaveLength(0);
      expect(app.inspect().objective!.usage.requests).toBe(0);
      await send(choices[1]!); await work;
      expect(app.inspect().pending).toHaveLength(0);
      expect(screen.lastFrame()).toContain('QUESTION_ANSWERED');
      expect(screen.lastFrame()).not.toContain('INPUT NEEDED');
      expect(screen.lastFrame()).not.toContain('Request lines');
    } finally { screen.unmount(); await app.close(); await work; f.cleanup(); }
  });

  it('keeps multiline Unicode questions readable after resizing without changing approval or answer behavior', async () => {
    const f = fixture({ version: 4 });
    const unicode = '\u65e5\u672c\u8a9e\u306e\u30cb\u30e5\u30fc\u30b9';
    const question = `Which URL should I use?\n${`${unicode} `.repeat(12)}\nFINAL_QUESTION_LINE`;
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.options!.question(question);
      await runtime.requestPermission('read_file', { path: 'notes.txt' });
      runtime.message('READ_APPROVED');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const work = app.submit('Ask before retrieving content.');
    try {
      await vi.waitFor(() => expect(app.inspect().pending[0]?.kind).toBe('question'));
      Object.defineProperties(screen.stdout, { columns: { value: 42, configurable: true }, rows: { value: 32, configurable: true } });
      screen.stdout.emit('resize'); await settle();
      expect(screen.lastFrame()).toContain('FINAL_QUESTION_LINE');
      expect(screen.lastFrame()).toContain(unicode);
      expect(screen.lastFrame()!.split('\n').length).toBeLessThanOrEqual(32);
      await send('/request');
      expect(screen.lastFrame()).toContain('Which URL should I use?');
      await send('/back');
      expect(screen.lastFrame()).toContain('FINAL_QUESTION_LINE');
      await send('Use the stated source.');
      expect(app.inspect().pending[0]?.kind).toBe('approval');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      await send('/request');
      expect(screen.lastFrame()).toContain('read_file');
      expect(screen.lastFrame()!.replaceAll('\n', '')).toContain('notes.txt');
      expect(app.inspect().pending[0]?.status).toBe('pending');
      await send('/approve'); await work;
      expect(app.inspect().objective?.status).toBe('completed');
    } finally { screen.unmount(); await app.close(); await work; f.cleanup(); }
  });

  it('keeps tracing opt-in, folds overflow, expands without replay, and preserves expansion across live calls', async () => {
    const f = fixture({ version: 4 });
    let release: (() => void) | undefined; let calls = 0;
    const runtime = new ScriptRuntime(async runtime => {
      for (let index = 0; index < 12; index++) await runtime.call('trace_fixture', { path: `item-${index}`, secret: 'fixture-trace-key' });
      await new Promise<void>(resolve => { release = resolve; });
      await runtime.call('trace_fixture', { path: 'last-item', secret: 'fixture-trace-key' });
      runtime.message('TRACE_FINISHED');
    });
    const app = await SessionController.open({ config: f.config, apiKey: 'fixture-trace-key', runtimeFactory: () => runtime });
    app.broker.register('trace_fixture', 'Synthetic trace evidence.', z.object({ path: z.string(), secret: z.string() }), 'internal',
      () => ({ value: ++calls }));
    let screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const work = app.submit('Inspect synthetic trace activity.');
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      Object.defineProperties(screen.stdout, { columns: { value: 100, configurable: true }, rows: { value: 24, configurable: true } });
      screen.stdout.emit('resize');
      await settle();
      expect(screen.lastFrame()).not.toContain('TRACE ON');
      await send('/trace on');
      expect(screen.lastFrame()).toContain('TRACE ON');
      expect(screen.lastFrame()).toContain('Earlier success: 0 model + 11 tool calls');
      expect(screen.lastFrame()).toContain('item-11');
      const before = app.inspect().objective!.usage.requests;
      await send('/trace expand');
      expect(screen.lastFrame()).not.toContain('> Earlier success');
      screen.stdin.write('\x1b[5~'); await settle();
      const scrolledFrame = screen.lastFrame();
      const scrolledCalls = screen.lastFrame()!.split('\n').filter(line => line.includes('[done] TOOL'));
      expect(scrolledCalls.length, scrolledFrame).toBeGreaterThan(0);
      release!(); await work; await settle();
      expect(screen.lastFrame()).not.toContain('> Earlier success');
      expect(screen.lastFrame()!.split('\n').filter(line => line.includes('[done] TOOL')),
        JSON.stringify({ before: scrolledFrame, after: screen.lastFrame() })).toEqual(scrolledCalls);
      expect(calls).toBe(13);
      expect(app.inspect().objective!.usage.requests).toBe(before);
      const id = app.trace().items.at(-1)!.value.id;
      await send(`/trace t-${id.slice(0, 8)}`);
      expect(screen.lastFrame()).toContain('Arguments (redacted)');
      expect(screen.lastFrame()).toContain('[REDACTED]');
      expect(screen.lastFrame()).not.toContain('fixture-trace-key');
      expect(calls).toBe(13);
      await send('/trace off');
      expect(screen.lastFrame()).not.toContain('TRACE ON');
      expect(screen.lastFrame()).toContain('TRACE_FINISHED');
      await send('/trace on');
      await send('/trace collapse');
      expect(screen.lastFrame()).toContain('> Earlier success');
      Object.defineProperties(screen.stdout, { columns: { value: 42, configurable: true }, rows: { value: 22, configurable: true } });
      screen.stdout.emit('resize'); await settle();
      expect(screen.lastFrame()!.split('\n').every(line => line.length <= 42)).toBe(true);
      screen.unmount(); screen = render(<TerminalApp controller={app} />); await settle();
      expect(screen.lastFrame()).not.toContain('TRACE ON');
      await send('/trace on');
      await send('/clear');
      expect(screen.lastFrame()).toContain('No recorded calls for this objective');
      expect(app.store.list('action', app.id)).toHaveLength(13);
    } finally { release?.(); await work; screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('traces live approvals and settled unknown model usage without changing decisions', async () => {
    const f = fixture({ version: 4 });
    const runtime = new ScriptRuntime(async runtime => {
      const request = app.resources.beginModelRequest(100, 'fixture-model', undefined, null);
      runtime.options!.emit('runtime', { state: 'model_request', request });
      await runtime.requestPermission('read_file', { path: 'notes.txt' });
      app.resources.settle(request);
      runtime.options!.emit('runtime', { state: 'model_request', request });
      runtime.message('TRACE_APPROVAL_FINISHED');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const work = app.submit('Read synthetic notes.');
    try {
      await vi.waitFor(() => expect(app.inspect().pending).toHaveLength(1));
      await send('/trace on');
      expect(screen.lastFrame()).toContain('[run] MODEL');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      const pending = app.inspect().pending[0]!;
      const action = app.trace().items.find(item => item.kind === 'model')!;
      await send(`/trace ${action.value.id}`);
      expect(app.inspect().pending[0]).toEqual(pending);
      await send('/trace off');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      await send('/trace on');
      await send('/approve');
      await work; await settle();
      expect(screen.lastFrame()).toContain('> Trace |');
      await send('/trace expand');
      expect(screen.lastFrame()).toContain('usage unknown');
      expect(screen.lastFrame()).not.toContain('[run]');
      expect(app.inspect().pending).toHaveLength(0);
      await send('/trace nonsense extra');
      expect(screen.lastFrame()).toContain('Use /trace');
      expect(app.store.list('action', app.id)).toHaveLength(0);
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('pages history, keeps an older active model visible, and restores recorded calls without stale state after resume', async () => {
    const f = fixture({ version: 4 });
    let release: (() => void) | undefined; let calls = 0;
    const runtime = new ScriptRuntime(async runtime => {
      const request = app.resources.beginModelRequest(100, 'fixture-model', undefined, null);
      runtime.options!.emit('runtime', { state: 'model_request', request });
      for (let index = 0; index < 42; index++) await runtime.call('trace_page', { path: `page-${index}` });
      await new Promise<void>(resolve => { release = resolve; });
      app.resources.settle(request);
      runtime.options!.emit('runtime', { state: 'model_request', request });
      runtime.message('PAGED_TRACE_FINISHED');
    });
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const id = app.id;
    app.broker.register('trace_page', 'Synthetic paged history.', z.object({ path: z.string() }), 'internal', () => ({ value: ++calls }));
    let screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    const work = app.submit('Inspect bounded history.');
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await send('/trace on');
      expect(screen.lastFrame()).toContain('[run] MODEL');
      expect(app.trace().items).toHaveLength(40);
      expect(app.trace().items.some(item => item.kind === 'model')).toBe(false);
      await send('/trace older');
      expect(screen.lastFrame()).toContain('page-0');
      expect(screen.lastFrame()).toContain('[run] MODEL');
      await send('/trace latest');
      release!(); await work; await settle();
      screen.unmount(); await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id,
        runtimeFactory: () => new ScriptRuntime(async runtime => runtime.message('FRESH_TRACE_OBJECTIVE')) });
      screen = render(<TerminalApp controller={app} />); await settle();
      expect(screen.lastFrame()).not.toContain('TRACE ON');
      await send('/trace on');
      await send('/trace older');
      await send('/trace expand');
      expect(screen.lastFrame()).toContain('usage unknown');
      expect(screen.lastFrame()).not.toContain('[run]');
      expect(calls).toBe(42);
      await app.submit('Start another objective.'); await settle();
      expect(screen.lastFrame()).toContain('Trace | 0 model + 0 tool calls');
      expect(screen.lastFrame()).not.toContain('page-0');
      expect(app.store.list('action', app.id)).toHaveLength(42);
    } finally { release?.(); await work; screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('clears the conversation, inspector and input recall, including after remount, without deleting evidence', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('OLD_ASSISTANT_CONTEXT'));
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    let screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      await send('OLD_USER_CONTEXT');
      expect(screen.lastFrame()).toContain('OLD_ASSISTANT_CONTEXT');
      const old = app.inspect().objective!;
      const error = app.store.event({ type: 'error', sessionId: app.id, objectiveId: old.id,
        data: { message: 'HISTORICAL_ERROR', code: 'FIXTURE' } });
      await app.setApproveAll(true);
      await send('/status');
      await send('/clear');
      expect(screen.lastFrame()).toContain('Context cleared.');
      expect(screen.lastFrame()).toContain('idle');
      expect(screen.lastFrame()).toContain('APPROVE ALL: ENABLED');
      expect(screen.lastFrame()).not.toContain('OLD_USER_CONTEXT');
      expect(screen.lastFrame()).not.toContain('OLD_ASSISTANT_CONTEXT');
      screen.stdin.write('\x1b[A'); await settle();
      expect(screen.lastFrame()).not.toContain('/clear');
      expect(screen.lastFrame()).not.toContain('> /status');
      expect(app.store.get('objective', old.id, app.id)).toEqual(old);
      await send(`/error ${error.data.errorId}`);
      expect(screen.lastFrame()).toContain('HISTORICAL_ERROR');
      await send('/back');
      screen.unmount();
      screen = render(<TerminalApp controller={app} />);
      await settle();
      screen.stdin.write('\x1b[A'); await settle();
      expect(screen.lastFrame()).not.toContain('OLD_USER_CONTEXT');
      expect(screen.lastFrame()).not.toContain('OLD_ASSISTANT_CONTEXT');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });

  describe('inline trace projection', () => {
    it('folds only contiguous older successes, retaining the newest success and every unsafe or active outcome', () => {
      const f = fixture({ version: 4 });
      try {
        const statuses: Action['status'][] = ['completed', 'completed', 'failed', 'completed', 'completed', 'started', 'denied', 'unknown', 'completed'];
        const records: ActivityRecord[] = statuses
          .map((status, index) => ({
            order: index, kind: 'tool', value: {
              id: index.toString(16).padStart(64, '0'), sessionId: 's', objectiveId: 'o', callId: `call-${index}`,
              tool: 'fixture', args: {}, argsHash: 'h', effect: 'internal',
              status,
              resultId: null, error: null,
            },
          }));
        const calls = records.map(item => projectActivity(item, { model: f.config.model, pending: [], status: 'running' }));
        const folded = foldActivity(calls, 3, false);
        expect(folded.filter(item => item.kind === 'group')).toEqual([
          { kind: 'group', tools: 2, models: 0 }, { kind: 'group', tools: 2, models: 0 },
        ]);
        expect(folded.filter(item => item.kind !== 'group').map(item => item.status)).toEqual(['failed', 'running', 'denied', 'unknown', 'completed']);
        expect(foldActivity(calls, calls.length, false)).toEqual(calls);
        expect(foldActivity(calls, 3, true)).toEqual(calls);
      } finally { f.cleanup(); }
    });

    it('does not present missing accounting or interrupted requests as active or invent historical timing', () => {
      const f = fixture({ version: 4 });
      try {
        const record: ActivityRecord = { order: 1, kind: 'model', value: {
          id: 'a'.repeat(32), sessionId: 's', objectiveId: 'o', input: 0, output: 0, reservation: 0,
          interaction: 'model-or-auxiliary', status: 'unknown', outcome: 'completed', reportedUsage: false, error: null,
        } };
        const done = projectActivity(record, { model: f.config.model, pending: [], status: 'completed' });
        expect(done).toMatchObject({ status: 'completed', successful: false });
        expect(activityLine(done)).toContain('usage unknown');
        expect(activityDetail(done, f.config)).toContain('Duration: time unavailable');
        expect(activityDetail(done, f.config)).toContain('Input tokens: unknown');
        record.value.outcome = 'running';
        expect(projectActivity(record, { model: f.config.model, pending: [], status: 'recovery_required' }).status).toBe('unknown');
      } finally { f.cleanup(); }
    });
  });

  it('rejects clear during a live approval without losing the conversation or approving the call', async () => {
    const f = fixture();
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async runtime => {
      await runtime.requestPermission('read_file', { path: 'notes.txt' });
      runtime.message('Preserved conversation.');
    }) });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      await send('WAITING_USER_CONTEXT');
      const runtimeId = app.runtimeId;
      await send('/clear');
      expect(screen.lastFrame()).toContain('Finish or reconcile the current objective first');
      expect(screen.lastFrame()).toContain('WAITING_USER_CONTEXT');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      expect(app.inspect().pending).toHaveLength(1);
      expect(app.runtimeId).toBe(runtimeId);
      await send('/approve');
      expect(app.inspect().objective?.status).toBe('completed');
      await send('/clear unexpected');
      expect(app.inspect().objective?.original).toBe('WAITING_USER_CONTEXT');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('distinguishes uncapped usage, unknown billing and current context/output provenance', async () => {
    const f = fixture({ version: 4 });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async runtime => {
      app.resources.settle(app.resources.beginModelRequest(200, 'synthetic', undefined, null));
      runtime.message('A verified answer with unknown billing.');
    }) });
    const screen = render(<TerminalApp controller={app} />);
    try {
      await settle();
      expect(screen.lastFrame()).toContain('no task token budget');
      expect(screen.lastFrame()).toContain('Context ?/? (unavailable)');
      expect(screen.lastFrame()).toContain('SDK/provider default');
      await app.submit('Complete without a task quota.'); await settle();
      expect(screen.lastFrame()).toContain('Usage unknown');
      expect(screen.lastFrame()).toContain('no task token budget');
      expect(screen.lastFrame()).toContain('cost unknown');
      expect(screen.lastFrame()).not.toContain('/undefined');
      expect(screen.lastFrame()).not.toContain('/100000');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });
  it('pages historical action errors and excludes successful actions and their private arguments', async () => {
    const f = fixture();
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async () => {}) });
    try {
      for (let index = 0; index < 21; index++) {
        app.store.event({ type: 'action', sessionId: app.id, objectiveId: null, data: {
          action: { id: `legacy-${index}`, callId: `call-${index}`, tool: 'legacy_tool',
            status: 'failed', error: `Legacy failure ${index}`, errorCode: 'LEGACY',
            args: { privateValue: 'PRIVATE_LEGACY_ARGUMENT' } },
        } });
      }
      const success = app.store.event({ type: 'action', sessionId: app.id, objectiveId: null,
        data: { action: { tool: 'successful_tool', status: 'completed' } } });
      const first = app.store.errors(app.id);
      expect(first.errors).toHaveLength(20);
      expect(first.errors[0]).toMatchObject({ source: 'tool', code: 'LEGACY', callId: 'call-20', message: 'Legacy failure 20' });
      expect(JSON.stringify(first)).not.toContain('PRIVATE_LEGACY_ARGUMENT');
      const last = app.store.errors(app.id, first.next!);
      expect(last.errors).toHaveLength(1);
      expect(last.errors[0]?.message).toBe('Legacy failure 0');
      expect(last.next).toBeNull();
      expect(() => app.store.error(app.id, `error-${success.sequence}`)).toThrow('belongs to this session');
    } finally { await app.close(); f.cleanup(); }
  });
  it('inspects persistent tool errors by ID across objectives without replaying them or exposing arguments', async () => {
    const f = fixture();
    let calls = 0;
    const runtimeFactory = () => new ScriptRuntime(async runtime => {
      if (calls === 0) await runtime.call('fixture_failure', { privateValue: 'PRIVATE_TOOL_ARGUMENT' });
      else runtime.message('Synthetic later objective.');
    });
    let app = await SessionController.open({ config: f.config, apiKey: 'synthetic-ui-key', runtimeFactory });
    const sessionId = app.id;
    app.broker.register('fixture_failure', 'Synthetic failed tool.', z.object({ privateValue: z.string() }), 'internal',
      () => { calls++; throw new HarnessError('FIXTURE_FAILURE', 'Tool failed with synthetic-ui-key.'); });
    try {
      await app.submit('Record a synthetic failure.');
      const error = app.store.errors(app.id).errors.find(error => error.source === 'tool')!;
      expect(error).toMatchObject({ code: 'FIXTURE_FAILURE', tool: 'fixture_failure', status: 'failed' });
      expect(error.stack).toContain('HarnessError');
      expect(JSON.stringify(error)).not.toContain('PRIVATE_TOOL_ARGUMENT');
      expect(JSON.stringify(error)).not.toContain('synthetic-ui-key');
      const peer = await SessionController.open({ config: f.config, runtimeFactory });
      try { expect(() => peer.store.error(peer.id, error.id)).toThrow('belongs to this session'); }
      finally { await peer.close(); }
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId, apiKey: 'synthetic-ui-key', runtimeFactory });
      expect(app.store.error(app.id, error.id)).toEqual(error);
      const screen = render(<TerminalApp controller={app} />);
      const send = async (input: string) => { screen.stdin.write(input); await settle(); screen.stdin.write('\r'); await settle(); };
      try {
        await settle();
        await send('Start a later objective.');
        await send('/errors');
        expect(screen.lastFrame()).toContain(error.id);
        expect(screen.lastFrame()).toContain('FIXTURE_FAILURE');
        await send(`/error ${error.id}`);
        expect(screen.lastFrame()).toContain(error.id);
        expect(calls).toBe(1);
        await send('/back');
        await send('/error invalid');
        expect(screen.lastFrame()).toContain('Use an error ID from /errors');
      } finally { screen.unmount(); }
    } finally { await app.close(); f.cleanup(); }
  });
  it('enables session-wide approval from the command, shows the mode, and can restore approval prompts', async () => {
    const f = fixture({ permissionMode: 'manual' });
    const runtime = new ScriptRuntime(async runtime => {
      if (runtime.options!.permissionMode !== 'allow-all') await runtime.requestPermission('read_file', { path: 'notes.txt' });
      runtime.message('Synthetic session-approved work.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      await send('Read synthetic notes.');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      await send('/approve_all');
      expect(app.inspect().pending).toHaveLength(1);
      await send('/approve');
      expect(app.inspect().objective?.status).toBe('completed');
      expect(app.inspect().approveAll).toBe(true);
      expect(screen.lastFrame()?.split('\n')).toContain('APPROVE ALL: ENABLED');
      await send('Read synthetic notes again.');
      expect(app.inspect().objective?.status).toBe('completed');
      expect(app.inspect().pending).toHaveLength(0);
      await send('/status');
      screen.stdin.write('\x1b[5~'); await settle();
      expect(screen.lastFrame()?.split('\n')).toContain('APPROVE ALL: ENABLED');
      await send('/back');
      await send('/approve_all unknown');
      expect(screen.lastFrame()).toContain('Use /approve_all or /approve_all off.');
      expect(app.inspect().approveAll).toBe(true);
      await send('/approve_all off');
      expect(screen.lastFrame()).not.toContain('APPROVE ALL: ENABLED');
      await send('Read with per-call approval.');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      expect(app.inspect().pending).toHaveLength(1);
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('shows the persisted approval indicator immediately after resume while idle', async () => {
    const f = fixture();
    const runtimeFactory = () => new ScriptRuntime(async runtime => runtime.message('Synthetic completed work.'));
    let app = await SessionController.open({ config: f.config, runtimeFactory });
    const id = app.id;
    try {
      await app.setApproveAll(true);
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory });
      const screen = render(<TerminalApp controller={app} />);
      try {
        await settle();
        expect(screen.lastFrame()?.split('\n')).toContain('APPROVE ALL: ENABLED');
        expect(screen.lastFrame()).toContain('idle');
      } finally { screen.unmount(); }
    } finally { await app.close(); f.cleanup(); }
  });

  it('lists the effective SDK skills and exposes reload errors without inventing snapshots', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => runtime.message('Synthetic completed objective.'));
    let catalog = [{ name: 'review-notes', description: 'Synthetic review-notes guidance.',
      source: 'workspace', enabled: true, userInvocable: true }];
    const list = vi.spyOn(runtime, 'listSkills').mockImplementation(async () => catalog);
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      await send('Complete the synthetic objective.');
      await send('/skills list');
      expect(screen.lastFrame()).toContain('review-notes');
      expect(screen.lastFrame()).toContain('Synthetic review-notes');
      expect((await app.listSkills()).skills).toEqual(catalog);
      catalog = [
        { name: 'review-notes', description: 'Updated guidance.', source: 'workspace', enabled: true, userInvocable: true },
        { name: 'summarize-notes', description: 'New guidance.', source: 'workspace', enabled: true, userInvocable: true },
      ];
      await send('/skills reload');
      expect(screen.lastFrame()).toContain('summarize-notes');
      expect((await app.listSkills()).skills.find(skill => skill.name === 'review-notes')!.description).toBe('Updated guidance.');
      list.mockRejectedValueOnce(new Error('SDK rejected malformed frontmatter.'));
      await send('/skills reload');
      expect(screen.lastFrame()).toContain('Skills command failed');
      expect(screen.lastFrame()).toContain('frontmatter');
      expect((await app.listSkills()).skills).toEqual(catalog);
      await send('/skills unknown');
      expect(screen.lastFrame()).toContain('Use /skills list or /skills reload.');
      await send('/skills');
      expect(screen.lastFrame()).toContain('summarize-notes');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });
  it('retains safe paste, live request inspection/approval, plans, results and resize-safe scrolling', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.requestPermission('read_file', { path: 'notes.txt' });
      await runtime.call('work_inspect', {});
      runtime.message('Synthetic terminal evidence.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      screen.stdin.write('\x1b[200~Read\nsynthetic notes\x1b[201~'); await settle();
      expect(app.inspect().objective).toBeUndefined();
      expect(screen.lastFrame()).toContain('synthetic notes');
      screen.stdin.write('\r'); await settle();
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      await send('/request');
      expect(screen.lastFrame()).toContain('read_file');
      await send('/approve');
      expect(app.inspect().objective?.status).toBe('completed');
      expect(screen.lastFrame()).toContain('Synthetic terminal evidence.');
      await send('/plan');
      await send('/back');
      expect(screen.lastFrame()).toContain('1 results');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });
});
