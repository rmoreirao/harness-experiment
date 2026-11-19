import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { Ownership } from '../src/ownership.js';
import { fixture, worker } from './helpers.js';
import { errorDiagnostic, errorInspector } from '../src/errors.js';
import { Redactor } from '../src/privacy.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
it('uses an OS lock across real processes and releases it after owner termination', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const { child } = await worker(['lock', f.config.dataDir, 'session-one']);
  try {
    expect(() => new Ownership(f.config.dataDir, 'session-one')).toThrow('already owned');
    const other = new Ownership(f.config.dataDir, 'session-two'); other.close();
  } finally {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill(); await exited;
  }
  const next = new Ownership(f.config.dataDir, 'session-one'); next.close();
});
it('rejects a newer database schema rather than downgrading it', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const store = new Store(f.config.dataDir);
  store.db.pragma('user_version = 3'); store.close();
  expect(() => new Store(f.config.dataDir)).toThrow('Unsupported session storage generation');
});

describe('Native storage generation', () => {
  it('uses a fresh native store without modifying historical data', () => {
    const f = fixture(); cleanup.push(f.cleanup);
    const historical = path.join(f.directory, 'historical.db');
    const old = new Database(historical);
    old.exec('CREATE TABLE legacy_records(value TEXT); INSERT INTO legacy_records VALUES (\'historical sentinel\'); PRAGMA user_version=2;');
    old.close();
    const before = readFileSync(historical);
    const store = new Store(f.dataDir);
    try {
      expect(store.db.pragma('user_version', { simple: true })).toBe(4);
      expect(existsSync(path.join(f.dataDir, 'native.db'))).toBe(true);
      expect(existsSync(path.join(f.dataDir, 'product-v2.db'))).toBe(false);
      const session = store.createSession(f.config);
      expect(store.session(session.id)).toMatchObject({
        id: session.id, runtimeId: session.runtimeId, config: { version: 4, provider: { kind: 'byok' } },
      });
      expect(readFileSync(historical)).toEqual(before);
    } finally { store.close(); }
  });

  it('rejects historical stores without upgrading or adding files', () => {
    const f = fixture(); cleanup.push(f.cleanup);
    const created = new Store(f.dataDir); created.close();
    const historical = path.join(f.dataDir, 'product-v2.db');
    const old = new Database(historical);
    old.exec('CREATE TABLE sessions(value TEXT); INSERT INTO sessions VALUES (\'untouched session\'); PRAGMA user_version=2;');
    old.close();
    writeFileSync(path.join(f.dataDir, 'user-note.txt'), 'Preserve historical data.');
    const names = readdirSync(f.dataDir).sort();
    const before = new Map(names.map(name => [name, readFileSync(path.join(f.dataDir, name))]));
    expect(() => new Store(f.dataDir)).toThrow('Historical session storage is unsupported');
    expect(readdirSync(f.dataDir).sort()).toEqual(names);
    for (const [name, bytes] of before) expect(readFileSync(path.join(f.dataDir, name)), name).toEqual(bytes);
  });

  it('rejects unknown native storage generations without changing their schema', () => {
    const f = fixture(); cleanup.push(f.cleanup);
    const store = new Store(f.dataDir);
    store.db.pragma('user_version = 99'); store.close();
    const file = path.join(f.dataDir, 'native.db');
    const before = readFileSync(file);
    expect(() => new Store(f.dataDir)).toThrow('Use a fresh native data directory');
    expect(readFileSync(file)).toEqual(before);
    const inspect = new Database(file, { readonly: true });
    try { expect(inspect.pragma('user_version', { simple: true })).toBe(99); }
    finally { inspect.close(); }
  });

  it('retains worker delegation and native invocation identity across reopen', () => {
    const f = fixture(); cleanup.push(f.cleanup);
    let store = new Store(f.dataDir);
    try {
      const id = store.createSession(f.config).id;
      store.put('worker', { id: 'worker-one', sessionId: id, objectiveId: 'objective-one',
        parentId: 'parent-agent', name: 'writer', model: 'worker-model', callId: 'delegation-one',
        status: 'completed', started: 100, finished: 200 });
      store.put('action', { id: 'native-one', sessionId: id, objectiveId: 'objective-one',
        runtimeSessionId: 'child-sdk-session', actorId: 'worker-one', parentCallId: 'delegation-one',
        callId: 'native-call-one', tool: 'powershell', origin: 'native', effect: 'execute', args: { command: 'Synthetic check.' },
        argsHash: 'synthetic-hash', status: 'completed', resultId: null, error: null });
      store.close(); store = new Store(f.dataDir);
      expect(store.get('worker', 'worker-one', id)).toEqual({
        id: 'worker-one', sessionId: id, objectiveId: 'objective-one', parentId: 'parent-agent',
        name: 'writer', model: 'worker-model', callId: 'delegation-one', status: 'completed', started: 100, finished: 200,
      });
      expect(store.get('action', 'native-one', id)).toMatchObject({
        runtimeSessionId: 'child-sdk-session', actorId: 'worker-one', parentCallId: 'delegation-one',
        callId: 'native-call-one', origin: 'native', status: 'completed',
      });
      expect(store.get('action', 'native-one', id)).not.toHaveProperty('container');
      expect(() => store.get('action', 'native-one', 'another-session')).toThrow('belongs to this session');
    } finally { store.close(); }
  });
});
it('preserves redacted structured errors across reopen and restricts inspection to the owning session', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const secret = 'synthetic-diagnostic-secret';
  const redactor = new Redactor([secret]);
  let store = new Store(f.config.dataDir, redactor);
  try {
    const sessionId = store.createSession(f.config).id;
    const peerId = store.createSession(f.config).id;
    const cause = new Error(`Provider cause ${secret}\u001b[31m`);
    const failure = Object.assign(new Error(`Provider rejected ${secret}`, { cause }), {
      code: 'authentication_error', status: 401, requestID: 'provider-request-one',
      request: { body: 'PRIVATE_REQUEST_BODY' }, response: { body: 'PRIVATE_RESPONSE_BODY' },
    });
    const event = store.event({ type: 'error', sessionId, objectiveId: 'earlier-objective',
      data: errorDiagnostic(failure, redactor, { operation: 'Responses request' }) });
    const id = String(event.data.errorId);
    store.close(); store = new Store(f.config.dataDir, redactor);
    expect(store.error(sessionId, id)).toMatchObject({
      id, objectiveId: 'earlier-objective', source: 'model', code: 'authentication_error',
      httpStatus: 401, providerRequestId: 'provider-request-one',
      message: 'Provider rejected [REDACTED]', cause: { message: 'Provider cause [REDACTED]' },
    });
    expect(store.error(sessionId, id).at).toBeGreaterThan(0);
    expect(store.error(sessionId, id).stack).toContain('[REDACTED]');
    const stored = JSON.stringify(store.events(sessionId));
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('\\u001b');
    expect(stored).not.toContain('PRIVATE_REQUEST_BODY');
    expect(stored).not.toContain('PRIVATE_RESPONSE_BODY');
    expect(store.errors(peerId).errors).toEqual([]);
    expect(() => store.error(peerId, id)).toThrow('belongs to this session');
    expect(errorInspector('/errors', store, sessionId)).toContain(id);
    expect(errorInspector(`/error ${id}`, store, sessionId)).toContain('provider-request-one');
    expect(() => errorInspector('/error', store, sessionId)).toThrow('Use /errors');
    expect(() => store.error(sessionId, 'error-9007199254740992')).toThrow('Use an error ID');
  } finally { store.close(); }
});
it('pages older errors without including other event types and retains legacy message-only entries', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const store = new Store(f.config.dataDir);
  try {
    const sessionId = store.createSession(f.config).id;
    for (let index = 0; index < 22; index++) {
      store.event({ type: 'state', sessionId, objectiveId: null, data: { message: 'Not an error.' } });
      store.event({ type: 'error', sessionId, objectiveId: null, data: { message: `Legacy failure ${index}` } });
    }
    const page = store.errors(sessionId);
    expect(page.errors).toHaveLength(20);
    expect(page.errors[0]?.message).toBe('Legacy failure 21');
    expect(page.next).toBe(page.errors.at(-1)?.id);
    const listing = errorInspector('/errors', store, sessionId)!;
    expect(listing.indexOf(`${page.errors.at(-1)!.id} |`)).toBeLessThan(listing.indexOf(`${page.errors[0]!.id} |`));
    const older = store.errors(sessionId, page.next!);
    expect(older.errors.map(error => error.message)).toEqual(['Legacy failure 1', 'Legacy failure 0']);
    expect(older.next).toBeNull();
    expect(errorInspector(`/errors ${page.next}`, store, sessionId)).toContain('Legacy failure 0');
    const cause = new Error('Cyclic cause'); cause.cause = cause;
    const diagnostic = errorDiagnostic(cause, store.redactor);
    expect(diagnostic.cause?.cause?.cause?.message).toBe('Cyclic cause');
    expect(diagnostic.cause?.cause?.cause?.cause).toBeUndefined();
    const secret = 'synthetic-boundary-secret';
    const bounded = errorDiagnostic(new Error(`${'x'.repeat(2040)}${secret}`), new Redactor([secret]));
    expect(bounded.message).not.toContain('synthetic-');
    expect(bounded.message).toContain('[truncated]');
  } finally { store.close(); }
});
it('retains event timestamps and pages stable objective-scoped calls without replaying or leaking records', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  let store = new Store(f.config.dataDir, new Redactor(['fixture-trace-key']));
  try {
    const sessionId = store.createSession(f.config).id;
    const peer = store.createSession(f.config).id;
    const emitted = store.event({ type: 'state', sessionId, objectiveId: 'objective', data: { status: 'running' } });
    for (let index = 0; index < 5; index++) store.put('model', {
      id: `${'a'.repeat(24)}${index.toString().padStart(8, '0')}`, sessionId, objectiveId: 'objective',
      status: 'completed', input: 10, output: 2, reservation: 0, interaction: 'fixture', error: null,
    });
    store.put('action', {
      id: 'b'.repeat(64), sessionId, objectiveId: 'another-objective', callId: 'private-peer-call',
      tool: 'private_tool', argsHash: 'fixture', args: { secret: 'fixture-trace-key' }, effect: 'read',
      status: 'completed', resultId: null, error: null,
    });
    const first = store.activity(sessionId, 'objective', undefined, 2);
    const second = store.activity(sessionId, 'objective', first.next!, 2);
    const third = store.activity(sessionId, 'objective', second.next!, 2);
    expect([third, second, first].flatMap(page => page.items).map(item => item.value.id.slice(-1))).toEqual(['0', '1', '2', '3', '4']);
    expect(third.next).toBeNull();
    expect(store.activity(peer, 'objective').items).toEqual([]);
    expect(() => store.activityCall(sessionId, 'objective', 'm-aaaaaaaa')).toThrow('Ambiguous');
    const call = store.activityCall(sessionId, 'objective', first.items[0]!.value.id);
    expect(call).toEqual(first.items[0]);
    expect(() => store.activityCall(peer, 'objective', call.value.id)).toThrow('belongs to this objective');
    expect(() => store.activityCall(sessionId, 'objective', 't-bbbbbbbb')).toThrow('belongs to this objective');
    expect(() => store.activity(sessionId, 'objective', -1)).toThrow('Invalid bounded');
    store.close(); store = new Store(f.config.dataDir);
    expect(store.events(sessionId)[0]).toEqual(emitted);
    expect(store.activity(sessionId, 'objective', undefined, 2)).toEqual(first);
  } finally { store.close(); }
});
