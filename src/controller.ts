import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash, parseConfig, configSecretEnvironmentNames, type Config } from './config.js';
import { HarnessError, errorText, type Action, type ModelLimits, type Objective, type Runtime, type AppEvent, type PermissionMode, type TaskMode } from './contracts.js';
import { errorDiagnostic } from './errors.js';
import { Ownership } from './ownership.js';
import { Redactor } from './privacy.js';
import { Store } from './store.js';
import { Resources } from './resources.js';
import { ActionBroker } from './policy.js';
import { ProtectedNetwork } from './network.js';
import { Research } from './research.js';
import { DockerExecution } from './execution.js';
import { ControlledBrowser } from './browser.js';
import { CopilotRuntime } from './runtime.js';

export interface OpenOptions {
  config: Config;
  sessionId?: string;
  trusted?: boolean;
  apiKey?: string;
  searchKey?: string;
  runtimeFactory?: (resources: Resources, signal: () => AbortSignal) => Runtime;
}
const activeStatuses = ['preparing', 'running', 'awaiting_approval', 'awaiting_input', 'recovery_required'];
export class SessionController {
  readonly id: string;
  private runtimeIdentity: string;
  get runtimeId(): string { return this.runtimeIdentity; }
  readonly store: Store;
  readonly config: Config;
  readonly broker: ActionBroker;
  readonly resources: Resources;
  private readonly owner: Ownership;
  private readonly runtime: Runtime;
  private readonly execution: DockerExecution;
  private readonly browser: ControlledBrowser;
  private readonly listeners = new Set<(event: AppEvent) => void>();
  private currentId = '';
  private aborter = new AbortController();
  private job?: Promise<Objective>;
  private closing?: Promise<void>;
  private clearing?: Promise<void>;
  private opening?: Promise<void>;
  private resetFailed = false;
  private closed = false;
  private runtimeOpen = false;
  private runtimeCreated = false;
  private runtimeError: string | null = null;
  private modelLimits?: ModelLimits;
  private constructor(options: OpenOptions, store: Store, owner: Ownership, id: string) {
    this.store = store; this.owner = owner; this.id = id;
    const session = store.session(id); this.runtimeIdentity = session.runtimeId;
    this.config = parseConfig(session.config);
    this.resources = new Resources(store, this.config, id, () => {
      if (!this.currentId) throw new HarnessError('OBJECTIVE', 'No current objective.');
      return this.currentId;
    });
    this.broker = new ActionBroker(store, this.config, id, this.resources, () => this.aborter.signal,
      (type, data) => this.emit(type, data));
    const network = new ProtectedNetwork(this.config);
    new Research(store, id, network, options.searchKey ?? process.env.BRAVE_SEARCH_API_KEY).register(this.broker);
    this.execution = new DockerExecution(this.config, store, id); this.execution.register(this.broker);
    this.browser = new ControlledBrowser(store, id, network); this.browser.register(this.broker);
    const key = options.apiKey ?? (this.config.provider.kind === 'byok' ? process.env[this.config.provider.apiKeyEnv] : undefined) ?? '';
    this.runtime = options.runtimeFactory?.(this.resources, () => this.aborter.signal) ??
      new CopilotRuntime(this.config, key, this.resources, () => this.aborter.signal);
    this.registerStateTools();
    if (!store.list('sessionPolicy', id).length) store.put('sessionPolicy', {
      id, sessionId: id, trusted: false, taskMode: this.config.taskMode,
    });
    if (options.trusted === true) this.trust(true);
    this.runtimeCreated = Boolean(store.db.prepare<[string, string], { found: number }>(
      `SELECT 1 AS found FROM events WHERE session_id=? AND type='runtime' AND json_extract(data,'$.state')='creating'
       AND seq>COALESCE((SELECT MAX(seq) FROM events WHERE session_id=? AND type='runtime'
         AND json_extract(data,'$.state')='context_cleared'),0) LIMIT 1`).get(id, id));
    const objective = store.conversationObjectives(id).at(-1);
    if (objective) {
      this.currentId = objective.id;
      if (activeStatuses.includes(objective.status)) {
        for (const action of store.list('action', id, objective.id)) {
          if (action.status === 'started' || action.status === 'pending') {
            action.status = action.status === 'started' ? 'unknown' : 'denied'; store.put('action', action);
          }
        }
        for (const worker of store.list('worker', id, objective.id)) {
          if (worker.status === 'running') { worker.status = 'unknown'; store.put('worker', worker); }
        }
        for (const decision of store.list('decision', id, objective.id)) {
          if (decision.status === 'pending') { decision.status = 'expired'; store.put('decision', decision); }
        }
        for (const request of store.list('model', id, objective.id)) {
          if (request.status === 'reserved' || request.status === 'started') {
            request.status = 'unknown'; objective.usage.reserved -= request.reservation;
            objective.usage.unknown = true; objective.usage.cost = null; store.put('model', request);
          }
        }
        objective.status = 'recovery_required';
        objective.reason = 'Interrupted native work requires explicit reconciliation. No actions or expired decisions were replayed.';
        store.put('objective', objective);
      }
    }
  }
  static async open(options: OpenOptions): Promise<SessionController> {
    const config = parseConfig(options.config);
    const key = config.provider.kind === 'byok' ? process.env[config.provider.apiKeyEnv] : undefined;
    const redactor = new Redactor([options.apiKey ?? key ?? '', options.searchKey ?? process.env.BRAVE_SEARCH_API_KEY ?? '',
      ...configSecretEnvironmentNames(config).map(name => process.env[name] ?? '')]);
    const store = new Store(config.dataDir, redactor);
    let owner: Ownership | undefined;
    try {
      const session = options.sessionId ? store.session(options.sessionId) : store.createSession(config);
      if (path.resolve(session.config.dataDir) !== config.dataDir || hash(session.config) !== hash(config)) {
        throw new HarnessError('CONFIG', 'Resume must restore the exact saved native configuration.');
      }
      owner = new Ownership(config.dataDir, `native-session:${session.id}`);
      return new SessionController(options, store, owner, session.id);
    } catch (error) { owner?.close(); store.close(); throw error; }
  }
  get trusted(): boolean { return this.store.get('sessionPolicy', this.id, this.id).trusted; }
  get taskMode(): TaskMode { return this.store.get('sessionPolicy', this.id, this.id).taskMode; }
  trust(approved: boolean): void {
    const trusted = z.boolean().parse(approved);
    this.owner.assert();
    if (this.closed || this.closing || this.job || this.opening || this.runtimeOpen) throw new HarnessError('BUSY', 'Trust must be decided before the runtime starts.');
    const policy = this.store.get('sessionPolicy', this.id, this.id);
    policy.trusted = trusted; this.store.put('sessionPolicy', policy);
    this.emit('state', { trusted, unsandboxed: true });
  }
  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private emit(type: AppEvent['type'], data: Record<string, unknown>): void {
    if (type === 'runtime' && !data.actorId && data.state === 'permission_mode' &&
        (data.mode === 'manual' || data.mode === 'assisted' || data.mode === 'allow-all')) {
      this.store.put('approvalPolicy', { id: this.id, sessionId: this.id, mode: data.mode, approveAll: data.mode === 'allow-all' });
    }
    if (type === 'runtime' && !data.actorId && data.state === 'task_mode' &&
        (data.mode === 'interactive' || data.mode === 'plan' || data.mode === 'autopilot')) {
      const policy = this.store.get('sessionPolicy', this.id, this.id);
      policy.taskMode = data.mode; this.store.put('sessionPolicy', policy);
    }
    if (type === 'text' && !data.actorId && !data.parentCallId && typeof data.message === 'string' && this.currentId) {
      const objective = this.resources.current();
      objective.output = this.store.redactor.text(data.message); this.store.put('objective', objective);
    }
    if (type === 'error' && !data.actorId && data.source !== 'tool' && this.runtimeError === null) this.runtimeError = String(data.message ?? 'Runtime reported an error.');
    const event = this.store.event({ type, sessionId: this.id, objectiveId: this.currentId || null, data });
    for (const listener of this.listeners) listener(event);
  }
  inspect() {
    this.owner.assert();
    const objective = this.currentId ? this.resources.current() : undefined;
    const actions = objective ? this.store.list('action', this.id, objective.id) : [];
    const activeModels = objective ? this.resources.pending() : [];
    return {
      sessionId: this.id, runtimeId: this.runtimeId, provider: this.config.provider.kind,
      model: this.config.model.canonical, workspace: this.config.workspace,
      objective, busy: Boolean(this.job || this.clearing || this.opening), trusted: this.trusted, unsandboxed: true,
      approveAll: this.broker.approveAll, permissionMode: this.broker.permissionMode, taskMode: this.taskMode,
      pending: objective ? this.store.list('decision', this.id, objective.id).filter(item => item.status === 'pending') : [],
      actions, workers: objective ? this.store.list('worker', this.id, objective.id) : [],
      assignments: objective ? this.store.list('assignment', this.id, objective.id) : [],
      verificationDomains: objective ? this.verificationDomains(objective, actions) : ['general'],
      recentErrors: this.store.recentActionErrors(this.id),
      modelLimits: this.modelLimits ?? {
        model: this.config.model.canonical, providerCapacityVerified: false,
        prompt: { limit: this.config.model.contextTokens ?? null, used: null,
          source: this.config.model.contextTokens !== undefined ? 'explicit override' : 'unavailable' },
        output: { limit: this.config.model.outputTokens ?? null,
          source: this.config.model.outputTokens !== undefined ? 'explicit override' : 'SDK/provider default' },
        compactionThreshold: null,
      },
      budget: { maxTokens: this.config.limits.maxTokens ?? null, maxCost: this.config.limits.maxCost ?? null,
        mode: this.resources.hasBudget ? 'explicit' : 'none',
        scope: 'intercepted model and explicitly priced domain requests', externalCharges: 'not covered' },
      pendingModelRequests: activeModels.length, activeModels,
      results: objective ? this.store.list('result', this.id, objective.id) : [],
    };
  }
  async listSkills() { await this.ensureRuntime(); return { skills: await this.runtime.listSkills() }; }
  async plan(): Promise<string | null> { await this.ensureRuntime(); return this.runtime.readPlan(); }
  async reloadSkills() {
    this.assertIdle();
    if (this.runtimeOpen) { await this.runtime.close(); this.runtimeOpen = false; }
    return this.listSkills();
  }
  trace(before?: number) {
    this.owner.assert();
    return this.currentId ? this.store.activity(this.id, this.currentId, before) : { items: [], next: null };
  }
  traceCall(query: string) {
    this.owner.assert();
    if (!this.currentId) throw new HarnessError('TRACE_ID', 'No current objective to inspect.');
    return this.store.activityCall(this.id, this.currentId, query);
  }
  private assertIdle(): void {
    this.owner.assert();
    if (this.closed || this.closing || this.job || this.clearing || this.opening ||
        (this.currentId && activeStatuses.includes(this.resources.current().status))) throw new HarnessError('BUSY', 'Finish or reconcile the current objective first.');
  }
  private async ensureRuntime(): Promise<void> {
    this.owner.assert();
    if (!this.trusted) throw new HarnessError('TRUST_REQUIRED', 'Native execution is unsandboxed. Explicitly trust this session before loading workspace hooks, MCP servers or tools.');
    if (this.closed || this.closing) throw new HarnessError('CLOSED', 'Session is closing.');
    if (this.runtimeOpen) return;
    if (this.opening) return this.opening;
    const work = (async () => {
      const resume = this.runtimeCreated;
      this.runtimeCreated = true; this.emit('runtime', { state: 'creating', resume });
      await this.runtime.open({
        sessionId: this.runtimeId, resume,
        directory: path.join(this.config.dataDir, 'runtime', this.id, this.runtimeId),
        tools: this.broker.tools(), signal: this.aborter.signal, emit: (type, data) => this.emit(type, data),
        permissionMode: this.broker.permissionMode, taskMode: this.taskMode,
        permission: (request, invocation) => this.broker.permission(request, invocation),
        onContext: limits => { this.modelLimits = limits; },
        question: (question, choices, allowFreeform) => this.broker.question(question, choices, allowFreeform),
        beforeStop: () => this.beforeStop(),
      });
      const effective = await this.runtime.setPermissionMode(this.broker.permissionMode);
      this.broker.setPermissionMode(effective);
      this.runtimeOpen = true;
    })();
    this.opening = work;
    try { await work; } finally { this.opening = undefined; }
  }
  async auth(action: 'status' | 'login' | 'advance' | 'cancel', input?: string) {
    const selected = z.enum(['status', 'login', 'advance', 'cancel']).parse(action);
    const value = z.string().max(4000).optional().parse(input);
    if (value !== undefined && !['login', 'advance'].includes(selected)) throw new HarnessError('AUTH_INPUT', 'Only login and advance accept explicit authentication input.');
    if (selected !== 'cancel') this.assertIdle();
    await this.ensureRuntime();
    return this.runtime.auth(selected, value);
  }
  async mcp(action: 'list' | 'status' | 'login', serverName?: string) {
    const selected = z.enum(['list', 'status', 'login']).parse(action);
    const name = z.string().min(1).max(200).optional().parse(serverName);
    if (selected === 'list' ? name !== undefined : name === undefined) throw new HarnessError('MCP_INPUT', 'Use list without a server name, or status/login with an explicit configured server name.');
    if (selected === 'login') this.assertIdle();
    await this.ensureRuntime();
    return this.runtime.mcp(selected, name);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.owner.assert();
    if (!this.trusted) throw new HarnessError('TRUST_REQUIRED', 'Trust this native session before selecting execution permissions.');
    if (this.closed || this.closing) throw new HarnessError('CLOSED', 'Session is closing.');
    const selected = z.enum(['manual', 'assisted', 'allow-all']).parse(mode);
    const effective = this.runtimeOpen ? await this.runtime.setPermissionMode(selected) : selected;
    this.broker.setPermissionMode(effective);
    if (effective !== selected) throw new HarnessError('PERMISSION_MODE', `Runtime retained ${effective}; requested ${selected} was not applied.`);
  }
  async setApproveAll(enabled: boolean): Promise<void> { await this.setPermissionMode(enabled ? 'allow-all' : 'manual'); }
  async setTaskMode(mode: TaskMode): Promise<void> {
    this.assertIdle();
    const selected = z.enum(['interactive', 'plan', 'autopilot']).parse(mode);
    if (this.runtimeOpen) await this.runtime.setTaskMode(selected);
    const policy = this.store.get('sessionPolicy', this.id, this.id);
    policy.taskMode = selected; this.store.put('sessionPolicy', policy); this.emit('state', { taskMode: selected });
  }
  async submit(original: string, options: { domain?: Objective['domain']; criteria?: string[] } = {}): Promise<Objective> {
    this.assertIdle();
    if (!this.trusted) throw new HarnessError('TRUST_REQUIRED', 'Explicitly trust the native session before submitting work.');
    if (this.resetFailed) throw new HarnessError('CONTEXT', 'Retry /clear after the failed context reset.');
    const goal = z.string().trim().min(1).max(100000).parse(original);
    const criteria = z.array(z.string().min(1).max(2000)).max(30).parse(options.criteria ?? []);
    const objective: Objective = {
      id: randomUUID(), sessionId: this.id, original: goal,
      domain: z.enum(['general', 'coding', 'research', 'browser']).parse(options.domain ?? 'general'), criteria,
      status: 'preparing', created: Date.now(), deadline: Date.now() + this.config.limits.timeoutMs,
      plan: null, replans: 0, actions: 0, output: '', reason: null,
      usage: { input: 0, output: 0, requests: 0, reserved: 0, cost: this.resources.rates() ? 0 : null, unknown: false },
    };
    this.currentId = objective.id; this.store.put('objective', objective);
    return this.start(goal);
  }
  private async start(prompt: string): Promise<Objective> {
    this.aborter = new AbortController(); this.runtimeError = null;
    const work = Promise.resolve().then(() => this.drive(prompt));
    this.job = work;
    try { return await work; } finally { this.job = undefined; }
  }
  private async drive(prompt: string): Promise<Objective> {
    const objective = this.resources.current();
    const timer = setTimeout(() => this.aborter.abort(new HarnessError('TIME_LIMIT', 'Objective deadline reached.')), Math.max(1, objective.deadline - Date.now()));
    try {
      this.resources.check(); await this.ensureRuntime(); this.aborter.signal.throwIfAborted();
      const current = this.resources.current(); current.status = 'running'; this.store.put('objective', current); this.emit('state', { objective: current });
      await this.runtime.send(`${prompt}\n\nObjective ID: ${current.id}. Domain: ${current.domain}.
Acceptance criteria: ${JSON.stringify(current.criteria)}.
Use SDK planning and native tools. Coordinate non-overlapping file assignments before delegating writers.
Capture real command output and review the resulting diff for coding work. Never treat an unrelated successful command as verification.
Use the retained research evidence tools when citation-verified research is required. Native retrieval alone is not a verified report.
Do not claim completion with active workers, unknown effects or missing acceptance evidence.`);
      await this.broker.drain();
      const observed = this.resources.current();
      observed.plan = await this.runtime.readPlan();
      this.store.put('objective', observed); this.emit('plan', { content: observed.plan });
      const failures = this.validation();
      const final = this.resources.current();
      final.status = failures.length ? 'partial' : 'completed'; final.reason = failures.length ? failures.join(' ') : 'Recorded native activity and objective evidence requirements satisfied.';
      if (this.runtimeError) { final.status = 'failed'; final.reason = this.runtimeError; }
      if (this.unknownEffects()) { final.status = 'recovery_required'; final.reason = 'Unresolved native effects, workers or model usage require reconciliation.'; }
      this.store.put('objective', final); this.emit('state', { objective: final }); return final;
    } catch (error) {
      await this.runtime.abort(); await this.broker.drain();
      const final = this.resources.current();
      final.status = this.unknownEffects() ? 'recovery_required' : this.aborter.signal.aborted ? 'cancelled' : 'failed';
      final.reason = this.runtimeError ?? errorText(error); this.store.put('objective', final);
      this.emit('error', errorDiagnostic(error, this.store.redactor, { operation: 'objective', status: final.status }));
      this.emit('state', { objective: final }); return final;
    } finally { clearTimeout(timer); }
  }
  private unknownEffects(): boolean {
    const current = this.resources.current();
    return (this.resources.hasBudget && current.usage.unknown) || current.usage.reserved !== 0 || this.resources.pending().length !== 0 ||
      this.store.list('action', this.id, current.id).some(item => ['started', 'unknown'].includes(item.status)) ||
      this.store.list('worker', this.id, current.id).some(item => ['running', 'unknown'].includes(item.status));
  }
  private validation(): string[] {
    const current = this.resources.current(); const reasons: string[] = [];
    if (!current.output.trim()) reasons.push('No final parent answer was recorded.');
    const actions = this.store.list('action', this.id, current.id);
    if (actions.some(item => ['pending', 'started', 'unknown'].includes(item.status))) reasons.push('Native/custom activity is unresolved.');
    if (this.unknownEffects()) reasons.push('Usage, workers or side effects are unresolved.');
    if (this.taskMode === 'plan') return reasons;
    const domains = this.verificationDomains(current, actions);
    if (domains.includes('coding')) {
      const latestCommands = new Map(actions.filter(item => item.origin === 'native' && item.effect === 'execute')
        .map(item => [`${item.tool}:${item.argsHash}`, item]));
      if ([...latestCommands.values()].some(item => ['failed', 'denied'].includes(item.status))) {
        reasons.push('A native command failed or was denied without a subsequent successful result for that command.');
      }
      const nativeCheck = actions.some(item => item.origin === 'native' && item.status === 'completed' && item.effect === 'execute' && item.resultId &&
        !/^(?:task|delegate|agent)/i.test(item.tool));
      const dockerCheck = this.store.list('execution', this.id, current.id).some(item => item.status === 'completed' && item.exitCode === 0 && item.outputResultId);
      if (!nativeCheck && !dockerCheck) reasons.push('No successful native or Docker verification command was recorded.');
    }
    const results = this.store.list('result', this.id, current.id);
    if (domains.includes('research') && !results.some(item => item.provenance.kind === 'research_report')) reasons.push('No citation-verified research report was recorded.');
    if (domains.includes('browser') && !actions.some(item => item.status === 'completed' && item.tool === 'browser_verify')) reasons.push('No observed browser acceptance evidence was recorded.');
    return reasons;
  }
  private verificationDomains(objective: Objective, actions: Action[]): Objective['domain'][] {
    const domains = new Set<Objective['domain']>();
    if (objective.domain !== 'general') domains.add(objective.domain);
    if (actions.some(item => item.tool.startsWith('browser_'))) domains.add('browser');
    if (actions.some(item => ['web_search', 'web_fetch', 'research_claim', 'research_report'].includes(item.tool))) domains.add('research');
    if (actions.some(item => item.effect === 'write' || ['execution_run', 'execution_publish'].includes(item.tool))) domains.add('coding');
    return domains.size ? [...domains] : ['general'];
  }
  private async beforeStop(): Promise<string | null> {
    const current = this.resources.check();
    const failures = this.validation();
    if (!failures.length || current.replans >= this.config.limits.maxReplans) return null;
    current.replans++; this.store.put('objective', current);
    return `Objective evidence is incomplete (${current.replans}/${this.config.limits.maxReplans}): ${failures.join(' ')} Continue within scope or explain the blocker honestly.`;
  }
  private registerStateTools(): void {
    this.broker.register('work_inspect', 'Inspect the objective, recorded output and worker assignments without replaying effects.', z.object({}).strict(), 'internal',
      () => ({ objective: this.resources.current(), results: this.store.list('result', this.id, this.currentId),
        workers: this.store.list('worker', this.id, this.currentId), assignments: this.store.list('assignment', this.id, this.currentId) }));
    this.broker.register('result_read', 'Read a bounded stored-result page without repeating the action.', z.object({
      id: z.string().uuid(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32768).default(8192),
    }).strict(), 'internal', args => this.store.readResult(this.id, args.id, args.offset, args.limit));
    this.broker.register('work_assign', 'Reserve non-overlapping file paths before delegating a writer. This coordinates work; it is not filesystem confinement.', z.object({
      worker: z.string().min(1).max(200), paths: z.array(z.string().min(1)).min(1).max(100),
    }).strict(), 'internal', args => {
      const paths = [...new Set(args.paths.map(file => path.resolve(this.config.workspace, file)))];
      const overlaps = (a: string, b: string) => {
        const left = a.toLowerCase(), right = b.toLowerCase();
        return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
      };
      const conflict = this.store.list('assignment', this.id, this.currentId).find(item =>
        item.status === 'active' && item.worker !== args.worker && item.paths.some(a => paths.some(b => overlaps(a, b))));
      if (conflict) throw new HarnessError('EDIT_CONFLICT', `Paths are already assigned to ${conflict.worker}. Coordinate or release assignment ${conflict.id}.`);
      const assignment = { id: randomUUID(), sessionId: this.id, objectiveId: this.currentId, worker: args.worker, paths, status: 'active' as const };
      this.store.put('assignment', assignment); this.emit('state', { assignment }); return assignment;
    });
    this.broker.register('work_release', 'Release a completed writer assignment.', z.object({ id: z.string().uuid() }).strict(), 'internal', args => {
      const assignment = this.store.get('assignment', args.id, this.id);
      if (assignment.objectiveId !== this.currentId) throw new HarnessError('ASSIGNMENT', 'Assignment belongs to another objective.');
      assignment.status = 'released'; this.store.put('assignment', assignment); this.emit('state', { assignment }); return assignment;
    });
  }
  decide(id: string, revision: number, binding: string, answer: string, source: 'human_response' | 'external' = 'external'): void {
    this.broker.decide(id, revision, binding, answer, source);
  }
  async cancel(): Promise<void> {
    this.owner.assert(); this.aborter.abort(new HarnessError('CANCELLED', 'Cancelled by the user.'));
    await this.runtime.abort(); await this.job; await this.broker.drain();
    if (this.currentId) for (const decision of this.store.list('decision', this.id, this.currentId)) {
      if (decision.status === 'pending') { decision.status = 'expired'; this.store.put('decision', decision); }
    }
  }
  async reconcile(input: { note: string; actions?: { id: string; note: string }[]; workers?: { id: string; note: string }[]; usage?: { id: string; input: number; output: number }[] }): Promise<void> {
    if (this.job || !input.note.trim()) throw new HarnessError('RECOVERY', 'Stop work and provide a reconciliation note.');
    const objective = this.resources.current();
    if (objective.status !== 'recovery_required') throw new HarnessError('RECOVERY', 'No objective requires reconciliation.');
    if (this.resources.pending().length) throw new HarnessError('RECOVERY', 'Pending model requests must stop before reconciliation.');
    this.store.db.transaction(() => {
      for (const resolution of input.actions ?? []) {
        const action = this.store.get('action', resolution.id, this.id);
        if (action.objectiveId !== objective.id || !['unknown', 'started'].includes(action.status) || !resolution.note.trim()) throw new HarnessError('RECOVERY', 'Invalid exact action reconciliation.');
        action.status = 'resolved'; action.error = resolution.note; this.store.put('action', action);
      }
      for (const resolution of input.workers ?? []) {
        const worker = this.store.get('worker', resolution.id, this.id);
        if (worker.objectiveId !== objective.id || !['unknown', 'running'].includes(worker.status) || !resolution.note.trim()) throw new HarnessError('RECOVERY', 'Invalid exact worker reconciliation.');
        worker.status = 'resolved'; worker.error = resolution.note; this.store.put('worker', worker);
      }
      for (const usage of input.usage ?? []) {
        z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).parse(usage);
        const request = this.store.get('model', usage.id, this.id);
        if (request.objectiveId !== objective.id || request.status !== 'unknown') throw new HarnessError('RECOVERY', 'Invalid model-request reconciliation.');
        request.status = 'completed'; request.reportedUsage = true; request.input = usage.input; request.output = usage.output;
        objective.usage.input += usage.input; objective.usage.output += usage.output; this.store.put('model', request);
      }
      if (this.store.list('action', this.id, objective.id).some(item => ['started', 'unknown'].includes(item.status)) ||
          this.store.list('worker', this.id, objective.id).some(item => ['running', 'unknown'].includes(item.status)) ||
          this.resources.hasBudget && this.store.list('model', this.id, objective.id).some(item => item.status === 'unknown')) {
        throw new HarnessError('RECOVERY', 'Every unknown effect, worker and budgeted request must be reconciled.');
      }
      objective.usage.unknown = this.store.list('model', this.id, objective.id).some(item => item.status === 'unknown');
      const actions = this.store.list('action', this.id, objective.id);
      const requests = this.store.list('model', this.id, objective.id);
      objective.usage.cost = objective.usage.unknown || actions.some(item => item.cost === null) || requests.some(item => !this.resources.rates(item.model)) ? null :
        requests.reduce((sum, item) => {
          const rates = this.resources.rates(item.model)!;
          return sum + (item.input * rates.input + item.output * rates.output) / 1e6;
        }, 0) + actions.reduce((sum, item) => sum + (item.cost ?? 0), 0);
      objective.status = 'partial'; objective.reason = input.note; this.store.put('objective', objective);
      this.emit('state', { objective, reconciled: true });
    })();
  }
  async continueObjective(): Promise<Objective> {
    if (this.job || this.clearing || this.closing || this.closed) throw new HarnessError('BUSY', 'Work is active or closing.');
    const current = this.resources.current();
    if (current.status !== 'partial') throw new HarnessError('CONTINUATION', 'Only reconciled/partial objectives can continue.');
    current.status = 'preparing'; this.store.put('objective', current);
    return this.start(`Continue the same objective without resetting scope or limits: ${current.original}`);
  }
  async clearContext(): Promise<void> {
    this.assertIdle();
    if (this.currentId && this.unknownEffects()) throw new HarnessError('BUSY', 'Reconcile unresolved effects before clearing context.');
    const work = (async () => {
      this.resetFailed = true; this.runtimeOpen = false; await this.runtime.close();
      const { session, event } = this.store.clearContext(this.id);
      this.runtimeIdentity = session.runtimeId; this.currentId = ''; this.runtimeCreated = false;
      this.modelLimits = undefined; this.runtimeError = null; this.resetFailed = false;
      this.aborter = new AbortController();
      for (const listener of this.listeners) listener(event);
    })();
    this.clearing = work;
    try { await work; } finally { this.clearing = undefined; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const work = this.shutdown(); this.closing = work;
    void work.catch(() => { if (this.closing === work) this.closing = undefined; });
    return work;
  }
  private async shutdown(): Promise<void> {
    if (this.closed) return;
    const failures: unknown[] = [];
    if (this.clearing) {
      try { await this.clearing; } catch (error) { failures.push(error); }
    }
    if (this.opening) {
      try { await this.opening; } catch (error) { failures.push(error); }
    }
    try { await this.cancel(); } catch (error) { failures.push(error); }
    try { await this.browser.close(); } catch (error) { failures.push(error); }
    try { await this.execution.close(); } catch (error) { failures.push(error); }
    try { await this.runtime.close(); } catch (error) { failures.push(error); }
    if (this.currentId) {
      const objective = this.resources.current();
      if (failures.length || activeStatuses.includes(objective.status) || this.unknownEffects()) {
        objective.status = 'recovery_required'; objective.reason ??= 'Interrupted native work requires reconciliation.';
        this.store.put('objective', objective);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Native shutdown was not clean. Inspect recorded state and retry closing; the session lock is retained.');
    this.owner.close(); this.store.close(); this.closed = true;
  }
}
