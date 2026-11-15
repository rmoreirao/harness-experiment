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
    private readonly objectiveId: () => string) {
    this.tools = new Semaphore(config.limits.concurrency);
  }
  current(): Objective { return this.store.get('objective', this.objectiveId(), this.sessionId); }
  check(): Objective {
    const objective = this.current();
    if (!['preparing', 'running', 'awaiting_approval', 'awaiting_input'].includes(objective.status)) throw new HarnessError('INACTIVE', 'No objective is admitted for execution.');
    if (Date.now() >= objective.deadline) throw new HarnessError('TIME_LIMIT', 'Objective deadline reached; waits and restart do not reset it.');
    if (objective.usage.unknown) throw new HarnessError('UNKNOWN_USAGE', 'Model usage requires reconciliation.');
    return objective;
  }
  action(): void {
    const objective = this.check();
    if (objective.actions >= this.config.limits.maxActions) throw new HarnessError('ACTION_LIMIT', 'Action cap reached.');
    objective.actions++; this.store.put('objective', objective);
  }
  reserve(bodyBytes: number, interaction: string, input?: { frameHash: string; items: readonly unknown[] }): ModelRequest {
    const objective = this.check();
    const limits = this.config.limits;
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) throw new HarnessError('MODEL_BODY', 'Invalid model request byte count.');
    const fingerprint = input ? {
      frameHash: hash([interaction, input.frameHash]), inputHash: hash(input.items), count: input.items.length,
    } : undefined;
    let inputBound = bodyBytes;
    if (input && fingerprint) {
      const prior = this.store.reportedModelAnchor(this.sessionId, fingerprint.frameHash);
      const prefix = prior?.inputFingerprint;
      if (prior && prefix && Number.isSafeInteger(prefix.count) && prefix.count >= 0 && prefix.count <= input.items.length &&
          hash(input.items.slice(0, prefix.count)) === prefix.inputHash) {
        const addedBytes = input.items.slice(prefix.count).reduce<number>((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
        inputBound = Math.min(bodyBytes, prior.input + prior.output + addedBytes);
      }
    }
    const reservation = inputBound + this.config.model.outputTokens + 4096;
    if (objective.usage.requests >= limits.maxRequests) throw new HarnessError('REQUEST_LIMIT', 'Model request cap reached.');
    if (objective.usage.input + objective.usage.output + objective.usage.reserved + reservation > limits.maxTokens) {
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
      input: 0, output: 0, status: 'reserved', interaction, error: null,
      requestBytes: bodyBytes, inputBound, inputFingerprint: fingerprint,
    };
    this.store.db.transaction(() => {
      objective.usage.reserved += reservation; objective.usage.requests++;
      this.store.put('model', request); this.store.put('objective', objective);
    })();
    return request;
  }
  settle(request: ModelRequest, usage?: { input: number; output: number }, error?: string, knownNoCharge = false): void {
    if (this.store.get('model', request.id, this.sessionId).status !== 'reserved') return;
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
      if (limits.inputPerMillion !== undefined) {
        objective.usage.cost = (objective.usage.cost ?? 0) +
          (usage.input * limits.inputPerMillion + usage.output * limits.outputPerMillion!) / 1e6;
      }
      if (usage.input + usage.output > request.reservation) objective.usage.unknown = true;
    } else if (!knownNoCharge) objective.usage.unknown = true;
    this.store.db.transaction(() => { this.store.put('model', request); this.store.put('objective', objective); })();
  }
}
