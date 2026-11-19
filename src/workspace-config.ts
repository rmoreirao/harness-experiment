import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { CustomAgentConfig, MCPServerConfig } from '@github/copilot-sdk';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';
import { customAgentConfigSchema, mcpServerConfigSchema, type Config } from './config.js';
import { HarnessError, errorText } from './contracts.js';
import { within } from './files.js';

export interface WorkspaceConfiguration {
  skillDirectories: string[];
  agentDirectories: string[];
  hookDirectories: string[];
  customAgents: CustomAgentConfig[];
  mcpServers: Record<string, MCPServerConfig>;
  instructions: string;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

class WorkspaceSources {
  private readonly visited = new Map<string, number>();
  private entries = 0;
  private bytes = 0;

  constructor(private readonly config: Config) {
    if (lstatSync(config.workspace).isSymbolicLink() ||
        path.relative(config.workspace, realpathSync(config.workspace)) !== '') {
      throw new HarnessError('SCOPE', 'Workspace identity changed before configuration discovery.');
    }
  }

  private account(file: string, bytes: number): void {
    const identity = process.platform === 'win32' ? file.toLowerCase() : file;
    const previous = this.visited.get(identity);
    if (previous === undefined && ++this.entries > this.config.limits.maxFiles) {
      throw new HarnessError('CONFIG_LIMIT', 'Workspace configuration exceeds the entry limit.');
    }
    this.visited.set(identity, bytes);
    this.bytes += bytes - (previous ?? 0);
    if (this.bytes > this.config.limits.maxWorkspaceBytes) throw new HarnessError('CONFIG_LIMIT', 'Workspace configuration exceeds the aggregate byte limit.');
  }

  resolve(relative: string): string {
    if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
        /[<>:"|?*]/.test(relative) || Array.from(relative).some(character => character.charCodeAt(0) < 32) ||
        relative.split(/[/\\]/).some(part => part === '..' || /[. ]$/.test(part) && part !== '.')) {
      throw new HarnessError('SCOPE', 'Configuration roots must be relative paths inside the workspace.');
    }
    const file = path.resolve(this.config.workspace, relative.replaceAll('\\', path.sep));
    if (!within(this.config.workspace, file)) throw new HarnessError('SCOPE', 'Configuration path is outside the workspace.');
    let current = this.config.workspace;
    for (const part of path.relative(this.config.workspace, file).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory() && stat.nlink !== 1 || !within(this.config.workspace, realpathSync(current))) {
          throw new HarnessError('SCOPE', `Linked or out-of-workspace configuration path: ${relative}`);
        }
      } catch (error) {
        if (missing(error)) return file;
        throw error;
      }
    }
    return file;
  }

  files(relative: string): string[] {
    const root = this.resolve(relative);
    try {
      if (!lstatSync(root).isDirectory()) throw new HarnessError('CONFIG', `Configuration root must be a directory: ${relative}`);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const files: string[] = [];
    const walk = (directory: string, depth: number): void => {
      if (depth > 40) throw new HarnessError('CONFIG_LIMIT', 'Workspace configuration exceeds the directory depth limit.');
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relativeFile = path.relative(this.config.workspace, path.join(directory, entry.name));
        const file = this.resolve(relativeFile);
        const stat = lstatSync(file);
        this.account(file, stat.isFile() ? stat.size : 0);
        if (stat.isDirectory()) walk(file, depth + 1);
        else if (stat.isFile()) files.push(file);
        else throw new HarnessError('SCOPE', `Configuration sources must be normal files or directories: ${relativeFile}`);
      }
    };
    walk(root, 0);
    return files;
  }

  read(relative: string): string | undefined {
    const file = this.resolve(relative);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(file); }
    catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.size > this.config.limits.maxFileBytes) {
      throw new HarnessError('CONFIG_LIMIT', `Configuration source must be a bounded normal file: ${relative}`);
    }
    const bytes = readFileSync(file);
    if (bytes.length > this.config.limits.maxFileBytes || bytes.includes(0)) throw new HarnessError('CONFIG_LIMIT', `Configuration source is too large or binary: ${relative}`);
    this.account(file, bytes.length);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new HarnessError('CONFIG', `Configuration source must be UTF-8 text: ${relative}`); }
  }
}

