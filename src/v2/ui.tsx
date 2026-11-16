import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useStdin, useStdout } from 'ink';
import { edit, emptyEditor, InputDecoder, type InputAction } from '../editor.js';
import { terminalText } from '../privacy.js';
import { errorText, record } from '../contracts.js';
import { errorDiagnostic, errorInspector, errorNotice } from '../errors.js';
import type { Objective } from './contracts.js';
import type { V2Controller } from './controller.js';

export const V2_HELP = `/status /plan /request /back /cancel /continue /exit
/approve or /reject decides the displayed current action only.
/approve_all approves all pending and future tool calls in this session, including after resume.
/approve_all off restores per-call approvals. Questions and safety restrictions still apply.
/inspect RESULT_ID [BYTE_OFFSET] reads a stored result page; binary pages are base64.
/events [SEQUENCE] inspects a bounded audit page.
/errors [BEFORE_ID] lists session errors; /error ERROR_ID inspects one error.
/grant {"paths":["ABSOLUTE_PATH"],"origins":[],"expires":TIMESTAMP} explicitly enables scoped trusted reads.
/revoke GRANT_ID removes a trusted-read grant.
/skills list (or /skills) lists loaded skills; /skills reload refreshes them while idle.
/reconcile {"note":"checked effects","actions":[],"usage":[]} resolves exact unknown records.
Enter sends; Ctrl+J or Alt+Enter inserts a newline; paste never submits.
Arrows edit/history; PageUp/PageDown scroll; Ctrl+C cancels; Ctrl+D saves/exits.`;

