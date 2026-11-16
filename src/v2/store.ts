import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { Redactor } from '../privacy.js';
import { hash } from '../config.js';
import { HarnessError } from '../contracts.js';
import { errorId, errorPage, errorSequence, storedError, type ErrorPage, type ErrorRecord, type ErrorRow } from '../errors.js';
import { SDK_VERSION, RUNTIME_VERSION, sessionConfigSchema, type V2Config } from './config.js';
import type { Entities, Objective, Result, V2Event } from './contracts.js';

interface DataRow { data: string }
const errorEvents = `(type='error' OR (type='action' AND json_extract(data,'$.action.status') IN ('failed','denied','unknown')))`;
export interface V2Session { id: string; runtimeId: string; config: V2Config; created: number }
export class V2Store {
  readonly db: Database.Database;
  constructor(readonly directory: string, readonly redactor = new Redactor()) {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new HarnessError('STORAGE', 'V2 storage cannot be a symlink.');
    this.db = new Database(path.join(directory, 'product-v2.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    try {
      this.db.transaction(() => {
        const version = this.db.pragma('user_version', { simple: true });
        if (version !== 0 && version !== 2) throw new HarnessError('SCHEMA', 'Unsupported V2 schema version.');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL UNIQUE,
            config TEXT NOT NULL, digest TEXT NOT NULL, sdk TEXT NOT NULL, runtime TEXT NOT NULL, created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
            objective_id TEXT, status TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
          CREATE INDEX IF NOT EXISTS records_owner ON records(kind,session_id,objective_id);
          CREATE UNIQUE INDEX IF NOT EXISTS one_objective ON records(session_id) WHERE kind='objective'
            AND status IN ('preparing','running','awaiting_approval','awaiting_input','recovery_required');
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,
            objective_id TEXT,type TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
          PRAGMA user_version=2;
        `);
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  createSession(config: V2Config): V2Session {
    const session = { id: randomUUID(), runtimeId: randomUUID(), config, created: Date.now() };
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)')
      .run(session.id, session.runtimeId, JSON.stringify(config), hash(config), SDK_VERSION, RUNTIME_VERSION, session.created);
    return session;
  }
  session(id: string): V2Session {
    const row = this.db.prepare<[string], { runtime_id: string; config: string; digest: string; sdk: string; runtime: string; created: number }>(
      'SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) throw new HarnessError('SESSION', 'No V2 session with that identity.');
    const saved: unknown = JSON.parse(row.config);
    if (hash(saved) !== row.digest || row.sdk !== SDK_VERSION || row.runtime !== RUNTIME_VERSION) {
      throw new HarnessError('COMPATIBILITY', 'Stored runtime/configuration is incompatible; no automatic conversion.');
    }
    const config = sessionConfigSchema.parse(saved);
    if (hash(config) !== row.digest) throw new HarnessError('COMPATIBILITY', 'Stored configuration defaults changed; no automatic conversion.');
    return { id, runtimeId: row.runtime_id, config, created: row.created };
  }
  sessions(): V2Session[] {
    return this.db.prepare<[], { id: string }>('SELECT id FROM sessions ORDER BY created DESC').all().map(row => this.session(row.id));
  }
  put<K extends keyof Entities>(kind: K, value: Entities[K]): void {
    const owner = 'objectiveId' in value ? value.objectiveId : kind === 'objective' ? value.id : null;
    this.db.prepare(`INSERT INTO records VALUES (?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
      status=excluded.status,data=excluded.data`).run(kind, value.id, value.sessionId, owner,
      'status' in value ? value.status : null, JSON.stringify(this.redactor.value(value)));
  }
  get<K extends keyof Entities>(kind: K, id: string, sessionId: string): Entities[K] {
    const row = this.db.prepare<[string, string, string], DataRow>('SELECT data FROM records WHERE kind=? AND id=? AND session_id=?')
      .get(kind, id, sessionId);
    if (!row) throw new HarnessError('RECORD', `No ${kind} belongs to this session.`);
    return JSON.parse(row.data) as Entities[K];
  }
  list<K extends keyof Entities>(kind: K, sessionId: string, objectiveId?: string): Entities[K][] {
    const rows = objectiveId
      ? this.db.prepare<[string, string, string], DataRow>('SELECT data FROM records WHERE kind=? AND session_id=? AND objective_id=? ORDER BY rowid')
        .all(kind, sessionId, objectiveId)
      : this.db.prepare<[string, string], DataRow>('SELECT data FROM records WHERE kind=? AND session_id=? ORDER BY rowid').all(kind, sessionId);
    return rows.map(row => JSON.parse(row.data) as Entities[K]);
  }
  latest(sessionId: string): Objective | undefined { return this.list('objective', sessionId).at(-1); }
  conversationObjectives(sessionId: string): Objective[] {
    const objectives = this.list('objective', sessionId);
    const boundary = this.list('conversation', sessionId)[0];
    if (!boundary?.afterObjectiveId) return objectives;
    const index = objectives.findIndex(objective => objective.id === boundary.afterObjectiveId);
    if (index < 0) throw new HarnessError('CONTEXT', 'Saved conversation boundary references a missing objective.');
    return objectives.slice(index + 1);
  }
  clearContext(sessionId: string): { session: V2Session; event: V2Event } {
    return this.db.transaction(() => {
      const session = this.session(sessionId);
      const previousRuntimeId = session.runtimeId;
      session.runtimeId = randomUUID();
      this.db.prepare('UPDATE sessions SET runtime_id=? WHERE id=?').run(session.runtimeId, sessionId);
      this.put('conversation', { id: sessionId, sessionId, afterObjectiveId: this.latest(sessionId)?.id ?? null });
      const event = this.event({ type: 'runtime', sessionId, objectiveId: null,
        data: { state: 'context_cleared', previousRuntimeId, runtimeId: session.runtimeId } });
      return { session, event };
    }).immediate();
  }
  reportedModelAnchor(sessionId: string, frameHash: string) {
    const row = this.db.prepare<[string, string], DataRow>(`SELECT data FROM records
      WHERE kind='model' AND session_id=? AND status='completed'
      AND json_extract(data,'$.reportedUsage')=1
      AND json_extract(data,'$.inputFingerprint.frameHash')=?
      ORDER BY rowid DESC LIMIT 1`).get(sessionId, frameHash);
    return row ? JSON.parse(row.data) as Entities['model'] : undefined;
  }
  recentActionErrors(sessionId: string) {
    return this.db.prepare<[string], {
      id: string; objectiveId: string; tool: string; status: string; code: string | null; message: string | null; url: unknown;
    }>(`SELECT id,objective_id AS objectiveId,json_extract(data,'$.tool') AS tool,status,
      json_extract(data,'$.errorCode') AS code,substr(json_extract(data,'$.error'),1,2048) AS message,
      json_extract(data,'$.args.url') AS url
      FROM records WHERE kind='action' AND session_id=? AND status IN ('failed','denied','unknown')
      ORDER BY rowid DESC LIMIT 10`).all(sessionId).map(({ url, ...error }) => ({
        ...error, origin: typeof url === 'string' && URL.canParse(url) ? new URL(url).origin : null,
      }));
  }
  event(event: V2Event): V2Event {
    const data = this.redactor.value(event.data);
    const inserted = this.db.prepare('INSERT INTO events(session_id,objective_id,type,at,data) VALUES (?,?,?,?,?)')
      .run(event.sessionId, event.objectiveId, event.type, Date.now(), JSON.stringify(data));
    const sequence = Number(inserted.lastInsertRowid);
    const action = event.data.action;
    const failed = event.type === 'error' || (event.type === 'action' && typeof action === 'object' && action !== null &&
      'status' in action && ['failed', 'denied', 'unknown'].includes(String(action.status)));
    return { ...event, sequence, data: { ...data as Record<string, unknown>, ...(failed ? { errorId: errorId(sequence) } : {}) } };
  }
  errors(sessionId: string, before?: string): ErrorPage {
    const rows = this.db.prepare<[string, number], ErrorRow>(
      `SELECT seq AS sequence,at,session_id AS sessionId,NULL AS runId,objective_id AS objectiveId,data
       FROM events WHERE session_id=? AND ${errorEvents} AND seq<? ORDER BY seq DESC LIMIT 21`)
      .all(sessionId, before === undefined ? Number.MAX_SAFE_INTEGER : errorSequence(before));
    return errorPage(rows, this.redactor);
  }
  error(sessionId: string, id: string): ErrorRecord {
    const row = this.db.prepare<[string, number], ErrorRow>(
      `SELECT seq AS sequence,at,session_id AS sessionId,NULL AS runId,objective_id AS objectiveId,data
       FROM events WHERE session_id=? AND ${errorEvents} AND seq=?`).get(sessionId, errorSequence(id));
    if (!row) throw new HarnessError('ERROR_NOT_FOUND', 'No recorded error with that ID belongs to this session.');
    return storedError(row, this.redactor);
  }
  events(sessionId: string, after = 0, limit = 100): V2Event[] {
    this.range(after, limit, 200);
    return this.db.prepare<[string, number, number], { seq: number; objective_id: string | null; type: V2Event['type']; data: string }>(
      'SELECT seq,objective_id,type,data FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, after, limit).map(row => ({
        sequence: row.seq, sessionId, objectiveId: row.objective_id, type: row.type, data: JSON.parse(row.data) as Record<string, unknown>,
      }));
  }
  result(sessionId: string, objectiveId: string, actionId: string, content: string | Buffer,
    provenance: Record<string, unknown>, mediaType = 'application/json'): Result {
    const objective = this.get('objective', objectiveId, sessionId);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(this.redactor.text(content));
    const used = this.list('result', sessionId, objectiveId).reduce((sum, item) => sum + item.bytes, 0);
    const limit = this.session(sessionId).config.limits.maxResultBytes;
    if (used + buffer.length > limit) throw new HarnessError('RESULT_LIMIT', 'Objective result storage limit reached.');
    const result: Result = {
      id: randomUUID(), sessionId, objectiveId: objective.id, actionId,
      bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex'),
      mediaType, provenance: this.redactor.value(provenance) as Record<string, unknown>, created: Date.now(),
    };
    const directory = path.join(this.directory, 'results', sessionId);
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new HarnessError('STORAGE', 'Unsafe result directory.');
    writeFileSync(path.join(directory, result.id), buffer, { flag: 'wx', mode: 0o600 });
    this.put('result', result);
    return result;
  }
  readResult(sessionId: string, id: string, offset = 0, limit = 8192): { result: Result; text: string; next: number | null } {
    this.range(offset, limit, 32768);
    const result = this.get('result', id, sessionId);
    if (offset > result.bytes) throw new HarnessError('RANGE', 'Byte offset is beyond the result.');
    const file = path.join(this.directory, 'results', sessionId, result.id);
    if (!/^[a-f0-9-]{36}$/.test(result.id) || lstatSync(file).isSymbolicLink()) throw new HarnessError('STORAGE', 'Unsafe result path.');
    const content = readFileSync(file);
    if (content.length !== result.bytes || createHash('sha256').update(content).digest('hex') !== result.hash) {
      throw new HarnessError('RESULT_HASH', 'Stored result was changed.');
    }
    const binary = !/^(application\/json|text\/)/.test(result.mediaType);
    let end = Math.min(content.length, offset + limit);
    if (!binary) {
      if (offset < content.length && (content[offset]! & 0xc0) === 0x80) throw new HarnessError('RANGE', 'Byte offset splits a UTF-8 character.');
      while (end < content.length && (content[end]! & 0xc0) === 0x80) end--;
      if (end === offset && offset < content.length) throw new HarnessError('RANGE', 'Page limit is too small for the next UTF-8 character.');
    }
    return { result, text: binary ? content.subarray(offset, end).toString('base64') : content.subarray(offset, end).toString('utf8'),
      next: end < content.length ? end : null };
  }
  private range(offset: number, limit: number, max: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > max) {
      throw new HarnessError('RANGE', 'Invalid bounded result range.');
    }
  }
  close(): void { this.db.close(); }
}
