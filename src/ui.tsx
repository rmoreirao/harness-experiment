import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useStdin, useStdout } from 'ink';
import { SessionController } from './controller.js';
import { errorText, type PendingRequest } from './contracts.js';
import { edit, emptyEditor, InputDecoder, type InputAction } from './editor.js';
import { terminalText } from './privacy.js';

export const HELP = [
  '/help  /status  /exit  /cancel  /continue',
  '/approve or /reject: decide the displayed action',
  '/request: inspect the complete pending action; /back: return to conversation',
  '/inspect <invocation ID>: inspect recorded tool output',
  '/reconcile {"note":"effects checked","input":0,"output":0}: resolve interrupted work',
  'Enter submits. Ctrl+J or Alt+Enter inserts a newline. Bracketed paste never submits.',
  'Arrows edit/history. PageUp/PageDown scroll. Ctrl+C cancels/clears. Ctrl+D saves and exits.',
].join('\n');

export function TerminalApp({ controller }: { controller: SessionController }) {
  const { exit } = useApp();
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({ width: stdout.columns ?? 100, height: stdout.rows ?? 30 });
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState(() => emptyEditor(controller.store.transcript(controller.id).filter(m => m.role === 'user').map(m => m.text)));
  const editorRef = useRef(editor); editorRef.current = editor;
  const [live, setLive] = useState('');
  const [notice, setNotice] = useState('Type /help for commands. Documents are never read without approval.');
  const [offset, setOffset] = useState(0);
  const [inspector, setInspector] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const commandRef = useRef<(text: string) => Promise<void>>(async () => {});
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); busyRef.current = true;
    try { await operation(); }
    catch (error) { setNotice(controller.store.redactor.text(errorText(error))); }
    finally { setBusy(false); busyRef.current = false; setRevision(r => r + 1); }
  };
  commandRef.current = async text => {
    const current = controller.inspect();
    const pending = current.pending[0];
    if (text === '/exit') { await controller.close(); exit(); return; }
    if (text === '/cancel') { controller.cancel(); setNotice('Cancellation requested.'); setRevision(r => r + 1); return; }
    if (text === '/help') { setInspector(HELP); setOffset(0); return; }
    if (text === '/status') { setInspector(JSON.stringify(current, null, 2)); setOffset(0); return; }
    if (text === '/back') { setInspector(null); setOffset(0); return; }
    if (text === '/request') {
      if (!pending) throw new Error('There is no pending action.');
      setInspector(JSON.stringify(pending, null, 2)); setOffset(0); return;
    }
    if (text.startsWith('/inspect ')) {
      const invocation = controller.store.invocation(text.slice(9).trim());
      if (!invocation || !current.run || invocation.runId !== current.run.id) throw new Error('No matching tool invocation in the current run.');
      setInspector(controller.store.toolResult(invocation.id, controller.id)); setOffset(0); return;
    }
    if (text.startsWith('/reconcile ')) {
      const value: unknown = JSON.parse(text.slice(11));
      const { z } = await import('zod');
      const result = z.object({ note: z.string().min(1), input: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative().optional() }).parse(value);
      await run(() => controller.reconcile(result.note, result.input !== undefined && result.output !== undefined ? { input: result.input, output: result.output } : undefined));
      return;
    }
    if (busyRef.current) { setNotice('Work is running. Use Ctrl+C to interrupt before sending another request.'); return; }
    if (text === '/continue') { await run(() => controller.continueRun()); return; }
    if (text === '/approve' || text === '/reject') {
      if (!pending || pending.kind !== 'approval') throw new Error('There is no pending tool approval.');
      setInspector(null); setOffset(0);
      await run(() => controller.respond(pending.id, pending.revision, text === '/approve' ? 'approve' : 'reject')); return;
    }
    if (text.startsWith('/')) throw new Error('Unknown command. Type /help.');
    if (pending?.kind === 'question') { await run(() => controller.respond(pending.id, pending.revision, { answer: text })); return; }
    await run(() => controller.submit(text));
  };
  useEffect(() => controller.subscribe(event => {
    if (event.type === 'text') setLive(t => t + String(event.data.delta ?? ''));
    if (event.type === 'state') { setLive(''); setRevision(r => r + 1); }
    if (event.type === 'request' || event.type === 'tool' || event.type === 'usage') setRevision(r => r + 1);
    if (event.type === 'tool') setNotice(`Tool ${String(event.data.tool)}: ${String(event.data.status)}${event.data.id ? ` [${String(event.data.id)}]` : ''}`);
    if (event.type === 'compaction') setNotice('Working context compacted. Full transcript and tool results are retained.');
    if (event.type === 'error') setNotice(String(event.data.message ?? 'Operation failed.'));
  }), [controller]);
  useEffect(() => {
    const decoder = new InputDecoder();
    setRawMode(true);
    const act = (action: InputAction) => {
      if (action.type === 'pageUp' || action.type === 'pageDown') { setOffset(o => Math.max(0, o + (action.type === 'pageUp' ? 8 : -8))); return; }
      if (action.type === 'cancel') {
        if (busyRef.current || controller.inspect().pending.length) controller.cancel();
        else {
          const next = emptyEditor(editorRef.current.history);
          editorRef.current = next;
          setEditor(next);
        }
        setRevision(r => r + 1); return;
      }
      if (action.type === 'exit') { void commandRef.current('/exit').catch(e => setNotice(errorText(e))); return; }
      if (action.type === 'redraw') { setRevision(r => r + 1); return; }
      if (action.type === 'submit') {
        const text = editorRef.current.text;
        if (!text.trim()) return;
        setEditor(s => emptyEditor([...s.history, text]));
        editorRef.current = emptyEditor([...editorRef.current.history, text]);
        setOffset(0);
        void commandRef.current(text).catch(e => setNotice(controller.store.redactor.text(errorText(e))));
        return;
      }
      const next = edit(editorRef.current, action);
      editorRef.current = next;
      setEditor(next);
    };
    const data = (chunk: Buffer | string) => { for (const action of decoder.feed(String(chunk))) act(action); };
    const resize = () => setDimensions({ width: stdout.columns ?? 100, height: stdout.rows ?? 30 });
    stdin.on('data', data); stdout.on('resize', resize);
    return () => { stdin.off('data', data); stdout.off('resize', resize); setRawMode(false); };
  }, [controller, stdin, stdout, setRawMode]);
  const state = controller.inspect();
  const width = Math.max(20, dimensions.width - 4);
  const rows = (inspector !== null ? [inspector] : [...controller.store.transcript(controller.id).map(m => `${m.role.toUpperCase()}  ${m.text}`), ...(live ? [`ASSISTANT  ${live}`] : [])])
    .flatMap(t => terminalText(t).split('\n').flatMap(line => {
      const chars = Array.from(line);
      const lines: string[] = [];
      for (let i = 0; i < Math.max(1, chars.length); i += width) lines.push(chars.slice(i, i + width).join(''));
      return lines;
    }));
  const pending = state.pending[0];
  const viewport = Math.max(2, dimensions.height - (pending ? 16 : 11) - Math.min(4, editor.text.split('\n').length));
  const end = Math.max(0, rows.length - offset);
  const visible = rows.slice(Math.max(0, end - viewport), end);
  const prompt = Array.from(editor.text); prompt.splice(editor.cursor, 0, '|');
  const promptRow = Array.from(editor.text).slice(0, editor.cursor).join('').split('\n').length - 1;
  const promptView = prompt.join('').split('\n').slice(Math.max(0, promptRow - 1), promptRow + 3).join('\n');
  void revision;
  return <Box flexDirection="column" width={Math.max(20, dimensions.width - 1)}>
    <Text bold color="cyan">HARNESS  {state.mode === 'fake' ? '[OFFLINE FAKE MODEL]' : state.model}  {state.sessionId.slice(0, 8)}</Text>
    <Text wrap="truncate-end">Allowed folder: {terminalText(state.workspace)}</Text>
    <Text>Policy: approve document reads and writes | {state.run?.status ?? 'idle'}{busy ? ' [working]' : ''}</Text>
    <Box flexDirection="column" minHeight={viewport}>
      {visible.length ? visible.map((line, i) => <Text key={i} wrap="truncate">{line}</Text>) : <Text dimColor>Describe the work. Start with "Read documents, summarize them, and save the summary."</Text>}
    </Box>
    {pending && <Request request={pending} />}
    <Text wrap="truncate-end" color={state.run?.status === 'failed' ? 'red' : undefined}>
      {terminalText(notice).split('\n').slice(-4).join('\n')}
    </Text>
    <Text dimColor>Tokens {state.run ? state.run.usage.input + state.run.usage.output : 0}/{controller.config.limits.maxTokens} | Context est. {state.run?.contextUnits ?? 0}/{controller.config.limits.contextTokens} | PgUp/PgDn scroll | /help</Text>
    <Text color="cyan">&gt; {promptView}</Text>
    <Text dimColor>Enter send | Ctrl+J newline | Ctrl+C interrupt | Ctrl+D save/exit</Text>
  </Box>;
}
function Request({ request }: { request: PendingRequest }) {
  return <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
    <Text bold>{request.kind === 'question' ? 'INPUT NEEDED' : 'APPROVAL REQUIRED'}: {request.tool}</Text>
    <Text wrap="truncate-end">{terminalText(JSON.stringify(request.args)).slice(0, 300)}</Text>
    <Text>{request.kind === 'question' ? 'Type your answer and press Enter.' : '/request shows the full action. /approve or /reject decides this call only.'}</Text>
  </Box>;
}
