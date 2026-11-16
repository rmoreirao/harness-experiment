import { randomUUID } from 'node:crypto';
import { HarnessError } from '../contracts.js';
import { hash } from '../config.js';
import type { V2Store } from './store.js';
import type { V2Config } from './config.js';
import type { ModelRequest, Objective } from './contracts.js';

export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly maximum: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    while (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiters = this.waiters.filter(item => item !== wake); reject(signal.reason); };
        this.waiters.push(wake); signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
    }
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; this.waiters.shift()?.(); } };
  }
}
export class Resources {
  readonly tools: Semaphore;
  readonly models = new Semaphore(1);
  constructor(readonly store: V2Store, readonly config: V2Config, readonly sessionId: string,
    private readonly objectiveId: () => string, private readonly scope: 'objective' | 'verification' = 'objective') {
    this.tools = new Semaphore(config.limits.concurrency);
  }
  current(): Objective { return this.store.get('objective', this.objectiveId(), this.sessionId); }
  get hasBudget(): boolean { return this.config.limits.maxTokens !== undefined || this.config.limits.maxCost !== undefined; }
  pending(): ModelRequest[] {
    return this.store.list('model', this.sessionId, this.current().id)
      .filter(request => request.status === 'started' || request.status === 'reserved');
  }
  check(): Objective {
    const objective = this.current();
    if (!['preparing', 'running', 'awaiting_approval', 'awaiting_input'].includes(objective.status)) throw new HarnessError('INACTIVE', 'No objective is admitted for execution.');
    if (Date.now() >= objective.deadline) throw new HarnessError('TIME_LIMIT', 'Objective deadline reached; waits and restart do not reset it.');
    if (this.hasBudget && (objective.usage.unknown || this.config.limits.maxCost !== undefined && objective.usage.cost === null)) {
      throw new HarnessError('UNKNOWN_USAGE', 'Model usage requires reconciliation before enforcing the configured budget.');
    }
    return objective;
  }
  action(): void {
    const objective = this.check();
    if (objective.actions >= this.config.limits.maxActions) throw new HarnessError('ACTION_LIMIT', 'Action cap reached.');
    objective.actions++; this.store.put('objective', objective);
  }
  beginModelRequest(bodyBytes: number, interaction: string, input?: { frameHash: string; items: readonly unknown[] },
    outputLimit?: number | null): ModelRequest {
    const objective = this.check();
    const limits = this.config.limits;
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) throw new HarnessError('MODEL_BODY', 'Invalid model request byte count.');
    if (objective.usage.requests >= limits.maxRequests) throw new HarnessError('REQUEST_LIMIT', 'Model request cap reached.');
    const fingerprint = this.hasBudget && input ? {
      frameHash: hash([interaction, input.frameHash]), inputHash: hash(input.items), count: input.items.length,
    } : undefined;
    let inputBound = bodyBytes;
    if (this.hasBudget && input && fingerprint) {
      const prior = this.store.reportedModelAnchor(this.sessionId, fingerprint.frameHash);
      const prefix = prior?.inputFingerprint;
      if (prior && prefix && Number.isSafeInteger(prefix.count) && prefix.count >= 0 && prefix.count <= input.items.length &&
          hash(input.items.slice(0, prefix.count)) === prefix.inputHash) {
        const addedBytes = input.items.slice(prefix.count).reduce<number>((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
        inputBound = Math.min(bodyBytes, prior.input + prior.output + addedBytes);
      }
    }
    const output = outputLimit === undefined ? this.config.model.outputTokens : outputLimit;
    let reservation = 0;
    if (this.hasBudget) {
      if (typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0) {
        throw new HarnessError('BUDGET_OUTPUT_LIMIT', 'The explicit budget requires a finite request output bound. Set model.outputTokens; no default output limit was invented and no model request was sent.');
      }
      reservation = inputBound + output + 4096;
      if (!Number.isSafeInteger(reservation)) throw new HarnessError('BUDGET_BOUND', 'The request reservation exceeds the safe accounting range; no model request was sent.');
    }
    if (limits.maxTokens !== undefined && objective.usage.input + objective.usage.output + objective.usage.reserved + reservation > limits.maxTokens) {
      const used = objective.usage.input + objective.usage.output;
      const available = limits.maxTokens - used - objective.usage.reserved;
      throw new HarnessError('TOKEN_LIMIT', `Insufficient tokens: ${used}/${limits.maxTokens} used; next reservation ${reservation}, remaining ${available}. No model request was sent.`);
    }
    if (limits.maxCost !== undefined) {
      const maximumPrice = Math.max(limits.inputPerMillion!, limits.outputPerMillion!);
      if ((objective.usage.cost ?? 0) + (objective.usage.reserved + reservation) * maximumPrice / 1e6 > limits.maxCost) {
        throw new HarnessError('COST_LIMIT', 'Insufficient currency to reserve the model request.');
      }
    }
    const request: ModelRequest = {
      id: randomUUID(), sessionId: this.sessionId, objectiveId: objective.id, reservation,
      input: 0, output: 0, status: this.hasBudget ? 'reserved' : 'started', interaction, error: null,
      requestBytes: bodyBytes, ...(this.hasBudget ? { inputBound, inputFingerprint: fingerprint } : {}),
      budgetScope: this.hasBudget ? this.scope : 'none',
    };
    this.store.db.transaction(() => {
      objective.usage.reserved += reservation; objective.usage.requests++;
      this.store.put('model', request); this.store.put('objective', objective);
    })();
    return request;
  }
  reserve(bodyBytes: number, interaction: string, input?: { frameHash: string; items: readonly unknown[] }): ModelRequest {
    return this.beginModelRequest(bodyBytes, interaction, input);
  }
  settle(request: ModelRequest, usage?: { input: number; output: number }, error?: string, knownNoCharge = false): void {
    if (!['started', 'reserved'].includes(this.store.get('model', request.id, this.sessionId).status)) return;
    const objective = this.store.get('objective', request.objectiveId, this.sessionId);
    const valid = usage && Number.isSafeInteger(usage.input) && usage.input >= 0 &&
      Number.isSafeInteger(usage.output) && usage.output >= 0;
    request.status = valid ? 'completed' : knownNoCharge ? 'failed' : 'unknown';
    request.reportedUsage = Boolean(valid);
    request.error = error ?? null;
    objective.usage.reserved -= request.reservation;
    if (valid) {
      request.input = usage.input; request.output = usage.output;
      objective.usage.input += usage.input; objective.usage.output += usage.output;
      const limits = this.config.limits;
      if (limits.inputPerMillion !== undefined && objective.usage.cost !== null) {
        objective.usage.cost +=
          (usage.input * limits.inputPerMillion + usage.output * limits.outputPerMillion!) / 1e6;
      }
      if (request.status === 'completed' && request.reservation > 0 && usage.input + usage.output > request.reservation) objective.usage.unknown = true;
    } else if (!knownNoCharge) { objective.usage.unknown = true; objective.usage.cost = null; }
    this.store.db.transaction(() => { this.store.put('model', request); this.store.put('objective', objective); })();
  }
}
