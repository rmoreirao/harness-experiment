import {
  CopilotRequestHandler, type CopilotRequestContext, type CopilotWebSocketHandler,
  type SessionEvent,
} from '@github/copilot-sdk';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import { hash, type Config } from './config.js';
import { HarnessError, errorText, record, type ModelRequest } from './contracts.js';
import { errorDiagnostic } from './errors.js';
import { Resources } from './resources.js';

export interface VerificationBudget { maxTokens: number; outputTokens: number }
export interface TransportControls {
  admissionFailure?: (error: HarnessError) => void;
  observeOutput?: (limit: number | null) => void;
  verification?: VerificationBudget;
  modelActivity?: (request: ModelRequest) => void;
}
interface PendingRequest {
  request: ModelRequest;
  actorId?: string;
  interaction: string;
  model: string;
  settled: boolean;
}

const providerKeys = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_AI_API_KEY',
  'AZURE_AI_FOUNDRY_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY',
  'GROQ_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'BRAVE_SEARCH_API_KEY',
  'COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_HOME',
  'COPILOT_CONFIG_DIR', 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS', 'COPILOT_SKILLS_DIRS',
  'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'ANTHROPIC_BASE_URL', 'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_BASE_URL', 'HARNESS_MODEL', 'HARNESS_WIRE_MODEL', 'HARNESS_PROVIDER',
]);

export function runtimeEnvironment(_stateDirectory?: string, secretNames: readonly string[] = []): Record<string, string> {
  const excluded = new Set([...providerKeys, ...secretNames.map(name => name.toUpperCase())]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && !excluded.has(upper) &&
        !/^HARNESS_.*(?:API_?KEY|TOKEN|SECRET|PASSWORD)/.test(upper) &&
        !/^COPILOT_.*(?:CONFIG|SKILL|AGENT|HOOK|PLUGIN|MCP)/.test(upper) &&
        !/^(?:COPILOT|OTEL)_.*(?:ENDPOINT|HEADERS|EXPORTER)/.test(upper)) env[key] = value;
  }
  return {
    ...env, COPILOT_TELEMETRY_LEVEL: 'off', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true',
    COPILOT_TELEMETRY_DISABLED: 'true', COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT: 'NO_CONTENT', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
  };
}

export function configuredModels(config: Config): { id: string; wire: string }[] {
  return [{ id: config.model.canonical, wire: config.model.wire }, ...config.models]
    .filter((model, index, models) => models.findIndex(other => other.id === model.id) === index);
}
export function selectionId(config: Config, model: string): string {
  const id = configuredModels(config).some(candidate => candidate.id === model) ? model :
    model.startsWith('harness/') ? model.slice('harness/'.length) : model;
  if (!configuredModels(config).some(candidate => candidate.id === id)) {
    throw new HarnessError('MODEL_IDENTITY', `Model "${id}" is not configured for this session's provider.`);
  }
  return config.provider.kind === 'byok' ? `harness/${id}` : id;
}

