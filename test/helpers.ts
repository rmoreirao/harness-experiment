import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig, type Config } from '../src/config.js';
import { SessionController } from '../src/controller.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function fixture(overrides: Record<string, unknown> = {}): { config: Config; root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-test-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'notes.md'), '# Project notes\nThe launch is on Monday. Approval is required before publication.\n');
  const config = parseConfig({ mode: 'fake', workspace, dataDir: path.join(root, 'data'), ...overrides });
  return { config, root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
export async function approveAll(app: SessionController): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const pending = app.inspect().pending[0];
    if (!pending) return;
    await app.respond(pending.id, pending.revision, pending.kind === 'question' ? { answer: 'Focus on the launch date.' } : 'approve');
  }
  throw new Error('Approval loop did not finish.');
}
export async function worker(args: string[]): Promise<{ child: ChildProcess; line: string }> {
  const file = fileURLToPath(new URL('./worker.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', file, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Worker timed out: ${errors}`)); }, 15000);
    child.stderr?.on('data', chunk => { errors += String(chunk); });
    child.stdout?.on('data', chunk => {
      output += String(chunk);
      if (output.includes('\n')) { clearTimeout(timeout); resolve({ child, line: output.split('\n')[0]!.trim() }); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); if (!output.includes('\n')) reject(new Error(`Worker exit ${code}: ${errors}`)); });
  });
}
