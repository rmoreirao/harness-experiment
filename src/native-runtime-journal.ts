import { randomUUID } from 'node:crypto';
import type { SessionEvent, SessionHooks, SubagentStartHookInput } from '@github/copilot-sdk';
import { hash, type Config } from './config.js';
import { HarnessError, errorText, record, type Action, type Worker, type RuntimeOptions, type ToolActor } from './contracts.js';
import type { Resources } from './resources.js';

type PreToolUseHookInput = Parameters<NonNullable<SessionHooks['onPreToolUse']>>[0];
type PostToolUseHookInput = Parameters<NonNullable<SessionHooks['onPostToolUse']>>[0];
type PostToolUseFailureHookInput = Parameters<NonNullable<SessionHooks['onPostToolUseFailure']>>[0];
function custom(name: string): boolean { return /^(?:custom:)?harness_/.test(name); }
function delegation(name: string): boolean {
  return /^(?:task|runSubagent|run_subagent|start_agent|run_agent|read_agent|write_agent|list_agents|agent|wait_agent|multi_tool_use\.parallel|parallel|run_program|run_dynamic_workflow)$/.test(name);
}
function spawnsWorker(name: string): boolean { return /^(?:task|runSubagent|run_subagent|start_agent|run_agent|agent)$/.test(name); }
function shellControl(name: string): boolean { return /^(?:read|stop|list)_(?:powershell|bash|shell)|^(?:read|stop|list)_agents?$/.test(name); }
function nativeEffect(name: string): Action['effect'] {
  if (delegation(name) || name === 'ask_user' || name === 'exit_plan_mode') return 'internal';
  if (shellControl(name)) return name.startsWith('stop_') ? 'internal' : 'read';
  if (/shell|powershell|bash|exec|command/.test(name)) return 'execute';
  if (/edit|write|patch|create|delete|move|replace/.test(name)) return 'write';
  if (/fetch|browse|search_web|web_/.test(name)) return 'network';
  return 'read';
}
function bounded(value: unknown, maximum: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  if (maximum < 20) return new TextDecoder().decode(bytes.subarray(0, maximum), { stream: true });
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, maximum - 20)), { stream: true }) + '\n[output truncated]';
}

export class NativeRuntimeJournal {
  private readonly actions = new Map<string, Action>();
  private readonly admitted = new Set<string>();
  private readonly commandReleases = new Map<string, () => void>();
  private readonly workerReleases = new Map<string, () => void>();
  private readonly workerReservations = new Map<string, { parent: string; name?: string; release: () => void }>();
  private readonly workers = new Map<string, Worker>();
  private readonly actorSessions = new Map<string, string>();
  private readonly sessionsActors = new Map<string, string>();
  private readonly workerSessions: { session: string; parent: string; name: string }[] = [];
  private readonly eventIds = new Set<string>();
  private readonly shellActions = new Map<string, Action>();
  private readonly hookOutput = new Map<string, unknown>();
  private readonly partialBytes = new Map<string, number>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private aborting = false;
  constructor(private readonly config: Config, private readonly resources: Resources,
    private readonly options: RuntimeOptions, private readonly signal: () => AbortSignal,
    private readonly onTimeout?: (action: Action) => void) {}

