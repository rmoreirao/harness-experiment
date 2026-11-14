import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import type { FunctionTool } from '@openai/agents';
import { z } from 'zod';
import { type Config, hash } from './config.js';
import { HarnessError, type RunContextData, type AppEvent, type Task, type Invocation, record, errorText } from './contracts.js';
import { FileTools } from './files.js';
import { Store } from './storage.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: FunctionTool<RunContextData>['parameters'];
  effect: Invocation['effect'];
  approval: boolean;
  authorize?: (args: Record<string, unknown>) => void;
  execute: (args: Record<string, unknown>, runId: string, signal: AbortSignal, callId: string) => Promise<unknown> | unknown;
}
const pathsSchema = z.object({ paths: z.array(z.string().min(1)).min(1).max(16) });
const writeSchema = z.object({ path: z.string().min(1), content: z.string(), expectedHash: z.string().min(1) });
const tasksSchema = z.object({ tasks: z.array(z.object({
  id: z.string().min(1), title: z.string().min(1), status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
})).max(100) });
function objectSchema(schema: z.ZodObject): FunctionTool<RunContextData>['parameters'] {
  const json = z.toJSONSchema(schema, { target: 'draft-7' });
  return { ...json, type: 'object', properties: json.properties ?? {}, required: json.required ?? [], additionalProperties: false };
}

