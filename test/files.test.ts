import { afterEach, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/storage.js';
import { FileTools } from '../src/files.js';
import { fixture } from './helpers.js';
import { terminalText, Redactor } from '../src/privacy.js';
import { parseConfig } from '../src/config.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
it('rejects escapes, credential paths, NTFS streams, junctions, reserved names and unsupported formats', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const store = new Store(f.config.dataDir);
  try {
    const files = new FileTools(f.config, store, store.createSession(f.config));
    for (const name of ['..\\secret.md', '.env', 'notes.md:secret', 'NUL.md', '\\\\localhost\\share\\secret.md', 'notes.md.']) {
      expect(() => files.resolve(name)).toThrow();
    }
    mkdirSync(path.join(f.root, 'outside'));
    symlinkSync(path.join(f.root, 'outside'), path.join(f.config.workspace, 'linked'), 'junction');
    expect(() => files.resolve('linked\\secret.md', true)).toThrow();
    writeFileSync(path.join(f.config.workspace, 'binary.bin'), 'unsupported');
    expect(() => files.read(['binary.bin'])).toThrow('Only UTF-8');
  } finally { store.close(); }
});
it('requires approved-read snapshots for overwrite and detects stale writes', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const store = new Store(f.config.dataDir);
  try {
    const files = new FileTools(f.config, store, store.createSession(f.config));
    expect(() => files.write('run', 'notes.md', 'replacement', 'arbitrary')).toThrow('approved read');
    const doc = files.read(['notes.md']).documents[0]!;
    writeFileSync(path.join(f.config.workspace, 'notes.md'), 'external edit');
    expect(() => files.write('run', 'notes.md', 'replacement', doc.hash)).toThrow('changed');
    expect(readFileSync(path.join(f.config.workspace, 'notes.md'), 'utf8')).toBe('external edit');
    expect(() => files.write('run', 'notes.md', 'replacement', 'new')).toThrow();
  } finally { store.close(); }
});
it('enforces bounded document reads and rejects invalid UTF-8', () => {
  const f = fixture({ limits: { maxFileBytes: 32 } }); cleanup.push(f.cleanup);
  const store = new Store(f.config.dataDir);
  try {
    const files = new FileTools(f.config, store, store.createSession(f.config));
    expect(() => files.read(['notes.md'])).toThrow('maxFileBytes');
    writeFileSync(path.join(f.config.workspace, 'invalid.md'), Buffer.from([255, 254, 0]));
    expect(() => files.read(['invalid.md'])).toThrow();
  } finally { store.close(); }
});
it('strips terminal control payloads and redacts explicit credentials recursively', () => {
  expect(terminalText('\x1b]52;c;malicious\x07\x1b[31mhello\x1b[0m')).toBe('hello');
  const r = new Redactor(['specific-secret']);
  expect(r.value({ apiKey: 'key', text: 'specific-secret', nested: ['Bearer token'] })).toEqual({
    apiKey: '[REDACTED]', text: '[REDACTED]', nested: ['[REDACTED]'],
  });
});
it('validates endpoint safety and disallows MCP authentication and execution tools', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  expect(() => parseConfig({ ...f.config, mode: 'openai', baseURL: 'http://example.com/v1', model: 'test' })).toThrow('HTTPS');
  expect(() => parseConfig({ ...f.config, mode: 'openai', baseURL: 'https://key:password@example.com/v1', model: 'test' })).toThrow('credentials');
  expect(() => parseConfig({ ...f.config, mode: 'openai', baseURL: 'https://example.invalid/openai/v1/responses', model: 'test' })).toThrow('Remove the trailing /responses');
  expect(() => parseConfig({ ...f.config, limits: { maxCost: 1 } })).toThrow('pricing');
  expect(() => parseConfig({ ...f.config, mcp: [{ name: 'danger', transport: 'http', url: 'http://127.0.0.1:1', trusted: true, tools: ['shell_exec'] }] })).toThrow('execution');
  expect(() => parseConfig({ ...f.config, mcp: [{ name: 'a', transport: 'http', url: 'http://127.0.0.1:1', trusted: true, tools: ['read'], apiKey: 'not allowed' }] })).toThrow();
  expect(() => parseConfig({ ...f.config, workspace: path.join(f.root, 'does-not-exist') })).toThrow('Use --workspace with an existing folder');
  expect(() => parseConfig({ ...f.config, workspace: path.join(f.config.workspace, 'notes.md') })).toThrow('not a file');
});
