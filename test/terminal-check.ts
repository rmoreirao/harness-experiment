import * as pty from 'node-pty';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Store } from '../src/storage.js';
import { fixture } from './helpers.js';

if (process.platform !== 'win32') throw new Error('This verification targets Windows ConPTY and PowerShell.');
const f = fixture();
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
class TerminalDriver {
  readonly child: pty.IPty;
  output = '';
  exited = false;
  private readonly listeners = new Set<() => void>();
  constructor(args: string[]) {
    this.child = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command',
      `& ${[process.execPath, cli, ...args].map(quote).join(' ')}`],
    { name: 'xterm-256color', cols: 100, rows: 35, cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '0' } });
    this.child.onData(data => { this.output += data; for (const listener of this.listeners) listener(); });
    this.child.onExit(() => { this.exited = true; for (const listener of this.listeners) listener(); });
  }
  waitFor(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Missing "${text}" in terminal:\n${stripVTControlCharacters(this.output).slice(-6000)}`));
      }, 20000);
      const check = () => {
        if (stripVTControlCharacters(this.output).includes(text)) { clearTimeout(timer); this.listeners.delete(check); resolve(); }
        else if (this.exited) { clearTimeout(timer); this.listeners.delete(check); reject(new Error(`Terminal exited waiting for ${text}`)); }
      };
      this.listeners.add(check); check();
    });
  }
  async send(text: string): Promise<void> {
    this.output = '';
    this.child.write(`\x1b[200~${text}\x1b[201~`);
    await this.waitFor(`> ${text}|`);
    this.child.write('\r');
  }
  waitForExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Terminal did not exit cleanly.')), 10000);
      this.child.onExit(() => { clearTimeout(timer); resolve(); });
    });
  }
  async close(): Promise<void> {
    if (this.exited) return;
    this.child.write('\x04');
    await this.waitForExit();
  }
  async cleanup(): Promise<void> {
    if (this.exited) return;
    this.child.kill();
    await this.waitForExit();
  }
}
const terminals: TerminalDriver[] = [];
const start = (resume?: string) => {
  const terminal = new TerminalDriver(resume ? ['resume', resume, '--data-dir', f.config.dataDir] :
    ['--fake', '--workspace', f.config.workspace, '--data-dir', f.config.dataDir]);
  terminals.push(terminal);
  return terminal;
};
function sessions(): string[] {
  const store = new Store(f.config.dataDir);
  try { return store.sessions().map(s => s.id); } finally { store.close(); }
}
try {
  let first = start();
  await first.waitFor('HARNESS');
  const firstId = sessions()[0]!;
  const second = start();
  await second.waitFor('HARNESS');
  const ids = sessions();
  if (ids.length !== 2 || ids[0] === ids[1]) throw new Error('Concurrent terminals did not create distinct sessions.');
  await second.send('independent second session');
  await second.waitFor('OFFLINE FAKE MODEL: independent second session');
  await second.waitFor('completed');
  if (first.output.includes('independent second session')) throw new Error('Conversation leaked between terminal instances.');
  const duplicate = start(firstId);
  await duplicate.waitFor('already owned');
  await duplicate.waitForExit();
  await second.close();

  first.child.write('\x1b[200~first line\r\nsecond line\x1b[201~');
  await first.waitFor('second line');
  if (stripVTControlCharacters(first.output).includes('OFFLINE FAKE MODEL: first line')) throw new Error('Paste submitted without Enter.');
  first.child.write('\r');
  await first.waitFor('OFFLINE FAKE MODEL: first line');
  await first.waitFor('completed');
  first.child.resize(70, 28);
  await first.send('Read documents, summarize them, and save the summary.');
  await first.waitFor('APPROVAL REQUIRED: read_documents');
  if (existsSync(path.join(f.config.workspace, 'summary.md'))) throw new Error('Output created before approval.');
  await first.close();
  first = start(firstId);
  await first.waitFor('APPROVAL REQUIRED: read_documents');
  await first.send('/approve');
  await first.waitFor('APPROVAL REQUIRED: write_file');
  first.output = '';
  first.child.write('\x03');
  await first.waitFor('cancelled');
  if (existsSync(path.join(f.config.workspace, 'summary.md'))) throw new Error('Cancelled save created a file.');
  await first.send('confirm cancellation');
  await first.waitFor('OFFLINE FAKE MODEL: confirm cancellation');
  await first.waitFor('completed');
  await first.send('Read documents, summarize them, and save the summary.');
  await first.waitFor('APPROVAL REQUIRED: read_documents');
  await first.send('/approve');
  await first.waitFor('APPROVAL REQUIRED: write_file');
  await first.close();
  first = start(firstId);
  await first.waitFor('APPROVAL REQUIRED: write_file');
  await first.send('/approve');
  await first.waitFor('Summary saved');
  await first.waitFor('completed');
  if (!existsSync(path.join(f.config.workspace, 'summary.md'))) throw new Error('Approved output was not created.');
  first.child.write('\x1b[5~'); first.child.write('\x1b[6~');
  await first.close();
  console.log('PASS Windows PowerShell/ConPTY: independent concurrent terminals, duplicate-owner rejection, multiline paste, explicit Enter, streaming, resize, read/save approval restart, Ctrl+C cancellation, subsequent request, scrolling, exit.');
} finally {
  for (const terminal of terminals) await terminal.cleanup();
  f.cleanup();
}
// node-pty's Windows console-list helper can retain IPC after the verified terminals exit.
process.exit(0);
