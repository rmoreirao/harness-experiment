import { afterEach, expect, it } from 'vitest';
import { Store, SqliteSession } from '../src/storage.js';
import { Ownership } from '../src/ownership.js';
import { fixture, worker } from './helpers.js';
import { errorDiagnostic, errorInspector } from '../src/errors.js';
import { Redactor } from '../src/privacy.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
it('atomically deduplicates history operations and rejects changed IDs and stale suffixes', async () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const store = new Store(f.config.dataDir);
  try {
    const session = new SqliteSession(store, store.createSession(f.config));
    const a = { type: 'message' as const, role: 'user' as const, content: 'hello' };
    const op = { operationId: 'one', transaction: { type: 'append_items' as const, items: [a] } };
    await session.applyHistoryTransaction(op);
    await session.applyHistoryTransaction(op);
    expect(await session.getItems()).toEqual([a]);
    await expect(session.applyHistoryTransaction({ ...op, transaction: { type: 'append_items', items: [{ ...a, content: 'different' }] } })).rejects.toThrow('different content');
    await expect(session.applyHistoryTransaction({ operationId: 'two', transaction: { type: 'replace_suffix', expectedSuffix: [{ ...a, content: 'stale' }], replacement: [] } })).rejects.toThrow('History changed');
    expect(await session.getItems()).toEqual([a]);
    await session.applyHistoryTransaction({ operationId: 'two', transaction: { type: 'replace_suffix', expectedSuffix: [a], replacement: [{ ...a, content: 'replacement' }] } });
    expect((await session.getItems())[0]).toMatchObject({ content: 'replacement' });
  } finally { store.close(); }
});

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
  store.db.pragma('user_version = 2'); store.close();
  expect(() => new Store(f.config.dataDir)).toThrow('newer');
});
it('preserves redacted structured errors across reopen and restricts inspection to the owning session', () => {
  const f = fixture(); cleanup.push(f.cleanup);
  const secret = 'synthetic-diagnostic-secret';
  const redactor = new Redactor([secret]);
  let store = new Store(f.config.dataDir, redactor);
  try {
    const sessionId = store.createSession(f.config);
    const peerId = store.createSession(f.config);
    const cause = new Error(`Provider cause ${secret}\u001b[31m`);
    const failure = Object.assign(new Error(`Provider rejected ${secret}`, { cause }), {
      code: 'authentication_error', status: 401, requestID: 'provider-request-one',
      request: { body: 'PRIVATE_REQUEST_BODY' }, response: { body: 'PRIVATE_RESPONSE_BODY' },
    });
    const event = store.event({ type: 'error', sessionId, runId: 'earlier-run',
      data: errorDiagnostic(failure, redactor, { operation: 'Responses request' }) });
    const id = String(event.data.errorId);
    store.close(); store = new Store(f.config.dataDir, redactor);
    expect(store.error(sessionId, id)).toMatchObject({
      id, runId: 'earlier-run', source: 'model', code: 'authentication_error',
      httpStatus: 401, providerRequestId: 'provider-request-one',
      message: 'Provider rejected [REDACTED]', cause: { message: 'Provider cause [REDACTED]' },
    });
    expect(store.error(sessionId, id).at).toBeGreaterThan(0);
    expect(store.error(sessionId, id).stack).toContain('[REDACTED]');
    const stored = JSON.stringify(store.trace('earlier-run'));
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
    const sessionId = store.createSession(f.config);
    for (let index = 0; index < 22; index++) {
      store.event({ type: 'state', sessionId, runId: null, data: { message: 'Not an error.' } });
      store.event({ type: 'error', sessionId, runId: null, data: { message: `Legacy failure ${index}` } });
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
