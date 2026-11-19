import { execFile } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HarnessError } from './contracts.js';
import { Workspace } from './workspace.js';
import type { Store } from './store.js';
import type { ActionBroker } from './policy.js';
import type { Config } from './config.js';
import type { ExecutionRecord } from './contracts.js';

export class DockerExecution {
  private containers = new Set<string>();
  constructor(readonly config: Config, readonly store: Store, readonly sessionId: string) {}
  private docker(args: string[], signal?: AbortSignal, maxBuffer = 8192, allowProcessExit = false): Promise<string> {
    const host = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP, TMP: process.env.TMP,
    };
    return new Promise((resolve, reject) => execFile('docker', ['--host', host, ...args], {
      env, signal, maxBuffer, windowsHide: true, timeout: this.config.limits.toolTimeoutMs,
    }, (error, stdout, stderr) => {
      if (error && !(allowProcessExit && typeof error.code === 'number' && !error.killed)) reject(new HarnessError('DOCKER', `${error.message}\n${stderr}`));
      else if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) reject(new HarnessError('OUTPUT_LIMIT', 'Process output cap reached.'));
      else resolve(stdout + stderr);
    }));
  }
  async probe(signal: AbortSignal): Promise<{ image: string; engine: string }> {
    if (!this.config.execution) throw new HarnessError('EXECUTION_DISABLED', 'No isolated execution provider is configured.');
    const engine = (await this.docker(['info', '--format', '{{.OSType}}'], signal)).trim();
    if (engine !== 'linux') throw new HarnessError('EXECUTION_DISABLED', 'Only the Linux Docker isolation contract is implemented; no native Windows fallback.');
    const image = (await this.docker(['image', 'inspect', this.config.execution.image, '--format', '{{.Id}}'], signal)).trim();
    if (image !== this.config.execution.image) throw new HarnessError('EXECUTION_DISABLED', 'The pinned image is not installed. Automatic image pulls are disabled.');
    return { image, engine };
  }
  private record(id: string): ExecutionRecord {
    const record = this.store.get('execution', id, this.sessionId);
    const expected = path.join(this.config.dataDir, 'mirrors', this.sessionId, record.id);
    if (record.directory !== expected || !/^[a-f0-9-]{36}$/.test(record.id)) throw new HarnessError('EXECUTION', 'Invalid workspace mirror identity.');
    return record;
  }
  async run(executable: string, args: string[], cwd: string, objectiveId: string, actionId: string, signal: AbortSignal): Promise<ExecutionRecord> {
    const provider = this.config.execution;
    if (!provider) throw new HarnessError('EXECUTION_DISABLED', 'No provider; host execution is never a fallback.');
    await this.probe(signal);
    const id = randomUUID();
    const parent = path.join(this.config.dataDir, 'mirrors', this.sessionId);
    mkdirSync(parent, { recursive: true });
    const directory = path.join(parent, id);
    if (/[,"]/.test(directory)) throw new HarnessError('EXECUTION', 'Docker mirror paths cannot contain commas or quotes.');
    const baseline = Object.fromEntries(new Workspace(this.config).mirror(directory));
    const mirror = new Workspace(this.config, directory);
    mirror.resolve(cwd);
    const container = `harness-native-${id}`;
    const record: ExecutionRecord = {
      id, sessionId: this.sessionId, objectiveId, directory, baseline, container, executable, args,
      status: 'running', exitCode: null, outputResultId: null,
    };
    this.store.put('execution', record); this.containers.add(container);
    try {
      await this.docker([
        'create', '--pull=never', '--name', container, '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
        '--memory', `${provider.memoryMb}m`, '--memory-swap', `${provider.memoryMb}m`,
        '--cpus', String(provider.cpus), '--user=65534:65534',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
        '--mount', `type=bind,source=${directory},target=/workspace`,
        '--workdir', `/workspace/${cwd.replaceAll('\\', '/') === '.' ? '' : cwd.replaceAll('\\', '/')}`,
        '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
        '--entrypoint', executable, provider.image, ...args,
      ], signal);
      const inspected = z.array(z.object({
        HostConfig: z.object({ Privileged: z.boolean(), NetworkMode: z.string(), ReadonlyRootfs: z.boolean(), CapDrop: z.array(z.string()), PidMode: z.string() }),
        Config: z.object({ User: z.string() }),
        Mounts: z.array(z.object({ Destination: z.string(), Type: z.string() })),
      })).parse(JSON.parse(await this.docker(['inspect', container], signal, 131072)))[0]!;
      if (inspected.HostConfig.Privileged || inspected.HostConfig.NetworkMode !== 'none' || !inspected.HostConfig.ReadonlyRootfs ||
          !inspected.HostConfig.CapDrop.includes('ALL') || inspected.HostConfig.PidMode || inspected.Config.User !== '65534:65534' ||
          inspected.Mounts.some(mount => mount.Type !== 'tmpfs' && mount.Destination !== '/workspace')) {
        throw new HarnessError('ISOLATION', 'Engine did not apply the required isolation contract.');
      }
      const output = await this.docker(['start', '--attach', container], signal, this.config.limits.maxOutputBytes, true);
      const code = Number((await this.docker(['inspect', '--format', '{{.State.ExitCode}}', container], signal)).trim());
      if (!Number.isInteger(code)) throw new HarnessError('EXECUTION', 'Engine did not report a valid exit code.');
      const result = this.store.result(this.sessionId, objectiveId, actionId, output, {
        kind: 'process_output', executionId: id, executable, args, image: provider.image, network: 'none', exitCode: code,
      }, 'text/plain');
      record.outputResultId = result.id; record.exitCode = code; record.status = code === 0 ? 'completed' : 'failed';
      this.store.put('execution', record); return record;
    } catch (error) {
      record.status = signal.aborted ? 'cancelled' : 'unknown'; this.store.put('execution', record); throw error;
    } finally {
      await this.docker(['rm', '--force', '--volumes', container]);
      this.containers.delete(container);
    }
  }
  changes(id: string): { path: string; baseline: string; hash: string; deleted: boolean }[] {
    const record = this.record(id);
    if (record.status === 'running') throw new HarnessError('EXECUTION', 'Wait for execution to stop before inspecting changes.');
    const mirror = new Workspace(this.config, record.directory);
    const changes: { path: string; baseline: string; hash: string; deleted: boolean }[] = [];
    for (const file of new Set([...Object.keys(record.baseline), ...mirror.files()])) {
      const exists = existsSync(path.join(record.directory, file));
      const hash = exists ? mirror.read(file).hash : 'deleted';
      const baseline = record.baseline[file] ?? 'new';
      if (hash !== baseline) changes.push({ path: file, baseline, hash, deleted: !exists });
    }
    return changes;
  }
  register(broker: ActionBroker): void {
    if (!this.config.execution) return;
    broker.register('execution_run', 'Execute ONLY in a pinned, no-network Docker container with a filtered writable workspace mirror, no host secrets, no engine socket, non-root user and resource limits. Package scripts are arbitrary execution.', z.object({
      executable: z.string().regex(/^[a-zA-Z0-9_./-]{1,200}$/),
      args: z.array(z.string().max(8000)).max(100).default([]),
      cwd: z.string().default('.'),
    }).strict(), 'execute', (args, context) => this.run(args.executable, args.args, args.cwd, context.action.objectiveId, context.action.id, context.signal));
    broker.register('execution_status', 'Inspect a recorded execution without rerunning it.', z.object({ id: z.string().uuid() }).strict(),
      'internal', args => this.record(args.id));
    broker.register('execution_changes', 'Inspect changed/deleted paths and exact hashes from a stopped isolated mirror.', z.object({ id: z.string().uuid() }).strict(),
      'read', args => ({ executionId: args.id, changes: this.changes(args.id) }));
    broker.register('execution_read', 'Read a bounded changed source file inside a stopped execution mirror.', z.object({
      id: z.string().uuid(), path: z.string(), start: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(200).default(100),
    }).strict(), 'read', args => {
      const record = this.record(args.id);
      if (record.status === 'running') throw new HarnessError('EXECUTION', 'The mirror is still being modified.');
      const result = new Workspace(this.config, record.directory).read(args.path);
      return { hash: result.hash, lines: result.text.split('\n').slice(args.start - 1, args.start - 1 + args.lines) };
    });
    broker.register('execution_publish', 'Publish only the exact approved mirror changes after checking every host baseline and mirror hash. Deletions are destructive. Concurrent/unrelated host edits are never overwritten.', z.object({
      id: z.string().uuid(), changes: z.array(z.object({
        path: z.string(), baseline: z.string().regex(/^(new|[a-f0-9]{64})$/),
        hash: z.string().regex(/^(deleted|[a-f0-9]{64})$/),
      }).strict()).min(1).max(100),
    }).strict(), 'write', (args, context) => {
      const record = this.record(args.id);
      if (record.objectiveId !== context.action.objectiveId) throw new HarnessError('EXECUTION', 'Publication belongs to a different objective.');
      const known = this.changes(args.id); const host = new Workspace(this.config); const mirror = new Workspace(this.config, record.directory);
      if (new Set(args.changes.map(change => change.path.toLowerCase())).size !== args.changes.length) throw new HarnessError('PATCH', 'Duplicate publication path.');
      for (const change of args.changes) {
        if (!known.some(item => item.path === change.path && item.baseline === change.baseline && item.hash === change.hash)) throw new HarnessError('PUBLICATION_PRECONDITION', 'Mirror publication precondition changed; nothing was published.');
        host.resolve(change.path, change.baseline === 'new');
        const current = existsSync(path.join(host.root, change.path)) ? host.read(change.path).hash : 'new';
        if (current !== change.baseline) throw new HarnessError('PUBLICATION_PRECONDITION', 'Host changed since mirror creation; nothing was published.');
      }
      const published = args.changes.map(change => {
        if (change.hash === 'deleted') return host.patch(change.path, change.baseline, [], undefined, true);
        const next = mirror.read(change.path).text;
        if (change.baseline === 'new') return host.patch(change.path, 'new', [], next);
        return host.patch(change.path, change.baseline, [{ oldText: host.read(change.path).text, newText: next }]);
      });
      return { executionId: args.id, published };
    });
  }
  async close(): Promise<void> {
    for (const container of [...this.containers]) {
      await this.docker(['rm', '--force', '--volumes', container]); this.containers.delete(container);
    }
  }
}
