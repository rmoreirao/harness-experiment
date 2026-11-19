#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { render } from 'ink';
import { z } from 'zod';
import { defaultDataDir, loadEnvironment } from './config.js';
import { errorText, record } from './contracts.js';
import { Redactor, serializeHostMessage } from './privacy.js';
import { Ownership } from './ownership.js';
import { loadConfig, SDK_VERSION, RUNTIME_VERSION } from './config.js';
import { Store } from './store.js';
import { SessionController } from './controller.js';
import { HELP, TerminalApp } from './ui.js';

async function headless(app: SessionController): Promise<void> {
  const write = (value: unknown, authorizationUrl?: string) => process.stdout.write(serializeHostMessage(app.store.redactor, value, authorizationUrl) + '\n');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const unsubscribe = app.subscribe(event => write({ type: 'event', event }));
  const handle = async (line: string) => {
    let id: string | undefined;
    try {
      if (Buffer.byteLength(line) > 131072) throw new Error('Headless command exceeds its byte limit.');
      const command = z.object({ id: z.string().max(100), operation: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).strict().parse(JSON.parse(line));
      id = command.id; let result: unknown; let authorizationUrl: string | undefined;
      switch (command.operation) {
        case 'inspect': result = app.inspect(); break;
        case 'skills': {
          const args = z.object({ action: z.enum(['list', 'reload']).default('list') }).strict().parse(command.args);
          result = args.action === 'reload' ? await app.reloadSkills() : await app.listSkills(); break;
        }
        case 'trust': {
          const args = z.object({ trusted: z.boolean() }).strict().parse(command.args);
          app.trust(args.trusted); result = { trusted: app.trusted, unsandboxed: true }; break;
        }
        case 'permissions': {
          const args = z.object({ mode: z.enum(['manual', 'assisted', 'allow-all']) }).strict().parse(command.args);
          await app.setPermissionMode(args.mode); result = { mode: app.inspect().permissionMode }; break;
        }
        case 'mode': {
          const args = z.object({ mode: z.enum(['interactive', 'plan', 'autopilot']) }).strict().parse(command.args);
          await app.setTaskMode(args.mode); result = { mode: app.taskMode }; break;
        }
        case 'auth': {
          const args = z.object({ action: z.enum(['status', 'login', 'advance', 'cancel']).default('status'), input: z.string().max(4000).optional() }).strict().parse(command.args);
          result = await app.auth(args.action, args.input); break;
        }
        case 'mcp': {
          const args = z.object({ action: z.enum(['list', 'status', 'login']).default('list'), serverName: z.string().min(1).max(200).optional() }).strict().parse(command.args);
          result = await app.mcp(args.action, args.serverName);
          if (args.action === 'login' && record(result) && typeof result.authorizationUrl === 'string') authorizationUrl = result.authorizationUrl;
          break;
        }
        case 'submit': {
          const args = z.object({ objective: z.string().trim().min(1).max(100000), domain: z.enum(['general', 'coding', 'research', 'browser']).optional(), criteria: z.array(z.string().min(1).max(2000)).max(30).optional() }).strict().parse(command.args);
          const state = app.inspect();
          if (!state.trusted) throw new Error('Explicit session trust is required before submitting native work.');
          if (state.busy || state.objective && ['preparing', 'running', 'awaiting_approval', 'awaiting_input', 'recovery_required'].includes(state.objective.status)) {
            throw new Error('One objective is already admitted; no second objective was accepted.');
          }
          z.string().trim().min(1).max(100000).parse(args.objective);
          const work = app.submit(args.objective, args);
          result = { admitted: true, objectiveId: app.inspect().objective?.id };
          void work.then(objective => write({ type: 'objective', id, objective }),
            error => write({ type: 'error', id, message: errorText(error) })); break;
        }
        case 'decide': {
          const args = z.object({ id: z.string(), revision: z.number().int(), binding: z.string(), answer: z.string(),
            source: z.enum(['human_response', 'external']).default('external') }).strict().parse(command.args);
          app.decide(args.id, args.revision, args.binding, args.answer, args.source); result = { decided: true }; break;
        }
        case 'cancel': await app.cancel(); result = app.inspect(); break;
        case 'continue': {
          const state = app.inspect();
          if (state.busy || state.objective?.status !== 'partial') throw new Error('No stopped partial objective is available to continue.');
          const work = app.continueObjective();
          result = { admitted: true };
          void work.then(objective => write({ type: 'objective', id, objective }), error => write({ type: 'error', id, message: errorText(error) })); break;
        }
        case 'reconcile': {
          const args = z.object({
            note: z.string().min(1), actions: z.array(z.object({ id: z.string(), note: z.string() })).optional(),
            workers: z.array(z.object({ id: z.string(), note: z.string() })).optional(),
            usage: z.array(z.object({ id: z.string(), input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })).optional(),
          }).strict().parse(command.args);
          await app.reconcile(args); result = app.inspect(); break;
        }
        case 'result': {
          const args = z.object({ id: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }).strict().parse(command.args);
          result = app.store.readResult(app.id, args.id, args.offset, args.limit); break;
        }
        case 'events': {
          const args = z.object({ after: z.number().int().optional(), limit: z.number().int().optional() }).strict().parse(command.args);
          result = app.store.events(app.id, args.after, args.limit); break;
        }
        case 'close': input.close(); result = { closing: true }; break;
        default: throw new Error('Unsupported headless operation.');
      }
      write({ type: 'response', id, result }, authorizationUrl);
    } catch (error) { write({ type: 'error', id, message: errorText(error) }); }
  };
  try {
    const stop = () => input.close();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await new Promise<void>(resolve => {
      input.on('line', line => { void handle(line); });
      input.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); });
    });
  } finally { unsubscribe(); await app.close(); }
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, version: { type: 'boolean' }, config: { type: 'string' },
    workspace: { type: 'string' }, 'data-dir': { type: 'string' }, headless: { type: 'boolean' },
    domain: { type: 'string' }, criterion: { type: 'string', multiple: true },
    'trust-workspace': { type: 'boolean', default: false },
  } });
  if (values.version) { console.log(`harness-experiment 0.2.0 | SDK ${SDK_VERSION} | runtime ${RUNTIME_VERSION}`); return; }
  if (values.help) {
    console.log('harness [--config FILE] [--workspace FOLDER] [--data-dir FOLDER] [--trust-workspace] [--domain general|coding|research|browser] [--criterion TEXT]\nharness sessions | resume SESSION_ID\n--headless: bounded JSON-lines API; trust must be explicit.\n--trust-workspace: explicitly trust this unsandboxed native session before workspace code loads.\n\n' + HELP); return;
  }
  loadEnvironment();
  const dataDir = path.resolve(values['data-dir'] ?? defaultDataDir());
  if (positionals[0] === 'sessions') {
    const store = new Store(dataDir);
    try { for (const session of store.sessions()) console.log(`${session.id}  ${Ownership.held(dataDir, `native-session:${session.id}`) ? 'active' : 'saved'}  ${session.config.workspace}`); }
    finally { store.close(); }
    return;
  }
  const resumeId = positionals[0] === 'resume' ? positionals[1] : undefined;
  if (positionals.length && (!resumeId || positionals.length !== 2)) throw new Error('Use resume SESSION_ID, sessions, or --help.');
  let config;
  if (resumeId) {
    const store = new Store(dataDir);
    try { config = store.session(resumeId).config; } finally { store.close(); }
  } else config = loadConfig(values.config, {
    ...(values.workspace ? { workspace: values.workspace } : {}), ...(values['data-dir'] ? { dataDir } : {}),
  });
  const domain = z.enum(['general', 'coding', 'research', 'browser']).parse(values.domain ?? 'general');
  if (!values.headless && (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Interactive mode requires Windows Terminal/PowerShell with a TTY. Use --headless or the exported API.');
  }
  const app = await SessionController.open({ config, sessionId: resumeId, trusted: values['trust-workspace'] });
  if (values.headless) {
    await headless(app);
    return;
  }
  try {
    const { WindowsInput } = await import('./windows-input.js');
    const input = new WindowsInput();
    let inputError: Error | undefined;
    let terminate = () => {};
    let alternate = false;
    input.on('error', (error: Error) => { inputError = error; terminate(); });
    try {
      process.stdout.write('\x1b[?2004h');
      const mouseMode = (enabled: boolean) => input.setMouseTracking(enabled);
      let traceFrame = false;
      const reportFrame = (enabled: boolean) => { traceFrame = enabled; };
      const terminal = render(<TerminalApp controller={app} domain={domain} criteria={values.criterion}
        onMouseMode={mouseMode} onTraceFrame={reportFrame} />,
        {
          stdin: input, exitOnCtrlC: false, maxFps: 30, incrementalRendering: false,
          onRender() {
            // Between buffer transitions, Ink must exclusively own cursor movement.
            if (traceFrame) {
              if (!alternate) { process.stdout.write('\x1b[?1049h'); alternate = true; }
            } else if (alternate) {
              process.stdout.write(`\x1b[?1049l${'\n'.repeat(Math.max(1, process.stdout.rows))}\x1b[H`);
              alternate = false;
            }
          },
        });
      terminate = () => terminal.unmount();
      process.once('SIGTERM', terminate);
      try { await terminal.waitUntilExit(); }
      finally { process.off('SIGTERM', terminate); }
    } finally {
      if (alternate) process.stdout.write('\x1b[?1049l');
      process.stdout.write('\x1b[?2004l');
      if (!input.closed) await new Promise<void>(resolve => { input.once('close', resolve); input.destroy(); });
    }
    if (inputError) throw inputError;
  } finally { await app.close(); }
}
main().catch(error => {
  console.error(new Redactor([process.env.OPENAI_API_KEY ?? '', process.env.BRAVE_SEARCH_API_KEY ?? '']).text(errorText(error)));
  process.exitCode = 1;
});
