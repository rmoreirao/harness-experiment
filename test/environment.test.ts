import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, ScriptRuntime, TrustedSessionController } from './helpers.js';
import { loadEnvironment } from '../src/config.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

it('redacts configured MCP secret output while storing only environment references', async () => {
  const secret = 'SYNTHETIC_REFERENCED_MCP_SECRET';
  vi.stubEnv('FIXTURE_MCP_TOKEN', secret);
  const f = fixture({ mcpServers: {
    fixture: { type: 'http', url: 'https://mcp.example.invalid/tools', headers: { authorization: '${env:FIXTURE_MCP_TOKEN}' } },
  } });
  const runtime = new ScriptRuntime(async runtime => {
    runtime.message(`Provider output ${secret}`);
    runtime.options!.emit('runtime', { state: 'diagnostic', message: `MCP diagnostic ${secret}` });
  });
  const app = await TrustedSessionController.open({ config: f.config, runtimeFactory: () => runtime });
  try {
    expect((await app.submit('Redact the configured integration secret.')).output).toBe('Provider output [REDACTED]');
    expect(JSON.stringify(app.store.events(app.id))).not.toContain(secret);
    const saved = app.store.db.prepare<[string], { config: string }>('SELECT config FROM sessions WHERE id=?').get(app.id)!.config;
    expect(saved).toContain('${env:FIXTURE_MCP_TOKEN}');
    expect(saved).not.toContain(secret);
    expect(app.config.mcpServers.fixture).toMatchObject({ headers: { authorization: '${env:FIXTURE_MCP_TOKEN}' } });
  } finally { await app.close(); f.cleanup(); vi.unstubAllEnvs(); }
});

it('loads .env into model configuration without persisting the API key', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  writeFileSync(path.join(f.directory, '.env'), [
    'HARNESS_PROVIDER=byok',
    'OPENAI_BASE_URL=https://example.invalid/v1',
    'HARNESS_MODEL=synthetic-model',
    'OPENAI_API_KEY=synthetic-env-key',
  ].join('\n'));
  const env = { ...process.env };
  for (const key of ['HARNESS_PROVIDER', 'OPENAI_BASE_URL', 'HARNESS_MODEL', 'HARNESS_WIRE_MODEL', 'OPENAI_API_KEY']) delete env[key];
  const configModule = new URL('../src/config.ts', import.meta.url).href;
  const code = `
    const {loadEnvironment,loadConfig}=await import(process.argv[1]);
    loadEnvironment();
    const config=loadConfig(undefined,{workspace:process.argv[2],dataDir:process.argv[3]});
    console.log(JSON.stringify({
      model:config.model.canonical,baseURL:config.provider.baseURL,
      keyLoaded:process.env.OPENAI_API_KEY==='synthetic-env-key',
      secretInConfiguration:JSON.stringify(config).includes('synthetic-env-key')
    }));
  `;
  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module',
    '-e', code, configModule, f.config.workspace, f.config.dataDir],
  { cwd: f.directory, env, encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({
    model: 'synthetic-model', baseURL: 'https://example.invalid/v1',
    keyLoaded: true, secretInConfiguration: false,
  });
  const cli = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), '--workspace', f.config.workspace],
  { cwd: f.directory, env, encoding: 'utf8' });
  expect(cli.status).toBe(1);
  expect(cli.stderr).toContain('with a TTY');
  expect(cli.stderr).not.toContain('synthetic-env-key');
});

it('keeps existing process settings ahead of .env', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const file = path.join(f.directory, '.env');
  writeFileSync(file, 'OPENAI_BASE_URL=https://file.invalid/v1\nHARNESS_MODEL=file-model\nOPENAI_API_KEY=file-key\n');
  const code = `
    const {loadEnvironment}=await import(process.argv[1]);
    loadEnvironment(process.argv[2]);
    console.log(JSON.stringify({
      baseURL:process.env.OPENAI_BASE_URL,model:process.env.HARNESS_MODEL,
      keyUnchanged:process.env.OPENAI_API_KEY==='process-key'
    }));
  `;
  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module',
    '-e', code, new URL('../src/config.ts', import.meta.url).href, file], {
    env: { ...process.env, OPENAI_BASE_URL: 'https://process.invalid/v1', HARNESS_MODEL: 'process-model', OPENAI_API_KEY: 'process-key' },
    encoding: 'utf8',
  });
  expect(JSON.parse(output)).toEqual({
    baseURL: 'https://process.invalid/v1', model: 'process-model', keyUnchanged: true,
  });
});

it('uses the fresh native data location for the root API and default CLI session discovery and resume', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const env = { ...process.env, HARNESS_PROVIDER: 'byok', LOCALAPPDATA: f.directory, OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    HARNESS_MODEL: 'synthetic', HARNESS_WIRE_MODEL: '', OPENAI_API_KEY: '', BRAVE_SEARCH_API_KEY: '' };
  const code = `
    const {defaultDataDir,loadConfig,Store}=await import(process.argv[1]);
    const config=loadConfig(undefined,{workspace:process.argv[2]});
    const store=new Store(config.dataDir);
    try {console.log(JSON.stringify({dataDir:config.dataDir,defaultDataDir:defaultDataDir(),id:store.createSession(config).id}));}
    finally {store.close();}
  `;
  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module',
    '-e', code, new URL('../src/index.ts', import.meta.url).href, f.workspace],
  { cwd: f.workspace, env, encoding: 'utf8' });
  const saved = JSON.parse(output) as { dataDir: string; defaultDataDir: string; id: string };
  const expected = path.join(f.directory, 'harness-experiment', 'native');
  expect(saved).toMatchObject({ dataDir: expected, defaultDataDir: expected });
  const cli = ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.tsx', import.meta.url))];
  const sessions = execFileSync(process.execPath, [...cli, 'sessions'], { cwd: f.workspace, env, encoding: 'utf8' });
  expect(sessions).toContain(`${saved.id}  saved`);
  const resumed = execFileSync(process.execPath, [...cli, 'resume', saved.id, '--headless'], {
    cwd: f.workspace, env, encoding: 'utf8', input: '{"id":"state","operation":"inspect"}\n{"id":"close","operation":"close"}\n',
  });
  const records = resumed.trim().split('\n').map(line => JSON.parse(line) as { id: string; result: { sessionId: string } });
  expect(records.find(record => record.id === 'state')?.result.sessionId).toBe(saved.id);
}, 90000);

it('allows a missing optional .env but surfaces an unreadable environment path', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  expect(() => loadEnvironment(path.join(f.directory, 'missing.env'))).not.toThrow();
  const directory = path.join(f.directory, 'directory.env');
  mkdirSync(directory);
  expect(() => loadEnvironment(directory)).toThrow('Could not read the environment file');
});
