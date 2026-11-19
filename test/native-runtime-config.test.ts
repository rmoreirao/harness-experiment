import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWorkspaceOnlyRuntimeConfiguration } from '../src/native-runtime-config.js';
import { fixture } from './helpers.js';

describe('Native SDK private configuration preflight', () => {
  it('accepts absent and empty SDK MCP state without rewriting it', () => {
    const f = fixture();
    const file = path.join(f.directory, 'mcp-config.json');
    try {
      expect(() => assertWorkspaceOnlyRuntimeConfiguration(f.directory, 128)).not.toThrow();
      for (const text of ['{}', '{"mcpServers":{}}']) {
        writeFileSync(file, text);
        expect(() => assertWorkspaceOnlyRuntimeConfiguration(f.directory, 128)).not.toThrow();
        expect(readFileSync(file, 'utf8')).toBe(text);
      }
    } finally { f.cleanup(); }
  });

  it.each([
    { label: 'array', text: '[]' },
    { label: 'null', text: 'null' },
    { label: 'non-record MCP servers', text: '{"mcpServers":[]}' },
    { label: 'unknown configuration fields', text: '{"mcpServers":{},"personal":true}' },
    { label: 'executable MCP declarations', text: '{"mcpServers":{"ambient":{"command":"MUST_NOT_EXECUTE"}}}' },
    { label: 'malformed JSON', text: '{"secret":"SYNTHETIC_PRIVATE_PAYLOAD"' },
  ])('rejects $label without changing the source or exposing its content', ({ text }) => {
    const f = fixture();
    const file = path.join(f.directory, 'mcp-config.json');
    writeFileSync(file, text);
    try {
      let failure: unknown;
      try { assertWorkspaceOnlyRuntimeConfiguration(f.directory, 1024); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'RUNTIME_CONFIGURATION' });
      expect((failure as Error).message).toContain('trusted workspace');
      expect((failure as Error).message).not.toContain('SYNTHETIC_PRIVATE_PAYLOAD');
      expect(readFileSync(file, 'utf8')).toBe(text);
    } finally { f.cleanup(); }
  });

  it('enforces the exact private configuration byte limit before parsing', () => {
    const f = fixture();
    const file = path.join(f.directory, 'mcp-config.json');
    try {
      writeFileSync(file, '{}' + ' '.repeat(126));
      expect(() => assertWorkspaceOnlyRuntimeConfiguration(f.directory, 128)).not.toThrow();
      writeFileSync(file, '{}' + ' '.repeat(127));
      expect(() => assertWorkspaceOnlyRuntimeConfiguration(f.directory, 128)).toThrow('file was not changed');
      expect(readFileSync(file).length).toBe(129);
    } finally { f.cleanup(); }
  });

  it('refuses linked private configuration without following or deleting it', () => {
    const f = fixture();
    const target = path.join(f.directory, 'external-state'); mkdirSync(target);
    writeFileSync(path.join(target, 'marker'), 'EXTERNAL_STATE_UNCHANGED');
    const file = path.join(f.workspace, 'mcp-config.json');
    symlinkSync(target, file, 'junction');
    try {
      expect(() => assertWorkspaceOnlyRuntimeConfiguration(f.workspace, 1024)).toThrow('file was not changed');
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(target, 'marker'), 'utf8')).toBe('EXTERNAL_STATE_UNCHANGED');
    } finally { f.cleanup(); }
  });
});