export function V2TerminalApp({ controller, domain = 'general', criteria = [] }: {
  controller: V2Controller; domain?: Objective['domain']; criteria?: string[];
}) {
  const { exit } = useApp(); const { stdin, setRawMode } = useStdin(); const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({ width: stdout.columns ?? 100, height: stdout.rows ?? 30 });
  const [, refresh] = useState(0);
  const [editor, setEditor] = useState(() => emptyEditor(controller.store.list('objective', controller.id).map(objective => objective.original)));
  const editorRef = useRef(editor); editorRef.current = editor;
  const [inspector, setInspector] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
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
    if (input === '/exit') { setStopping(true); await controller.close(); exit(); return; }
    if (input === '/cancel') { launch(controller.cancel(), '/cancel'); return; }
    if (input === '/help') { setInspector(V2_HELP); setOffset(0); return; }
    if (input === '/status') { setInspector(JSON.stringify(state, null, 2)); setOffset(0); return; }
    const errors = errorInspector(input, controller.store, controller.id);
    if (errors !== null) { setInspector(errors); setOffset(0); return; }
    if (input === '/plan') { setInspector(JSON.stringify(state.objective?.steps ?? [], null, 2)); setOffset(0); return; }
    if (input === '/request') { setInspector(JSON.stringify(pending ?? { notice: 'No pending request.' }, null, 2)); setOffset(0); return; }
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
    if (event.type === 'text' && typeof event.data.delta === 'string') setLive(value => value + event.data.delta);
    if (event.type === 'text' && typeof event.data.message === 'string') setLive('');
    if (event.type === 'error') setNotice(errorNotice(event.data));
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
    refresh(value => value + 1);
  }), [controller]);
  useEffect(() => {
    const decoder = new InputDecoder(); setRawMode(true);
    const act = (action: InputAction) => {
      if (action.type === 'pageUp' || action.type === 'pageDown') { setOffset(value => Math.max(0, value + (action.type === 'pageUp' ? 8 : -8))); return; }
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
  if (stopping) return <Text>Stopping owned work and saving V2 state...</Text>;
  const state = controller.inspect(); const objective = state.objective; const pending = state.pending[0];
  const transcript = controller.store.list('objective', controller.id).flatMap(objective => [
    `YOU  ${objective.original}`, ...(objective.output ? [`ASSISTANT  ${objective.output}`] : []),
  ]);
  const width = Math.max(16, dimensions.width - 4);
  const rows = (inspector !== null ? [inspector] : [...transcript, ...(live ? [`ASSISTANT  ${live}`] : [])])
    .flatMap(text => terminalText(text).split('\n').flatMap(line => {
      const characters = Array.from(line); const lines: string[] = [];
      for (let index = 0; index < Math.max(1, characters.length); index += width) lines.push(characters.slice(index, index + width).join(''));
      return lines;
    }));
  const viewport = Math.max(2, dimensions.height - (pending ? 16 : 11) - (state.approveAll ? 1 : 0) - Math.min(4, editor.text.split('\n').length));
  const end = Math.max(0, rows.length - offset); const visible = rows.slice(Math.max(0, end - viewport), end);
  const draft = Array.from(editor.text); draft.splice(editor.cursor, 0, '|');
  const cursorRow = Array.from(editor.text).slice(0, editor.cursor).join('').split('\n').length - 1;
  return <Box flexDirection="column" width={Math.max(20, dimensions.width - 1)}>
    <Text bold color="cyan">HARNESS V2  {state.model}  {state.sessionId.slice(0, 8)}</Text>
    {state.approveAll && <Text bold color="yellow">APPROVE ALL: ENABLED</Text>}
    <Text wrap="truncate-end">
      {terminalText(state.workspace)}{state.readOnly ? ' | read-only restriction' : state.approveAll ? '' : ' | approval-first'}
    </Text>
    <Text>{objective?.status ?? 'idle'} | {objective?.steps.filter(step => step.status === 'done').length ?? 0}/{objective?.steps.length ?? 0} steps | {state.results.length} results | {state.grants.length} read grants</Text>
    <Box flexDirection="column" minHeight={viewport}>
      {visible.length ? visible.map((line, index) => <Text key={index} wrap="truncate">{line}</Text>) :
        <Text dimColor>Delegate coding, research or browser work. Capabilities without configured providers stay disabled.</Text>}
    </Box>
    {pending && <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Text bold>{pending.kind === 'approval' ? 'APPROVAL REQUIRED' : 'INPUT NEEDED'}</Text>
      <Text wrap="truncate-end">{terminalText(pending.description).slice(0, 250)}</Text>
      <Text>{pending.kind === 'approval' ? '/request: full scope | /approve or /reject: this action | /approve_all: session' : 'Type your answer. Answers do not authorize actions.'}</Text>
    </Box>}
    <Text wrap="truncate-end" color={objective?.status === 'failed' || objective?.status === 'recovery_required' ? 'red' : undefined}>
      {terminalText(notice)}
    </Text>
    <Text dimColor wrap="truncate-end">
      Usage {objective?.usage.unknown ? `unknown (known ${objective.usage.input + objective.usage.output})` : objective ? objective.usage.input + objective.usage.output : 0}
      {state.budget.maxTokens !== null ? `/${state.budget.maxTokens}` : ' | no task token budget'}
      {' | '}cost {objective?.usage.cost ?? 'unknown'}{state.budget.maxCost !== null ? `/${state.budget.maxCost}` : ''}
      {' | '}in flight {state.pendingModelRequests}
    </Text>
    <Text dimColor wrap="truncate-end">
      Context {state.modelLimits.prompt.used ?? '?'}/{state.modelLimits.prompt.limit ?? '?'} ({state.modelLimits.prompt.source})
      {' | '}Output {state.modelLimits.output.limit ?? 'default'} ({state.modelLimits.output.source}) | /status
    </Text>
    <Text color="cyan">&gt; {draft.join('').split('\n').slice(Math.max(0, cursorRow - 1), cursorRow + 3).join('\n')}</Text>
    <Text dimColor>Enter send | Ctrl+J newline | Ctrl+C cancel | PageUp/PageDown inspect</Text>
  </Box>;
}
