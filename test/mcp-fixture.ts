import { createServer, type Server } from 'node:http';
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

function makeServer(counter?: string): McpServer {
  const server = new McpServer({ name: 'synthetic-fixture', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo synthetic fixture input', inputSchema: { text: z.string() } },
    async ({ text }) => {
      if (counter) appendFileSync(counter, 'called\n');
      return { content: [{ type: 'text', text }], structuredContent: { text, providerKeyInherited: Boolean(process.env.OPENAI_API_KEY) } };
    });
  server.registerTool('slow', { description: 'Synthetic long-running operation', inputSchema: { text: z.string() } },
    async () => { await delay(30000); return { content: [{ type: 'text', text: 'completed late' }] }; });
  return server;
}
export async function httpFixture(): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) throw new Error('Fixture body limit');
      }
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      if (body && typeof body === 'object' && 'method' in body && body.method === 'tools/call') calls++;
      const mcp = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await transport.handleRequest(req, res, body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return { server, url: `http://127.0.0.1:${address.port}/mcp`, calls: () => calls };
}
if (process.argv.includes('--stdio')) {
  await makeServer(process.argv[process.argv.indexOf('--stdio') + 1]).connect(new StdioServerTransport());
}