export class ControlledModelTransport extends CopilotRequestHandler {
  private readonly admission: Resources;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly usageEvents = new Set<string>();
  constructor(private readonly config: Config, private readonly key: string, private readonly resources: Resources,
    private readonly objectiveSignal: () => AbortSignal, private readonly usage: () => void,
    private readonly controls: TransportControls = {}) {
    super();
    const models = configuredModels(config);
    if (new Set(models.map(model => model.wire)).size !== models.length) {
      throw new HarnessError('MODEL_IDENTITY', 'Configured models need distinct wire identifiers for unambiguous per-model accounting.');
    }
    if (config.provider.kind === 'copilot' && (resources.hasBudget || controls.verification)) {
      throw new HarnessError('COPILOT_BUDGET', 'Hard token/currency budgets are unsupported for Copilot allowances. Select BYOK or remove the hard budget.');
    }
    if (controls.verification) {
      const guard = z.object({
        maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        outputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(controls.verification);
      this.admission = new Resources(resources.store, {
        ...config, limits: { ...config.limits, maxTokens: Math.min(config.limits.maxTokens ?? guard.maxTokens, guard.maxTokens) },
      }, resources.sessionId, () => resources.current().id, 'verification');
    } else this.admission = resources;
  }
  protected override async openWebSocket(_context: CopilotRequestContext): Promise<CopilotWebSocketHandler> {
    throw new HarnessError('MODEL_TRANSPORT', 'This host admits observable HTTP/SSE model requests only.');
  }
  protected override async sendRequest(request: Request, context: CopilotRequestContext): Promise<Response> {
    const signal = AbortSignal.any([
      context.signal, this.objectiveSignal(), AbortSignal.timeout(this.config.limits.toolTimeoutMs),
    ]);
    const release = await this.resources.models.acquire(signal);
    let pending: PendingRequest | undefined;
    try {
      const requestBytes = Buffer.from(await request.clone().arrayBuffer());
      const encoding = request.headers.get('content-encoding')?.toLowerCase();
      const decompressOptions = { maxOutputLength: this.config.limits.maxResultBytes };
      const body = (encoding === 'gzip' ? gunzipSync(requestBytes, decompressOptions) :
        encoding === 'br' ? brotliDecompressSync(requestBytes, decompressOptions) :
          encoding === 'deflate' ? inflateSync(requestBytes, decompressOptions) : requestBytes).toString('utf8');
      if (Buffer.byteLength(body) > this.config.limits.maxResultBytes) throw new HarnessError('MODEL_BODY', 'Model request exceeds its body cap.');
      const data = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
      const wire = typeof data.model === 'string' ? data.model : '';
      const configured = configuredModels(this.config).find(model => model.wire === wire || model.id === wire);
      let destination: URL | undefined;
      if (this.config.provider.kind === 'byok') {
        destination = new URL(`${this.config.provider.baseURL.replace(/\/$/, '')}/responses`);
        if (!this.key && !['127.0.0.1', '[::1]', 'localhost'].includes(destination.hostname)) {
          throw new HarnessError('MODEL_CREDENTIAL', `${this.config.provider.apiKeyEnv} is missing; no model request was sent.`);
        }
        if (request.url !== destination.href || context.url !== destination.href || request.method !== 'POST') {
          throw new HarnessError('MODEL_DESTINATION', 'Unexpected model destination or provider fallback was blocked.');
        }
        if (!configured) throw new HarnessError('MODEL_IDENTITY', 'Runtime selected a wire model outside this session configuration.');
      }
      const model = configured?.id ?? (wire || this.config.model.canonical);
      const sdkOutput = typeof data.max_output_tokens === 'number' && Number.isSafeInteger(data.max_output_tokens) && data.max_output_tokens > 0
        ? data.max_output_tokens : typeof data.max_tokens === 'number' && Number.isSafeInteger(data.max_tokens) && data.max_tokens > 0
          ? data.max_tokens : null;
      this.controls.observeOutput?.(sdkOutput);
      if (this.controls.verification) data.max_output_tokens = Math.min(sdkOutput ?? this.controls.verification.outputTokens, this.controls.verification.outputTokens);
      const encoded = JSON.stringify(data);
      const input = this.admission.hasBudget && Array.isArray(data.input) ? {
        frameHash: hash(Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'input'))),
        items: data.input,
      } : undefined;
      const reservation = this.admission.beginModelRequest(
        Buffer.byteLength(encoded), context.interactionType ?? 'model-or-auxiliary', input,
        this.controls.verification ? Number(data.max_output_tokens) : sdkOutput,
        { provider: this.config.provider.kind, model, wireModel: wire,
          actorId: context.agentId },
      );
      pending = { request: reservation, model, actorId: context.agentId,
        interaction: context.interactionType ?? '', settled: false };
      this.pending.set(context.requestId, pending);
      this.controls.modelActivity?.(reservation);
      const response = destination
        ? await fetch(destination, {
          method: 'POST', signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${this.key}` },
          body: encoded,
        })
        : await super.sendRequest(new Request(request, { signal }), context);
      if (!response.ok || !response.body) {
        this.settle(pending, undefined, `HTTP ${response.status}`);
        this.recordError({ name: 'ModelHTTPError', code: 'MODEL_HTTP',
          message: `Model endpoint returned HTTP ${response.status}.`, status: response.status,
          requestID: response.headers.get('x-request-id') }, pending.request.id);
        release();
        return new Response(`Model endpoint returned HTTP ${response.status}.`, { status: response.status || 502 });
      }
      return this.observe(response, signal, pending, release);
    } catch (error) {
      if (pending) this.settle(pending, undefined, errorText(error), signal.aborted);
      release();
      this.recordError(error, pending?.request.id);
      if (!pending && error instanceof HarnessError) {
        this.controls.admissionFailure?.(error);
        const diagnostic = errorDiagnostic(error, this.resources.store.redactor);
        return new Response(JSON.stringify({ error: {
          type: 'harness_admission_error', code: diagnostic.code, message: diagnostic.message,
        } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      throw error;
    }
  }
  private observe(response: Response, signal: AbortSignal, pending: PendingRequest, release: () => void): Response {
    const reader = response.body!.getReader();
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder();
    let bytes = 0; let partial = ''; let usage: { input?: number; output?: number } | undefined; let finished = false;
    let terminal = false; let eventData: string[] = [];
    let streamError: string | undefined;
    const inspect = (text: string) => {
      if (!text) return;
      if (text === '[DONE]') { terminal = true; return; }
      const value: unknown = JSON.parse(text);
      if (!record(value)) return;
      const container = record(value.response) ? value.response : record(value.message) ? value.message : value;
      if (['response.completed', 'response.incomplete', 'response.failed', 'message_stop'].includes(String(value.type))) terminal = true;
      if (value.type === 'response.failed' || value.type === 'error') {
        const error = record(container.error) ? container.error : record(value.error) ? value.error : undefined;
        streamError = typeof error?.message === 'string' ? error.message : 'Provider reported a failed model response.';
      }
      if (!record(container.usage)) return;
      const input = container.usage.input_tokens ?? container.usage.prompt_tokens;
      const output = container.usage.output_tokens ?? container.usage.completion_tokens;
      if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) usage = { ...usage, input };
      if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) usage = { ...usage, output };
    };
    const line = (value: string) => {
      if (value.startsWith('data:')) eventData.push(value.slice(5).trimStart());
      else if (!value && eventData.length) { inspect(eventData.join('\n')); eventData = []; }
    };
    const finish = (error?: string) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', abort);
      const reported = terminal && typeof usage?.input === 'number' && typeof usage.output === 'number'
        ? { input: usage.input, output: usage.output } : undefined;
      if (reported || error || this.config.provider.kind === 'byok') this.settle(pending, reported, error ?? streamError, signal.aborted);
      release();
    };
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); finish('Model request cancelled.'); };
    signal.addEventListener('abort', abort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) {
            partial += decoder.decode();
            if (sse) {
              line(partial.trimEnd()); line('');
            } else { inspect(partial); terminal = true; }
            finish(); controller.close(); return;
          }
          bytes += chunk.value.length;
          if (bytes > this.config.limits.maxOutputBytes) throw new HarnessError('MODEL_OUTPUT', 'Model response body cap reached.');
          partial += decoder.decode(chunk.value, { stream: true });
          if (sse) {
            let newline: number;
            while ((newline = partial.indexOf('\n')) >= 0) {
              line(partial.slice(0, newline).trimEnd()); partial = partial.slice(newline + 1);
            }
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          try { await reader.cancel(error); }
          finally { finish(errorText(error)); this.recordError(error, pending.request.id, true); controller.error(error); }
        }
      },
      cancel: async reason => { try { await reader.cancel(reason); } finally { finish('Model stream cancelled.'); } },
    });
    const headers = new Headers(response.headers);
    headers.delete('content-encoding'); headers.delete('content-length');
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }
  observeUsage(event: Extract<SessionEvent, { type: 'assistant.usage' }>): void {
    if (this.config.provider.kind !== 'copilot') return;
    const accounting = event.data.accounting;
    const id = accounting ? `${accounting.sourceSessionId}:${accounting.sequence}:${accounting.usageId}` : event.data.apiCallId ?? event.id;
    if (event.checkpoint || this.usageEvents.has(id)) return;
    this.usageEvents.add(id);
    const candidates = [...this.pending.values()].filter(item => !item.settled &&
      item.actorId === event.agentId &&
      (item.model === event.data.model || item.request.wireModel === event.data.model));
    const pending = candidates.find(item => item.interaction === event.data.interactionType) ?? candidates[0];
    if (!pending) return;
    const input = event.data.inputTokens; const output = event.data.outputTokens;
    const usage = typeof input === 'number' && typeof output === 'number' ? { input, output } : undefined;
    this.settle(pending, usage);
  }
  reconcile(reason: string): void {
    for (const pending of this.pending.values()) if (!pending.settled) this.settle(pending, undefined, reason, true);
    this.pending.clear();
  }
  private settle(pending: PendingRequest, usage?: { input: number; output: number }, error?: string, cancelled = false): void {
    if (pending.settled) return;
    pending.settled = true;
    for (const [id, value] of this.pending) if (value === pending) this.pending.delete(id);
    this.admission.settle(pending.request, usage, error, false, cancelled);
    this.controls.modelActivity?.(pending.request); this.usage();
  }
  private recordError(error: unknown, callId?: string, streamStarted = false): void {
    this.resources.store.event({
      type: 'error', sessionId: this.resources.sessionId, objectiveId: this.resources.current().id,
      data: errorDiagnostic(error, this.resources.store.redactor, {
        source: 'model', operation: 'model request', model: this.config.model.wire, callId, streamStarted,
      }),
    });
  }
}
