import { existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSecretEnvironmentNames, parseConfig } from '../src/config.js';
import { loadWorkspaceConfiguration } from '../src/workspace-config.js';
import { fixture, skillFile } from './helpers.js';

function source(workspace: string, name: string, text: string | Buffer): string {
  const file = path.join(workspace, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

afterEach(() => vi.unstubAllEnvs());

describe('Trusted workspace extension sources', () => {
  it('resolves configured MCP secret references only in ephemeral SDK configuration', () => {
    vi.stubEnv('FIXTURE_MCP_HEADER', 'SYNTHETIC_HEADER_SECRET');
    vi.stubEnv('FIXTURE_MCP_ENV', 'SYNTHETIC_ENV_SECRET');
    vi.stubEnv('FIXTURE_MCP_ARG', 'SYNTHETIC_ARG_SECRET');
    const f = fixture({ mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.invalid/tools',
        headers: { authorization: '${env:FIXTURE_MCP_HEADER}' } },
      local: { type: 'stdio', command: 'node', args: ['--token', '${env:FIXTURE_MCP_ARG}'],
        env: { SERVICE_TOKEN: '${env:FIXTURE_MCP_ENV}' } },
    } });
    try {
      const before = JSON.stringify(f.config);
      expect(configSecretEnvironmentNames(f.config).sort()).toEqual([
        'BRAVE_SEARCH_API_KEY', 'FIXTURE_MCP_ARG', 'FIXTURE_MCP_ENV', 'FIXTURE_MCP_HEADER', 'OPENAI_API_KEY',
      ].sort());
      expect(loadWorkspaceConfiguration(f.config).mcpServers).toEqual({
        remote: { type: 'http', url: 'https://mcp.example.invalid/tools', headers: { authorization: 'SYNTHETIC_HEADER_SECRET' } },
        local: { type: 'stdio', command: 'node', args: ['--token', 'SYNTHETIC_ARG_SECRET'],
          env: { SERVICE_TOKEN: 'SYNTHETIC_ENV_SECRET' } },
      });
      expect(JSON.stringify(f.config)).toBe(before);
      expect(before).not.toContain('SYNTHETIC_');
      expect(before).toContain('${env:FIXTURE_MCP_HEADER}');
    } finally { f.cleanup(); }
  });

  it('rejects literal MCP credentials in persisted configuration instead of storing them', () => {
    const f = fixture();
    try {
      for (const server of [
        { type: 'http', url: 'https://mcp.example.invalid', headers: { authorization: 'SYNTHETIC_LITERAL_SECRET' } },
        { command: 'node', env: { API_KEY: 'SYNTHETIC_LITERAL_SECRET' } },
        { command: 'node', args: ['--token', 'SYNTHETIC_LITERAL_SECRET'] },
      ]) expect(() => parseConfig({ ...f.config, mcpServers: { fixture: server } })).toThrow();
    } finally { f.cleanup(); }
  });

  it('discovers workspace instructions skills agents hooks and MCP without personal sources', () => {
    const f = fixture();
    try {
      vi.stubEnv('HOME', path.join(f.directory, 'personal'));
      vi.stubEnv('USERPROFILE', path.join(f.directory, 'personal'));
      for (const root of [f.directory, path.join(f.directory, 'personal')]) {
        source(root, 'AGENTS.md', 'PERSONAL_INSTRUCTION_DECOY');
        source(root, '.github/agents/decoy.agent.md', '---\nname: personal-decoy\n---\nPERSONAL_AGENT_DECOY');
        source(root, '.github/hooks/decoy.json', '{"hooks": {"sessionStart": [{"command": "PERSONAL_HOOK_DECOY"}]}}');
        source(root, '.github/mcp.json', '{"mcpServers":{"personal-decoy":{"command":"PERSONAL_MCP_DECOY"}}}');
        skillFile(root, 'personal-decoy', 'PERSONAL_SKILL_DECOY');
      }
      source(f.workspace, 'AGENTS.md', 'WORKSPACE_AGENTS_INSTRUCTIONS');
      source(f.workspace, 'CLAUDE.md', 'WORKSPACE_CLAUDE_INSTRUCTIONS');
      source(f.workspace, '.github/copilot-instructions.md', 'WORKSPACE_COPILOT_INSTRUCTIONS');
      source(f.workspace, '.github/agents/writer.agent.md', '---\nname: writer\ntools: "*"\n---\nWrite the assigned file.');
      source(f.workspace, '.github/hooks/start.json', '{"hooks": {"sessionStart": [{"command": "WORKSPACE_HOOK"}]}}');
      source(f.workspace, '.github/mcp.json', '{"servers":{"workspace-server":{"command":"WORKSPACE_MCP"}}}');
      skillFile(f.workspace, 'workspace-skill', 'WORKSPACE_SKILL');
      const loaded = loadWorkspaceConfiguration(f.config);
      expect(loaded.skillDirectories).toEqual([path.join(f.workspace, '.github', 'skills')]);
      expect(loaded.agentDirectories).toEqual([path.join(f.workspace, '.github', 'agents')]);
      expect(loaded.hookDirectories).toEqual([path.join(f.workspace, '.github', 'hooks')]);
      expect(loaded.customAgents).toEqual([{ name: 'writer', prompt: 'Write the assigned file.', tools: null }]);
      expect(loaded.mcpServers).toEqual({ 'workspace-server': { command: 'WORKSPACE_MCP' } });
      for (const marker of ['WORKSPACE_AGENTS_INSTRUCTIONS', 'WORKSPACE_CLAUDE_INSTRUCTIONS', 'WORKSPACE_COPILOT_INSTRUCTIONS']) {
        expect(loaded.instructions).toContain(marker);
      }
      expect(JSON.stringify(loaded)).not.toContain('PERSONAL_');
      expect(JSON.stringify(loaded)).not.toContain('personal-decoy');
    } finally { f.cleanup(); }
  });

  it('reads configuration without executing hooks or starting MCP commands', () => {
    const f = fixture();
    try {
      const marker = path.join(f.workspace, 'MUST_NOT_EXIST');
      source(f.workspace, '.github/hooks/start.json',
        JSON.stringify({ hooks: { sessionStart: [{ command: 'node', args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)},"executed")`] }] } }));
      source(f.workspace, '.github/mcp.json', JSON.stringify({ mcpServers: {
        fixture: { command: 'node', args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)},"executed")`] },
      } }));
      expect(loadWorkspaceConfiguration(f.config).mcpServers.fixture).toMatchObject({ command: 'node' });
      expect(existsSync(marker)).toBe(false);
    } finally { f.cleanup(); }
  });

  it('allows missing default extension roots without broadening discovery', () => {
    const f = fixture();
    try {
      expect(loadWorkspaceConfiguration(f.config)).toEqual({
        skillDirectories: [path.join(f.workspace, '.github', 'skills')],
        agentDirectories: [path.join(f.workspace, '.github', 'agents')],
        hookDirectories: [path.join(f.workspace, '.github', 'hooks')],
        customAgents: [], mcpServers: {}, instructions: '',
      });
    } finally { f.cleanup(); }
  });

  it.each(['../outside', '..\\outside', 'C:\\personal\\skills', '/outside'])(
    'rejects extension roots outside the trusted workspace labeled %s', invalid => {
      const f = fixture();
      try {
        for (const key of ['skillDirectories', 'agentDirectories', 'hookDirectories']) {
          expect(() => parseConfig({ ...f.config, [key]: [invalid] }), key).toThrow('relative paths inside the workspace');
        }
      } finally { f.cleanup(); }
    },
  );

  it.each(['skills', 'agents', 'hooks'])('rejects a junction anywhere under workspace %s assets', directory => {
    const f = fixture();
    try {
      const root = path.join(f.workspace, '.github', directory, 'workflow', 'assets');
      mkdirSync(root, { recursive: true });
      const external = path.join(f.directory, 'external');
      mkdirSync(external);
      source(external, 'payload.ps1', 'throw "External payload must not execute."');
      symlinkSync(external, path.join(root, 'linked-assets'), 'junction');
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('Linked or out-of-workspace configuration path');
    } finally { f.cleanup(); }
  });

  it('rejects hard-linked workspace instructions without reading their content', () => {
    const f = fixture();
    try {
      const file = source(f.directory, 'external.md', 'EXTERNAL_HARD_LINK_CONTENT');
      linkSync(file, path.join(f.workspace, 'AGENTS.md'));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('Linked or out-of-workspace configuration path');
    } finally { f.cleanup(); }
  });

  it('normalizes workspace agent overrides and gives explicit agents precedence', () => {
    const f = fixture({ models: [{ id: 'worker-model', wire: 'worker-wire' }],
      agents: [{ name: 'writer', prompt: 'Configured prompt.', model: 'worker-model', tools: ['powershell'] }],
    });
    try {
      source(f.workspace, '.github/agents/writer.agent.md', '---\nname: writer\n---\nWorkspace prompt.');
      source(f.workspace, '.github/agents/reviewer.agent.yaml', [
        'name: reviewer', 'prompt: Review the assignment.', 'model: worker-model',
        'model-policy: preferred', 'tools: read_file, powershell', 'reasoning-effort: high',
      ].join('\n'));
      expect(loadWorkspaceConfiguration(f.config).customAgents).toEqual([
        { name: 'reviewer', prompt: 'Review the assignment.', model: 'worker-model',
          modelPolicy: 'required', tools: ['read_file', 'powershell'], reasoningEffort: 'high' },
        { name: 'writer', prompt: 'Configured prompt.', model: 'worker-model',
          modelPolicy: 'required', tools: ['powershell'] },
      ]);
    } finally { f.cleanup(); }
  });

  it('rejects unknown workspace agent models rather than silently falling back', () => {
    const f = fixture();
    try {
      source(f.workspace, '.github/agents/writer.agent.md', '---\nname: writer\nmodel: missing-model\n---\nWrite.');
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('Unknown model "missing-model"');
    } finally { f.cleanup(); }
  });

  it('rejects duplicate workspace agent identities rather than arbitrarily selecting one', () => {
    const f = fixture();
    try {
      for (const name of ['one', 'two']) {
        source(f.workspace, `.github/agents/${name}.agent.md`, '---\nname: duplicate\n---\nWrite.');
      }
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('Duplicate workspace agent name "duplicate"');
    } finally { f.cleanup(); }
  });

  it('merges configured MCP transports with explicit configuration taking precedence', () => {
    const f = fixture({ mcpServers: {
      shared: { type: 'sse', url: 'https://configured.example.invalid/events' },
      local: { type: 'stdio', command: 'node', args: ['fixture.js'], workingDirectory: '.' },
    } });
    try {
      source(f.workspace, '.github/mcp.json', JSON.stringify({ mcpServers: {
        shared: { type: 'http', url: 'https://workspace.example.invalid/mcp' },
        other: { type: 'http', url: 'https://other.example.invalid/mcp' },
      } }));
      expect(loadWorkspaceConfiguration(f.config).mcpServers).toEqual({
        shared: { type: 'sse', url: 'https://configured.example.invalid/events' },
        other: { type: 'http', url: 'https://other.example.invalid/mcp' },
        local: { type: 'stdio', command: 'node', args: ['fixture.js'], workingDirectory: f.workspace },
      });
    } finally { f.cleanup(); }
  });

  it('rejects conflicting MCP source identities and outside command working directories', () => {
    const f = fixture();
    try {
      source(f.workspace, '.github/mcp.json', JSON.stringify({
        mcpServers: { duplicate: { command: 'one' } }, servers: { duplicate: { command: 'two' } },
      }));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('Duplicate MCP server "duplicate"');
      source(f.workspace, '.github/mcp.json',
        JSON.stringify({ servers: { outside: { command: 'node', workingDirectory: '../outside' } } }));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('relative paths inside the workspace');
    } finally { f.cleanup(); }
  });

  it('enforces exact instruction byte boundaries and rejects invalid text', () => {
    const f = fixture({ limits: { maxFileBytes: 128 } });
    try {
      source(f.workspace, 'AGENTS.md', 'x'.repeat(128));
      expect(loadWorkspaceConfiguration(f.config).instructions).toContain('x'.repeat(128));
      source(f.workspace, 'AGENTS.md', 'x'.repeat(129));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('bounded normal file');
      source(f.workspace, 'AGENTS.md', Buffer.from([0xff, 0xfe]));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('UTF-8');
      source(f.workspace, 'AGENTS.md', Buffer.from([65, 0, 66]));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('binary');
    } finally { f.cleanup(); }
  });

  it('counts nested extension assets against entry and aggregate byte limits', () => {
    const f = fixture({ limits: { maxFiles: 2, maxWorkspaceBytes: 1024 } });
    try {
      source(f.workspace, '.github/skills/workflow/first.txt', 'x'.repeat(1024));
      expect(loadWorkspaceConfiguration(f.config).customAgents).toEqual([]);
      source(f.workspace, '.github/skills/workflow/first.txt', 'x'.repeat(1025));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('aggregate byte limit');
      source(f.workspace, '.github/skills/workflow/first.txt', 'x');
      source(f.workspace, '.github/skills/workflow/second.txt', 'x');
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('entry limit');
    } finally { f.cleanup(); }
  });
});
