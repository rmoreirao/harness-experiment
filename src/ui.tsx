import { useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useStdin, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { edit, emptyEditor, InputDecoder, type InputAction } from './editor.js';
import { terminalText } from './privacy.js';
import { errorText, record } from './contracts.js';
import { errorDiagnostic, errorInspector, errorNotice } from './errors.js';
import type { Decision, Objective } from './contracts.js';
import type { SessionController } from './controller.js';
import { activityDetail, activityLine, projectActivity } from './activity.js';
import { traceBlocks, type DisplayLine, type TraceTarget } from './trace-view.js';

export const HELP = `/status /plan /request /back /cancel /continue /clear /exit
/request opens the full pending question or approval scope; PageUp/PageDown scroll; /back returns.
/clear resets model context, conversation and input history while idle; saved evidence and settings remain.
/approve or /reject decides the displayed current action only.
/approve_all approves all pending and future tool calls in this session, including after resume.
/approve_all off restores per-call approvals. Questions and safety restrictions still apply.
/inspect RESULT_ID [BYTE_OFFSET] reads a stored result page; binary pages are base64.
/events [SEQUENCE] inspects a bounded audit page.
/trace on|off shows or hides inline plan/tool/model activity (off each launch).
/trace expand|collapse unfolds or folds older successful calls; failures remain separate.
/trace older|latest pages recorded calls; /trace CALL_ID inspects one without replaying it.
Click trace > or v to expand/collapse. Ctrl+T focuses traces; arrows select; Space/Enter toggles.
Mouse reporting is active only with /trace on; /trace off restores normal terminal mouse behavior.
/errors [BEFORE_ID] lists session errors; /error ERROR_ID inspects one error.
/grant {"paths":["ABSOLUTE_PATH"],"origins":[],"expires":TIMESTAMP} explicitly enables scoped trusted reads.
/revoke GRANT_ID removes a trusted-read grant.
/skills list (or /skills) lists loaded skills; /skills reload refreshes them while idle.
/reconcile {"note":"checked effects","actions":[],"usage":[]} resolves exact unknown records.
Enter sends; Ctrl+J or Alt+Enter inserts a newline; paste never submits.
Arrows edit/history; PageUp/PageDown scroll; Ctrl+C cancels; Ctrl+D saves/exits.`;

function wrapText(text: string, width: number, wordWrap = true): string[] {
  return wrapAnsi(terminalText(text).replaceAll('\t', '    '), Math.max(1, width), { hard: true, trim: false, wordWrap }).split('\n');
}
function requestBody(request: Decision): string {
  return [request.description, ...(request.choices?.length ? ['', 'Choices:', ...request.choices.map(choice => `- ${choice}`)] : [])].join('\n');
}
function requestHint(request: Decision): string {
  if (request.kind === 'approval') return '/request: full scope | /approve or /reject: this action | /approve_all: session';
  return request.choices?.length && !request.allowFreeform
    ? 'Type a listed choice below. Answers do not authorize actions.'
    : 'Type your answer below. Answers do not authorize actions.';
}

export function TerminalApp({ controller, domain = 'general', criteria = [], onMouseMode, onTraceFrame }: {
  controller: SessionController; domain?: Objective['domain']; criteria?: string[]; onMouseMode?: (enabled: boolean) => void;
  onTraceFrame?: (enabled: boolean) => void;
}) {
  const { exit } = useApp(); const { stdin, setRawMode } = useStdin(); const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({ width: stdout.columns ?? 100, height: stdout.rows ?? 30 });
  const [, refresh] = useState(0);
  const [editor, setEditor] = useState(() => emptyEditor(controller.store.conversationObjectives(controller.id).map(objective => objective.original)));
  const editorRef = useRef(editor); editorRef.current = editor;
  const [inspector, setInspector] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [tracing, setTracing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [traceDisclosure, setTraceDisclosure] = useState<{ objectiveId?: string; open: boolean } | null>(null);
  const [openCalls, setOpenCalls] = useState<Set<string>>(() => new Set());
  const [traceFocused, setTraceFocused] = useState(false);
  const [traceSelection, setTraceSelection] = useState('root');
  const traceAnchor = useRef<{ key: string; screenRow: number } | null>(null);
  const traceAction = useRef<(target: TraceTarget, mode?: 'toggle' | 'open' | 'close') => void>(() => {});
  const traceInteraction = useRef<{
    enabled: boolean; focused: boolean; width: number; start: number; viewport: number; count: number;
    targets: { target: TraceTarget; row: number }[]; selected?: TraceTarget; hits: Map<number, TraceTarget>; open: Map<string, boolean>;
  }>({ enabled: false, focused: false, width: 0, start: 0, viewport: 0, count: 0, targets: [], hits: new Map(), open: new Map() });
  const [traceBefore, setTraceBefore] = useState<number>();
  const [pausedLive, setPausedLive] = useState(false);
  const [traceRevision, setTraceRevision] = useState(0);
  const traceObjective = useRef<string | undefined>(undefined);
  const previousRows = useRef({ key: '', count: 0 });
  const traceScroll = useRef<{
    enabled: boolean; inspecting: boolean; request: boolean; before?: number; last?: number;
    offset: number; maximum: number; pageSize: number; paused: boolean;
  }>({ enabled: false, inspecting: false, request: false, offset: 0, maximum: 0, pageSize: 8, paused: false });
  const [notice, setNotice] = useState(() => controller.inspect().objective?.reason ?? (controller.inspect().approveAll
    ? 'Session-wide tool approval enabled. Use /approve_all off to restore per-call approvals.'
    : 'Approval-first. Describe an objective or use /help.'));
  const [live, setLive] = useState('');
  const [stopping, setStopping] = useState(false);
  const command = useRef<(input: string) => Promise<void>>(async () => {});
  const reportError = (error: unknown, operation: string) => {
    const data = errorDiagnostic(error, controller.store.redactor, { source: 'command', operation });
    try {
      const event = controller.store.event({
        type: 'error', sessionId: controller.id, objectiveId: controller.inspect().objective?.id ?? null, data,
      });
      setNotice(errorNotice(event.data));
    } catch (storageError) {
      setNotice(`${data.message}\nError history could not be saved: ${controller.store.redactor.text(errorText(storageError))}`);
    }
  };
  const launch = (work: Promise<unknown>, operation: string) => {
    void work.catch(error => reportError(error, operation))
      .finally(() => refresh(value => value + 1));
  };
  command.current = async input => {
    const state = controller.inspect(); const pending = state.pending[0];
    setTraceFocused(false);
    if (input !== '/request') setRequestId(null);
    if (input === '/exit') { setStopping(true); await controller.close(); exit(); return; }
    if (input === '/cancel') { launch(controller.cancel(), '/cancel'); return; }
    if (input === '/clear') { await controller.clearContext(); return; }
    if (input === '/help') { setInspector(HELP); setOffset(0); return; }
    if (input === '/status') { setInspector(JSON.stringify(state, null, 2)); setOffset(0); return; }
    if (/^\/trace(?:\s|$)/.test(input)) {
      const [, action, ...extra] = input.trim().split(/\s+/);
      if (!action || extra.length) throw new Error('Use /trace on|off|expand|collapse|older|latest or /trace CALL_ID.');
      if (action === 'on' || action === 'off') {
        if (action === 'on') { setTraceBefore(undefined); setPausedLive(false); }
        setTracing(action === 'on'); setInspector(null); setOffset(0); return;
      }
      if (!tracing) throw new Error('Enable the activity feed with /trace on first.');
      if (action === 'expand' || action === 'collapse') {
        setExpanded(action === 'expand'); setTraceDisclosure({ objectiveId: state.objective?.id, open: true });
        setInspector(null); setOffset(0); return;
      }
      if (action === 'older' || action === 'latest') {
        const next = action === 'older' ? controller.trace(traceBefore).next : undefined;
        if (next === null) throw new Error('No older calls in this objective.');
        setTraceBefore(next); setPausedLive(false); setInspector(null); setOffset(0); return;
      }
      const call = projectActivity(controller.traceCall(action), {
        model: controller.config.model, pending: state.pending, status: state.objective?.status,
      });
      setInspector(activityDetail(call, controller.config)); setOffset(0); return;
    }
    const errors = errorInspector(input, controller.store, controller.id);
    if (errors !== null) { setInspector(errors); setOffset(0); return; }
    if (input === '/plan') { setInspector(JSON.stringify(state.objective?.steps ?? [], null, 2)); setOffset(0); return; }
    if (input === '/request') {
      setRequestId(pending?.id ?? null); setInspector(pending ? null : 'No pending request.'); setOffset(0); return;
    }
    if (input === '/back') { setInspector(null); setOffset(0); return; }
    if (/^\/approve_all(?:\s|$)/.test(input)) {
      try {
        const [, action, ...extra] = input.trim().split(/\s+/);
        if (extra.length || (action !== undefined && action !== 'off')) throw new Error('Use /approve_all or /approve_all off.');
        controller.setApproveAll(action !== 'off');
        setInspector(null);
        setNotice(action === 'off' ? 'Per-call tool approvals restored. Already approved calls are not revoked.'
          : 'All pending and future tool calls approved for this session. Questions still require answers. Use /approve_all off to disable.');
        refresh(value => value + 1); return;
      } catch (error) {
        setInspector(`Approval command failed: ${controller.store.redactor.text(errorText(error))}`);
        setOffset(0); throw error;
      }
    }
    if (/^\/skills(?:\s|$)/.test(input)) {
      try {
        const [, action = 'list', ...extra] = input.trim().split(/\s+/);
        if (extra.length || !['list', 'reload'].includes(action)) throw new Error('Use /skills list or /skills reload.');
        const catalog = action === 'reload' ? controller.reloadSkills() : controller.listSkills();
        setInspector(`${action === 'reload' ? 'Skills reloaded.\n' : ''}Skills directory: ${catalog.directory}
Loaded skills: ${catalog.skills.length}

${catalog.skills.map(skill => `${skill.name} [${skill.source}]\n${skill.description}`).join('\n\n')}`);
        setOffset(0); return;
      } catch (error) {
        setInspector(`Skills command failed: ${controller.store.redactor.text(errorText(error))}`);
        setOffset(0); throw error;
      }
    }
    if (input === '/approve' || input === '/reject') {
      if (!pending || pending.kind !== 'approval') throw new Error('No current live approval.');
      controller.decide(pending.id, pending.revision, pending.binding, input === '/approve' ? 'approve' : 'deny');
      setInspector(null); refresh(value => value + 1); return;
    }
    if (input.startsWith('/inspect ')) {
      const [id = '', offset = '0'] = input.slice(9).trim().split(/\s+/);
      setInspector(JSON.stringify(controller.store.readResult(controller.id, id, Number(offset)), null, 2)); setOffset(0); return;
    }
    if (input.startsWith('/events')) {
      setInspector(JSON.stringify(controller.store.events(controller.id, Number(input.slice(7).trim() || 0)), null, 2)); setOffset(0); return;
    }
    if (input.startsWith('/grant ')) {
      const { z } = await import('zod');
      const grant = z.object({ paths: z.array(z.string()), origins: z.array(z.string()), expires: z.number() }).strict().parse(JSON.parse(input.slice(7)));
      controller.broker.grant(grant.paths, grant.origins, grant.expires); setNotice('Explicit trusted-read grant enabled. /status shows its scope.'); return;
    }
    if (input.startsWith('/revoke ')) { controller.broker.revoke(input.slice(8).trim()); setNotice('Trusted-read grant revoked.'); return; }
    if (input.startsWith('/reconcile ')) {
      const { z } = await import('zod');
      const resolution = z.object({
        note: z.string().min(1), actions: z.array(z.object({ id: z.string(), note: z.string().min(1) })).optional(),
        usage: z.array(z.object({ id: z.string(), input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })).optional(),
      }).strict().parse(JSON.parse(input.slice(11)));
      await controller.reconcile(resolution); setNotice('Reconciled; /continue retains the original scope and budget.'); return;
    }
    if (input === '/continue') { launch(controller.continueObjective(), '/continue'); return; }
    if (input.startsWith('/')) throw new Error('Unknown command. Use /help.');
    if (pending?.kind === 'question') { controller.decide(pending.id, pending.revision, pending.binding, input); return; }
    setLive(''); launch(controller.submit(input, { domain, criteria }), 'submit'); refresh(value => value + 1);
  };
  useEffect(() => controller.subscribe(event => {
    if (event.type === 'runtime' && event.data.state === 'context_cleared') {
      editorRef.current = emptyEditor(); setEditor(editorRef.current);
      setInspector(null); setRequestId(null); setOffset(0); setLive('');
      setTraceBefore(undefined); setPausedLive(false); setExpanded(false);
      setTraceDisclosure(null); setOpenCalls(new Set()); setTraceFocused(false); setTraceSelection('root');
      setNotice('Context cleared. Saved evidence, files and session settings are unchanged.');
    }
    if (event.type === 'text' && typeof event.data.delta === 'string') setLive(value => value + event.data.delta);
    if (event.type === 'text' && typeof event.data.message === 'string') setLive('');
    if (event.type === 'error') setNotice(errorNotice(event.data));
    if (event.type === 'request' && record(event.data.decision) && event.data.decision.kind === 'question') {
      setNotice('Waiting for input. /request opens the full question.');
    }
    if (event.type === 'state' && record(event.data.objective) && typeof event.data.objective.reason === 'string') {
      const objective = event.data.objective;
      const error = controller.store.errors(controller.id).errors.find(error => error.objectiveId === objective.id);
      setNotice(errorNotice({ message: objective.reason, errorId: error?.id }));
    }
    if (event.type === 'action') {
      const action = record(event.data.action) ? event.data.action : undefined;
      if (action && typeof action.tool === 'string' && typeof action.status === 'string') setNotice(typeof event.data.errorId === 'string'
        ? errorNotice({ message: `${action.tool}: ${action.status}${typeof action.error === 'string' ? ` - ${action.error}` : ''}`, errorId: event.data.errorId })
        : `${action.tool}: ${action.status}${action.resultId ? ` | result ${action.resultId}` : ''}`);
    }
    if (event.type === 'action' || event.type === 'request' || event.type === 'state' ||
        (event.type === 'runtime' && event.data.state === 'model_request')) setTraceRevision(value => value + 1);
    refresh(value => value + 1);
  }), [controller]);
  useEffect(() => {
    const decoder = new InputDecoder(); setRawMode(true);
    const act = (action: InputAction) => {
      if (action.type === 'mouse') {
        const view = traceInteraction.current;
        if (!view.enabled || action.released) return;
        if (action.button & 28) return;
        if (action.button & 64) { act({ type: action.button & 1 ? 'pageDown' : 'pageUp' }); return; }
        if ((action.button & 3) !== 0 || (action.button & 32)) return;
        const target = action.x <= view.width ? view.hits.get(action.y) : undefined;
        if (target) traceAction.current(target);
        else { view.focused = false; setTraceFocused(false); }
        return;
      }
      if (action.type === 'traceFocus') {
        const view = traceInteraction.current;
        if (view.enabled) {
          const focus = !view.focused;
          view.focused = focus; setTraceFocused(focus);
          if (focus && view.selected) {
            const row = view.targets.find(item => item.target.key === view.selected?.key)!.row;
            setOffset(Math.max(0, view.count - row - view.viewport));
          }
        }
        return;
      }
      if (action.type === 'pageUp' || action.type === 'pageDown') {
        const view = traceScroll.current;
        if (view.request) {
          setOffset(Math.min(view.maximum, Math.max(0, view.offset + (action.type === 'pageDown' ? view.pageSize : -view.pageSize))));
        } else if (view.enabled) {
          const next = Math.min(view.maximum, Math.max(0, view.offset + (action.type === 'pageUp' ? 8 : -8)));
          if (!view.inspecting && action.type === 'pageUp' && next > 0 && view.before === undefined && view.last !== undefined) {
            setTraceBefore(view.last + 1); setPausedLive(true);
          }
          if (!view.inspecting && action.type === 'pageDown' && next === 0 && view.paused) {
            setTraceBefore(undefined); setPausedLive(false);
          }
          setOffset(next);
        } else setOffset(value => Math.max(0, value + (action.type === 'pageUp' ? 8 : -8)));
        return;
      }
      const trace = traceInteraction.current;
      if (trace.enabled && trace.focused && trace.selected) {
        if (action.type === 'up' || action.type === 'down') {
          const current = trace.targets.findIndex(item => item.target.key === trace.selected?.key);
          const next = trace.targets[Math.max(0, Math.min(trace.targets.length - 1, current + (action.type === 'up' ? -1 : 1)))]!;
          trace.selected = next.target; setTraceSelection(next.target.key);
          if (next.row < trace.start) setOffset(Math.max(0, trace.count - next.row - trace.viewport));
          else if (next.row >= trace.start + trace.viewport) setOffset(Math.max(0, trace.count - next.row - 1));
          return;
        }
        if (action.type === 'submit' || (action.type === 'insert' && action.text === ' ')) {
          traceAction.current(trace.selected); return;
        }
        if (action.type === 'right' || action.type === 'left') {
          traceAction.current(trace.selected, action.type === 'right' ? 'open' : 'close'); return;
        }
        if (action.type === 'insert') { trace.focused = false; setTraceFocused(false); }
      }
      if (action.type === 'cancel') {
        if (controller.inspect().busy || controller.inspect().pending.length) launch(controller.cancel(), '/cancel');
        else { editorRef.current = emptyEditor(editorRef.current.history); setEditor(editorRef.current); }
        return;
      }
      if (action.type === 'exit') { void command.current('/exit').catch(error => reportError(error, '/exit')); return; }
      if (action.type === 'redraw') { refresh(value => value + 1); return; }
      if (action.type === 'submit') {
        const text = editorRef.current.text;
        if (!text.trim()) return;
        editorRef.current = emptyEditor([...editorRef.current.history, text]); setEditor(editorRef.current); setOffset(0);
        void command.current(text).catch(error => reportError(error, text.startsWith('/') ? text.split(/\s+/)[0]! : 'submit')); return;
      }
      editorRef.current = edit(editorRef.current, action); setEditor(editorRef.current);
    };
    const data = (chunk: Buffer | string) => { for (const action of decoder.feed(String(chunk))) act(action); };
    const resize = () => setDimensions({ width: stdout.columns ?? 100, height: stdout.rows ?? 30 });
    stdin.on('data', data); stdout.on('resize', resize);
    return () => { stdin.off('data', data); stdout.off('resize', resize); setRawMode(false); };
  }, [controller, stdin, stdout, setRawMode]);
  useEffect(() => {
    if (!tracing || stopping || !stdout.isTTY) return;
    onMouseMode?.(true);
    stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => { onMouseMode?.(false); stdout.write('\x1b[?1000l\x1b[?1006l'); };
  }, [tracing, stopping, stdout, onMouseMode]);
  const state = stopping ? undefined : controller.inspect(); const objective = state?.objective; const pending = state?.pending[0];
  const inspectingRequest = Boolean(pending && requestId === pending.id);
  const objectiveId = objective?.id;
  const currentPage = traceObjective.current === objectiveId ? traceBefore : undefined;
  const activity = useMemo(() => tracing && !stopping ? controller.trace(currentPage) : { items: [], next: null },
    [controller, tracing, stopping, currentPage, objectiveId, traceRevision]);
  const activityContext = {
    model: controller.config.model, pending: state?.pending ?? [], status: objective?.status,
  };
  const calls = activity.items.map(item => projectActivity(item, activityContext));
  const running = tracing && state ? [
    ...state.actions.filter(action => action.status === 'started')
      .map(value => projectActivity({ order: 0, kind: 'tool', value }, activityContext)),
    ...state.activeModels.map(value => projectActivity({ order: 0, kind: 'model', value }, activityContext)),
  ].filter(call => call.status === 'running') : [];
  useEffect(() => {
    if (traceObjective.current !== objectiveId) {
      traceObjective.current = objectiveId; setTraceBefore(undefined); setPausedLive(false); setExpanded(false); setOffset(0);
      setTraceDisclosure(null); setOpenCalls(new Set()); setTraceFocused(false); setTraceSelection('root'); traceAnchor.current = null;
    }
  }, [objectiveId]);
  useEffect(() => {
    if (!tracing || !running.length) return;
    const timer = setInterval(() => refresh(value => value + 1), 500);
    return () => clearInterval(timer);
  }, [tracing, running.length]);
  const frameWidth = Math.max(20, dimensions.width - 1);
  const width = Math.max(16, dimensions.width - 4);
  const draft = Array.from(editor.text); draft.splice(editor.cursor, 0, '|');
  const cursorPrefix = wrapText(`> ${Array.from(editor.text).slice(0, editor.cursor).join('')}|`, frameWidth, false);
  const cursorRow = cursorPrefix.length - 1;
  const composer = wrapText(`> ${draft.join('')}`, frameWidth, false).slice(Math.max(0, cursorRow - 1), cursorRow + 3);
  const compact = Boolean(pending && dimensions.height < 22);
  const bodyRows = pending ? wrapText(requestBody(pending), frameWidth - 4) : [];
  const hintRows = pending ? wrapText(requestHint(pending), frameWidth - 4) : [];
  const footerRows = 1 + (compact ? 0 : 2) + (inspectingRequest || (tracing && !compact) ? 1 : 0) +
    composer.length + terminalText(notice).split('\n').length;
  const available = Math.max(0, dimensions.height - (compact ? 2 : 3) - (state?.approveAll ? 1 : 0) - footerRows - 1);
  const panelFixed = 3 + hintRows.length;
  const conversationMinimum = Math.min(2, Math.max(0, available - panelFixed - 1));
  const bodyCapacity = Math.max(0, available - conversationMinimum - panelFixed);
  const overflow = bodyRows.length > bodyCapacity;
  const preview = bodyRows.slice(0, Math.max(0, bodyCapacity - (overflow ? 1 : 0)));
  if (overflow) preview.push('More: /request');
  const panelHeight = pending && !inspectingRequest ? panelFixed + preview.length : 0;
  const viewport = pending ? Math.max(0, available - panelHeight) :
    Math.max(2, dimensions.height - 11 - (state?.approveAll ? 1 : 0) - (tracing ? 1 : 0) - composer.length);
  const defaultGroupOpen = !objective || Boolean(state?.busy) ||
    calls.some(call => ['failed', 'denied', 'unknown', 'cancelled'].includes(call.status));
  const groupOpen = traceDisclosure && traceDisclosure.objectiveId === objectiveId ? traceDisclosure.open : defaultGroupOpen;
  traceAction.current = (target, mode = 'toggle') => {
    const view = traceInteraction.current;
    if (!view.enabled) return;
    const isOpen = view.open.get(target.key) ?? false;
    view.focused = true; view.selected = target;
    if ((mode === 'open' && isOpen) || (mode === 'close' && !isOpen)) {
      setTraceFocused(true); setTraceSelection(target.key); return;
    }
    const row = view.targets.find(item => item.target.key === target.key)?.row;
    if (row !== undefined) traceAnchor.current = { key: target.key, screenRow: Math.max(0, row - view.start) };
    const next = mode === 'open' || (mode === 'toggle' && !isOpen);
    if (target.kind === 'call' && next && currentPage === undefined && state?.busy && activity.items.length) {
      setTraceBefore(activity.items.at(-1)!.order + 1); setPausedLive(true);
    }
    view.open.set(target.key, next);
    if (target.kind === 'history') for (const item of view.targets) {
      if (item.target.kind === 'history') view.open.set(item.target.key, next);
    }
    setTraceFocused(true); setTraceSelection(target.key);
    if (target.kind === 'root') setTraceDisclosure({ objectiveId, open: next });
    else if (target.kind === 'history') setExpanded(next);
    else setOpenCalls(previous => {
      const calls = new Set(previous);
      if (next) calls.add(target.callId); else calls.delete(target.callId);
      return calls;
    });
  };
  const traceLines: DisplayLine[] = [
    { text: 'TRACE ON' },
    ...(objective?.steps.length ? ['PLAN', ...objective.steps.map(step =>
      `${step.status === 'done' ? '[x]' : step.status === 'in_progress' ? '[>]' : step.status === 'blocked' ? '[!]' : '[ ]'} ${step.title}${step.blocker ? ` | ${step.blocker}` : ''}`)]
      : ['PLAN: not recorded yet']).map(text => ({ text })),
    ...(currentPage === undefined ? [] : [pausedLive ? 'Live following paused | PageDown or /trace latest to follow' :
      'Earlier calls | /trace latest returns to live activity']).map(text => ({ text })),
    ...(activity.next === null ? [] : [{ text: 'More recorded calls: /trace older' }]),
    ...traceBlocks(calls, controller.config, {
      open: groupOpen, historyExpanded: expanded, openCalls, capacity: Math.max(2, viewport - 5),
      paged: activity.next !== null || currentPage !== undefined,
    }),
  ];
  const transcript: DisplayLine[] = stopping ? [] : controller.store.conversationObjectives(controller.id).flatMap(objective => [
    { text: `YOU  ${objective.original}` }, ...(tracing && objective.id === objectiveId ? traceLines : []),
    ...(objective.output ? [{ text: `ASSISTANT  ${objective.output}` }] : []),
  ]);
  const blocks: DisplayLine[] = inspectingRequest && pending ? [
    pending.kind === 'approval' ? 'APPROVAL REQUIRED' : 'INPUT NEEDED',
    '', requestBody(pending), '', requestHint(pending),
  ].map(text => ({ text })) : inspector !== null ? [{ text: inspector }] : [
    ...transcript, ...(tracing && !objective ? traceLines : []), ...(live ? [{ text: `ASSISTANT  ${live}` }] : []),
  ];
  const rows = blocks.flatMap(block => wrapText(block.text, width, inspectingRequest).map(text => ({ ...block, text })));
  const rowKey = `${objectiveId ?? ''}:${inspectingRequest ? pending?.id : inspector === null ? 'conversation' : 'inspector'}:${currentPage ?? 'live'}`;
  useLayoutEffect(() => {
    const previous = previousRows.current;
    const anchor = traceAnchor.current;
    traceAnchor.current = null;
    if (anchor) {
      const row = rows.findIndex(line => line.target?.key === anchor.key);
      if (row >= 0) setOffset(Math.min(Math.max(0, rows.length - viewport), Math.max(0, rows.length - viewport - row + anchor.screenRow)));
    } else if (tracing && !inspectingRequest && previous.key === rowKey) setOffset(value => value > 0
      ? Math.min(Math.max(0, rows.length - viewport), Math.max(0, value + rows.length - previous.count)) : 0);
    previousRows.current = { key: rowKey, count: rows.length };
  }, [tracing, inspectingRequest, rowKey, rows.length, viewport, traceDisclosure, openCalls, expanded]);
  const boundedOffset = Math.min(offset, Math.max(0, rows.length - viewport));
  const start = inspectingRequest ? boundedOffset : Math.max(0, rows.length - boundedOffset - viewport);
  const visible = rows.slice(start, inspectingRequest ? start + viewport : rows.length - boundedOffset);
  const targets: { target: TraceTarget; row: number }[] = [];
  const seen = new Set<string>();
  for (const [row, line] of rows.entries()) {
    if (line.target && !seen.has(line.target.key)) { targets.push({ target: line.target, row }); seen.add(line.target.key); }
  }
  const selected = targets.find(item => item.target.key === traceSelection)?.target ?? targets[0]?.target;
  const hits = new Map<number, TraceTarget>();
  const headerRows = (compact ? 2 : 3) + (state?.approveAll ? 1 : 0);
  useInsertionEffect(() => {
    onTraceFrame?.(tracing && !stopping);
    return () => onTraceFrame?.(false);
  });
  for (const [row, line] of visible.entries()) if (line.target) hits.set(headerRows + row + 1, line.target);
  traceInteraction.current = {
    enabled: tracing && !stopping && inspector === null && !inspectingRequest, focused: traceFocused,
    width: frameWidth, start, viewport, count: rows.length, targets, selected, hits,
    open: new Map(targets.map(({ target }) => [target.key,
      target.kind === 'root' ? groupOpen : target.kind === 'history' ? expanded : openCalls.has(target.callId)])),
  };
  traceScroll.current = {
    enabled: tracing, inspecting: inspector !== null || inspectingRequest, request: inspectingRequest,
    before: currentPage, last: activity.items.at(-1)?.order,
    offset: boundedOffset, maximum: Math.max(0, rows.length - viewport), pageSize: Math.max(1, Math.min(8, viewport)), paused: pausedLive,
  };
  if (!state) return <Text>Stopping owned work and saving state...</Text>;
  return <Box flexDirection="column" width={frameWidth} height={tracing ? Math.max(1, dimensions.height - 1) : undefined}>
    <Text bold color="cyan" wrap="truncate-end">HARNESS  {state.model}  {state.sessionId.slice(0, 8)}{tracing ? ' | TRACE ON' : ''}</Text>
    {state.approveAll && <Text bold color="yellow">APPROVE ALL: ENABLED</Text>}
    {!compact && <Text wrap="truncate-end">
      {terminalText(state.workspace)}{state.readOnly ? ' | read-only restriction' : state.approveAll ? '' : ' | approval-first'}
    </Text>}
    <Text wrap="truncate-end">{objective?.status ?? 'idle'} | {objective?.steps.filter(step => step.status === 'done').length ?? 0}/{objective?.steps.length ?? 0} steps | {state.results.length} results | {state.grants.length} read grants</Text>
    <Box flexDirection="column" minHeight={viewport}>
      {visible.length ? visible.map((line, index) => <Text key={index} wrap="truncate"
        inverse={traceFocused && line.target !== undefined && line.target.key === selected?.key}>{line.text}</Text>) :
        viewport > 0 && <Text dimColor wrap="truncate-end">Delegate coding, research or browser work. Capabilities without configured providers stay disabled.</Text>}
    </Box>
    {pending && !inspectingRequest && <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Text bold>{pending.kind === 'approval' ? 'APPROVAL REQUIRED' : 'INPUT NEEDED'}</Text>
      {preview.map((line, index) => <Text key={`body-${index}`} wrap="truncate">{line}</Text>)}
      {hintRows.map((line, index) => <Text key={`hint-${index}`} wrap="truncate">{line}</Text>)}
    </Box>}
    <Text wrap="truncate-end" color={objective?.status === 'failed' || objective?.status === 'recovery_required' ? 'red' : undefined}>
      {terminalText(notice)}
    </Text>
    {!compact && <Text dimColor wrap="truncate-end">
      Usage {objective?.usage.unknown ? `unknown (known ${objective.usage.input + objective.usage.output})` : objective ? objective.usage.input + objective.usage.output : 0}
      {state.budget.maxTokens !== null ? `/${state.budget.maxTokens}` : ' | no task token budget'}
      {' | '}cost {objective?.usage.cost ?? 'unknown'}{state.budget.maxCost !== null ? `/${state.budget.maxCost}` : ''}
      {' | '}in flight {state.pendingModelRequests}
    </Text>}
    {!compact && <Text dimColor wrap="truncate-end">
      Context {state.modelLimits.prompt.used ?? '?'}/{state.modelLimits.prompt.limit ?? '?'} ({state.modelLimits.prompt.source})
      {' | '}Output {state.modelLimits.output.limit ?? 'default'} ({state.modelLimits.output.source}) | /status
    </Text>}
    {inspectingRequest ? <Text dimColor wrap="truncate-end">
      Request lines {start + 1}-{Math.min(rows.length, start + viewport)}/{rows.length} | PageUp/PageDown | /back
    </Text> : tracing && !compact && <Text dimColor wrap="truncate-end">
      {pending?.kind === 'question' ? 'Waiting for input | /request: full question' : running.length ? `${running.length} running | ${activityLine(running.at(-1)!)}` :
        'Click > / v | Ctrl+T trace focus | /trace older|latest | /trace off'}
    </Text>}
    <Text color="cyan">{composer.join('\n')}</Text>
    <Text dimColor wrap="truncate-end">{traceFocused
      ? 'TRACE FOCUS | Up/Down select | Space/Enter toggle | Ctrl+T input'
      : tracing ? 'Ctrl+T trace focus | Enter send | Ctrl+C cancel | PageUp/PageDown inspect'
      : 'Enter send | Ctrl+J newline | Ctrl+C cancel | PageUp/PageDown inspect'}</Text>
  </Box>;
}
