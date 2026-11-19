import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { TrustedSessionController as SessionController } from './helpers.js';
import { digest } from '../src/workspace.js';
import { Workspace } from '../src/workspace.js';
import { fixture, ScriptRuntime, approve } from './helpers.js';
import type { ExecutionRecord } from '../src/contracts.js';

const image = process.env.HARNESS_TEST_DOCKER_IMAGE;
const browser = process.env.HARNESS_TEST_BROWSER;
describe('Opt-in local provider acceptance (no downloads or paid calls)', () => {
  it.skipIf(!image)('A07 terminates exact owned containers on command timeout and output overflow', async () => {
    for (const mode of ['timeout', 'output'] as const) {
      const f = fixture({ execution: { provider: 'docker', image }, limits: { toolTimeoutMs: mode === 'timeout' ? 2000 : 15000, maxOutputBytes: 1024 } });
      const runtime = new ScriptRuntime(async runtime => {
        await runtime.call('execution_run', { executable: '/bin/sh', args: ['-c', mode === 'timeout' ? 'sleep 30' : 'while :; do printf "bounded-output-check\\n"; done'] });
      });
      const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
      try {
        const result = await app.submit(`Exercise synthetic container ${mode} enforcement.`);
        expect(result.status).toBe('recovery_required');
        const execution = app.store.list('execution', app.id, result.id)[0]!;
        expect(execution.exitCode).toBeNull();
        const remaining = execFileSync('docker', ['--host', process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock',
          'ps', '-a', '--filter', `name=${execution.container}`, '--format', '{{.Names}}'], { encoding: 'utf8' });
        expect(remaining.trim()).toBe('');
      } finally { await app.close(); f.cleanup(); }
    }
  }, 60000);

  it.skipIf(!image)('A02/A06 reproduces/fixes a source bug, proves isolation, checks output and publishes exact mirror changes', async () => {
    const f = fixture({ execution: { provider: 'docker', image }, limits: { toolTimeoutMs: 60000 } });
    writeFileSync(path.join(f.workspace, 'calculator.sh'), 'sum() { printf "%s\\n" "$(($1-$2))"; }\n');
    writeFileSync(path.join(f.workspace, 'check.sh'), '. ./calculator.sh\n[ "$(sum 2 1)" = "3" ] || { printf "FAIL: arithmetic mismatch\\n"; exit 1; }\nprintf "genuine check passed\\n"\n');
    writeFileSync(path.join(f.workspace, '.env'), 'SYNTHETIC_PRIVATE_FILE=never-mirror');
    execFileSync('git', ['init', '--quiet'], { cwd: f.workspace });
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'add', '.'], { cwd: f.workspace });
    execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic baseline'], { cwd: f.workspace });
    writeFileSync(path.join(f.workspace, 'notes.txt'), 'Unrelated user edit; preserve it.');
    const runtime = new ScriptRuntime(async runtime => {
      const baseline = await runtime.call('execution_run', { executable: '/bin/sh', args: ['check.sh'] }) as unknown as ExecutionRecord;
      expect(baseline.exitCode).toBe(1);
      expect(app.store.readResult(app.id, baseline.outputResultId!).text).toContain('FAIL: arithmetic mismatch');
      const workspace = new Workspace(f.config);
      const source = workspace.read('calculator.sh');
      workspace.patch('calculator.sh', source.hash, [{ oldText: '$1-$2', newText: '$1+$2' }]);
      const check = await runtime.call('execution_run', { executable: '/bin/sh', args: ['check.sh'] }) as unknown as ExecutionRecord;
      expect(check.status, check.outputResultId ? app.store.readResult(app.id, check.outputResultId).text : JSON.stringify(check)).toBe('completed'); expect(check.exitCode).toBe(0);
      const isolation = await runtime.call('execution_run', { executable: '/bin/sh', args: ['-c',
        'set -eu; [ -z "${OPENAI_API_KEY+x}" ]; [ ! -e .env ]; [ ! -e /var/run/docker.sock ]; if (printf no > /etc/harness-escape) 2>/dev/null; then exit 1; fi; [ "$(ls /sys/class/net)" = lo ]; printf "isolated verification" > evidence.txt; printf "isolated verification" > approved.txt; printf "isolation enforced\\n"',
      ] }) as unknown as ExecutionRecord;
      expect(isolation.exitCode).toBe(0);
      const changes = await runtime.call('execution_changes', { id: isolation.id });
      const publish = (changes.changes as Record<string, unknown>[]).map(change => ({ path: change.path, baseline: change.baseline, hash: change.hash }));
      writeFileSync(path.join(f.workspace, 'evidence.txt'), 'Concurrent host edit; do not overwrite.');
      await expect(runtime.call('execution_publish', { id: isolation.id, changes: publish })).rejects.toThrow('Host changed');
      expect(existsSync(path.join(f.workspace, 'approved.txt'))).toBe(false);
      await runtime.call('execution_publish', { id: isolation.id, changes: publish.filter(change => change.path === 'approved.txt') });
      expect(execFileSync('git', ['--no-pager', 'diff', '--', 'calculator.sh'], { cwd: f.workspace, encoding: 'utf8' })).toContain('$1+$2');
      const checkResult = app.inspect().results.find(result => result.provenance.kind === 'process_output' && result.provenance.executionId === check.id)!;
      await runtime.updatePlan(`Arithmetic verified by Docker result ${checkResult.id}; reviewed exact calculator diff.`);
      runtime.message('The focused change passes the real isolated check; unrelated changes are preserved.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime }); approve(app);
    try {
      const result = await app.submit('Fix the synthetic arithmetic bug.', { domain: 'coding' });
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8')).toBe('Unrelated user edit; preserve it.');
      expect(readFileSync(path.join(f.workspace, 'evidence.txt'), 'utf8')).toBe('Concurrent host edit; do not overwrite.');
      expect(readFileSync(path.join(f.workspace, 'approved.txt'), 'utf8')).toBe('isolated verification');
    } finally { await app.close(); f.cleanup(); }
  }, 120000);

  it.skipIf(!browser)('A04/A06 uses observations, denies submissions without effects, isolates cookies, and preserves screenshot/download provenance', async () => {
    let submissions = 0;
    let submittedCookie: string | undefined;
    const server = createServer(async (request, response) => {
      if (request.url === '/download') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Synthetic downloaded evidence.'); return; }
      if (request.url === '/done') { submissions++; submittedCookie = request.headers.cookie; response.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Saved synthetic request</h1>'); return; }
      if (request.url === '/state') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<h1>Cookie: ${request.headers.cookie ?? 'none'}</h1>`); return; }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'synthetic=first; Path=/; HttpOnly' })
        .end('<h1>Synthetic form</h1><form action="/done" method="post"><label>Name<input id="name" name="name"></label><button id="submit" type="submit">Save request</button></form>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const f = fixture({ browser: { executablePath: browser, version: process.env.HARNESS_TEST_BROWSER_VERSION }, network: { localFixtureOrigins: [origin] } });
    let denySubmission = true;
    const runtime = new ScriptRuntime(async runtime => {
      const initial = await runtime.call('browser_navigate', { url: origin + '/' });
      const typed = await runtime.call('browser_action', { observation: initial.id, selector: '#name', action: 'type', text: 'Synthetic' });
      const submit = { observation: typed.id, selector: '#submit', action: 'click',
        requests: [{ url: origin + '/done', method: 'POST', bodyHash: digest('name=Synthetic') }] };
      await expect((async () => {
        await runtime.requestPermission('browser_action', { selector: '#submit' });
        return runtime.call('browser_action', submit);
      })()).rejects.toThrow('denied');
      expect(submissions).toBe(0); denySubmission = false;
      await runtime.requestPermission('browser_action', { selector: '#submit' });
      const done = await runtime.call('browser_action', submit);
      expect(submissions).toBe(1);
      expect(submittedCookie).toContain('synthetic=first');
      await expect(runtime.call('browser_action', { observation: typed.id, selector: '#submit', action: 'click' })).rejects.toThrow('Observe');
      const observation = await runtime.call('browser_snapshot', {});
      await runtime.call('browser_screenshot', { observation: observation.id });
      await runtime.call('browser_download', { url: origin + '/download' });
      const verified = await runtime.call('browser_verify', { observation: observation.id });
      expect(verified.verified).toBe(true);
      const evidence = app.inspect().results.find(result => result.provenance.tool === 'browser_verify')!;
      await runtime.updatePlan(`Saved form state verified by observation result ${evidence.id}.`);
      expect(done.snapshot).toContain('Saved synthetic request'); runtime.message('Saved synthetic request, verified from the page.');
    });
    const app = await SessionController.open({ config: f.config, runtimeFactory: () => runtime });
    app.subscribe(event => {
      if (event.type !== 'request') return;
      const request = app.inspect().pending.at(-1)!;
      app.decide(request.id, request.revision, request.binding, denySubmission && request.description.includes('#submit') ? 'deny' : 'approve');
    });
    const secondRuntime = new ScriptRuntime(async runtime => {
      const state = await runtime.call('browser_navigate', { url: origin + '/state' });
      expect(state.snapshot).toContain('Cookie: none');
      await runtime.call('browser_verify', { observation: state.id });
      const evidence = second!.inspect().results.find(result => result.provenance.tool === 'browser_verify')!;
      await runtime.updatePlan(`Independent browser state verified by result ${evidence.id}.`);
      runtime.message('Independent browser state confirmed.');
    });
    let second: SessionController | undefined;
    try {
      const result = await app.submit('Save the synthetic form, then observe the result.', { domain: 'browser', criteria: ['Saved synthetic request'] });
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(app.inspect().results.some(result => result.provenance.kind === 'browser_screenshot')).toBe(true);
      expect(app.inspect().results.some(result => result.provenance.kind === 'quarantined_download')).toBe(true);
      second = await SessionController.open({ config: f.config, runtimeFactory: () => secondRuntime }); approve(second);
      expect((await second.submit('Inspect clean browser state.', { criteria: ['Cookie: none'] })).status).toBe('completed');
    } finally {
      await second?.close(); await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup();
    }
  }, 120000);
});
