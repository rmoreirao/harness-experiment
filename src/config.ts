import path from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import type { CustomAgentConfig, MCPServerConfig } from '@github/copilot-sdk';
import { HarnessError } from './contracts.js';
import { within } from './files.js';

export const SDK_VERSION = '1.0.34';
export const RUNTIME_VERSION = '1.0.112';
export const DEFAULT_SKILLS_DIRECTORY = path.join('.github', 'skills');
const modelId = z.string().trim().min(1).max(200);
const optionalTokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const origin = z.string().url().transform(value => {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password) throw new HarnessError('CONFIG', 'Use exact origins without paths or credentials.');
  return value;
});
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash && !/\/responses\/?$/.test(url.pathname) &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname));
}, 'Use an HTTPS API base (HTTP only on loopback), without credentials, query, fragment or /responses.');
const workspaceDirectory = z.string().trim().min(1).max(1000).refine(value =>
  !path.isAbsolute(value) && !path.win32.isAbsolute(value) &&
  !/[<>:"|?*]/.test(value) && !Array.from(value).some(character => character.charCodeAt(0) < 32) &&
  !value.split(/[/\\]/).includes('..'),
'Extension directories must be relative paths inside the workspace, without parent traversal.');
const stringRecord = z.record(z.string().min(1), z.string());
const mcpBase = {
  tools: z.array(z.string().min(1)).optional(),
  timeout: z.number().int().positive().optional(),
};
export const mcpServerConfigSchema = z.union([
  z.object({
    ...mcpBase,
    type: z.enum(['stdio', 'local']).optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
    workingDirectory: z.string().min(1).optional(),
  }).strict(),
  z.object({
    ...mcpBase,
    type: z.enum(['http', 'sse']),
    url: z.string().url().refine(value => {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
    }, 'MCP URLs must use HTTP or HTTPS without embedded credentials or fragments.'),
    headers: stringRecord.optional(),
  }).strict(),
]) satisfies z.ZodType<MCPServerConfig>;
const environmentReference = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const persistedMcpServerConfigSchema = mcpServerConfigSchema.superRefine((server, context) => {
  const credentials = 'command' in server ? server.env : server.headers;
  for (const [name, value] of Object.entries(credentials ?? {})) {
    if (!environmentReference.test(value)) {
      context.addIssue({ code: 'custom', message: `MCP ${'command' in server ? 'env' : 'headers'} values must use \${env:VARIABLE} references, not persisted literals.`,
        path: ['command' in server ? 'env' : 'headers', name] });
    }
  }
  if ('url' in server && new URL(server.url).search) {
    context.addIssue({ code: 'custom', message: 'Persisted MCP URLs cannot contain query parameters. Use environment-referenced headers or native MCP authentication.', path: ['url'] });
  }
  if ('command' in server) {
    for (const [index, argument] of (server.args ?? []).entries()) {
      const option = /^(--?[^=]+)(?:=(.*))?$/.exec(argument);
      if (option && /(?:api[-_]?key|token|secret|password|credential|authorization|auth[-_]?header|header)$/i.test(option[1]!)) {
        const value = option[2] ?? server.args?.[index + 1];
        if (value !== undefined && !environmentReference.test(value)) {
          context.addIssue({ code: 'custom', message: 'MCP credential arguments must use ${env:VARIABLE} references, not persisted literals.', path: ['args', index] });
        }
      }
    }
  }
});
export const customAgentConfigSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1),
  description: z.string().optional(),
  displayName: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).nullable().optional(),
  model: modelId.optional(),
  modelPolicy: z.literal('required').optional(),
  skills: z.array(z.string().min(1)).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
}).strict().transform(agent => agent.model ? { ...agent, modelPolicy: 'required' as const } : agent) satisfies z.ZodType<CustomAgentConfig>;
export const sessionConfigSchema = z.object({
  version: z.literal(4, { error: 'Only native configuration version 4 is supported. Versions 2 and 3 cannot be migrated or resumed.' }),
  workspace: z.string().min(1),
  dataDir: z.string().min(1),
  provider: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('copilot') }).strict(),
    z.object({
      kind: z.literal('byok'),
      baseURL: endpoint,
      apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('OPENAI_API_KEY'),
    }).strict(),
  ]).prefault({ kind: 'copilot' }),
  model: z.object({
    canonical: modelId,
    wire: modelId.optional(),
    contextTokens: optionalTokenLimit,
    outputTokens: optionalTokenLimit,
  }).strict().transform(model => ({ ...model, wire: model.wire ?? model.canonical })),
  models: z.array(z.object({
    id: modelId,
    wire: modelId,
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional(),
  }).strict()).max(100).default([]),
  agents: z.array(customAgentConfigSchema).max(100).default([]),
  permissionMode: z.enum(['manual', 'assisted', 'allow-all']).default('allow-all'),
  taskMode: z.enum(['interactive', 'plan', 'autopilot']).default('interactive'),
  skillDirectories: z.array(workspaceDirectory).max(50).default([DEFAULT_SKILLS_DIRECTORY]),
  agentDirectories: z.array(workspaceDirectory).max(50).default([path.join('.github', 'agents')]),
  hookDirectories: z.array(workspaceDirectory).max(50).default([path.join('.github', 'hooks')]),
  mcpServers: z.record(z.string().trim().min(1).max(200), persistedMcpServerConfigSchema).default({}),
  network: z.object({
    origins: z.array(z.union([z.literal('*'), origin])).max(100).default(['*']),
    localFixtureOrigins: z.array(origin).max(20).default([]),
    maxBytes: z.number().int().min(1024).max(10485760).default(5242880),
    timeoutMs: z.number().int().min(100).max(120000).default(15000),
    redirects: z.number().int().min(0).max(10).default(3),
  }).strict().prefault({}),
  search: z.object({
    provider: z.literal('brave'),
    costPerRequest: z.number().nonnegative().optional(),
  }).strict().optional(),
  execution: z.object({
    provider: z.literal('docker'),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    memoryMb: z.number().int().min(64).max(8192).default(512),
    cpus: z.number().min(0.1).max(4).default(1),
  }).strict().optional(),
  browser: z.object({
    executablePath: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
    javaScript: z.literal(false).default(false),
  }).strict().optional(),
  limits: z.object({
    maxTokens: optionalTokenLimit,
    maxRequests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
    maxActions: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1000),
    maxReplans: z.number().int().min(0).max(20).default(2),
    timeoutMs: z.number().int().min(100).max(86400000).default(3600000),
    toolTimeoutMs: z.number().int().min(100).max(86400000).default(300000),
    concurrency: z.number().int().min(1).max(64).default(4),
    modelConcurrency: z.number().int().min(1).max(64).default(4),
    workerConcurrency: z.number().int().min(1).max(64).default(4),
    maxFileBytes: z.number().int().min(128).max(10485760).default(1048576),
    maxOutputBytes: z.number().int().min(128).max(10485760).default(1048576),
    maxResultBytes: z.number().int().min(1024).max(104857600).default(20971520),
    maxWorkspaceBytes: z.number().int().min(1024).max(1073741824).default(52428800),
    maxFiles: z.number().int().min(1).max(50000).default(5000),
    maxCost: z.number().positive().optional(),
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional(),
  }).strict().prefault({}),
}).strict().superRefine((config, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (config.model.outputTokens !== undefined && config.model.contextTokens !== undefined &&
      config.model.outputTokens >= config.model.contextTokens) issue('Output limit must be smaller than context limit.');
  if ((config.limits.inputPerMillion === undefined) !== (config.limits.outputPerMillion === undefined) ||
      config.limits.maxCost !== undefined && config.limits.inputPerMillion === undefined) {
    issue('Currency accounting requires both input and output prices.');
  }
  if (new Set(config.models.map(model => model.id)).size !== config.models.length) issue('Duplicate worker model identifier.');
  if (new Set(config.agents.map(agent => agent.name)).size !== config.agents.length) issue('Duplicate custom agent name.');
  for (const model of config.models) {
    if ((model.inputPerMillion === undefined) !== (model.outputPerMillion === undefined)) issue(`Model "${model.id}" requires both input and output prices.`);
    if (model.id === config.model.canonical && model.wire !== config.model.wire) issue('The parent model must have one unambiguous wire identifier.');
    if (config.limits.maxCost !== undefined && model.id !== config.model.canonical && model.inputPerMillion === undefined) {
      issue(`Cost budgets require prices for allowed worker model "${model.id}".`);
    }
  }
  const identities = new Set([config.model.canonical, ...config.models.map(model => model.id)]);
  for (const agent of config.agents) {
    if (agent.model && !identities.has(agent.model)) issue(`Unknown model "${agent.model}" for agent "${agent.name}". Declare it in models for this provider.`);
  }
  if (config.provider.kind === 'copilot' && (config.limits.maxTokens !== undefined || config.limits.maxCost !== undefined ||
      config.limits.inputPerMillion !== undefined || config.limits.outputPerMillion !== undefined ||
      config.models.some(model => model.inputPerMillion !== undefined || model.outputPerMillion !== undefined))) {
    issue('Copilot token/cost hard budgets and BYOK token prices are unsupported. Remove them or explicitly select BYOK.');
  }
});
export type Config = z.infer<typeof sessionConfigSchema>;

