import { createServer, type ServerResponse } from 'node:http';
import { record } from '../src/contracts.js';

export const providerKey = 'synthetic-provider-wire-key';
function event(res: ServerResponse, type: string, data: Record<string, unknown>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}
export function complete(res: ServerResponse, id: string, output: Record<string, unknown>[], text?: string,
  usage: boolean | { input_tokens: number; output_tokens: number; total_tokens: number } = true): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  event(res, 'response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
  for (const [index, item] of output.entries()) {
    event(res, 'response.output_item.added', { output_index: index, item });
    if (item.type === 'message' && text) {
      event(res, 'response.content_part.added', { item_id: item.id, output_index: index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
      event(res, 'response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: text });
      event(res, 'response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text });
    }
    if (item.type === 'function_call') {
      event(res, 'response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
    }
    event(res, 'response.output_item.done', { output_index: index, item });
  }
  event(res, 'response.completed', { response: {
    id, object: 'response', created_at: 1, model: 'wire-fixture', status: 'completed', output,
    usage: usage === true ? { input_tokens: 100, output_tokens: 40, total_tokens: 140 } : usage || undefined,
  } });
  res.end();
}
export function message(text: string): Record<string, unknown>[] {
  return [{ id: 'msg_wire', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }];
}
export async function provider(handler: (res: ServerResponse, body: Record<string, unknown>, count: number) => void, apiKey = providerKey) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== '/v1/responses' || req.headers.authorization !== `Bearer ${apiKey}`) throw new Error('Unexpected fixture URL or authorization.');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(body)) throw new Error('Invalid wire fixture request');
      requests.push(body);
      handler(res, body, requests.length);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }

  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No provider fixture port');
  return { requests, baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

// Feed the real SDK's controlled model transport without binding a port or
// contacting a provider. Responses use the same synchronous SSE fixture above.
export function memoryProvider(handler: (res: ServerResponse, body: Record<string, unknown>, count: number) => void) {
  const requests: Record<string, unknown>[] = [];
  const baseURL = 'http://127.0.0.1:9/v1';
  let closed = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (closed || request.url !== `${baseURL}/responses` || request.method !== 'POST' ||
        request.headers.get('authorization') !== `Bearer ${providerKey}`) {
      throw new Error('Unexpected in-memory provider destination or authorization; no network request was sent.');
    }
    const body: unknown = JSON.parse(await request.text());
    if (!record(body)) throw new Error('Invalid in-memory model request.');
    requests.push(body);
    let status = 200;
    let headers: Record<string, string> = {};
    let ended = false;
    const chunks: string[] = [];
    const response = {
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; return response; },
      write(chunk: string) { chunks.push(chunk); return true; },
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); ended = true; return response; },
    };
    handler(response as unknown as ServerResponse, body, requests.length);
    if (!ended) throw new Error('In-memory provider fixtures must complete synchronously.');
    return new Response(chunks.join(''), { status, headers });
  };
  return { requests, baseURL, fetch, close: async () => { closed = true; } };
}
