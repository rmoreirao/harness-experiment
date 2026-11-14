#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { SessionController } from './controller.js';
import { defaultDataDir, loadConfig, loadEnvironment } from './config.js';
import { Store } from './storage.js';
import { Ownership } from './ownership.js';
import { errorText } from './contracts.js';
import { Redactor } from './privacy.js';
import { HELP, TerminalApp } from './ui.js';

async function main(): Promise<void> {
  loadEnvironment();
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: {
      config: { type: 'string' }, workspace: { type: 'string' }, 'data-dir': { type: 'string' },
      fake: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
    },
  });
  if (values.version) { console.log('harness-experiment 0.1.0'); return; }
  if (values.help) {
    console.log('harness [--fake] [--workspace <folder>] [--config <file>] [--data-dir <folder>]\nharness sessions [--data-dir <folder>]\nharness resume <session-id> [--data-dir <folder>]\n\n' + HELP);
    return;
  }
  const dataDir = values['data-dir'] ?? defaultDataDir();
  if (positionals[0] === 'sessions') {
    const store = new Store(dataDir);
    try {
      for (const session of store.sessions()) console.log(`${session.id}  ${Ownership.held(dataDir, `session:${session.id}`) ? 'active' : 'saved'}  ${session.workspace}`);
    } finally { store.close(); }
    return;
  }
  let config;
  const resumeId = positionals[0] === 'resume' ? positionals[1] : undefined;
  if (positionals.length && !resumeId) throw new Error('Unknown command or missing session ID. Use --help.');
  if (resumeId) {
    const store = new Store(dataDir);
    try { config = store.session(resumeId).config; } finally { store.close(); }
  } else {
    config = loadConfig(values.config, {
      ...(values.workspace ? { workspace: values.workspace } : {}),
      ...(values['data-dir'] ? { dataDir } : {}),
      ...(values.fake ? { mode: 'fake' } : {}),
    });
  }
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive mode requires Windows Terminal with PowerShell and an attached TTY. Use the exported API for headless work.');
  }
  const controller = await SessionController.open({ config, sessionId: resumeId });
  process.stdout.write('\x1b[?2004h');
  const app = render(<TerminalApp controller={controller} />, { exitOnCtrlC: false, maxFps: 30 });
  const stop = () => { void controller.close().then(() => app.unmount(), error => app.unmount(error)); };
  process.once('SIGTERM', stop);
  try { await app.waitUntilExit(); }
  finally {
    process.off('SIGTERM', stop);
    process.stdout.write('\x1b[?2004l');
    await controller.close();
  }
}
main().catch(error => {
  console.error(new Redactor([process.env.OPENAI_API_KEY ?? '']).text(errorText(error)));
  process.exitCode = 1;
});
