import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixture } from './helpers.js';
import { complete, message, provider, providerKey } from './provider-fixture.js';

const execFileAsync = promisify(execFile);
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const script = fileURLToPath(new URL('./live-check.ts', import.meta.url));
function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['OPENAI_BASE_URL', 'HARNESS_MODEL', 'OPENAI_API_KEY']) delete env[name];
  return env;
}
it.each(['currency', 'tokens'] as const)('runs the opt-in live verifier using .env with an explicit %s budget', async budget => {
  const endpoint = await provider((res, _body, count) => {
    if (budget === 'tokens' && count === 1) {
      complete(res, 'resp_question', [{ id: 'fc_question', type: 'function_call', status: 'completed',
        call_id: 'question', name: 'ask_user', arguments: '{"question":"Which source file and output should I use?"}' }]);
      return;
    }
    const step = count - (budget === 'tokens' ? 1 : 0);
    if (step === 1) complete(res, 'resp_read', [{ id: 'fc_read', type: 'function_call', status: 'completed',
      call_id: 'read', name: 'read_documents', arguments: '{"paths":["notes.md"]}' }]);
    else if (step === 2) complete(res, 'resp_write', [{ id: 'fc_write', type: 'function_call', status: 'completed',
      call_id: 'write', name: 'write_file', arguments: JSON.stringify({
        path: 'summary.md', content: 'Launch on Monday. Source: notes.md.', expectedHash: 'new',
      }) }]);
    else complete(res, 'resp_done', message('Summary saved.'), 'Summary saved.');
  });
  const f = fixture(); cleanup.push(f.cleanup);
  const config = path.join(f.root, 'verification.json');
  writeFileSync(config, JSON.stringify({ limits: { maxCost: 0.01, inputPerMillion: 0, outputPerMillion: 0 } }));
  writeFileSync(path.join(f.root, '.env'), `OPENAI_BASE_URL=${endpoint.baseURL}\nHARNESS_MODEL=wire-fixture\nOPENAI_API_KEY=${providerKey}\n`);
  try {
    const args = budget === 'currency' ? ['--config', config] : ['--max-tokens', '20000', '--max-requests', '10'];
    const result = await execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--live', ...args],
      { cwd: f.root, env: environment(), timeout: 20000 });
    const report = JSON.parse(result.stdout) as { passed: boolean; approvedRead: boolean; approvedSave: boolean };
    expect(report).toMatchObject({ passed: true, approvedRead: true, approvedSave: true });
    expect(endpoint.requests).toHaveLength(budget === 'tokens' ? 4 : 3);
    expect(result.stdout + result.stderr).not.toContain(providerKey);
  } finally { await endpoint.close(); }
});
it('loads .env but refuses paid verification without an explicit configured budget', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const config = path.join(f.root, 'verification.json');
  writeFileSync(config, '{}');
  writeFileSync(path.join(f.root, '.env'), 'OPENAI_BASE_URL=https://example.invalid/v1\nHARNESS_MODEL=wire-fixture\nOPENAI_API_KEY=synthetic-only\n');
  await expect(execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--live', '--config', config],
    { cwd: f.root, env: environment(), timeout: 15000 })).rejects.toMatchObject({
    stderr: expect.stringContaining('explicit maxCost'),
  });
});
it('requires explicit opt-in even when .env and a token cap are provided', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  writeFileSync(path.join(f.root, '.env'), 'OPENAI_BASE_URL=https://example.invalid/v1\nHARNESS_MODEL=wire-fixture\nOPENAI_API_KEY=synthetic-only\n');
  await expect(execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--max-tokens', '20000'],
    { cwd: f.root, env: environment(), timeout: 15000 })).rejects.toMatchObject({
    stderr: expect.stringContaining('Live verification is opt-in'),
  });
});
