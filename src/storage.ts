import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentInputItem, Session, SessionHistoryTransactionArgs } from '@openai/agents';
import { configSchema, configHash, hash, type Config } from './config.js';
import {
  HarnessError, invocationSchema, requestSchema, runSchema,
  type AppEvent, type Artifact, type Invocation, type PendingRequest,
  type RunRecord, type Task, type TranscriptEntry,
} from './contracts.js';
import { Redactor } from './privacy.js';

interface DataRow { data: string }
export class Store {
  readonly db: Database.Database;
  constructor(readonly dataDir: string, readonly redactor = new Redactor()) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'harness.db'), { timeout: 2000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    try { this.db.transaction(() => {
      const version = this.db.pragma('user_version', { simple: true });
      if (typeof version !== 'number' || version > 1) throw new HarnessError('SCHEMA', 'The database schema is newer than this application.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, config TEXT NOT NULL, config_hash TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);
        CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history_ops(session_id TEXT NOT NULL, op TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(session_id, op));
        CREATE TABLE IF NOT EXISTS transcript(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(session_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(session_id,id));
        CREATE TABLE IF NOT EXISTS snapshots(session_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(session_id,path));
        CREATE TABLE IF NOT EXISTS stream_buffers(run_id TEXT PRIMARY KEY, text TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }).immediate(); }
    catch (error) { this.db.close(); throw error; }
  }
  createSession(config: Config): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(id, JSON.stringify(config), configHash(config), Date.now());
    return id;
  }
  session(id: string): { id: string; config: Config; configHash: string } {
    const row = this.db.prepare<[string], { config: string; config_hash: string }>('SELECT config,config_hash FROM sessions WHERE id=?').get(id);
    if (!row) throw new HarnessError('SESSION', 'Session not found.');
    const config = configSchema.parse(JSON.parse(row.config));
    if (configHash(config) !== row.config_hash) throw new HarnessError('CONFIG', 'Stored session configuration is inconsistent.');
    return { id, config, configHash: row.config_hash };
  }
  sessions(): { id: string; workspace: string; created: number }[] {
    return this.db.prepare<[], { id: string; config: string; created: number }>('SELECT * FROM sessions ORDER BY created DESC').all()
      .map(row => ({ id: row.id, workspace: configSchema.parse(JSON.parse(row.config)).workspace, created: row.created }));
  }
  putRun(run: RunRecord): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(run.id, run.sessionId, JSON.stringify(run));
      this.event({ type: 'state', sessionId: run.sessionId, runId: run.id,
        data: { status: run.status, persisted: true, usage: run.usage } });
    })();
  }
  buffer(runId: string, text?: string): string {
    if (text !== undefined) this.db.prepare('INSERT INTO stream_buffers VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET text=excluded.text')
      .run(runId, this.redactor.text(text));
    return this.db.prepare<[string], { text: string }>('SELECT text FROM stream_buffers WHERE run_id=?').get(runId)?.text ?? '';
  }
  run(id: string): RunRecord {
    const row = this.db.prepare<[string], DataRow>('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new HarnessError('RUN', 'Run not found.');
    return runSchema.parse(JSON.parse(row.data));
  }
  latestRun(sessionId: string): RunRecord | undefined {
    const rows = this.db.prepare<[string], DataRow>('SELECT data FROM runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').all(sessionId);
    return rows[0] ? runSchema.parse(JSON.parse(rows[0].data)) : undefined;
  }
  addTranscript(sessionId: string, runId: string | null, role: TranscriptEntry['role'], text: string): void {
    this.db.prepare('INSERT INTO transcript(session_id,run_id,role,text) VALUES (?,?,?,?)')
      .run(sessionId, runId, role, this.redactor.text(text));
  }
  transcript(sessionId: string, limit = 500): TranscriptEntry[] {
    return this.db.prepare<[string, number], TranscriptEntry>(
      'SELECT id,run_id AS runId,role,text FROM (SELECT * FROM transcript WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(sessionId, limit);
  }
  event(event: AppEvent): void {
    const traceId = event.runId?.replaceAll('-', '') ?? hash(event.sessionId).slice(0, 32);
    const spanId = hash(`${event.runId}:${String(event.data.id ?? event.type)}`).slice(0, 16);
    this.db.prepare('INSERT INTO events(session_id,run_id,type,at,data) VALUES (?,?,?,?,?)')
      .run(event.sessionId, event.runId, event.type, Date.now(),
        JSON.stringify(this.redactor.value({ traceId, spanId, ...event.data })));
  }
  trace(runId: string): { sequence: number; type: string; at: number; data: unknown }[] {
    return this.db.prepare<[string], { sequence: number; type: string; at: number; data: string }>(
      'SELECT seq AS sequence,type,at,data FROM events WHERE run_id=? ORDER BY seq').all(runId)
      .map(row => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }
  putInvocation(item: Invocation): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO invocations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(item.id, item.runId, JSON.stringify(item));
      this.event({ type: 'tool', sessionId: this.run(item.runId).sessionId, runId: item.runId,
        data: { id: item.id, tool: item.tool, status: item.status, effect: item.effect } });
    })();
  }
  invocation(id: string): Invocation | undefined {
    const row = this.db.prepare<[string], DataRow>('SELECT data FROM invocations WHERE id=?').get(id);
    return row ? invocationSchema.parse(JSON.parse(row.data)) : undefined;
  }
  toolResult(id: string, sessionId: string): string {
    const item = this.invocation(id);
    if (!item || this.run(item.runId).sessionId !== sessionId) throw new HarnessError('TOOL_RESULT', 'No result belongs to this session.');
    if (item.outputPath) {
      const root = path.join(this.dataDir, 'outputs', sessionId);
      const relative = path.relative(realpathSync(root), realpathSync(item.outputPath));
      if (relative.startsWith('..') || path.isAbsolute(relative) || lstatSync(item.outputPath).isSymbolicLink() ||
          relative === '') {
        throw new HarnessError('TOOL_RESULT', 'Unsafe offloaded result path.');
      }
      return readFileSync(item.outputPath, 'utf8');
    }
    return item.output ?? item.error ?? item.status;
  }
  invocations(runId: string): Invocation[] {
    return this.db.prepare<[string], DataRow>('SELECT data FROM invocations WHERE run_id=?').all(runId)
      .map(row => invocationSchema.parse(JSON.parse(row.data)));
  }
  putRequest(item: PendingRequest): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(item.id, item.runId, JSON.stringify(item));
      this.event({ type: 'request', sessionId: this.run(item.runId).sessionId, runId: item.runId,
        data: { id: item.id, tool: item.tool, status: item.status, revision: item.revision } });
    })();
  }
  requests(runId: string): PendingRequest[] {
    return this.db.prepare<[string], DataRow>('SELECT data FROM requests WHERE run_id=? ORDER BY rowid').all(runId)
      .map(row => requestSchema.parse(JSON.parse(row.data)));
  }
  addArtifact(artifact: Artifact): void {
    this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(artifact.id, artifact.runId, artifact.path, artifact.hash, artifact.bytes);
  }
  artifacts(runId: string): Artifact[] {
    return this.db.prepare<[string], Artifact>('SELECT id,run_id AS runId,path,hash,bytes FROM artifacts WHERE run_id=?').all(runId);
  }
  setTasks(sessionId: string, tasks: Task[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE session_id=?').run(sessionId);
      const insert = this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?)');
      for (const task of tasks) insert.run(sessionId, task.id, task.title, task.status);
    })();
  }
  tasks(sessionId: string): Task[] {
    return this.db.prepare<[string], Task>('SELECT id,title,status FROM tasks WHERE session_id=? ORDER BY rowid').all(sessionId);
  }
  snapshot(sessionId: string, file: string): string | undefined {
    return this.db.prepare<[string, string], { hash: string }>('SELECT hash FROM snapshots WHERE session_id=? AND path=?')
      .get(sessionId, file)?.hash;
  }
  putSnapshot(sessionId: string, file: string, digest: string): void {
    this.db.prepare('INSERT INTO snapshots VALUES (?,?,?) ON CONFLICT(session_id,path) DO UPDATE SET hash=excluded.hash')
      .run(sessionId, file, digest);
  }
  close(): void { this.db.close(); }
}

