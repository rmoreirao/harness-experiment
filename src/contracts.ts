import { z } from 'zod';

export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export const runStatus = z.enum([
  'running', 'awaiting_approval', 'awaiting_input', 'completed',
  'partial', 'failed', 'cancelled', 'interrupted',
]);
export const usageSchema = z.object({
  input: z.number().nonnegative().default(0),
  output: z.number().nonnegative().default(0),
  requests: z.number().int().nonnegative().default(0),
  reserved: z.number().nonnegative().default(0),
  unknown: z.boolean().default(false),
  cost: z.number().nonnegative().nullable().default(null),
});
export const runSchema = z.object({
  id: z.string(), sessionId: z.string(), input: z.string(),
  status: runStatus, createdAt: z.number(), updatedAt: z.number(),
  activeMs: z.number().nonnegative(), usage: usageSchema,
  contextUnits: z.number().nonnegative().default(0),
  checkpoint: z.string().nullable(), configHash: z.string(),
  sdkVersion: z.literal('0.21.0'), schemaVersion: z.literal(1),
  reason: z.string().nullable(), finalOutput: z.string().nullable(),
  structuredOutput: z.unknown().optional(),
});
export type RunRecord = z.infer<typeof runSchema>;
export type UsageRecord = z.infer<typeof usageSchema>;
export const requestSchema = z.object({
  id: z.string(), runId: z.string(), callId: z.string(), tool: z.string(),
  kind: z.enum(['approval', 'question']),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'approved', 'rejected', 'answered']),
  answer: z.string().nullable(), revision: z.number().int().positive(),
});
export type PendingRequest = z.infer<typeof requestSchema>;
export const invocationSchema = z.object({
  id: z.string(), runId: z.string(), tool: z.string(), argsHash: z.string(),
  status: z.enum(['started', 'completed', 'failed', 'unknown', 'resolved']),
  effect: z.enum(['read', 'write', 'external', 'internal']),
  output: z.string().nullable(), error: z.string().nullable(),
  outputPath: z.string().nullable().default(null),
});
export type Invocation = z.infer<typeof invocationSchema>;
export interface TranscriptEntry {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  runId: string | null;
}
export interface Artifact {
  id: string;
  runId: string;
  path: string;
  hash: string;
  bytes: number;
}
export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
}
export interface AppEvent {
  type: 'state' | 'text' | 'tool' | 'request' | 'usage' | 'artifact' | 'error' | 'compaction';
  sessionId: string;
  runId: string | null;
  data: Record<string, unknown>;
}
export interface RunContextData {
  sessionId: string;
  runId: string;
}
export type Validator = (output: string, artifacts: Artifact[]) => string | null | Promise<string | null>;
export type LifecycleHook = (event: AppEvent) => void | Promise<void>;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
