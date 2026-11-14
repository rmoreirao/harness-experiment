import {
  lstatSync, realpathSync, readdirSync, openSync, closeSync,
  fstatSync, readFileSync, readSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, type Artifact } from './contracts.js';
import { hash, type Config } from './config.js';
import { Store } from './storage.js';
import { Ownership } from './ownership.js';

export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export class FileTools {
  constructor(readonly config: Config, readonly store: Store, readonly sessionId: string) {}
  resolve(input: string, writing = false): string {
    if (!input || Array.from(input).some(c => c.charCodeAt(0) < 32) || /^\\\\|^\/\/|^\\\?/.test(input)) {
      throw new HarnessError('PATH', 'Use a normal path inside the allowed workspace.');
    }
    const full = path.resolve(this.config.workspace, input);
    if (realpathSync(this.config.workspace).toLowerCase() !== this.config.workspace.toLowerCase()) {
      throw new HarnessError('SCOPE', 'Workspace identity changed since session creation.');
    }
    if (!within(this.config.workspace, full)) throw new HarnessError('SCOPE', 'Path is outside the allowed folder.');
    if (within(this.config.dataDir, full)) throw new HarnessError('SCOPE', 'Application state is not a document source.');
    const relative = path.relative(this.config.workspace, full);
    const parts = relative.split(path.sep);
    if (parts.some(p => /:|[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p) ||
      /^(\.git|node_modules|\.env(?:\..*)?|harness\.local\.json)$/i.test(p))) {
      throw new HarnessError('SCOPE', 'Reserved, credential, or internal path is not allowed.');
    }
    let current = this.config.workspace;
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      current = path.join(current, parts[i]!);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) {
          throw new HarnessError('SCOPE', 'Symlinks, junctions, and multiply linked files are not allowed.');
        }
        if (!within(this.config.workspace, realpathSync(current))) throw new HarnessError('SCOPE', 'Resolved path escapes the workspace.');
      } catch (error) {
        if (writing && i === parts.length - 1 && error instanceof Error && 'code' in error && error.code === 'ENOENT') break;
        throw error;
      }
    }
    return full;
  }
  list(folder = '.'): { files: string[] } {
    const root = this.resolve(folder);
    const files = readdirSync(root, { withFileTypes: true })
      .filter(e => e.isFile() && /\.(txt|md)$/i.test(e.name))
      .slice(0, 100)
      .map(e => path.relative(this.config.workspace, this.resolve(path.join(folder, e.name))));
    return { files };
  }
  read(paths: string[]): { documents: { path: string; text: string; hash: string }[] } {
    let total = 0;
    const documents = paths.map(input => {
      const file = this.resolve(input);
      if (!/\.(txt|md)$/i.test(file)) throw new HarnessError('FORMAT', 'Only UTF-8 .txt and .md files are supported.');
      const fd = openSync(file, 'r');
      try {
        const size = fstatSync(fd).size;
        if (total + size > this.config.limits.maxFileBytes) throw new HarnessError('FILE_LIMIT', 'Read exceeds maxFileBytes; select fewer or smaller documents.');
        const remaining = this.config.limits.maxFileBytes - total;
        const bytes = Buffer.alloc(remaining + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (!count) break;
          length += count;
        }
        const buffer = bytes.subarray(0, length);
        total += buffer.length;
        if (total > this.config.limits.maxFileBytes) throw new HarnessError('FILE_LIMIT', 'File grew beyond maxFileBytes.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        const digest = hash(buffer.toString('base64'));
        this.store.putSnapshot(this.sessionId, file.toLowerCase(), digest);
        return { path: path.relative(this.config.workspace, file), text, hash: digest };
      } finally { closeSync(fd); }
    });
    return { documents };
  }
  write(runId: string, input: string, content: string, expectedHash: string): Artifact {
    const file = this.resolve(input, true);
    if (!/\.(txt|md)$/i.test(file)) throw new HarnessError('FORMAT', 'Output must be a .txt or .md file.');
    if (Buffer.byteLength(content) > this.config.limits.maxFileBytes) throw new HarnessError('FILE_LIMIT', 'Output exceeds maxFileBytes.');
    const lock = new Ownership(this.config.dataDir, `file:${file.toLowerCase()}`);
    try {
      if (expectedHash === 'new') {
        writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
      } else {
        const authorized = this.store.snapshot(this.sessionId, file.toLowerCase());
        if (!authorized || authorized !== expectedHash) throw new HarnessError('STALE_WRITE', 'Overwrite requires the hash from an approved read.');
        const current = hash(readFileSync(file).toString('base64'));
        if (current !== expectedHash) throw new HarnessError('STALE_WRITE', 'File changed since the approved read; read and approve a new action.');
        const temporary = path.join(path.dirname(file), `.harness-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
          if (hash(readFileSync(file).toString('base64')) !== expectedHash) {
            throw new HarnessError('STALE_WRITE', 'File changed before replacement.');
          }
          renameSync(temporary, file);
        } catch (error) {
          try { unlinkSync(temporary); }
          catch (cleanup) {
            if (!(cleanup instanceof Error && 'code' in cleanup && cleanup.code === 'ENOENT')) {
              throw new AggregateError([error, cleanup], 'Write failed and its temporary file could not be removed.');
            }
          }
          throw error;
        }
      }
      return { id: randomUUID(), runId, path: file, hash: hash(Buffer.from(content).toString('base64')), bytes: Buffer.byteLength(content) };
    } finally { lock.close(); }
  }
}
