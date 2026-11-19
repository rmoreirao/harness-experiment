import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAttributedPermissionResult, type PermissionRequest, type PermissionRequestResult, type PermissionMode, type AttributedPermissionResult } from '@github/copilot-sdk';
import { hash } from './config.js';
import { HarnessError, errorText } from './contracts.js';
import { errorDiagnostic } from './errors.js';
import type { Action, Decision, RuntimeTool, AppEvent, ToolActor } from './contracts.js';
import type { Store } from './store.js';
import type { Resources } from './resources.js';
import type { Config } from './config.js';

export interface ToolContext { action: Action; signal: AbortSignal }
interface Capability {
  tool: RuntimeTool;
  effect: Action['effect'];
  parse: (value: unknown) => Record<string, unknown>;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
}

// SDK permissions authorize invocation. This registry owns only retained domain
// validation and result storage, not a second tool approval system.
export class ActionBroker {
  private capabilities = new Map<string, Capability>();
  private waiters = new Map<string, { resolve: (value: string) => void; reject: (error: unknown) => void }>();
  private tasks = new Set<Promise<string>>();
  constructor(readonly store: Store, readonly config: Config, readonly sessionId: string,
    readonly resources: Resources, private readonly signal: () => AbortSignal,
    private readonly emit: (type: AppEvent['type'], data: Record<string, unknown>) => void) {}
  register<T extends Record<string, unknown>>(name: string, description: string, schema: z.ZodType<T>,
    effect: Action['effect'], execute: (args: T, context: ToolContext) => Promise<unknown> | unknown,
    _scope?: (args: Record<string, unknown>) => { paths?: string[]; origins?: string[] }): void {
    if (this.capabilities.has(name)) throw new HarnessError('TOOL', 'Duplicate capability.');
    const tool: RuntimeTool = {
      name, description, parameters: z.toJSONSchema(schema),
      invoke: (args, callId, runtimeSignal, actor) => {
        const task = this.dispatch(name, args, callId, runtimeSignal, actor);
        this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {});
        return task;
      },
    };
    this.capabilities.set(name, { tool, effect,
      parse: value => schema.parse(value), execute: async (args, context) => execute(schema.parse(args), context) });
  }
  tools(): RuntimeTool[] { return [...this.capabilities.values()].map(item => item.tool); }
  get permissionMode(): PermissionMode {
    return this.store.list('approvalPolicy', this.sessionId)[0]?.mode ?? this.config.permissionMode;
  }
  get approveAll(): boolean { return this.permissionMode === 'allow-all'; }
  setPermissionMode(mode: PermissionMode): void {
    this.store.put('approvalPolicy', { id: this.sessionId, sessionId: this.sessionId, mode, approveAll: mode === 'allow-all' });
    this.emit('state', { permissionMode: mode, approveAll: mode === 'allow-all' });
  }
  async permission(request: PermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult | AttributedPermissionResult> {
    const objective = this.resources.check();
    const decision: Decision = {
      id: randomUUID(), sessionId: this.sessionId, objectiveId: objective.id, actionId: '',
      kind: 'approval', revision: 1, binding: hash([invocation.sessionId, request, randomUUID()]),
      description: `SDK permission request:\n${JSON.stringify(this.store.redactor.value(request), null, 2)}`,
      status: 'pending', answer: null, runtimeSessionId: invocation.sessionId,
    };
    // Requests which reach the callback may require human approval even when the
    // selected mode is allow-all (for example a managed-policy requirement).
    const answer = await this.wait(decision, this.signal());
    const human = this.store.get('decision', decision.id, this.sessionId).decisionSource === 'human_response';
    const result: PermissionRequestResult = answer === 'approve'
      ? { kind: 'approve-once', approvedInteractively: human } : { kind: 'reject' };
    return human
      ? createAttributedPermissionResult(result, { source: 'human_response', responseCapability: 'interactive', surface: 'sdk', outcome: 'prompted_user' })
      : result;
  }
  async dispatch(name: string, input: unknown, callId: string, runtimeSignal?: AbortSignal, actor: ToolActor = {}): Promise<string> {
    let action: Action | undefined;
    try {
      const capability = this.capabilities.get(name);
      if (!capability) throw new HarnessError('TOOL_DENIED', 'Unsupported capability.');
      if (!callId || callId.length > 1000) throw new HarnessError('IDENTITY', 'A bounded runtime tool call identity is required.');
      const signal = runtimeSignal ? AbortSignal.any([this.signal(), runtimeSignal]) : this.signal();
      signal.throwIfAborted();
      const args = capability.parse(input);
      const objective = this.resources.check();
      const id = hash([this.sessionId, objective.id, actor.runtimeSessionId ?? 'parent', callId]);
      const argsHash = hash([name, args, capability.effect]);
      const previous = this.store.list('action', this.sessionId, objective.id).find(item => item.id === id);
      if (previous) throw new HarnessError('RECOVERY', previous.argsHash === argsHash
        ? 'Recorded actions are not replayed. Inspect the existing result.'
        : 'A tool invocation identity was reused with changed arguments.');
      this.resources.action();
      action = {
        id, callId, sessionId: this.sessionId, objectiveId: objective.id, argsHash, args,
        tool: name, effect: capability.effect, origin: 'custom', ...actor, status: 'pending',
        resultId: null, error: null, created: Date.now(),
      };
      this.store.put('action', action); this.emit('action', { action });
      const release = await this.resources.tools.acquire(signal);
      try {
        signal.throwIfAborted(); this.resources.check();
        action.status = 'started'; action.started = Date.now();
        this.store.put('action', action); this.emit('action', { action });
        const output = await capability.execute(args, {
          action, signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.limits.toolTimeoutMs)]),
        });
        const encoded = JSON.stringify(output ?? null);
        if (Buffer.byteLength(encoded) > this.config.limits.maxOutputBytes) throw new HarnessError('OUTPUT_LIMIT', 'Tool output exceeds its configured limit.');
        const result = this.store.result(this.sessionId, objective.id, id, encoded, { tool: name, callId });
        action.resultId = result.id; action.status = 'completed'; action.finished = Date.now();
        this.store.put('action', action); this.emit('result', { result }); this.emit('action', { action });
        return JSON.stringify(this.store.readResult(this.sessionId, result.id));
      } finally { release(); }
    } catch (error) {
      if (!action) {
        this.emit('error', errorDiagnostic(error, this.store.redactor, { source: 'tool', tool: name, callId, status: 'not_started' }));
        throw error;
      }
      if (action.status === 'pending') action.status = 'denied';
      else if (action.status === 'started') {
        const noEffect = error instanceof HarnessError &&
          ['STALE_OBSERVATION', 'BROWSER_TARGET', 'BROWSER_COMPATIBILITY', 'EXECUTION_DISABLED', 'UPLOAD_DISABLED', 'PUBLICATION_PRECONDITION'].includes(error.code);
        const retrieval = action.effect === 'network' && error instanceof HarnessError &&
          ['HTTP', 'CONTENT_TYPE', 'BODY_LIMIT', 'REDIRECT_LIMIT', 'PRIVATE_NETWORK', 'DESTINATION', 'REDIRECT', 'SEARCH_CREDENTIAL', 'SEARCH_COST', 'COST_LIMIT'].includes(error.code);
        action.status = noEffect || retrieval || ['metadata', 'read', 'internal'].includes(action.effect) ? 'failed' : 'unknown';
      }
      action.error = errorText(error); action.finished = Date.now();
      action.errorCode = error instanceof HarnessError ? error.code : 'TOOL_FAILED';
      this.store.put('action', action); this.emit('action', {
        action, diagnostic: errorDiagnostic(error, this.store.redactor,
          { source: 'tool', tool: name, invocationId: action.id, callId, status: action.status }),
      });
      throw error;
    }
  }
  private async wait(decision: Decision, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.store.put('decision', decision);
    const objective = this.resources.current();
    objective.status = decision.kind === 'approval' ? 'awaiting_approval' : 'awaiting_input';
    this.store.put('objective', objective);
    try {
      return await new Promise<string>((resolve, reject) => {
        const abort = () => { this.waiters.delete(decision.id); reject(signal.reason); };
        this.waiters.set(decision.id, {
          resolve: answer => { signal.removeEventListener('abort', abort); resolve(answer); },
          reject: error => { signal.removeEventListener('abort', abort); reject(error); },
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        this.emit('request', { decision });
      });
    } finally {
      const current = this.resources.current();
      if (['awaiting_approval', 'awaiting_input'].includes(current.status)) {
        const pending = this.store.list('decision', this.sessionId, current.id).filter(item => item.status === 'pending' && this.waiters.has(item.id));
        current.status = pending.some(item => item.kind === 'question') ? 'awaiting_input' : pending.length ? 'awaiting_approval' : 'running';
        this.store.put('objective', current);
      }
    }
  }
  decide(id: string, revision: number, binding: string, answer: string, source: 'human_response' | 'external' = 'external'): void {
    const decision = this.store.get('decision', id, this.sessionId);
    const waiter = this.waiters.get(id);
    if (!waiter || decision.status !== 'pending' || decision.revision !== revision || decision.binding !== binding ||
        decision.objectiveId !== this.resources.current().id) throw new HarnessError('STALE_DECISION', 'This request is not the current live decision.');
    this.resources.check();
    if (decision.kind === 'approval' && !['approve', 'deny'].includes(answer)) throw new HarnessError('DECISION', 'Choose approve or deny.');
    if (decision.kind === 'question' && (!answer.trim() || (decision.choices?.length && !decision.allowFreeform && !decision.choices.includes(answer)))) {
      throw new HarnessError('DECISION', 'Use a listed answer for this question.');
    }
    decision.status = decision.kind === 'question' ? 'answered' : answer === 'approve' ? 'approved' : 'denied';
    decision.answer = answer; decision.decisionSource = source; this.store.put('decision', decision);
    this.waiters.delete(id); waiter.resolve(answer);
  }
  question(description: string, choices?: string[], allowFreeform = true): Promise<string> {
    const objective = this.resources.check();
    return this.wait({
      id: randomUUID(), sessionId: this.sessionId, objectiveId: objective.id, actionId: '',
      kind: 'question', revision: 1, binding: randomUUID(), description, choices, allowFreeform, status: 'pending', answer: null,
    }, this.signal());
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.tasks]); }
}
