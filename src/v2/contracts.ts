import { z } from 'zod';

export const statusSchema = z.enum([
  'preparing', 'running', 'awaiting_approval', 'awaiting_input', 'completed',
  'partial', 'failed', 'cancelled', 'recovery_required',
]);
export const stepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().min(1).max(500),
  expected: z.string().min(1).max(2000),
  dependencies: z.array(z.string()).max(50).default([]),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
  blocker: z.string().max(2000).optional(),
  results: z.array(z.string()).max(50).default([]),
}).strict();
export type Step = z.infer<typeof stepSchema>;
export interface Objective {
  id: string;
  sessionId: string;
  original: string;
  domain: 'general' | 'coding' | 'research' | 'browser';
  criteria: string[];
  status: z.infer<typeof statusSchema>;
  created: number;
  deadline: number;
  steps: Step[];
  planRevision: string | null;
  replans: number;
  actions: number;
  output: string;
  reason: string | null;
  usage: {
    input: number; output: number; requests: number;
    reserved: number; cost: number | null; unknown: boolean;
  };
}
export interface Action {
  id: string;
  sessionId: string;
  objectiveId: string;
  callId: string;
  tool: string;
  argsHash: string;
  args: Record<string, unknown>;
  effect: 'metadata' | 'read' | 'write' | 'execute' | 'network' | 'submit' | 'internal';
  status: 'pending' | 'started' | 'completed' | 'failed' | 'denied' | 'unknown' | 'resolved';
  resultId: string | null;
  error: string | null;
  errorCode?: string;
  cost?: number;
}
export interface Decision {
  id: string;
  sessionId: string;
  objectiveId: string;
  actionId: string;
  kind: 'approval' | 'question';
  revision: number;
  binding: string;
  description: string;
  status: 'pending' | 'approved' | 'denied' | 'answered' | 'expired';
  answer: string | null;
  choices?: string[];
  allowFreeform?: boolean;
}
export interface Result {
  id: string; sessionId: string; objectiveId: string;
  actionId: string; hash: string; bytes: number;
  mediaType: string; provenance: Record<string, unknown>;
  created: number;
}
export interface Source {
  id: string; sessionId: string; objectiveId: string;
  url: string; finalUrl: string; origin: string; title: string;
  retrieved: number; published: string | null;
  hash: string; resultId: string; extraction: string;
  evidence?: { id: string; quote: string; start: number; end: number; url: string | null }[];
}
export interface Claim {
  id: string; sessionId: string; objectiveId: string;
  text: string; inference: boolean; uncertainty: string | null;
  support: { sourceId: string; quote: string; evidenceId?: string }[];
  conflicts: { sourceId: string; quote: string; evidenceId?: string }[];
}
export interface ModelRequest {
  id: string; sessionId: string; objectiveId: string;
  status: 'started' | 'reserved' | 'completed' | 'unknown' | 'failed';
  reservation: number; input: number; output: number;
  interaction: string; error: string | null;
  requestBytes?: number;
  inputBound?: number;
  reportedUsage?: boolean;
  inputFingerprint?: { frameHash: string; inputHash: string; count: number };
  budgetScope?: 'objective' | 'verification' | 'none';
}
export interface ModelLimits {
  model: string;
  prompt: { limit: number | null; used: number | null; source: 'explicit override' | 'runtime reported' | 'unavailable' };
  output: { limit: number | null; source: 'explicit override' | 'SDK/provider default' };
  compactionThreshold: number | null;
  providerCapacityVerified: false;
  verification?: { maxTokens: number; outputTokens: number };
}
export interface Grant {
  id: string; sessionId: string;
  paths: string[]; origins: string[]; expires: number; revoked: boolean;
}
export interface ApprovalPolicy {
  id: string; sessionId: string; approveAll: boolean;
}
export interface ExecutionRecord {
  id: string; sessionId: string; objectiveId: string;
  directory: string; baseline: Record<string, string>;
  container: string; executable: string; args: string[];
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  exitCode: number | null; outputResultId: string | null;
}
export interface Entities {
  objective: Objective; action: Action; decision: Decision; result: Result;
  source: Source; claim: Claim; model: ModelRequest; grant: Grant; approvalPolicy: ApprovalPolicy; execution: ExecutionRecord;
}
export interface V2Event {
  sequence?: number; type: 'state' | 'text' | 'action' | 'request' | 'usage' | 'plan' | 'result' | 'error' | 'runtime' | 'context';
  sessionId: string; objectiveId: string | null;
  data: Record<string, unknown>;
}
export interface RuntimeTool {
  name: string; description: string; parameters: Record<string, unknown>;
  invoke: (args: unknown, callId: string, signal?: AbortSignal) => Promise<string>;
}
export interface RuntimeOptions {
  sessionId: string; resume: boolean; directory: string;
  tools: RuntimeTool[]; signal: AbortSignal;
  emit: (type: V2Event['type'], data: Record<string, unknown>) => void;
  question: (question: string, choices?: string[], allowFreeform?: boolean) => Promise<string>;
  beforeStop: () => Promise<string | null>;
  onContext?: (limits: ModelLimits) => void;
}
export interface Runtime {
  open(options: RuntimeOptions): Promise<void>;
  send(prompt: string): Promise<void>;
  updatePlan(content: string): Promise<void>;
  readPlan(): Promise<string | null>;
  events(): Promise<unknown[]>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