export function configSecretEnvironmentNames(config: Config): string[] {
  const names = new Set<string>(['BRAVE_SEARCH_API_KEY']);
  if (config.provider.kind === 'byok') names.add(config.provider.apiKeyEnv);
  for (const server of Object.values(config.mcpServers)) {
    const values = 'command' in server
      ? [...Object.values(server.env ?? {}), ...server.args ?? []]
      : Object.values(server.headers ?? {});
    for (const value of values) {
      for (const match of value.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]!);
    }
  }
  return [...names];
}

export function allowsHttpsOrigin(origins: readonly string[], value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value &&
    (origins.includes('*') || origins.includes(value));
}

export function parseConfig(value: unknown): Config {
  const config = sessionConfigSchema.parse(value);
  config.workspace = realpathSync(path.resolve(config.workspace));
  if (!lstatSync(config.workspace).isDirectory()) throw new HarnessError('CONFIG', 'Workspace must be an existing directory.');
  config.dataDir = path.resolve(config.dataDir);
  if (within(config.workspace, config.dataDir)) throw new HarnessError('CONFIG', 'Application data must be outside the workspace.');
  for (const value of config.network.localFixtureOrigins) {
    const url = new URL(value);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new HarnessError('CONFIG', 'Local fixtures require literal loopback origins.');
  }
  if (config.network.origins.some(value => value !== '*' && new URL(value).protocol !== 'https:')) throw new HarnessError('CONFIG', 'Public origins require HTTPS.');
  if (config.search && !allowsHttpsOrigin(config.network.origins, 'https://api.search.brave.com')) {
    throw new HarnessError('CONFIG', 'Brave search requires an allowed HTTPS network origin.');
  }
  if (config.browser) config.browser.executablePath = realpathSync(config.browser.executablePath);
  return config;
}

