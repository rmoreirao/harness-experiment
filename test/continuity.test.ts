import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { provider, complete, message } from './provider-fixture.js';
import { fixture, skillFile, ScriptRuntime, approve } from './helpers.js';
import { parseConfig } from '../src/config.js';
import { SessionController } from '../src/controller.js';

function client(configFile: string, cwd: string, resumeId?: string) {
  const command = path.resolve('src', 'cli.tsx');
  const process = spawn(globalThis.process.execPath, ['--import', pathToFileURL(path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href, command,
    '--headless', '--config', configFile, ...(resumeId ? ['resume', resumeId] : [])], {
    cwd, env: { ...globalThis.process.env, OPENAI_API_KEY: 'synthetic-provider-wire-key', OPENAI_BASE_URL: '', HARNESS_MODEL: '', HARNESS_WIRE_MODEL: '' },
  });
  let buffer = ''; let stderr = '';
  const records: Record<string, unknown>[] = [];
  process.stdout.on('data', chunk => {
    buffer += String(chunk); let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      records.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  process.stderr.on('data', chunk => { stderr += String(chunk); });
  const send = (id: string, operation: string, args: Record<string, unknown> = {}) => process.stdin.write(JSON.stringify({ id, operation, args }) + '\n');
  const wait = async (predicate: (record: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const record = records.find(predicate);
      if (record) return record;
      if (process.exitCode !== null) throw new Error(`Headless process exited ${process.exitCode}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Headless response timeout: ${stderr}\n${JSON.stringify(records).slice(-2000)}`);
  };
  return { process, records, send, wait };
}
async function close(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null) return;
  const exited = new Promise<void>(resolve => process.once('exit', () => resolve()));
  process.stdin.end(); await exited;
}
describe('A05/A08 actual process continuity', () => {
  it('lists and reloads the configured skill snapshot through the headless API without starting model work', async () => {
    const f = fixture();
    skillFile(f.workspace, 'review-notes', 'Original guidance.');
    const file = path.join(f.directory, 'config.json'); writeFileSync(file, JSON.stringify(f.config));
    const app = client(file, f.workspace);
    try {
      app.send('list', 'skills', { action: 'list' });
      const initial = (await app.wait(record => record.id === 'list')).result as { skills: { name: string; hash: string }[] };
      expect(initial.skills.some(skill => skill.name === 'review-notes')).toBe(true);
      skillFile(f.workspace, 'review-notes', 'Reloaded guidance.');
      app.send('reload', 'skills', { action: 'reload' });
      const updated = (await app.wait(record => record.id === 'reload')).result as typeof initial;
      expect(updated.skills.find(skill => skill.name === 'review-notes')!.hash).not.toBe(initial.skills.find(skill => skill.name === 'review-notes')!.hash);
      app.send('invalid', 'skills', { action: 'unknown' });
      expect((await app.wait(record => record.id === 'invalid')).type).toBe('error');
    } finally { await close(app.process); f.cleanup(); }
  });
  it('runs independent headless terminals with real SDK children, rejects conflicting commands, and exposes bounded results', async () => {
    const endpoint = await provider((response, _body, count) => complete(response, `resp_cli_${count}`,
      message('Synthetic headless result.'), 'Synthetic headless result.'));
    const f = fixture({ version: 3 });
    const config = parseConfig({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const file = path.join(f.directory, 'config.json'); writeFileSync(file, JSON.stringify(config));
    const one = client(file, f.workspace); const two = client(file, f.workspace);
    try {
      one.send('one', 'inspect'); two.send('two', 'inspect');
      const first = (await one.wait(record => record.id === 'one')).result as { sessionId: string };
      const second = (await two.wait(record => record.id === 'two')).result as { sessionId: string };
      expect(first.sessionId).not.toBe(second.sessionId);
      one.send('run-one', 'submit', { objective: 'Synthetic process one.' });
      one.send('conflict', 'submit', { objective: 'Do not admit this objective.' });
      two.send('run-two', 'submit', { objective: 'Synthetic process two.' });
      expect((await one.wait(record => record.id === 'conflict' && record.type === 'error')).message).toContain('already admitted');
      const resultOne = await one.wait(record => record.id === 'run-one' && record.type === 'objective');
      const resultTwo = await two.wait(record => record.id === 'run-two' && record.type === 'objective');
      expect(resultOne.objective).toMatchObject({ status: 'completed', original: 'Synthetic process one.' });
      expect(resultTwo.objective).toMatchObject({ status: 'completed', original: 'Synthetic process two.' });
      one.send('limits', 'inspect');
      expect((await one.wait(record => record.id === 'limits')).result).toMatchObject({
        budget: { mode: 'none', maxTokens: null, maxCost: null },
        modelLimits: { providerCapacityVerified: false, prompt: { source: 'runtime reported' },
          output: { limit: null, source: 'SDK/provider default' } },
      });
      one.send('audit', 'events', { limit: 1 });
      expect((await one.wait(record => record.id === 'audit')).result).toHaveLength(1);
      expect(endpoint.requests).toHaveLength(2);
    } finally { await Promise.all([close(one.process), close(two.process)]); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it.each([2, 3])('persists unknown external effects, requires exact reconciliation and never replays them on version-%i cold continuation', async version => {
    const f = fixture({ version }); const external = path.join(f.directory, 'effect.txt');
    let effects = 0;
    const runtime = new ScriptRuntime(async runtime => { await runtime.call('fixture_effect', {}); });
    let app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); const id = app.id;
    app.broker.register('fixture_effect', 'Synthetic failure after a known disposable external effect.', (await import('zod')).z.object({}).strict(), 'write', () => {
      writeFileSync(external, 'effect occurred once'); effects++; throw new Error('Injected failure after effect and before outcome.');
    });
    approve(app);
    try {
      const interrupted = await app.submit('Synthetic unknown-effect recovery.');
      expect(interrupted.status).toBe('recovery_required');
      await app.close();
      const next = new ScriptRuntime(async runtime => { runtime.message('The checked effect was not repeated.'); });
      app = await SessionController.open({ config: f.config, sessionId: id, runtimeFactory: () => next });
      const action = app.inspect().actions.find(action => action.status === 'unknown')!;
      await expect(app.submit('Conflicting objective.')).rejects.toThrow('already admitted');
      await expect(app.reconcile({ note: 'Not enough detail.' })).rejects.toThrow('Every unknown');
      await app.reconcile({ note: 'Inspected the synthetic external resource.', actions: [{ id: action.id, note: 'The exact effect is present once.' }] });
      const continued = await app.continueObjective();
      expect(continued.id).toBe(interrupted.id); expect(continued.deadline).toBe(interrupted.deadline);
      expect(continued.status).toBe('completed'); expect(effects).toBe(1);
      expect(readFileSync(external, 'utf8')).toBe('effect occurred once');
    } finally { await app.close(); f.cleanup(); }
  });

});