export class SqliteSession implements Session {
  constructor(readonly store: Store, readonly id: string) {}
  async getSessionId(): Promise<string> { return this.id; }
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.readItems(limit);
  }
  private readItems(limit?: number): AgentInputItem[] {
    if (limit !== undefined && limit <= 0) return [];
    const rows = this.store.db.prepare<[string, number], DataRow>(
      'SELECT data FROM (SELECT seq,data FROM history WHERE session_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
      .all(this.id, limit ?? -1);
    return rows.map(row => JSON.parse(row.data) as AgentInputItem);
  }
  resolveCalls(callIds: Set<string>, explanation: string): void {
    this.store.db.transaction(() => {
      const history = this.readItems();
      const completed = new Set(history.filter(i => i.type === 'function_call_result').map(i => i.callId));
      const unresolved = history.filter(i => i.type === 'function_call' && callIds.has(i.callId) && !completed.has(i.callId));
      this.append(unresolved.flatMap(item => item.type === 'function_call' ? [{
        type: 'function_call_result', name: item.name, callId: item.callId, status: 'completed',
        output: { type: 'text', text: explanation },
      }] : []));
    })();
  }
  async addItems(items: AgentInputItem[]): Promise<void> { this.append(items); }
  private append(items: AgentInputItem[]): void {
    this.store.db.transaction(() => {
      const insert = this.store.db.prepare('INSERT INTO history(session_id,data) VALUES (?,?)');
      for (const item of items) insert.run(this.id, JSON.stringify(this.store.redactor.value(item)));
    })();
  }
  async popItem(): Promise<AgentInputItem | undefined> {
    return this.store.db.transaction(() => {
      const row = this.store.db.prepare<[string], { seq: number; data: string }>('SELECT seq,data FROM history WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(this.id);
      if (!row) return undefined;
      this.store.db.prepare('DELETE FROM history WHERE seq=?').run(row.seq);
      return JSON.parse(row.data) as AgentInputItem;
    })();
  }
  async clearSession(): Promise<void> { this.store.db.prepare('DELETE FROM history WHERE session_id=?').run(this.id); }
  async replaceHistoryWithCompaction(items: AgentInputItem[]): Promise<void> {
    this.store.db.transaction(() => {
      this.store.db.prepare('DELETE FROM history WHERE session_id=?').run(this.id);
      this.append(items);
    })();
  }
  async applyHistoryTransaction(args: SessionHistoryTransactionArgs): Promise<void> {
    this.store.db.transaction(() => {
      const digest = hash(this.store.redactor.value(args.transaction));
      const existing = this.store.db.prepare<[string, string], { hash: string }>('SELECT hash FROM history_ops WHERE session_id=? AND op=?').get(this.id, args.operationId);
      if (existing) {
        if (existing.hash !== digest) throw new HarnessError('HISTORY', 'History operation ID was reused with different content.');
        return;
      }
      const tx = args.transaction;
      if (tx.type === 'append_items') this.append(tx.items);
      else {
        const rows = this.store.db.prepare<[string], { seq: number; data: string }>('SELECT seq,data FROM history WHERE session_id=? ORDER BY seq').all(this.id);
        const suffix = tx.expectedSuffix.length === 0 ? [] : rows.slice(-tx.expectedSuffix.length);
        if (hash(suffix.map(r => JSON.parse(r.data))) !== hash(this.store.redactor.value(tx.expectedSuffix))) {
          throw new HarnessError('HISTORY', 'History changed before suffix replacement.');
        }
        for (const row of suffix) this.store.db.prepare('DELETE FROM history WHERE seq=?').run(row.seq);
        this.append(tx.replacement);
      }
      this.store.db.prepare('INSERT INTO history_ops VALUES (?,?,?)').run(this.id, args.operationId, digest);
    })();
  }
}
