import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Usage, type AgentInputItem,
  type Model, type ModelRequest, type ModelResponse, type StreamEvent, type StreamEventResponseCompleted,
} from '@openai/agents';
import { HarnessError, record } from './contracts.js';
import { hash } from './config.js';

export function inputText(item: AgentInputItem): string {
  if ('role' in item) {
    if (typeof item.content === 'string') return item.content;
    return item.content.map(c => 'text' in c && typeof c.text === 'string' ? c.text : '').join('\n');
  }
  return '';
}
type FakeOutput = StreamEventResponseCompleted['response']['output'][number];
export type FakeHandler = (request: ModelRequest) => FakeOutput[] | Promise<FakeOutput[]>;
function call(name: string, args: Record<string, unknown>, index: number): FakeOutput[] {
  return [{ type: 'function_call', name, arguments: JSON.stringify(args), callId: `fake-${name}-${index}`, status: 'completed' }];
}
function referenceResponse(request: ModelRequest): FakeOutput[] {
  const items = typeof request.input === 'string' ? [] : request.input;
  let start = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && 'role' in item && item.role === 'user') start = i;
  }
  const user = typeof request.input === 'string' ? request.input : start >= 0 ? inputText(items[start]!) : '';
  const turn = items.slice(start + 1);
  const calls = turn.filter(i => i.type === 'function_call');
  const results = turn.filter(i => i.type === 'function_call_result');
  const result = (name: string): unknown => {
    const c = calls.find(i => i.name === name);
    const r = results.find(i => i.callId === c?.callId);
    if (!r) return undefined;
    const text = typeof r.output === 'string' ? r.output :
      record(r.output) && 'text' in r.output && typeof r.output.text === 'string' ? r.output.text : undefined;
    if (!text) return undefined;
    try { return JSON.parse(text) as unknown; } catch { return undefined; }
  };
  const message = (text: string): FakeOutput[] => [{
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }],
  }];
  if (/\bask\b|\bclarif/i.test(user)) {
    if (!calls.some(c => c.name === 'ask_user')) return call('ask_user', { question: 'What should the summary emphasize?' }, items.length);
    return message(`Clarification received: ${JSON.stringify(result('ask_user'))}`);
  }
  if (!/summari[sz]|documents|reference/i.test(user)) return message(`OFFLINE FAKE MODEL: ${user}`);
  if (!calls.some(c => c.name === 'list_documents')) return call('list_documents', { folder: '.' }, items.length);
  const listed = result('list_documents');
  if (!record(listed) || !Array.isArray(listed.files) || listed.files.length === 0) return message('No supported documents were found.');
  if (!calls.some(c => c.name === 'read_documents')) return call('read_documents', { paths: listed.files.filter(f => f !== 'summary.md').slice(0, 4) }, items.length);
  const read = result('read_documents');
  if (!record(read) || !Array.isArray(read.documents)) return message('Document reading was denied or failed. No summary was saved.');
  const lines = read.documents.filter(record).map(d => `## Source: ${String(d.path)}\n${String(d.text).slice(0, 200)}\n`);
  const content = `# Document summary\n\nSynthetic offline demonstration; not a model-quality evaluation.\n\n${lines.join('\n')}`;
  if (!calls.some(c => c.name === 'write_file')) return call('write_file', { path: 'summary.md', content, expectedHash: 'new' }, items.length);
  const written = result('write_file');
  return record(written) && typeof written.path === 'string'
    ? message(`Summary saved to ${written.path}.\nSources: ${read.documents.filter(record).map(d => d.path).join(', ')}`)
    : message('Summary generated, but saving was rejected or failed. No successful save is claimed.');
}
export class FakeModel implements Model {
  constructor(private readonly handler: FakeHandler = referenceResponse, private readonly delayMs = 0) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse & { output: FakeOutput[] }> {
    request.signal?.throwIfAborted();
    const output = await this.handler(request);
    if (this.delayMs) await delay(this.delayMs, undefined, { signal: request.signal });
    return {
      usage: new Usage({ requests: 1, inputTokens: Math.ceil(JSON.stringify(request.input).length / 4),
        outputTokens: Math.ceil(JSON.stringify(output).length / 4) }),
      output, responseId: randomUUID(),
    };
  }
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'response_started' };
    const response = await this.getResponse(request);
    for (const item of response.output) {
      if ('role' in item && item.role === 'assistant') {
        for (const c of item.content) if (c.type === 'output_text') {
          for (const chunk of c.text.match(/.{1,24}/gs) ?? []) {
            request.signal?.throwIfAborted();
            if (this.delayMs) await delay(this.delayMs, undefined, { signal: request.signal });
            yield { type: 'output_text_delta', delta: chunk };
          }
        }
      }
    }
    yield { type: 'response_done', response: {
      id: response.responseId ?? hash(response), output: response.output,
      usage: { ...response.usage },
    } };
  }
}
export async function* safeRetryStream(model: Model, request: ModelRequest): AsyncIterable<StreamEvent> {
  for (let attempt = 0; ; attempt++) {
    let emitted = false;
    try {
      for await (const event of model.getStreamedResponse(request)) { emitted = true; yield event; }
      return;
    } catch (error) {
      if (attempt >= 2 || emitted || !record(error) || error.status !== 429 || request.signal?.aborted) throw error;
      await delay(100 * 2 ** attempt, undefined, { signal: request.signal });
    }
  }
}
export function assertUsage(usage: Usage): void {
  if (!usage.requests || !Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0 || !Number.isFinite(usage.outputTokens) ||
      usage.inputTokens + usage.outputTokens <= 0) {
    throw new HarnessError('USAGE_UNKNOWN', 'Provider did not report usable token accounting; run requires recovery before further spending.');
  }
}
