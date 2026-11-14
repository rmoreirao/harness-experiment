import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';
import { loadEnvironment } from '../src/config.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

it('loads .env into model configuration without persisting the API key', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  writeFileSync(path.join(f.root, '.env'), [
    'OPENAI_BASE_URL=https://example.invalid/v1',
    'HARNESS_MODEL=synthetic-model',
    'OPENAI_API_KEY=synthetic-env-key',
  ].join('\n'));
  const env = { ...process.env };
  for (const key of ['OPENAI_BASE_URL', 'HARNESS_MODEL', 'OPENAI_API_KEY']) delete env[key];
  const configModule = new URL('../src/config.ts', import.meta.url).href;
  const code = `
    const {loadEnvironment,loadConfig}=await import(process.argv[1]);
    loadEnvironment();
    const config=loadConfig(undefined,{workspace:process.argv[2],dataDir:process.argv[3]});
    console.log(JSON.stringify({
      model:config.model,baseURL:config.baseURL,
      keyLoaded:process.env.OPENAI_API_KEY==='synthetic-env-key',
      secretInConfiguration:JSON.stringify(config).includes('synthetic-env-key')
    }));
  `;
  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module',
    '-e', code, configModule, f.config.workspace, f.config.dataDir],
  { cwd: f.root, env, encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({
    model: 'synthetic-model', baseURL: 'https://example.invalid/v1',
    keyLoaded: true, secretInConfiguration: false,
  });
  const cli = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), '--workspace', f.config.workspace],
  { cwd: f.root, env, encoding: 'utf8' });
  expect(cli.status).toBe(1);
  expect(cli.stderr).toContain('attached TTY');
  expect(cli.stderr).not.toContain('synthetic-env-key');
});

it('keeps existing process settings ahead of .env', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const file = path.join(f.root, '.env');
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

it('allows a missing optional .env but surfaces an unreadable environment path', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  expect(() => loadEnvironment(path.join(f.root, 'missing.env'))).not.toThrow();
  const directory = path.join(f.root, 'directory.env');
  mkdirSync(directory);
  expect(() => loadEnvironment(directory)).toThrow('Could not read the environment file');
});
