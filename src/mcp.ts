import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Config, hash } from './config.js';
import { HarnessError, errorText, record } from './contracts.js';
import { Gateway } from './gateway.js';

const execFileAsync = promisify(execFile);
export class McpConnections {
  private connections: { client: Client; stdio?: StdioClientTransport }[] = [];
  async connect(config: Config, gateway: Gateway, refresh = false): Promise<void> {
    try {
      for (const server of config.mcp) {
        const client = new Client({ name: 'harness-experiment', version: '0.1.0' });
        const env: Record<string, string> = {};
        for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT']) {
          if (process.env[key]) env[key] = process.env[key]!;
        }
        const transport = server.transport === 'stdio'
          ? new StdioClientTransport({ command: server.command, args: server.args, env, cwd: config.workspace, stderr: 'pipe', maxBufferSize: config.limits.maxToolBytes * 2 })
          : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { redirect: 'error' } });
        this.connections.push({ client, stdio: transport instanceof StdioClientTransport ? transport : undefined });
        if (transport instanceof StdioClientTransport) {
          transport.stderr?.on('data', chunk => {
            gateway.store.event({ type: 'error', sessionId: gateway.sessionId, runId: null,
              data: { server: server.name, stderr: String(chunk).slice(0, 2000) } });
          });
        }
        await client.connect(transport, { timeout: config.limits.toolTimeoutMs });
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const listed = await client.listTools({ cursor }, { timeout: config.limits.toolTimeoutMs });
          for (const remote of listed.tools) {
            if (!server.tools.includes(remote.name)) continue;
            if (seen.has(remote.name)) throw new HarnessError('MCP', 'Duplicate MCP tool identity.');
            seen.add(remote.name);
            const fullName = `mcp_${server.name}_${remote.name}`;
            const name = /^[a-zA-Z0-9_-]{1,64}$/.test(fullName) ? fullName :
              `mcp_${server.name.slice(0, 20)}_${remote.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 22)}_${hash(remote.name).slice(0, 8)}`;
            gateway.register({
              name,
              description: `UNTRUSTED MCP DESCRIPTION (${server.name}): ${remote.description ?? remote.name}`,
              parameters: { ...remote.inputSchema, type: 'object', properties: remote.inputSchema.properties ?? {}, required: remote.inputSchema.required ?? [], additionalProperties: false },
              effect: 'external', approval: true,
              execute: async (args, _runId, signal) => {
                const result = await client.callTool({ name: remote.name, arguments: args }, undefined, { signal, timeout: config.limits.toolTimeoutMs });
                if (result.isError) throw new HarnessError('MCP_TOOL', JSON.stringify(result.content));
                return result;
              },
            }, refresh);
          }
          cursor = listed.nextCursor;
        } while (cursor && seen.size < 100);
        if (server.tools.some(name => !seen.has(name))) throw new HarnessError('MCP', `Configured tools are missing from ${server.name}.`);
      }
    } catch (error) {
      await this.close();
      const auth = error instanceof Error && error.name === 'UnauthorizedError' ||
        record(error) && (error.code === 401 || error.code === 403);
      throw new HarnessError('MCP', `${auth ? 'MCP authentication is required but unsupported' : 'MCP connection failed'}: ${errorText(error)}`);
    }
  }
  async close(): Promise<void> {
    const failures: string[] = [];
    for (const { client, stdio } of this.connections.splice(0)) {
      const pid = stdio?.pid;
      if (pid && process.platform === 'win32') {
        try { await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); }
        catch (error) {
          // A server can exit between reading its PID and terminating its tree.
          try { process.kill(pid, 0); failures.push(errorText(error)); }
          catch (probe) { if (!(probe instanceof Error && 'code' in probe && probe.code === 'ESRCH')) failures.push(errorText(probe)); }
        }
      }
      try { await client.close(); } catch (error) { failures.push(errorText(error)); }
    }
    if (failures.length) throw new HarnessError('MCP_CLEANUP', failures.join('; '));
  }
}
