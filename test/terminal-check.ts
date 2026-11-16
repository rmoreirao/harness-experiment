import * as pty from 'node-pty';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import xterm from '@xterm/headless';
import { provider, complete, message } from './provider-fixture.js';
import { fixture } from './helpers.js';
import { Store } from '../src/store.js';

if (process.platform !== 'win32') throw new Error('Native terminal verification requires Windows/ConPTY.');
const nativeQuestion = `NATIVE_QUESTION_START ${'Confirm the intended source before continuing. '.repeat(30)} NATIVE_QUESTION_TAIL`;
const endpoint = await provider((response, _body, count) => {
  if (count === 3 || count === 4) complete(response, `native_read_${count}`, [{
    id: `native_fc_${count}`, type: 'function_call', call_id: `native_call_${count}`,
    name: 'harness_workspace_read', arguments: '{"path":"notes.txt"}', status: 'completed',
  }]);
  else if (count === 6) complete(response, 'native_question', [{
    id: 'native_question_fc', type: 'function_call', call_id: 'native_question_call',
    name: 'harness_work_question', arguments: JSON.stringify({
      question: nativeQuestion, choices: ['Use the stated source', 'Provide another source'], allowFreeform: false,
    }), status: 'completed',
  }]);
  else complete(response, `native_response_${count}`, message('Synthetic native terminal result.'), 'Synthetic native terminal result.');
});
const f = fixture({ version: 3 });
const config = path.join(f.directory, 'config.json');
writeFileSync(config, JSON.stringify({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } }));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
class Terminal {
  readonly child: pty.IPty;
  readonly screen = new xterm.Terminal({ cols: 100, rows: 35, allowProposedApi: true });
  output = '';
  exited = false;
  private listeners = new Set<() => void>();
  constructor(resume?: string) {
    const args = resume ? ['resume', resume, '--data-dir', f.dataDir] : ['--config', config];
    this.child = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command',
      `Write-Output 'Synthetic prior terminal output.'; & ${[process.execPath, cli, ...args].map(quote).join(' ')}`], {
      name: 'xterm-256color', cols: 100, rows: 35, cwd: f.workspace,
      env: { ...process.env, FORCE_COLOR: '0', OPENAI_API_KEY: 'synthetic-provider-wire-key',
        OPENAI_BASE_URL: endpoint.baseURL, HARNESS_MODEL: 'gpt-6.1-sol', HARNESS_WIRE_MODEL: 'synthetic-deployment' },
    });
    this.screen.onData(data => this.child.write(data));
    this.child.onData(data => { this.output += data; this.screen.write(data, () => { for (const listener of this.listeners) listener(); }); });
    this.child.onExit(() => { this.exited = true; for (const listener of this.listeners) listener(); });
  }
  wait(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`Missing ${text}:\n${stripVTControlCharacters(this.output).slice(-6000)}`)); }, 20000);
      const check = () => {
        if (stripVTControlCharacters(this.output).includes(text)) { clearTimeout(timer); this.listeners.delete(check); resolve(); }
        else if (this.exited) { clearTimeout(timer); this.listeners.delete(check); reject(new Error(`Terminal exited waiting for ${text}:\n${stripVTControlCharacters(this.output).slice(-3000)}`)); }
      };
      this.listeners.add(check); check();
    });
  }
  async send(text: string): Promise<void> {
    this.output = ''; this.child.write(`\x1b[200~${text}\x1b[201~`); await this.wait(`> ${text}|`);
    this.output = ''; this.child.write('\r'); await this.wait('> |');
  }
  lines(): string[] {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: this.screen.rows }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '');
  }
  waitScreen(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`Screen missing ${text}:\n${this.lines().join('\n')}`)); }, 20000);
      const check = () => {
        if (this.lines().some(line => line.includes(text))) { clearTimeout(timer); this.listeners.delete(check); resolve(); }
        else if (this.exited) { clearTimeout(timer); this.listeners.delete(check); reject(new Error(`Terminal exited waiting for ${text}`)); }
      };
      this.listeners.add(check); check();
    });
  }
  waitMouse(enabled: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check);
        reject(new Error(`Mouse mode ${enabled ? 'enabled' : 'disabled'} not observed: ${JSON.stringify(this.output.slice(-3000))}`)); }, 20000);
      const check = () => {
        if ((this.screen.modes.mouseTrackingMode !== 'none') === enabled) {
          clearTimeout(timer); this.listeners.delete(check); resolve();
        }
      };
      this.listeners.add(check); check();
    });
  }
  settleScreen(text?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(deadline); clearTimeout(quiet); this.listeners.delete(changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => {
        clearTimeout(quiet);
        if (this.exited) finish(new Error('Terminal exited before mouse target settled.'));
        else if (!text || this.lines().some(line => line.includes(text))) quiet = setTimeout(() => finish(), 80);
      };
      const deadline = setTimeout(() => finish(new Error(`Terminal screen did not settle${text ? `: ${text}` : ''}`)), 20000);
      this.listeners.add(changed); changed();
    });
  }
  async click(text: string): Promise<void> {
    await this.waitScreen(text);
    await this.settleScreen(text);
    const y = this.lines().findIndex(line => line.includes(text)) + 1;
    this.child.write(`\x1b[<0;2;${y}M\x1b[<0;2;${y}m`);
    await this.settleScreen();
  }
  resize(columns: number, rows: number): void {
    this.screen.resize(columns, rows); this.child.resize(columns, rows);
  }
  async exit(force = false): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Terminal did not stop its owned work.')), 10000);
      this.child.onExit(() => { clearTimeout(timer); resolve(); });
    });
    if (force) this.child.kill(); else this.child.write('\x04');
    await done;
  }
}
const terminals: Terminal[] = [];
const start = (id?: string) => { const terminal = new Terminal(id); terminals.push(terminal); return terminal; };
const sessions = () => {
  const store = new Store(f.dataDir);
  try { return store.sessions().map(session => session.id); } finally { store.close(); }
};
try {
  let first = start(); await first.wait('HARNESS  '); await first.wait('no task token budget'); const id = sessions()[0]!;
  const second = start(); await second.wait('HARNESS  ');
  if (sessions().length !== 2) throw new Error('Terminal sessions are not independent.');
  const duplicate = start(id); await duplicate.wait('already owned'); await duplicate.exit();
  first.child.write('\x1b[200~Synthetic first line\r\nSynthetic second line\x1b[201~');
  await first.wait('Synthetic second line');
  if (endpoint.requests.length) throw new Error('Paste submitted without Enter.');
  first.child.write('\r'); await first.wait('completed | 0/0 steps'); await first.wait('Synthetic native terminal result.');
  const beforeTrace = endpoint.requests.length;
  await first.send('/trace on'); await first.waitScreen('> Trace |');
  await first.waitMouse(true);
  if (String(first.screen.buffer.active.type) !== 'alternate') throw new Error('Trace did not enter its dedicated terminal screen.');
  await first.click('> Trace |'); await first.waitScreen('v Trace |');
  await first.settleScreen();
  const collapsedFrame = first.lines().join('\n');
  if (!first.lines().includes('TRACE FOCUS | Up/Down select | Space/Enter toggle | Ctrl+T input')) {
    throw new Error('Trace focus hint retained trailing text from the previous footer.');
  }
  const switches = first.output.split('\x1b[?1049').length;
  for (let cycle = 0; cycle < 3; cycle++) {
    await first.click('> [done] MODEL'); await first.waitScreen('Input tokens: 100');
    await first.click('v [done] MODEL'); await first.waitScreen('> [done] MODEL');
    await first.settleScreen();
    const actual = first.lines().join('\n');
    if (actual !== collapsedFrame) throw new Error(`Trace collapse left stale terminal text.\nExpected:\n${collapsedFrame}\nActual:\n${actual}`);
  }
  if (first.output.split('\x1b[?1049').length !== switches) throw new Error('Trace expansion unexpectedly switched terminal screens.');
  first.child.write(' '); await first.waitScreen('Input tokens: 100');
  first.child.write('\x1b[D'); await first.waitScreen('> [done] MODEL');
  first.child.write('\x14');
  await first.send('/approve_all'); await first.waitScreen('APPROVE ALL: ENABLED'); await first.settleScreen();
  if (first.lines()[1] !== 'APPROVE ALL: ENABLED') throw new Error('Approval header retained text from the previous workspace line.');
  first.child.write('\x14'); await first.waitScreen('TRACE FOCUS'); await first.settleScreen();
  const approvalFrame = first.lines().join('\n');
  await first.click('> [done] MODEL'); await first.waitScreen('Input tokens: 100');
  await first.click('v [done] MODEL'); await first.waitScreen('> [done] MODEL'); await first.settleScreen();
  if (first.lines().join('\n') !== approvalFrame) throw new Error('Approval/trace layout left stale text after collapsing a call.');
  first.child.write('\x14');
  await first.send('/approve_all off'); await first.settleScreen();
  await first.send('/trace expand'); await first.wait('TRACE ON');
  await first.send('/trace off'); await first.wait('Synthetic native terminal result.');
  await first.waitMouse(false);
  if (String(first.screen.buffer.active.type) !== 'normal') throw new Error('Trace did not restore the normal terminal screen.');
  if (endpoint.requests.length !== beforeTrace) throw new Error('Trace display commands invoked the model.');
  await second.send('Synthetic independent second terminal.'); await second.wait('completed | 0/0 steps'); await second.exit();
  first.resize(76, 30);
  await first.send('Read the synthetic notes.'); await first.wait('APPROVAL REQUIRED');
  await first.exit();
  first = start(id); await first.wait('recovery_required');
  await first.send('/reconcile {"note":"Stopped before dispatch; no side effects."}');
  await first.wait('partial');
  await first.send('/continue'); await first.wait('APPROVAL REQUIRED');
  await first.send('/approve'); await first.wait('completed | 0/0 steps');
  await first.wait('Synthetic native terminal result.');
  await first.send('/trace on'); await first.waitScreen('v Trace |');
  first.resize(60, 26);
  await first.click('v Trace |'); await first.waitScreen('> Trace |');
  await first.click('> Trace |'); await first.waitScreen('v Trace |');
  await first.waitScreen('> [done] TOOL');
  await first.send('/trace off'); await first.wait('Synthetic native terminal result.');
  first.resize(52, 20);
  await first.send('Ask the synthetic clarification.');
  await first.wait('INPUT NEEDED'); await first.wait('More: /request');
  const beforeInspection = endpoint.requests.length;
  await first.send('/request'); await first.wait('Request lines 1-');
  for (let page = 0; page < 12 && !stripVTControlCharacters(first.output).includes('NATIVE_QUESTION_TAIL'); page++) {
    first.output = ''; first.child.write('\x1b[6~'); await first.wait('Request lines ');
  }
  await first.wait('NATIVE_QUESTION_TAIL');
  if (endpoint.requests.length !== beforeInspection) throw new Error('Request inspection invoked the model or answered the question.');
  await first.send('Provide another source'); await first.wait('completed | 0/0 steps');
  await first.wait('Synthetic native terminal result.');
  first.child.write('\x1b[5~'); first.child.write('\x1b[6~');
  await first.send('/trace on'); await first.waitMouse(true);
  await first.exit();
  await first.waitMouse(false);
  if (String(first.screen.buffer.active.type) !== 'normal') throw new Error('Exit left the trace screen active.');
  console.log('PASS Windows PowerShell/ConPTY with real SDK and synthetic BYOK: independent terminals, duplicate-owner rejection, safe multiline paste, streaming, clickable trace/call accordions and keyboard fallback without extra model calls, mouse mode cleanup, resize, interrupted approval reconciliation, fresh approval after cold resume, wrapped/scrollable clarifications, scroll and owned shutdown. Physical clipboard/font checks remain manual.');
} finally {
  for (const terminal of terminals) await terminal.exit(true);
  await endpoint.close(); f.cleanup();
}
process.exit(0);
