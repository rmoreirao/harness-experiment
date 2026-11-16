import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';

describe('Live news verification authority', () => {
  it.each([
    { version: 2 },
    { version: 3, limits: { maxTokens: 100000 } },
    { version: 3, model: { baseURL: 'http://127.0.0.1:9/v1', canonical: 'synthetic', wire: 'synthetic', outputTokens: 2048 } },
  ])('does not silently remove explicit product policies to produce a default-mode verification: %j', overrides => {
    const f = fixture(overrides);
    const config = path.join(f.directory, 'config.json'); writeFileSync(config, JSON.stringify(f.config));
    const output = path.join(f.directory, 'verification');
    try {
      expect(() => execFileSync(process.execPath, [
        '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./news-live-check.ts', import.meta.url)),
        '--allow-spending', '--max-tokens', '100000', '--config', config, '--output-dir', output,
      ], { cwd: f.workspace, timeout: 20000, stdio: 'pipe',
        env: { ...process.env, OPENAI_API_KEY: 'synthetic-not-a-live-key', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', HARNESS_MODEL: 'synthetic' },
      })).toThrow('Default-mode news verification requires');
      expect(existsSync(output)).toBe(false);
    } finally { f.cleanup(); }
  });
  it.each([
    ['--max-tokens', '100000'],
    ['--allow-spending', '--max-tokens', '100001'],
  ])('does not start model work without explicit bounded opt-in: %j', (...args) => {
    const f = fixture();
    try {
      expect(() => execFileSync(process.execPath, [
        '--import', import.meta.resolve('tsx'),
        fileURLToPath(new URL('./news-live-check.ts', import.meta.url)),
        ...args, '--output-dir', path.join(f.directory, 'verification'),
      ], { cwd: f.workspace, timeout: 20000, stdio: 'pipe',
        env: { ...process.env, OPENAI_API_KEY: 'synthetic-not-a-live-key', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', HARNESS_MODEL: 'synthetic' },
      })).toThrow();
    } finally { f.cleanup(); }
  });
});
