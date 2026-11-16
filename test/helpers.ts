import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SKILLS_DIRECTORY, parseConfig } from '../src/config.js';
import { SessionController } from '../src/controller.js';
import type { Runtime, RuntimeOptions } from '../src/contracts.js';

export function fixture(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'harness-test-'));
  const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
  const dataDir = path.join(directory, 'state');
  writeFileSync(path.join(workspace, 'notes.txt'), 'Synthetic reference evidence.\nValue: 2\n');
  const config = parseConfig({
    version: 2, workspace, dataDir,
    model: { baseURL: 'http://127.0.0.1:9/v1', canonical: 'gpt-6.1-sol', wire: 'synthetic-deployment' },
    ...overrides,
  });
  return { directory, workspace, dataDir, config,
    cleanup: () => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
export function skillFile(workspace: string, name: string, content: string, directory = DEFAULT_SKILLS_DIRECTORY): string {
  const file = path.join(workspace, directory, name, 'SKILL.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: >-\n  Synthetic ${name} workflow guidance.\nlicense: MIT\n---\n${content}\n`);
  return file;
}
export class ScriptRuntime implements Runtime {
  options?: RuntimeOptions;
  plan = '';
  opens = 0;
  constructor(readonly script: (runtime: ScriptRuntime, prompt: string) => Promise<void>) {}
  async open(options: RuntimeOptions): Promise<void> { this.options = options; this.opens++; }
  async send(prompt: string): Promise<void> { await this.script(this, prompt); }
  async call(name: string, args: Record<string, unknown>, id = `${name}-${crypto.randomUUID()}`): Promise<Record<string, unknown>> {
    const tool = this.options?.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Unknown fixture tool ${name}`);
    const result = JSON.parse(await tool.invoke(args, id, this.options?.signal)) as { text: string };
    return JSON.parse(result.text) as Record<string, unknown>;
  }
  message(text: string): void { this.options?.emit('text', { message: text }); }
  async updatePlan(content: string): Promise<void> { this.plan = content; }
  async readPlan(): Promise<string | null> { return this.plan || null; }
  async events(): Promise<unknown[]> { return []; }
  async abort(): Promise<void> {}
  async close(): Promise<void> {}
}
export function approve(app: SessionController, answer = 'approve'): () => void {
  return app.subscribe(event => {
    if (event.type !== 'request') return;
    const request = app.inspect().pending.at(-1)!;
    app.decide(request.id, request.revision, request.binding, request.kind === 'question' ? request.choices?.[0] ?? 'Synthetic answer' : answer);
  });
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
