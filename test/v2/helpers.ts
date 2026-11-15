import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SKILLS_DIRECTORY, parseV2Config } from '../../src/v2/config.js';
import { V2Controller } from '../../src/v2/controller.js';
import type { Runtime, RuntimeOptions } from '../../src/v2/contracts.js';

export function fixture(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'harness-v2-test-'));
  const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
  const dataDir = path.join(directory, 'state');
  writeFileSync(path.join(workspace, 'notes.txt'), 'Synthetic reference evidence.\nValue: 2\n');
  const config = parseV2Config({
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
export function approve(app: V2Controller, answer = 'approve'): () => void {
  return app.subscribe(event => {
    if (event.type !== 'request') return;
    const request = app.inspect().pending.at(-1)!;
    app.decide(request.id, request.revision, request.binding, request.kind === 'question' ? request.choices?.[0] ?? 'Synthetic answer' : answer);
  });
}
