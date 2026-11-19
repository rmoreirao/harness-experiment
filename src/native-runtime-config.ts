import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HarnessError, record } from './contracts.js';

export function assertWorkspaceOnlyRuntimeConfiguration(directory: string, maximumBytes: number): void {
  const file = path.join(directory, 'mcp-config.json');
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(file); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const reject = () => new HarnessError('RUNTIME_CONFIGURATION',
    'SDK-private mcp-config.json can activate servers before workspace discovery. Move MCP declarations into the trusted workspace configuration; this file was not changed.');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw reject();
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw reject(); }
  if (!record(value) || Object.keys(value).some(key => key !== 'mcpServers') ||
      value.mcpServers !== undefined && (!record(value.mcpServers) || Object.keys(value.mcpServers).length !== 0)) throw reject();
}
