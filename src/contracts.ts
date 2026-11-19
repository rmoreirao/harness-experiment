import { z } from 'zod';
import type { PermissionRequest, PermissionRequestResult, PermissionMode, AttributedPermissionResult } from '@github/copilot-sdk';
import type { SkillInfo } from './skills.js';

export type TaskMode = 'interactive' | 'plan' | 'autopilot';
export type { PermissionMode };

export const statusSchema = z.enum([
  'preparing', 'running', 'awaiting_approval', 'awaiting_input', 'completed',
  'partial', 'failed', 'cancelled', 'recovery_required',
]);
export interface Objective {
  id: string;
  sessionId: string;
  original: string;
  domain: 'general' | 'coding' | 'research' | 'browser';
  criteria: string[];
  status: z.infer<typeof statusSchema>;
  created: number;
  deadline: number;
  plan: string | null;
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
  cost?: number | null;
  origin?: 'native' | 'custom';
  actorId?: string;
  parentCallId?: string;
  runtimeSessionId?: string;
  created?: number;
  started?: number;
  finished?: number;
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
  runtimeSessionId?: string;
  decisionSource?: 'human_response' | 'external';
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
  started?: number;
  finished?: number;
  outcome?: 'running' | 'completed' | 'failed' | 'cancelled';
  provider?: 'copilot' | 'byok';
  model?: string;
  wireModel?: string;
  actorId?: string;
}
export interface Worker {
  id: string; sessionId: string; objectiveId: string; name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'resolved';
  parentId?: string; callId?: string; model?: string;
  started: number; finished?: number; error?: string;
}
export interface Assignment {
  id: string; sessionId: string; objectiveId: string; worker: string;
  paths: string[]; status: 'active' | 'released';
}
export type ActivityRecord =
  | { order: number; kind: 'tool'; value: Action }
  | { order: number; kind: 'model'; value: ModelRequest };
export interface ActivityPage { items: ActivityRecord[]; next: number | null }
export interface ModelLimits {
  model: string;
  prompt: { limit: number | null; used: number | null; source: 'explicit override' | 'runtime reported' | 'unavailable' };
  output: { limit: number | null; source: 'explicit override' | 'SDK/provider default' };
  compactionThreshold: number | null;
  providerCapacityVerified: false;
  verification?: { maxTokens: number; outputTokens: number };
}
export interface ApprovalPolicy {
  id: string; sessionId: string; approveAll: boolean; mode: PermissionMode;
}
export interface SessionPolicy {
  id: string; sessionId: string; trusted: boolean; taskMode: TaskMode;
}
export interface ConversationBoundary {
  id: string; sessionId: string; afterObjectiveId: string | null;
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
  source: Source; claim: Claim; model: ModelRequest; approvalPolicy: ApprovalPolicy; execution: ExecutionRecord;
  conversation: ConversationBoundary;
  worker: Worker; assignment: Assignment; sessionPolicy: SessionPolicy;
}
export interface AppEvent {
  sequence?: number; at?: number; type: 'state' | 'text' | 'action' | 'request' | 'usage' | 'plan' | 'result' | 'error' | 'runtime' | 'context';
  sessionId: string; objectiveId: string | null;
  data: Record<string, unknown>;
}
export interface RuntimeTool {
  name: string; description: string; parameters: Record<string, unknown>;
  invoke: (args: unknown, callId: string, signal?: AbortSignal, actor?: ToolActor) => Promise<string>;
}
export interface ToolActor { actorId?: string; runtimeSessionId?: string; parentCallId?: string }
export interface RuntimeOptions {
  sessionId: string; resume: boolean; directory: string;
  tools: RuntimeTool[]; signal: AbortSignal;
  emit: (type: AppEvent['type'], data: Record<string, unknown>) => void;
  question: (question: string, choices?: string[], allowFreeform?: boolean) => Promise<string>;
  beforeStop: () => Promise<string | null>;
  permission: (request: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult | AttributedPermissionResult>;
  permissionMode: PermissionMode;
  taskMode: TaskMode;
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
  setPermissionMode(mode: PermissionMode): Promise<PermissionMode>;
  setTaskMode(mode: TaskMode): Promise<void>;
  auth(action: 'status' | 'login' | 'advance' | 'cancel', input?: string): Promise<Record<string, unknown>>;
  mcp(action: 'list' | 'status' | 'login', serverName?: string): Promise<Record<string, unknown>>;
  listSkills(): Promise<SkillInfo[]>;
}

export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