export class Gateway {
  readonly definitions = new Map<string, ToolDefinition>();
  private readonly validators = new Map<string, ReturnType<Ajv['compile']>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  readonly files: FileTools;
  constructor(
    readonly config: Config, readonly store: Store, readonly sessionId: string,
    readonly emit: (event: Omit<AppEvent, 'sessionId' | 'runId'>) => Promise<void>,
    readonly signal: () => AbortSignal,
  ) {
    this.files = new FileTools(config, store, sessionId);
    this.register({
      name: 'list_documents', description: 'List supported document names in an allowed folder; no file contents.',
      parameters: { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'], additionalProperties: false },
      effect: 'read', approval: false,
      authorize: a => { this.files.resolve(z.string().parse(a.folder)); },
      execute: a => this.files.list(z.string().parse(a.folder)),
    });
    this.register({
      name: 'read_documents', description: 'Read explicit UTF-8 .txt/.md documents after user approval. Contents go to the configured model.',
      parameters: objectSchema(pathsSchema), effect: 'read', approval: true,
      authorize: a => { for (const p of pathsSchema.parse(a).paths) this.files.resolve(p); },
      execute: a => this.files.read(pathsSchema.parse(a).paths),
    });
    this.register({
      name: 'search_documents', description: 'Search approved document contents using a literal query.',
      parameters: objectSchema(pathsSchema.extend({ query: z.string().min(1).max(200) })),
      effect: 'read', approval: true,
      authorize: a => { for (const p of pathsSchema.parse(a).paths) this.files.resolve(p); },
      execute: a => {
        const query = z.string().parse(a.query);
        return this.files.read(pathsSchema.parse(a).paths).documents.map(d => ({
          path: d.path, matches: d.text.split(/\r?\n/).flatMap((line, i) => line.includes(query) ? [{ line: i + 1, text: line }] : []).slice(0, 100),
        }));
      },
    });
    this.register({
      name: 'write_file', description: 'Save a text/Markdown file after separate user approval. expectedHash must be "new" or a hash from an approved read.',
      parameters: objectSchema(writeSchema), effect: 'write', approval: true,
      authorize: a => { this.files.resolve(writeSchema.parse(a).path, true); },
      execute: (a, runId) => {
        const { path: p, content, expectedHash } = writeSchema.parse(a);
        const artifact = this.files.write(runId, p, content, expectedHash);
        this.store.addArtifact(artifact);
        return artifact;
      },
    });
    this.register({
      name: 'set_tasks', description: 'Record progress of a bounded task list, separately from model history.',
      parameters: objectSchema(tasksSchema), effect: 'internal', approval: false,
      execute: a => { const tasks: Task[] = tasksSchema.parse(a).tasks; this.store.setTasks(sessionId, tasks); return { tasks }; },
    });
    this.register({
      name: 'ask_user', description: 'Ask a focused clarification question and wait for an answer.',
      parameters: objectSchema(z.object({ question: z.string().min(1).max(2000) })),
      effect: 'internal', approval: true,
      execute: (_a, runId, _signal, callId) => {
        const q = this.store.requests(runId).find(r => r.callId === callId && r.status === 'answered');
        if (!q) throw new HarnessError('QUESTION', 'Question has not been answered.');
        return { answer: q.answer };
      },
    });
  }
  register(def: ToolDefinition, refresh = false): void {
    if (def.effect === 'write' || def.effect === 'external' || (def.effect === 'read' && def.name !== 'list_documents')) {
      def = { ...def, approval: true };
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) throw new HarnessError('TOOLS', 'Tool names must be safe identifiers of at most 64 characters.');
    const previous = this.definitions.get(def.name);
    if (previous && (!refresh || hash({ ...previous, execute: null }) !== hash({ ...def, execute: null }))) {
      throw new HarnessError('TOOLS', `Duplicate or changed tool: ${def.name}`);
    }
    const ajv = new Ajv({ strict: false, allErrors: true });
    this.validators.set(def.name, ajv.compile(def.parameters));
    this.definitions.set(def.name, def);
  }
  get uncontained(): boolean { return this.inFlight.size > 0; }
  prepare(name: string, args: unknown): Record<string, unknown> {
    if (this.config.enabledTools && !this.config.enabledTools.includes(name)) throw new HarnessError('TOOL_POLICY', `${name} is not enabled for this session.`);
    const def = this.definitions.get(name);
    const validate = this.validators.get(name);
    if (!def || !validate || !record(args) || !validate(args)) throw new HarnessError('TOOL_INPUT', `Invalid arguments for ${name}.`);
    def.authorize?.(args);
    return args;
  }
  tools(): FunctionTool<RunContextData>[] {
    return [...this.definitions.values()].map(def => ({
      type: 'function', name: def.name, description: def.description, parameters: def.parameters,
      strict: false, needsApproval: async (_context, args) => { this.prepare(def.name, args); return def.approval; },
      isEnabled: async () => true,
      invoke: async (context, raw, details) => {
        const callId = details?.toolCall?.callId;
        if (!callId) throw new HarnessError('TOOL_ID', 'Tool invocation has no stable call ID.');
        const args: unknown = JSON.parse(raw);
        return this.execute(def.name, this.prepare(def.name, args), context.context.runId, callId);
      },
    }));
  }
  async execute(name: string, args: Record<string, unknown>, runId: string, callId: string): Promise<string> {
    const def = this.definitions.get(name);
    if (!def) throw new HarnessError('TOOL', 'Unknown tool.');
    this.prepare(name, args);
    if (def.approval) {
      const approval = this.store.requests(runId).find(r => r.callId === callId && r.tool === name);
      if (!approval || !['approved', 'answered'].includes(approval.status) || hash(approval.args) !== hash(args)) {
        throw new HarnessError('APPROVAL', 'Exact current tool approval is required.');
      }
    }
    const id = `${runId}:${callId}`;
    const previous = this.store.invocation(id);
    if (previous) {
      if (previous.argsHash !== hash(args) || previous.tool !== name) throw new HarnessError('REPLAY', 'Invocation identity changed.');
      if (previous.status === 'completed' && previous.output !== null) return previous.output;
      throw new HarnessError('UNCERTAIN', 'This invocation requires reconciliation; it will not be replayed automatically.');
    }
    this.signal().throwIfAborted();
    const invocation: Invocation = { id, runId, tool: name, argsHash: hash(args), status: 'started', effect: def.effect, output: null, error: null, outputPath: null };
    this.store.putInvocation(invocation);
    await this.emit({ type: 'tool', data: { id, tool: name, status: 'started', args } });
    const controller = new AbortController();
    const parent = this.signal();
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new HarnessError('TOOL_TIMEOUT', `${name} exceeded toolTimeoutMs.`)), this.config.limits.toolTimeoutMs);
    try {
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return def.execute(args, runId, controller.signal, callId);
      });
      this.inFlight.add(operation);
      const settled = operation.finally(() => this.inFlight.delete(operation));
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      let output: unknown;
      try { output = await Promise.race([settled, aborted]); }
      finally { if (abortListener) controller.signal.removeEventListener('abort', abortListener); }
      controller.signal.throwIfAborted();
      const full = JSON.stringify(this.store.redactor.value(output));
      if (full === undefined) throw new HarnessError('TOOL_OUTPUT', 'Tool must return a JSON-serializable result.');
      let modelOutput = full;
      let outputPath: string | null = null;
      const modelLimit = Math.min(this.config.limits.maxToolBytes, Math.floor(this.config.limits.contextTokens / 6));
      if (Buffer.byteLength(full) > modelLimit) {
        const dir = path.join(this.config.dataDir, 'outputs', this.sessionId);
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${randomUUID()}.json`);
        writeFileSync(file, full, { flag: 'wx' });
        outputPath = file;
        modelOutput = JSON.stringify({ truncated: true, resultId: id, preview: full.slice(0, Math.floor(modelLimit / 3)) });
      }
      this.store.putInvocation({ ...invocation, status: 'completed', output: modelOutput, outputPath });
      this.store.addTranscript(this.sessionId, runId, 'tool', `${name} [${id}]: ${modelOutput}`);
      await this.emit({ type: 'tool', data: { id, tool: name, status: 'completed', preview: modelOutput.slice(0, 1000) } });
      return modelOutput;
    } catch (error) {
      const knownPrecondition = error instanceof HarnessError && ['STALE_WRITE', 'SCOPE', 'FORMAT', 'FILE_LIMIT'].includes(error.code);
      const knownFileError = record(error) && ['EEXIST', 'ENOENT'].includes(String(error.code));
      const status = (def.effect === 'external' || def.effect === 'write') && !knownPrecondition && !knownFileError ? 'unknown' : 'failed';
      this.store.putInvocation({ ...invocation, status, error: this.store.redactor.text(errorText(error)) });
      await this.emit({ type: 'error', data: { tool: name, status, message: errorText(error) } });
      throw error;
    } finally { clearTimeout(timeout); parent.removeEventListener('abort', abort); }
  }
}
