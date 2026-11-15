import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { hash } from '../config.js';
import { HarnessError, errorText } from '../contracts.js';
import { errorDiagnostic } from '../errors.js';
import { within } from '../files.js';
import type { Action, Decision, RuntimeTool, V2Event } from './contracts.js';
import type { V2Store } from './store.js';
import type { Resources } from './resources.js';
import { allowsHttpsOrigin, type V2Config } from './config.js';

export interface ToolContext { action: Action; signal: AbortSignal }
interface Capability {
  tool: RuntimeTool;
  effect: Action['effect'];
  parse: (value: unknown) => Record<string, unknown>;
  execute: (args: unknown, context: ToolContext) => Promise<unknown>;
  scope?: (args: Record<string, unknown>) => { paths?: string[]; origins?: string[] };
}
export class ActionBroker {
  private capabilities = new Map<string, Capability>();
  private waiters = new Map<string, { resolve: (value: string) => void; reject: (error: unknown) => void }>();
  private tasks = new Set<Promise<string>>();
  constructor(readonly store: V2Store, readonly config: V2Config, readonly sessionId: string,
    readonly resources: Resources, private readonly signal: () => AbortSignal,
    private readonly emit: (type: V2Event['type'], data: Record<string, unknown>) => void) {}
  register<T extends Record<string, unknown>>(name: string, description: string, schema: z.ZodType<T>,
    effect: Action['effect'], execute: (args: T, context: ToolContext) => Promise<unknown> | unknown,
    scope?: Capability['scope']): void {
    if (this.capabilities.has(name)) throw new HarnessError('TOOL', 'Duplicate capability.');
    const tool: RuntimeTool = {
      name, description, parameters: z.toJSONSchema(schema),
      invoke: (args, callId, runtimeSignal) => {
        const task = this.dispatch(name, args, callId, runtimeSignal);
        this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {});
        return task;
      },
    };
    this.capabilities.set(name, { tool, effect, scope,
      parse: value => schema.parse(value), execute: async (args, context) => execute(schema.parse(args), context) });
  }
  tools(): RuntimeTool[] {
    const allowed = this.config.enabledTools;
    if (allowed?.some(name => !this.capabilities.has(name))) throw new HarnessError('TOOL', 'An enabled tool is unknown or its provider is unavailable.');
    return [...this.capabilities.values()].filter(capability => !allowed || allowed.includes(capability.tool.name)).map(capability => capability.tool);
  }
  get approveAll(): boolean {
    return this.store.list('approvalPolicy', this.sessionId)[0]?.approveAll ?? false;
  }
  setApproveAll(enabled: boolean): void {
    const objective = this.store.latest(this.sessionId);
    const pending = enabled && objective ? this.store.list('decision', this.sessionId, objective.id)
      .filter(decision => decision.kind === 'approval' && decision.status === 'pending')
      .map(decision => this.validateDecision(decision.id, decision.revision, decision.binding, 'approve')) : [];
    this.store.db.transaction(() => {
      this.store.put('approvalPolicy', { id: this.sessionId, sessionId: this.sessionId, approveAll: enabled });
      for (const { decision } of pending) this.store.put('decision', { ...decision, status: 'approved', answer: 'approve' });
    })();
    for (const { decision, waiter } of pending) {
      this.waiters.delete(decision.id); waiter.resolve('approve');
    }
    this.emit('state', { approveAll: enabled, approvedPending: pending.length });
  }
  private permitted(capability: Capability, args: Record<string, unknown>): boolean {
    if (['metadata', 'internal'].includes(capability.effect)) return true;
    if (!['read', 'network'].includes(capability.effect) || !capability.scope) return false;
    if (capability.effect === 'network' && typeof args.url === 'string' && new URL(args.url).search) return false;
    const scope = capability.scope(args);
    if (!scope.paths?.length && !scope.origins?.length) return false;
    return this.store.list('grant', this.sessionId).some(grant =>
      !grant.revoked && grant.expires > Date.now() &&
      (scope.paths ?? []).every(file => grant.paths.some(root => within(root, path.resolve(this.config.workspace, file)))) &&
      (scope.origins ?? []).every(origin => grant.origins.includes(origin)));
  }
  async dispatch(name: string, input: unknown, callId: string, runtimeSignal?: AbortSignal): Promise<string> {
    let action: Action | undefined;
    try {
      const capability = this.capabilities.get(name);
      if (!capability || (this.config.enabledTools && !this.config.enabledTools.includes(name))) throw new HarnessError('TOOL_DENIED', 'Unsupported or disabled capability.');
      if (!callId || callId.length > 200) throw new HarnessError('IDENTITY', 'A bounded runtime tool call identity is required.');
      const signal = runtimeSignal ? AbortSignal.any([this.signal(), runtimeSignal]) : this.signal();
      signal.throwIfAborted();
      const args = capability.parse(input);
      if (this.config.readOnly && ['write', 'execute', 'submit'].includes(capability.effect)) throw new HarnessError('READ_ONLY', 'This session is restricted to read-only capabilities.');
      const objective = this.resources.check();
      const id = hash([this.sessionId, objective.id, callId]);
      const argsHash = hash([name, args, capability.effect]);
      const previous = this.store.list('action', this.sessionId, objective.id).find(action => action.id === id);
      if (previous) {
        if (previous.argsHash !== argsHash) throw new HarnessError('IDENTITY', 'A tool call identity was reused with changed arguments.');
        if (previous.status === 'completed' && previous.resultId) return JSON.stringify(this.store.readResult(this.sessionId, previous.resultId));
        throw new HarnessError('RECOVERY', 'This action cannot be replayed. Inspect/reconcile its existing record.');
      }
      this.resources.action();
      action = {
        id, callId, sessionId: this.sessionId, objectiveId: objective.id, argsHash, args,
        tool: name, effect: capability.effect, status: 'pending', resultId: null, error: null,
      };
      this.store.put('action', action);
      const approveAll = this.approveAll;
      const automatic = !approveAll && this.permitted(capability, args);
      if (!automatic) {
        const decision: Decision = {
          id: randomUUID(), sessionId: this.sessionId, objectiveId: objective.id, actionId: id,
          kind: 'approval', revision: 1, binding: hash([this.sessionId, objective.id, id, argsHash, 1]),
          description: `${name} (${capability.effect}): ${JSON.stringify(args)}`,
          status: 'pending', answer: null,
        };
        let answer: string;
        if (approveAll) {
          this.store.put('decision', { ...decision, status: 'approved', answer: 'approve' });
          answer = 'approve';
        } else {
          answer = await this.wait(decision, signal);
        }
        if (answer !== 'approve') {
          action.status = 'denied'; this.store.put('action', action);
          throw new HarnessError('DENIED', 'The user denied this exact action; it did not execute.');
        }
      }
      signal.throwIfAborted(); this.resources.check();
      if (hash([name, capability.parse(args), capability.effect]) !== argsHash) throw new HarnessError('STALE_APPROVAL', 'Action binding changed.');
      const release = await this.resources.tools.acquire(signal);
      try {
        signal.throwIfAborted(); this.resources.check();
        if (automatic && !this.permitted(capability, args)) throw new HarnessError('GRANT_REVOKED', 'The trusted-read grant expired or was revoked before dispatch.');
        action.status = 'started'; this.store.put('action', action);
        this.emit('action', { action });
        const output = await capability.execute(args, { action, signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.limits.toolTimeoutMs)]) });
        const encoded = JSON.stringify(output ?? null);
        if (Buffer.byteLength(encoded) > this.config.limits.maxOutputBytes) throw new HarnessError('OUTPUT_LIMIT', 'Tool output exceeds its configured limit.');
        const result = this.store.result(this.sessionId, objective.id, id, encoded, { tool: name, callId });
        action.resultId = result.id; action.status = 'completed';
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
        const knownNoEffect = error instanceof HarnessError && ['STALE_OBSERVATION', 'BROWSER_TARGET', 'BROWSER_COMPATIBILITY', 'EXECUTION_DISABLED', 'UPLOAD_DISABLED', 'PUBLICATION_PRECONDITION'].includes(error.code);
        const knownRetrievalFailure = action.effect === 'network' && error instanceof HarnessError &&
          ['HTTP', 'CONTENT_TYPE', 'BODY_LIMIT', 'REDIRECT_LIMIT', 'PRIVATE_NETWORK', 'DESTINATION', 'REDIRECT', 'SEARCH_CREDENTIAL', 'SEARCH_COST', 'COST_LIMIT'].includes(error.code);
        action.status = knownNoEffect || knownRetrievalFailure || ['metadata', 'read', 'internal'].includes(action.effect) ? 'failed' : 'unknown';
      }
      action.error = errorText(error);
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
        this.emit('request', { decision });
      });
    } finally {
      const current = this.resources.current();
      if (['awaiting_approval', 'awaiting_input'].includes(current.status)) {
        const pending = this.store.list('decision', this.sessionId, current.id).filter(request => request.status === 'pending');
        current.status = pending.some(request => request.kind === 'question') ? 'awaiting_input' : pending.length ? 'awaiting_approval' : 'running';
        this.store.put('objective', current);
      }
    }
  }
  decide(id: string, revision: number, binding: string, answer: string): void {
    const { decision, waiter } = this.validateDecision(id, revision, binding, answer);
    decision.status = decision.kind === 'question' ? 'answered' : answer === 'approve' ? 'approved' : 'denied';
    decision.answer = answer; this.store.put('decision', decision);
    this.waiters.delete(id); waiter.resolve(answer);
  }
  private validateDecision(id: string, revision: number, binding: string, answer: string) {
    const decision = this.store.get('decision', id, this.sessionId);
    const waiter = this.waiters.get(id);
    if (!waiter || decision.status !== 'pending' || decision.revision !== revision || decision.binding !== binding ||
        decision.objectiveId !== this.resources.current().id) throw new HarnessError('STALE_DECISION', 'This request is not the current live decision.');
    this.resources.check();
    if (decision.kind === 'approval' && !['approve', 'deny'].includes(answer)) throw new HarnessError('DECISION', 'Choose approve or deny.');
    if (decision.kind === 'question' && (!answer.trim() || (decision.choices?.length && !decision.allowFreeform && !decision.choices.includes(answer)))) {
      throw new HarnessError('DECISION', 'Use a listed answer for this question.');
    }
    return { decision, waiter };
  }
  question(description: string, choices?: string[], allowFreeform = true): Promise<string> {
    const objective = this.resources.check();
    const decision: Decision = {
      id: randomUUID(), sessionId: this.sessionId, objectiveId: objective.id, actionId: '',
      kind: 'question', revision: 1, binding: randomUUID(), description, choices, allowFreeform, status: 'pending', answer: null,
    };
    return this.wait(decision, this.signal());
  }
  grant(paths: string[], origins: string[], expires: number): string {
    if (expires <= Date.now() || expires > Date.now() + 86400000) throw new HarnessError('GRANT', 'Trusted reads expire within 24 hours.');
    for (const root of paths) if (!within(this.config.workspace, path.resolve(root))) throw new HarnessError('GRANT', 'Read grant escapes the workspace.');
    for (const origin of origins) if (!allowsHttpsOrigin(this.config.network.origins, origin)) {
      throw new HarnessError('GRANT', 'Read grants require exact allowed HTTPS origins; a wildcard network allowlist does not grant automatic reads.');
    }
    const id = randomUUID();
    this.store.put('grant', { id, sessionId: this.sessionId, paths: paths.map(root => path.resolve(root)), origins, expires, revoked: false });
    this.emit('state', { grantId: id, paths, origins, expires }); return id;
  }
  revoke(id: string): void {
    const grant = this.store.get('grant', id, this.sessionId);
    grant.revoked = true; this.store.put('grant', grant); this.emit('state', { revokedGrant: id });
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.tasks]); }
}
