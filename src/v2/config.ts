import path from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { defaultDataDir } from '../config.js';
import { HarnessError } from '../contracts.js';
import { within } from '../files.js';

export const SDK_VERSION = '1.0.34';
export const RUNTIME_VERSION = '1.0.112';
export const DEFAULT_SKILLS_DIRECTORY = path.join('.github', 'skills');
const origin = z.string().url().transform(value => {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password) throw new HarnessError('CONFIG', 'Use exact origins without paths or credentials.');
  return value;
});
export const v2ConfigSchema = z.object({
  version: z.literal(2),
  workspace: z.string().min(1),
  dataDir: z.string().min(1),
  model: z.object({
    baseURL: z.string().url(),
    canonical: z.string().min(1).max(200),
    wire: z.string().min(1).max(200),
    wireAPI: z.literal('responses').default('responses'),
    contextTokens: z.number().int().min(1024).max(2000000).default(32000),
    outputTokens: z.number().int().min(32).max(128000).default(2048),
  }).strict(),
  readOnly: z.boolean().default(false),
  skillsDirectory: z.string().min(1).max(1000).optional(),
  enabledTools: z.array(z.string().regex(/^[a-zA-Z0-9_]{1,64}$/)).optional(),
  network: z.object({
    origins: z.array(z.union([z.literal('*'), origin])).max(100).default([]),
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
  mcp: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,20}$/),
    url: z.string().url(), tools: z.array(z.string().regex(/^[a-zA-Z0-9_]{1,32}$/)).min(1).max(30),
    trusted: z.literal(true),
  }).strict()).max(10).default([]),
  limits: z.object({
    maxTokens: z.number().int().min(128).default(100000),
    maxRequests: z.number().int().min(1).max(1000).default(100),
    maxActions: z.number().int().min(1).max(1000).default(100),
    maxReplans: z.number().int().min(0).max(20).default(2),
    timeoutMs: z.number().int().min(100).max(86400000).default(600000),
    toolTimeoutMs: z.number().int().min(100).max(300000).default(30000),
    concurrency: z.number().int().min(1).max(8).default(2),
    maxFileBytes: z.number().int().min(128).max(10485760).default(1048576),
    maxOutputBytes: z.number().int().min(128).max(10485760).default(1048576),
    maxResultBytes: z.number().int().min(1024).max(104857600).default(20971520),
    maxWorkspaceBytes: z.number().int().min(1024).max(1073741824).default(52428800),
    maxFiles: z.number().int().min(1).max(50000).default(5000),
    maxCost: z.number().positive().optional(),
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional(),
  }).strict().prefault({}),
}).strict();
export type V2Config = z.infer<typeof v2ConfigSchema>;

export function allowsHttpsOrigin(origins: readonly string[], value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value &&
    (origins.includes('*') || origins.includes(value));
}

export function parseV2Config(value: unknown): V2Config {
  const config = v2ConfigSchema.parse(value);
  config.workspace = realpathSync(path.resolve(config.workspace));
  if (!lstatSync(config.workspace).isDirectory()) throw new HarnessError('CONFIG', 'Workspace must be an existing directory.');
  config.dataDir = path.resolve(config.dataDir);
  if (within(config.workspace, config.dataDir)) throw new HarnessError('CONFIG', 'V2 data must be outside the workspace.');
  const url = new URL(config.model.baseURL);
  if (url.username || url.password || url.search || url.hash || /\/responses\/?$/.test(url.pathname) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new HarnessError('CONFIG', 'Use an explicit HTTPS API base (HTTP only on loopback), without credentials or /responses.');
  }
  if (config.model.outputTokens >= config.model.contextTokens) throw new HarnessError('CONFIG', 'Output limit must be smaller than context limit.');
  if ((config.limits.inputPerMillion === undefined) !== (config.limits.outputPerMillion === undefined) ||
      (config.limits.maxCost !== undefined && config.limits.inputPerMillion === undefined)) {
    throw new HarnessError('CONFIG', 'Currency accounting requires both input and output prices.');
  }
  for (const value of config.network.localFixtureOrigins) {
    const url = new URL(value);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new HarnessError('CONFIG', 'Local fixtures require literal loopback origins.');
  }
  if (config.network.origins.some(value => value !== '*' && new URL(value).protocol !== 'https:')) throw new HarnessError('CONFIG', 'Public origins require HTTPS.');
  if (config.search && !allowsHttpsOrigin(config.network.origins, 'https://api.search.brave.com')) {
    throw new HarnessError('CONFIG', 'Brave search requires an allowed HTTPS network origin.');
  }
  if (new Set(config.mcp.map(server => server.name)).size !== config.mcp.length) throw new HarnessError('CONFIG', 'Duplicate MCP server name.');
  for (const server of config.mcp) {
    const url = new URL(server.url);
    if (url.username || url.password || url.search || url.hash ||
        !(allowsHttpsOrigin(config.network.origins, url.origin) || config.network.localFixtureOrigins.includes(url.origin))) {
      throw new HarnessError('CONFIG', 'MCP requires an explicitly allowed no-auth URL.');
    }
  }
  if (config.browser) config.browser.executablePath = realpathSync(config.browser.executablePath);
  return config;
}
export function loadV2Config(file?: string, overrides: Record<string, unknown> = {}): V2Config {
  const input = file ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
  const model = z.record(z.string(), z.unknown()).parse(input.model ?? {});
  return parseV2Config({
    version: 2, workspace: process.cwd(), dataDir: path.join(defaultDataDir(), 'v2'), ...input,
    model: {
      ...model,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      ...(process.env.HARNESS_MODEL ? { canonical: process.env.HARNESS_MODEL, wire: process.env.HARNESS_MODEL } : {}),
      ...(process.env.HARNESS_WIRE_MODEL ? { wire: process.env.HARNESS_WIRE_MODEL } : {}),
    }, ...overrides,
  });
}
