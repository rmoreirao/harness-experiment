import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SessionController } from '../src/controller.js';
import { fixture, approveAll } from './helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
describe('reference workflow through the real Agents SDK', () => {
  it('requires independent read and save approvals and preserves them across restart', async () => {
    const f = fixture(); cleanup.push(f.cleanup);
    let app = await SessionController.open({ config: f.config });
    const id = app.id;
    try {
      const run = await app.submit('Read the documents, summarize them, and save the summary.');
      expect(run.status, run.reason ?? '').toBe('awaiting_approval');
      expect(app.inspect().pending[0]?.tool).toBe('read_documents');
      expect(app.store.invocations(run.id).some(i => i.tool === 'read_documents')).toBe(false);
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id });
      const read = app.inspect().pending[0]!;
      await app.respond(read.id, read.revision, 'approve');
      expect(app.inspect().pending[0]?.tool).toBe('write_file');
      expect(existsSync(path.join(f.config.workspace, 'summary.md'))).toBe(false);
      await app.close();
      app = await SessionController.open({ config: f.config, sessionId: id });
      await approveAll(app);
      expect(app.inspect().run?.status, app.inspect().run?.reason ?? '').toBe('completed');
      expect(readFileSync(path.join(f.config.workspace, 'summary.md'), 'utf8')).toContain('Monday');
      expect(app.store.artifacts(run.id)).toHaveLength(1);
    } finally { await app.close(); }
  });
  it('does not read contents after rejection', async () => {
    const f = fixture(); cleanup.push(f.cleanup);
    const app = await SessionController.open({ config: f.config });
    try {
      const run = await app.submit('Summarize the documents and save.');
      const pending = app.inspect().pending[0]!;
      await app.respond(pending.id, pending.revision, 'reject');
      expect(app.store.invocations(run.id).map(i => i.tool)).not.toContain('read_documents');
      expect(app.inspect().run?.status).toBe('partial');
      expect(existsSync(path.join(f.config.workspace, 'summary.md'))).toBe(false);
    } finally { await app.close(); }
  });
});