  hooks(): Pick<SessionHooks, 'onPreToolUse' | 'onPostToolUse' | 'onPostToolUseFailure' | 'onSubagentStart' | 'onSubagentStop'> {
    return {
      onPreToolUse: input => this.pre(input),
      onPostToolUse: input => this.post(input),
      onPostToolUseFailure: input => this.failed(input),
      onSubagentStart: (input, invocation) => this.startWorker(input, input.agentId ?? invocation.sessionId),
      onSubagentStop: (input, invocation) => { this.releaseWorker(input.agentId ?? invocation.sessionId); },
    };
  }
  private key(session: string, callId: string, objective = this.resources.current().id): string { return `${objective}\0${session}\0${callId}`; }
  private start(session: string, callId: string, tool: string, args: unknown, actorId?: string, parentCallId?: string): Action {
    const key = this.key(session, callId);
    const existing = this.actions.get(key);
    if (existing) {
      if (existing.tool !== tool || existing.argsHash !== hash(args ?? null)) throw new HarnessError('NATIVE_IDENTITY', 'A native invocation identity was reused with a different tool or arguments.');
      return existing;
    }
    const action: Action = {
      id: randomUUID(), sessionId: this.resources.sessionId, objectiveId: this.resources.current().id,
      callId, tool, argsHash: hash(args ?? null), args: record(args) ? args : { value: args ?? null },
      effect: nativeEffect(tool), status: 'started', resultId: null, error: null,
      origin: 'native', runtimeSessionId: session, actorId: actorId ?? this.sessionsActors.get(session),
      parentCallId, created: Date.now(), started: Date.now(),
    };
    this.actions.set(key, action); this.saveAction(action);
    return action;
  }
  private async pre(input: PreToolUseHookInput) {
    if (custom(input.toolName)) return;
    if (!input.toolCallId) return { permissionDecision: 'deny' as const,
      permissionDecisionReason: 'The runtime did not supply an invocation identity; native effects cannot be journaled safely.' };
    const key = this.key(input.sessionId, input.toolCallId);
    const previous = this.actions.get(key);
    if (previous && (previous.tool !== input.toolName || previous.argsHash !== hash(input.toolArgs ?? null) ||
        previous.status !== 'started' || this.admitted.has(key))) {
      const reason = previous.tool !== input.toolName || previous.argsHash !== hash(input.toolArgs ?? null)
        ? 'The native invocation identity was reused with changed arguments or a different tool.'
        : 'The native invocation identity has already been admitted or completed; its effects will not be replayed.';
      this.options.emit('runtime', { state: 'invocation_rejected', actionId: previous.id,
        callId: input.toolCallId, actorId: previous.actorId, reason });
      return { permissionDecision: 'deny' as const, permissionDecisionReason: reason };
    }
    const action = this.start(input.sessionId, input.toolCallId, input.toolName, input.toolArgs);
    this.admitted.add(key);
    try {
      this.resources.action();
      if (delegation(input.toolName)) {
        if (spawnsWorker(input.toolName)) {
          if (this.workerReleases.size + this.workerReservations.size >= this.config.limits.workerConcurrency) {
            throw new HarnessError('WORKER_LIMIT', 'Worker capacity is full. Finish an existing worker before delegating again; nested work was refused rather than queued behind its parent.');
          }
          const reservation = { parent: input.sessionId,
            name: record(input.toolArgs) && typeof input.toolArgs.agent_type === 'string' ? input.toolArgs.agent_type : undefined, release: () => {} };
          this.workerReservations.set(key, reservation);
          reservation.release = await this.resources.workers.acquire(this.signal());
        }
      } else if (!shellControl(input.toolName) && !['ask_user', 'exit_plan_mode'].includes(input.toolName)) {
        const signal = AbortSignal.any([this.signal(), AbortSignal.timeout(this.config.limits.toolTimeoutMs)]);
        this.commandReleases.set(key, await this.resources.tools.acquire(signal));
        if (this.onTimeout) {
          const timer = setTimeout(() => {
            this.finish(action, 'unknown', this.hookOutput.get(action.id),
              'Native tool deadline reached; cancellation is not rollback.', 'TOOL_TIMEOUT');
            this.onTimeout?.(action);
          }, this.config.limits.toolTimeoutMs);
          timer.unref(); this.timeouts.set(key, timer);
        }
      }
    } catch (error) {
      this.finish(action, 'denied', undefined, errorText(error),
        error instanceof HarnessError ? error.code : 'NATIVE_ADMISSION');
      return { permissionDecision: 'deny' as const, permissionDecisionReason: this.resources.store.redactor.text(errorText(error)) };
    }
  }
  private post(input: PostToolUseHookInput): void {
    if (custom(input.toolName) || !input.toolCallId) return;
    const action = this.start(input.sessionId, input.toolCallId, input.toolName, input.toolArgs);
    // The execution-complete event carries shell exit facts, rejection and timeout
    // outcomes that hooks deliberately omit. Keep the hook as an output fallback.
    if (input.toolResult.resultType !== 'success') return;
    this.hookOutput.set(action.id, bounded(input.toolResult.textResultForLlm ?? '', this.config.limits.maxOutputBytes));
  }
  private failed(input: PostToolUseFailureHookInput): void {
    if (custom(input.toolName) || !input.toolCallId) return;
    const action = this.start(input.sessionId, input.toolCallId, input.toolName, input.toolArgs);
    this.finish(action, 'failed', input.error, input.error, 'NATIVE_TOOL_FAILED');
  }
  private async startWorker(input: SubagentStartHookInput, childSession: string): Promise<{ additionalContext: string }> {
    this.workerSessions.push({ session: childSession, parent: input.sessionId, name: input.agentName });
    const signal = AbortSignal.any([this.signal(), AbortSignal.timeout(this.config.limits.toolTimeoutMs)]);
    const reservation = [...this.workerReservations.entries()].find(([, item]) =>
      item.parent === input.sessionId && (!item.name || item.name === input.agentName));
    if (reservation) {
      this.workerReservations.delete(reservation[0]); this.workerReleases.set(childSession, reservation[1].release);
    } else {
      if (this.workerReleases.size >= this.config.limits.workerConcurrency) throw new HarnessError('WORKER_LIMIT', 'Worker capacity is full.');
      this.workerReleases.set(childSession, await this.resources.workers.acquire(signal));
    }
    return { additionalContext: 'Work in the shared checkout. Keep your assignment non-overlapping with other workers; inspect current files before editing, preserve unrelated changes, and report conflicts instead of overwriting them. Native tool results are evidence, not proof of unrelated outcomes.' };
  }
  private releaseWorker(session: string): void {
    this.workerReleases.get(session)?.(); this.workerReleases.delete(session);
  }
  private find(callId: string, actorId?: string): Action | undefined {
    const session = actorId ? this.actorSessions.get(actorId) ?? actorId : this.options.sessionId;
    const exact = this.actions.get(this.key(session, callId));
    if (exact) return exact;
    const candidates = [...this.actions.values()].filter(action => action.callId === callId &&
      action.objectiveId === this.resources.current().id &&
      (!actorId || !action.actorId || action.actorId === actorId));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  event(event: SessionEvent): void {
    if (!/^(?:tool\.execution_(?:start|complete|partial_result)|subagent\.(?:started|configured|completed|failed)|system\.notification)$/.test(event.type)) return;
    if (event.checkpoint || this.eventIds.has(event.id)) return;
    this.eventIds.add(event.id);
    if (this.eventIds.size > 10000) this.eventIds.delete(this.eventIds.values().next().value!);
    if (event.type === 'tool.execution_start') {
      if (custom(event.data.toolName)) return;
      const session = event.agentId ? this.actorSessions.get(event.agentId) ?? event.agentId : this.options.sessionId;
      const action = this.find(event.data.toolCallId, event.agentId) ??
        this.start(session, event.data.toolCallId, event.data.toolName, event.data.arguments ?? {},
          event.agentId, event.data.parentToolCallId);
      if (event.agentId) action.actorId = event.agentId;
      action.parentCallId ??= event.data.parentToolCallId;
      this.saveAction(action);
    } else if (event.type === 'tool.execution_complete') {
      const action = this.find(event.data.toolCallId, event.agentId);
      if (!action) return;
      const code = event.data.error?.code;
      const denied = /denied|reject|permission/i.test(code ?? '') || /denied|rejected/i.test(event.data.error?.message ?? '');
      const exit = event.data.shellExecution?.exitCode ??
        event.data.result?.contents?.find(content => content.type === 'shell_exit')?.exitCode;
      const failed = !event.data.success || exit !== undefined && exit !== 0;
      const output = {
        success: !failed, ...(exit !== undefined ? { exitCode: exit } : {}),
        content: event.data.result?.detailedContent ?? event.data.result?.content ?? this.hookOutput.get(action.id) ?? '',
        ...(event.data.fileEdits ? { fileEdits: event.data.fileEdits } : {}),
        ...(event.data.error ? { error: event.data.error } : {}),
        runtimeSessionId: action.runtimeSessionId, toolCallId: action.callId,
      };
      for (const content of event.data.result?.contents ?? []) {
        if (content.type === 'shell_exit') {
          this.completeBackground(content.shellId, content.exitCode, content.outputPreview ?? String(output.content));
          if (action.effect === 'execute' && !this.shellActions.has(content.shellId)) this.shellActions.set(content.shellId, action);
        }
      }
      const shellId = /shellId:\s*([a-zA-Z0-9_-]+)/.exec(String(output.content))?.[1];
      if (shellId && action.effect === 'execute' && !this.shellActions.has(shellId)) this.shellActions.set(shellId, action);
      if (!failed && action.effect === 'execute' && exit === undefined &&
          (action.args.mode === 'async' || shellId && /\brunning\b/i.test(String(output.content)) ||
            /\b(?:still running|continues running|running in (?:the )?background)\b/i.test(String(output.content)))) {
        this.hookOutput.set(action.id, output);
        this.options.emit('runtime', { state: 'command_running', actionId: action.id, shellId: shellId ?? null });
      } else this.finish(action, denied ? 'denied' : failed ? 'failed' : 'completed', output,
        event.data.error?.message ?? (exit !== undefined && exit !== 0 ? `Command exited with code ${exit}.` : undefined), code);
    } else if (event.type === 'tool.execution_partial_result') {
      const action = this.find(event.data.toolCallId, event.agentId);
      if (action?.status !== 'started') return;
      const used = this.partialBytes.get(action.id) ?? 0;
      const remaining = this.config.limits.maxOutputBytes - used;
      if (remaining <= 0) return;
      const output = bounded(this.resources.store.redactor.value(event.data), Math.min(8192, remaining));
      this.partialBytes.set(action.id, used + Buffer.byteLength(output));
      this.options.emit('runtime', {
        state: 'tool_output', actionId: action.id, actorId: action.actorId,
        output,
      });
    } else if (event.type === 'subagent.started') {
      const id = event.agentId ?? `${event.data.toolCallId}:${event.data.agentName}`;
      const hook = this.workerSessions.find(item => item.name === event.data.agentName && !this.sessionsActors.has(item.session));
      if (hook) { this.actorSessions.set(id, hook.session); this.sessionsActors.set(hook.session, id); }
      const worker: Worker = {
        id, sessionId: this.resources.sessionId, objectiveId: this.resources.current().id,
        name: event.data.agentName, status: 'running', callId: event.data.toolCallId,
        parentId: event.data.parentId, model: event.data.model, started: Date.parse(event.timestamp),
      };
      this.workers.set(id, worker); this.saveWorker(worker);
    } else if (event.type === 'subagent.configured') {
      const worker = event.agentId ? this.workers.get(event.agentId) : undefined;
      if (worker) { worker.model = event.data.model; this.saveWorker(worker); }
    } else if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      const worker = (event.agentId ? this.workers.get(event.agentId) : undefined) ??
        [...this.workers.values()].find(item => item.callId === event.data.toolCallId && item.name === event.data.agentName);
      if (!worker) return;
      worker.status = event.type === 'subagent.failed' ? 'failed' : event.data.cancelled ? 'cancelled' : 'completed';
      worker.finished = Date.parse(event.timestamp); worker.model = event.data.model ?? worker.model;
      if (event.type === 'subagent.failed') worker.error = event.data.error;
      this.releaseWorker(this.actorSessions.get(worker.id) ?? worker.id);
      this.saveWorker(worker);
    } else if (event.type === 'system.notification' &&
      (event.data.kind.type === 'shell_completed' || event.data.kind.type === 'shell_detached_completed')) {
      const action = this.shellActions.get(event.data.kind.shellId);
      if (action) {
        const exit = event.data.kind.type === 'shell_completed' ? event.data.kind.exitCode : undefined;
        if (exit !== undefined) this.completeBackground(event.data.kind.shellId, exit, event.data.content);
        this.options.emit('runtime', { state: 'shell_completed', actionId: action.id, shellId: event.data.kind.shellId });
      }
    }
  }
  private capture(action: Action, content: unknown): void {
    if (action.resultId) return;
    const used = this.resources.store.list('result', action.sessionId, action.objectiveId).reduce((sum, item) => sum + item.bytes, 0);
    const remaining = this.config.limits.maxResultBytes - used;
    if (remaining <= 0) throw new HarnessError('RESULT_LIMIT', 'Objective result storage limit reached; native output could not be preserved.');
    const maximum = Math.min(remaining, this.config.limits.maxOutputBytes);
    const value = this.resources.store.redactor.value(content);
    let text = typeof value === 'string' ? bounded(value, maximum) : JSON.stringify(value);
    let mediaType = typeof value === 'string' ? 'text/plain' : 'application/json';
    if (Buffer.byteLength(text) > maximum) {
      if (maximum < 128) { text = bounded(text, maximum); mediaType = 'text/plain'; }
      else text = JSON.stringify({
        ...(record(value) ? { success: value.success, exitCode: value.exitCode } : {}),
        truncated: true, content: bounded(record(value) && typeof value.content === 'string' ? value.content : text, Math.max(20, Math.floor((maximum - 96) / 6))),
      });
    }
    const result = this.resources.store.result(action.sessionId, action.objectiveId, action.id, text, {
      origin: 'native', tool: action.tool, runtimeSessionId: action.runtimeSessionId,
      toolCallId: action.callId, actorId: action.actorId,
    }, mediaType);
    action.resultId = result.id; this.options.emit('result', { result });
  }
  private finish(action: Action, status: Action['status'], content?: unknown, error?: string, code?: string): void {
    if (['denied', 'unknown', 'resolved'].includes(action.status)) return;
    if (['completed', 'failed'].includes(action.status)) {
      if (action.status !== 'completed' || status !== 'failed') return;
    }
    if (content !== undefined && !action.resultId) this.capture(action, content);
    action.status = status; action.error = error ? this.resources.store.redactor.text(error) : null;
    action.errorCode = code; action.finished = Date.now();
    this.hookOutput.delete(action.id); this.partialBytes.delete(action.id);
    const key = this.key(action.runtimeSessionId!, action.callId, action.objectiveId);
    clearTimeout(this.timeouts.get(key)); this.timeouts.delete(key);
    this.commandReleases.get(key)?.(); this.commandReleases.delete(key);
    this.workerReservations.get(key)?.release(); this.workerReservations.delete(key);
    this.saveAction(action);
  }
  private saveAction(action: Action): void { this.resources.store.put('action', action); this.options.emit('action', { action }); }
  private saveWorker(worker: Worker): void { this.resources.store.put('worker', worker); this.options.emit('runtime', { state: 'worker', worker }); }
  actor(sessionId: string, agentId?: string): ToolActor {
    const actorId = agentId ?? this.sessionsActors.get(sessionId) ??
      (sessionId !== this.options.sessionId ? sessionId : undefined);
    const runtimeSessionId = actorId ? this.actorSessions.get(actorId) ??
      (sessionId !== this.options.sessionId ? sessionId : actorId) : sessionId;
    return { runtimeSessionId, actorId, parentCallId: actorId ? this.workers.get(actorId)?.callId : undefined };
  }
  completeBackground(shellId: string, exitCode: number | undefined, output: string, cancelled = false): void {
    const action = this.shellActions.get(shellId);
    if (!action || action.status !== 'started') return;
    this.finish(action, cancelled || exitCode === undefined ? 'unknown' : exitCode === 0 ? 'completed' : 'failed',
      { shellId, exitCode: exitCode ?? null, output, success: !cancelled && exitCode === 0 },
      cancelled ? 'Command was cancelled; inspect partial effects.' : exitCode === undefined ? 'Command ended without a verified exit status.' :
        exitCode !== 0 ? `Command exited with code ${exitCode}.` : undefined,
      cancelled ? 'NATIVE_EFFECT_UNKNOWN' : exitCode === undefined ? 'NATIVE_EXIT_UNKNOWN' : undefined);
  }
  trackBackground(shellId: string, command: string): void {
    if (this.shellActions.has(shellId)) return;
    const candidates = [...this.actions.values()].filter(action =>
      action.status === 'started' && action.effect === 'execute' && action.args.command === command);
    if (candidates.length === 1) this.shellActions.set(shellId, candidates[0]!);
  }
  releaseFinishedCommand(shellId: string): void {
    const action = this.shellActions.get(shellId);
    if (!action) return;
    const key = this.key(action.runtimeSessionId!, action.callId, action.objectiveId);
    clearTimeout(this.timeouts.get(key)); this.timeouts.delete(key);
    this.commandReleases.get(key)?.(); this.commandReleases.delete(key);
  }
  unfinished(): boolean {
    return this.pendingActivity(true);
  }
  active(): boolean {
    return this.pendingActivity(false);
  }
  private pendingActivity(unknown: boolean): boolean {
    const objective = this.resources.store.latest(this.resources.sessionId)?.id;
    if (!objective) return false;
    return this.resources.store.list('action', this.resources.sessionId, objective)
      .some(action => action.origin === 'native' && (['started', 'pending'].includes(action.status) || unknown && action.status === 'unknown')) ||
      this.resources.store.list('worker', this.resources.sessionId, objective)
        .some(worker => worker.status === 'running' || unknown && worker.status === 'unknown');
  }
  interrupt(reason: string): void {
    this.aborting = true;
    for (const action of this.actions.values()) {
      if (['started', 'pending'].includes(action.status)) this.finish(action, 'unknown', undefined, reason, 'NATIVE_EFFECT_UNKNOWN');
    }
    for (const worker of this.workers.values()) {
      if (worker.status !== 'running') continue;
      worker.status = 'unknown'; worker.error = reason; this.saveWorker(worker);
    }
    for (const release of this.commandReleases.values()) release();
    this.commandReleases.clear();
    for (const release of this.workerReleases.values()) release();
    this.workerReleases.clear();
    for (const item of this.workerReservations.values()) item.release();
    this.workerReservations.clear();
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
  }
  reconcile(): void {
    if (!this.options.resume) return;
    for (const action of this.resources.store.list('action', this.resources.sessionId)) {
      if (action.origin !== 'native' || !['pending', 'started'].includes(action.status)) continue;
      action.status = 'unknown'; action.error = 'Native execution was interrupted. Inspect its effects before continuing; it was not replayed.';
      action.errorCode = 'NATIVE_RECOVERY'; action.finished = Date.now(); this.saveAction(action);
    }
    for (const worker of this.resources.store.list('worker', this.resources.sessionId)) {
      if (worker.status !== 'running') continue;
      worker.status = 'unknown'; worker.error = 'Worker lifecycle was interrupted; its effects require inspection.'; this.saveWorker(worker);
    }
  }
  get cancelled(): boolean { return this.aborting; }
}