const mcpRecords = z.record(z.string().trim().min(1).max(200), mcpServerConfigSchema);
const workspaceMcpSchema = z.object({
  mcpServers: mcpRecords.optional(),
  servers: mcpRecords.optional(),
}).strict();
const hooksSchema = z.record(z.string().min(1), z.array(z.record(z.string(), z.unknown())));

function parseAgentYaml(text: string): unknown {
  try { return load(text, { schema: JSON_SCHEMA }); }
  catch { throw new HarnessError('CONFIG', 'Agent YAML is malformed. Check its syntax without including credentials in diagnostics.'); }
}

function normalizeMcpServers(
  config: Config, sources: WorkspaceSources, servers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const resolveValue = (value: string, serverName: string): string => value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match: string, name: string) => {
    const resolved = process.env[name];
    if (!resolved) throw new HarnessError('MCP_CREDENTIAL', `Environment variable "${name}" required by MCP server "${serverName}" is missing.`);
    return resolved;
  });
  return Object.fromEntries(Object.entries(servers).map(([name, server]): [string, MCPServerConfig] => {
    if ('command' in server) {
      const resolved: MCPServerConfig = {
        ...server,
        ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, resolveValue(value, name)])) } : {}),
        ...(server.args ? { args: server.args.map(value => resolveValue(value, name)) } : {}),
      };
      if (server.workingDirectory !== undefined) {
        const relative = path.isAbsolute(server.workingDirectory)
          ? path.relative(config.workspace, server.workingDirectory) || '.'
          : server.workingDirectory;
        const workingDirectory = sources.resolve(relative);
        if (!lstatSync(workingDirectory).isDirectory()) throw new HarnessError('CONFIG', `MCP working directory must exist: ${name}`);
        resolved.workingDirectory = workingDirectory;
      }
      return [name, resolved];
    }
    return [name, { ...server, ...(server.headers ? {
      headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, resolveValue(value, name)])),
    } : {}) }];
  }));
}

