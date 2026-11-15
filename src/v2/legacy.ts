import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import { existsSync } from 'node:fs';

export function legacyHistory(directory: string, sessionId?: string) {
  const file = path.join(directory, 'harness.db');
  if (!existsSync(file)) return { sessions: [], transcript: [] };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const sessions = db.prepare<[], { id: string; config: string; created: number }>('SELECT id,config,created FROM sessions ORDER BY created DESC LIMIT 200')
      .all().map(row => ({ id: row.id, workspace: z.object({ workspace: z.string() }).parse(JSON.parse(row.config)).workspace, created: row.created }));
    const transcript = sessionId ? db.prepare<[string], { role: string; text: string }>(
      'SELECT role,text FROM (SELECT id,role,text FROM transcript WHERE session_id=? ORDER BY id DESC LIMIT 200) ORDER BY id').all(sessionId) : [];
    return { sessions, transcript };
  } finally { db.close(); }
}
