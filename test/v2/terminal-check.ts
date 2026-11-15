import * as pty from 'node-pty';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { provider, complete, message } from '../provider-fixture.js';
import { fixture } from './helpers.js';
import { V2Store } from '../../src/v2/store.js';

if (process.platform !== 'win32') throw new Error('V2 native terminal verification requires Windows/ConPTY.');
const endpoint = await provider((response, _body, count) => {
  if (count === 3 || count === 4) complete(response, `native_read_${count}`, [{
    id: `native_fc_${count}`, type: 'function_call', call_id: `native_call_${count}`,
    name: 'harness_workspace_read', arguments: '{"path":"notes.txt"}', status: 'completed',
  }]);
  else complete(response, `native_response_${count}`, message('Synthetic V2 native terminal result.'), 'Synthetic V2 native terminal result.');
});
const f = fixture();
const config = path.join(f.directory, 'config.json');
writeFileSync(config, JSON.stringify({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } }));
const cli = fileURLToPath(new URL('../../dist/v2/cli.js', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
class Terminal {
  readonly child: pty.IPty;
  output = '';
  exited = false;
  private listeners = new Set<() => void>();
  constructor(resume?: string) {
    const args = resume ? ['resume', resume, '--data-dir', f.dataDir] : ['--config', config];
    this.child = pty.spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command',
      `& ${[process.execPath, cli, ...args].map(quote).join(' ')}`], {
      name: 'xterm-256color', cols: 100, rows: 35, cwd: f.workspace,
      env: { ...process.env, FORCE_COLOR: '0', OPENAI_API_KEY: 'synthetic-provider-wire-key',
        OPENAI_BASE_URL: endpoint.baseURL, HARNESS_MODEL: 'gpt-6.1-sol', HARNESS_WIRE_MODEL: 'synthetic-deployment' },
    });
    this.child.onData(data => { this.output += data; for (const listener of this.listeners) listener(); });
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
    this.output = ''; this.child.write(`\x1b[200~${text}\x1b[201~`); await this.wait(`> ${text}|`); this.child.write('\r');
  }
  async exit(force = false): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('V2 terminal did not stop its owned work.')), 10000);
      this.child.onExit(() => { clearTimeout(timer); resolve(); });
    });
    if (force) this.child.kill(); else this.child.write('\x04');
    await done;
  }
}
const terminals: Terminal[] = [];
const start = (id?: string) => { const terminal = new Terminal(id); terminals.push(terminal); return terminal; };
const sessions = () => {
  const store = new V2Store(f.dataDir);
  try { return store.sessions().map(session => session.id); } finally { store.close(); }
};
try {
  let first = start(); await first.wait('HARNESS V2'); const id = sessions()[0]!;
  const second = start(); await second.wait('HARNESS V2');
  if (sessions().length !== 2) throw new Error('V2 terminal sessions are not independent.');
  const duplicate = start(id); await duplicate.wait('already owned'); await duplicate.exit();
  first.child.write('\x1b[200~Synthetic first line\r\nSynthetic second line\x1b[201~');
  await first.wait('Synthetic second line');
  if (endpoint.requests.length) throw new Error('V2 paste submitted without Enter.');
  first.child.write('\r'); await first.wait('completed'); await first.wait('Synthetic V2 native terminal result.');
  await second.send('Synthetic independent second terminal.'); await second.wait('completed'); await second.exit();
  first.child.resize(76, 30);
  await first.send('Read the synthetic notes.'); await first.wait('APPROVAL REQUIRED');
  await first.exit();
  first = start(id); await first.wait('recovery_required');
  await first.send('/reconcile {"note":"Stopped before dispatch; no side effects."}');
  await first.wait('partial');
  await first.send('/continue'); await first.wait('APPROVAL REQUIRED');
  await first.send('/approve'); await first.wait('completed');
  await first.wait('Synthetic V2 native terminal result.');
  first.child.write('\x1b[5~'); first.child.write('\x1b[6~');
  await first.exit();
  console.log('PASS V2 Windows PowerShell/ConPTY with real SDK and synthetic BYOK: independent terminals, duplicate-owner rejection, safe multiline paste, streaming, resize, interrupted approval reconciliation, fresh approval after cold resume, scroll and owned shutdown. Physical clipboard/font checks remain manual.');
} finally {
  for (const terminal of terminals) await terminal.exit(true);
  await endpoint.close(); f.cleanup();
}
process.exit(0);