function loadAgent(config: Config, sources: WorkspaceSources, file: string): CustomAgentConfig {
  const relative = path.relative(config.workspace, file);
  const text = sources.read(relative);
  if (text === undefined) throw new HarnessError('CONFIG', `Agent source disappeared: ${relative}`);
  try {
    const markdown = /\.md$/i.test(file);
    const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
    if (markdown && !match) throw new Error('Agent Markdown requires YAML frontmatter and a prompt.');
    const metadata = z.record(z.string(), z.unknown()).parse(parseAgentYaml(markdown ? match![1]! : text));
    const name = metadata.name ?? path.basename(file).replace(/(?:\.agent)?\.(?:md|ya?ml)$/i, '');
    const authoredPolicy = metadata.modelPolicy ?? metadata['model-policy'];
    if (authoredPolicy !== undefined && authoredPolicy !== 'required' && authoredPolicy !== 'preferred') {
      throw new Error('Agent modelPolicy must be required or preferred.');
    }
    const authoredTools = metadata.tools;
    const tools = typeof authoredTools === 'string'
      ? authoredTools.trim() === '*' ? null : authoredTools.split(',').map(tool => tool.trim()).filter(Boolean)
      : authoredTools;
    const agent: CustomAgentConfig = customAgentConfigSchema.parse({
      name, prompt: markdown ? match![2]!.trim() : metadata.prompt,
      ...(metadata.description !== undefined ? { description: metadata.description } : {}),
      ...(metadata.displayName !== undefined || metadata['display-name'] !== undefined ? { displayName: metadata.displayName ?? metadata['display-name'] } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(metadata.model !== undefined ? { model: metadata.model, modelPolicy: 'required' } : {}),
      ...(metadata.skills !== undefined ? { skills: metadata.skills } : {}),
      ...(metadata.reasoningEffort !== undefined || metadata['reasoning-effort'] !== undefined ? { reasoningEffort: metadata.reasoningEffort ?? metadata['reasoning-effort'] } : {}),
    });
    if (metadata.hooks !== undefined) agent.hooks = hooksSchema.parse(metadata.hooks);
    if (metadata.mcpServers !== undefined || metadata['mcp-servers'] !== undefined) {
      agent.mcpServers = normalizeMcpServers(config, sources, mcpRecords.parse(metadata.mcpServers ?? metadata['mcp-servers']));
    }
    if (metadata.infer !== undefined) agent.infer = z.boolean().parse(metadata.infer);
    if (metadata['disable-model-invocation'] !== undefined) agent.infer = !z.boolean().parse(metadata['disable-model-invocation']);
    return agent;
  } catch (error) {
    throw new HarnessError('CONFIG', `${relative}: ${errorText(error)}`);
  }
}

export function loadWorkspaceConfiguration(config: Config): WorkspaceConfiguration {
  const sources = new WorkspaceSources(config);
  const roots = (directories: string[]): string[] => [...new Set(directories.map(directory => sources.resolve(directory)))];
  const skillDirectories = roots(config.skillDirectories);
  const agentDirectories = roots(config.agentDirectories);
  const hookDirectories = roots(config.hookDirectories);
  for (const directory of [...config.skillDirectories, ...config.hookDirectories]) sources.files(directory);
  const agents = new Map<string, CustomAgentConfig>();
  const seenAgentFiles = new Set<string>();
  for (const directory of config.agentDirectories) {
    for (const file of sources.files(directory)) {
      if (!/\.(?:md|agent\.ya?ml)$/i.test(file) || seenAgentFiles.has(file)) continue;
      seenAgentFiles.add(file);
      const agent = loadAgent(config, sources, file);
      if (agents.has(agent.name)) throw new HarnessError('CONFIG', `Duplicate workspace agent name "${agent.name}".`);
      agents.set(agent.name, agent);
    }
  }
  for (const agent of config.agents) agents.set(agent.name, { ...agent });
  const identities = new Set([config.model.canonical, ...config.models.map(model => model.id)]);
  for (const agent of agents.values()) {
    if (agent.model && !identities.has(agent.model)) throw new HarnessError('CONFIG', `Unknown model "${agent.model}" for agent "${agent.name}". Declare it in models for this provider.`);
    if (agent.model) agent.modelPolicy = 'required';
  }
  const mcpText = sources.read(path.join('.github', 'mcp.json'));
  let workspaceServers: Record<string, MCPServerConfig> = {};
  if (mcpText !== undefined) {
    let mcpValue: unknown;
    try { mcpValue = JSON.parse(mcpText); }
    catch { throw new HarnessError('CONFIG', `.github${path.sep}mcp.json must contain valid JSON.`); }
    try {
      const parsed = workspaceMcpSchema.parse(mcpValue);
      const duplicate = Object.keys(parsed.mcpServers ?? {}).find(name => Object.hasOwn(parsed.servers ?? {}, name));
      if (duplicate) throw new Error(`Duplicate MCP server "${duplicate}" in mcpServers and servers.`);
      workspaceServers = { ...parsed.servers, ...parsed.mcpServers };
    } catch (error) { throw new HarnessError('CONFIG', `.github${path.sep}mcp.json: ${errorText(error)}`); }
  }
  const instructions: string[] = [];
  for (const relative of ['AGENTS.md', 'CLAUDE.md', path.join('.github', 'copilot-instructions.md')]) {
    const text = sources.read(relative);
    if (text?.trim()) instructions.push(`Repository instruction source (${relative}):\n${text.trim()}`);
  }
  return {
    skillDirectories, agentDirectories, hookDirectories,
    customAgents: [...agents.values()],
    mcpServers: normalizeMcpServers(config, sources, { ...workspaceServers, ...config.mcpServers }),
    instructions: instructions.join('\n\n'),
  };
}
