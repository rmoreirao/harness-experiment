import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';

describe('Live news verification authority', () => {
  it.each([
    { label: 'token budget', overrides: { version: 4, limits: { maxTokens: 100000 } } },
    { label: 'currency budget', overrides: { version: 4, limits: { maxCost: 1, inputPerMillion: 1, outputPerMillion: 2 } } },
    { label: 'output override', overrides: { version: 4, model: { canonical: 'synthetic', wire: 'synthetic', outputTokens: 2048 } } },
  ])('does not silently remove explicit $label for default-mode verification', ({ overrides }) => {
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
