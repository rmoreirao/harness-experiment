import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';

describe('V2 live news verification authority', () => {
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