export function loadConfig(file?: string, overrides: Record<string, unknown> = {}): Config {
  const text = file ? readFileSync(file, 'utf8') : undefined;
  let value: unknown = {};
  if (text !== undefined) {
    try { value = JSON.parse(text); }
    catch { throw new HarnessError('CONFIG', 'Configuration must contain valid JSON. Check its syntax without including credentials in diagnostics.'); }
  }
  const input = z.record(z.string(), z.unknown()).parse(value);
  if (input.version === 2 || input.version === 3) {
    throw new HarnessError('CONFIG', 'Only native configuration version 4 is supported. Historical configurations cannot be migrated or resumed.');
  }
  const model = z.record(z.string(), z.unknown()).parse(input.model ?? {});
  const configuredProvider = z.record(z.string(), z.unknown()).parse(input.provider ?? { kind: 'copilot' });
  const providerKind = process.env.HARNESS_PROVIDER ?? configuredProvider.kind ?? 'copilot';
  if (providerKind !== 'copilot' && providerKind !== 'byok') throw new HarnessError('CONFIG', 'HARNESS_PROVIDER must be copilot or byok.');
  const provider = providerKind === 'copilot'
    ? process.env.HARNESS_PROVIDER ? { kind: 'copilot' } : configuredProvider
    : {
      ...(configuredProvider.kind === 'byok' ? configuredProvider : {}),
      kind: 'byok',
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    };
  return parseConfig({
    version: 4, workspace: process.cwd(), dataDir: defaultDataDir(), ...input, provider,
    model: {
      ...model,
      ...(process.env.HARNESS_MODEL ? { canonical: process.env.HARNESS_MODEL, wire: process.env.HARNESS_MODEL } : {}),
      ...(process.env.HARNESS_WIRE_MODEL ? { wire: process.env.HARNESS_WIRE_MODEL } : {}),
    }, ...overrides,
  });
}

export function loadEnvironment(file = path.resolve('.env')): void {
  try { loadEnvFile(file); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new HarnessError('ENV_FILE', 'Could not read the environment file. Check its path and permissions.');
  }
}

export function defaultDataDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'harness-experiment', 'native');
}

export function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
