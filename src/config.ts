import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import { Ajv } from 'ajv';
import { HarnessError } from './contracts.js';

const mcpServer = z.discriminatedUnion('transport', [
  z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/),
    transport: z.literal('stdio'), command: z.string().min(1),
    args: z.array(z.string()).default([]),
    tools: z.array(z.string().min(1)).min(1),
    trusted: z.literal(true),
  }).strict(),
  z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/),
    transport: z.literal('http'), url: z.string().url(),
    tools: z.array(z.string().min(1)).min(1),
    trusted: z.literal(true),
  }).strict(),
]);
export const configSchema = z.object({
  version: z.literal(1).default(1),
  mode: z.enum(['fake', 'openai']).default('openai'),
  workspace: z.string().min(1),
  dataDir: z.string().min(1),
  baseURL: z.string().url().optional(),
  model: z.string().min(1).default(''),
  instructions: z.string().default('Complete the requested work accurately.'),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  enabledTools: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).min(1).optional(),
  mcp: z.array(mcpServer).default([]),
  limits: z.object({
    maxIterations: z.number().int().min(1).max(1000).default(30),
    maxTokens: z.number().int().min(128).default(50000),
    maxOutputTokens: z.number().int().min(32).default(2048),
    contextTokens: z.number().int().min(512).default(16000),
    activeTimeoutMs: z.number().int().min(100).default(300000),
    toolTimeoutMs: z.number().int().min(50).default(30000),
    modelTimeoutMs: z.number().int().min(50).default(60000),
    maxConcurrency: z.number().int().min(1).max(16).default(2),
    maxFileBytes: z.number().int().min(1).max(10485760).default(262144),
    maxToolBytes: z.number().int().min(128).max(10485760).default(262144),
    maxCost: z.number().positive().optional(),
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional(),
  }).prefault({}),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type McpConfig = Config['mcp'][number];

export function loadEnvironment(file = path.resolve('.env')): void {
  try { loadEnvFile(file); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new HarnessError('ENV_FILE', 'Could not read the environment file. Check its path and permissions.');
  }
}

export function defaultDataDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'harness-experiment');
}
export function parseConfig(value: unknown): Config {
  const c = configSchema.parse(value);
  try { c.workspace = realpathSync(path.resolve(c.workspace)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
      throw new HarnessError('WORKSPACE', 'The workspace folder does not exist. Use --workspace with an existing folder, such as .\\docs in this repository.');
    }
    throw error;
  }
  if (!statSync(c.workspace).isDirectory()) throw new HarnessError('WORKSPACE', 'The workspace must be an existing folder, not a file.');
  c.dataDir = path.resolve(c.dataDir);
  if (c.mode === 'fake') c.model = 'fake-reference-v1';
  if (c.mode === 'openai' && (!c.baseURL || !c.model)) {
    throw new HarnessError('CONFIG', 'OpenAI mode requires baseURL and model. Use --fake for offline development.');
  }
  if (c.baseURL) {
    const url = new URL(c.baseURL);
    if (url.username || url.password || url.search || url.hash) {
      throw new HarnessError('CONFIG', 'Endpoint credentials, query strings, and fragments are not allowed in baseURL.');
    }
    if (/\/responses\/?$/.test(url.pathname)) {
      throw new HarnessError('CONFIG', 'OPENAI_BASE_URL must be the API base, not the /responses endpoint. Remove the trailing /responses; the SDK adds it.');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new HarnessError('CONFIG', 'Use HTTPS for remote endpoints; plain HTTP is allowed only on loopback.');
    }
  }
  if (new Set(c.mcp.map(s => s.name)).size !== c.mcp.length) throw new HarnessError('CONFIG', 'MCP server names must be unique.');
  for (const s of c.mcp) {
    if (s.transport === 'http') {
      const url = new URL(s.url);
      if (url.username || url.password || url.search || url.hash) throw new HarnessError('CONFIG', 'MCP URLs cannot include credentials or query strings.');
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new HarnessError('CONFIG', 'MCP requires HTTPS, except for loopback fixtures.');
      }
    }
    if (s.tools.some(t => /shell|exec|computer|python|javascript|terminal|code_interpreter/i.test(t))) {
      throw new HarnessError('CONFIG', 'Arbitrary execution tools are not enabled in the MVP.');
    }
  }
  if (c.limits.maxCost !== undefined &&
      (c.limits.inputPerMillion === undefined || c.limits.outputPerMillion === undefined)) {
    throw new HarnessError('CONFIG', 'Currency budgets require explicit inputPerMillion and outputPerMillion pricing.');
  }
  if ((c.limits.inputPerMillion === undefined) !== (c.limits.outputPerMillion === undefined)) {
    throw new HarnessError('CONFIG', 'Provide both inputPerMillion and outputPerMillion, or neither.');
  }
  if (c.outputSchema) {
    try { new Ajv({ strict: false }).compile(c.outputSchema); }
    catch { throw new HarnessError('CONFIG', 'outputSchema must be a valid, locally resolvable JSON Schema.'); }
  }
  if (c.limits.maxOutputTokens + 256 >= c.limits.contextTokens) {
    throw new HarnessError('CONFIG', 'contextTokens must leave space beyond maxOutputTokens and instruction overhead.');
  }
  return c;
}
export function loadConfig(file: string | undefined, overrides: Record<string, unknown> = {}): Config {
  const base: unknown = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const object = z.record(z.string(), z.unknown()).parse(base);
  return parseConfig({
    workspace: process.cwd(), dataDir: defaultDataDir(), ...object,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    ...(process.env.HARNESS_MODEL ? { model: process.env.HARNESS_MODEL } : {}),
    ...overrides,
  });
}
export function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
export function configHash(config: Config): string { return hash(config); }
