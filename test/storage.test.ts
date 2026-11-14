import { afterEach, expect, it } from 'vitest';
import { Store, SqliteSession } from '../src/storage.js';
import { Ownership } from '../src/ownership.js';
import { fixture, worker } from './helpers.js';

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
