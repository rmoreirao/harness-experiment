import { Usage, type Model, type ModelRequest, type ModelResponse, type StreamEvent } from '@openai/agents';
import { HarnessError, type AppEvent, type RunRecord } from './contracts.js';
import { type Config } from './config.js';
import { Store } from './storage.js';
import { assertUsage, safeRetryStream } from './model.js';
import { modelInputUnits } from './context.js';

export class BudgetModel implements Model {
  constructor(
    readonly inner: Model, readonly config: Config, readonly store: Store,
    readonly runId: () => string, readonly emit: (event: Omit<AppEvent, 'sessionId' | 'runId'>) => Promise<void>,
  ) {}
  private admit(request: ModelRequest): RunRecord {
    request.signal?.throwIfAborted();
    const run = this.store.run(this.runId());
    const limits = this.config.limits;
    if (run.usage.unknown || run.usage.reserved) throw new HarnessError('USAGE_UNKNOWN', 'A previous provider request has unresolved usage.');
    if (run.usage.requests >= limits.maxIterations) throw new HarnessError('ITERATION_LIMIT', 'maxIterations reached.');
    if (run.activeMs >= limits.activeTimeoutMs) throw new HarnessError('TIME_LIMIT', 'Active execution time limit reached.');
    const input = modelInputUnits(request.input, request.systemInstructions, request.tools);
    if (input + limits.maxOutputTokens > limits.contextTokens) throw new HarnessError('CONTEXT_LIMIT', 'Working context cannot fit safely; use smaller inputs or a larger configured context.');
    const reservation = input + limits.maxOutputTokens;
    if (run.usage.input + run.usage.output + reservation > limits.maxTokens) throw new HarnessError('TOKEN_LIMIT', 'Insufficient token budget for the next request.');
    const predicted = (input * (limits.inputPerMillion ?? 0) + limits.maxOutputTokens * (limits.outputPerMillion ?? 0)) / 1e6;
    if (limits.maxCost !== undefined && (run.usage.cost ?? 0) + predicted > limits.maxCost) throw new HarnessError('COST_LIMIT', 'Insufficient currency budget for the next request.');
    run.usage.reserved = reservation;
    run.usage.requests++;
    run.contextUnits = input;
    this.store.putRun(run);
    return run;
  }
  private async account(response: ModelResponse): Promise<void> {
    assertUsage(response.usage);
    const run = this.store.run(this.runId());
    run.usage.input += response.usage.inputTokens;
    run.usage.output += response.usage.outputTokens;
    if (run.usage.cost !== null) run.usage.cost += (response.usage.inputTokens * (this.config.limits.inputPerMillion ?? 0) +
      response.usage.outputTokens * (this.config.limits.outputPerMillion ?? 0)) / 1e6;
    run.usage.reserved = 0;
    this.store.putRun(run);
    await this.emit({ type: 'usage', data: { ...run.usage } });
    if (run.usage.input + run.usage.output > this.config.limits.maxTokens ||
      (this.config.limits.maxCost !== undefined && (run.usage.cost ?? 0) > this.config.limits.maxCost)) {
      throw new HarnessError('BUDGET_OVERSHOOT', 'Reported usage exceeded the reservation; no further work is admitted.');
    }
  }
  private uncertain(): void {
    const run = this.store.run(this.runId());
    if (run.usage.reserved) {
      if (this.config.mode === 'fake') run.usage.reserved = 0;
      else run.usage.unknown = true;
      this.store.putRun(run);
    }
  }
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.admit(request);
    try {
      const response = await this.inner.getResponse(request);
      await this.account(response);
      return response;
    } catch (error) { this.uncertain(); throw error; }
  }
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.admit(request);
    let done = false;
    try {
      for await (const event of safeRetryStream(this.inner, request)) {
        if (event.type === 'response_done') {
          await this.account({ usage: new Usage(event.response.usage), output: event.response.output });
          done = true;
        }
        yield event;
      }
      if (!done) throw new HarnessError('PROVIDER', 'Model stream ended without a completed response.');
    } catch (error) { this.uncertain(); throw error; }
  }
}
