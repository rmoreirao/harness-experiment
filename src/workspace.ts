import {
  lstatSync, realpathSync, readdirSync, openSync, fstatSync, closeSync,
  writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync, readSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from './contracts.js';
import { within } from './files.js';
import { Ownership } from './ownership.js';
import type { Config } from './config.js';

export function digest(content: Buffer | string): string { return createHash('sha256').update(content).digest('hex'); }
const protectedName = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.copilot|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|harness\.local\.json|harness\.v2\.local\.json)$/i;
const generatedName = /^(?:node_modules|dist|build|coverage|\.next|\.venv|vendor)$/i;

// This filtered source mirror belongs only to the optional Docker tool.
// SDK-native filesystem and shell operations do not use this boundary.
export class Workspace {
  constructor(readonly config: Config, readonly root = config.workspace) {}
  resolve(input: string, create = false): string {
    if (!input || Array.from(input).some(character => character.charCodeAt(0) < 32) || /[:*?"<>|]/.test(input) || path.isAbsolute(input) || /^[/\\]/.test(input)) {
      throw new HarnessError('PATH', 'Use a relative workspace path without reserved characters.');
    }
    if (realpathSync(this.root).toLowerCase() !== path.resolve(this.root).toLowerCase()) throw new HarnessError('SCOPE', 'Workspace identity changed.');
    const file = path.resolve(this.root, input);
    if (!within(this.root, file) || this.root === this.config.workspace && within(this.config.dataDir, file)) throw new HarnessError('SCOPE', 'Path is outside the permitted workspace.');
    const parts = path.relative(this.root, file).split(path.sep).filter(Boolean);
    if (parts.some(part => protectedName.test(part) || generatedName.test(part) || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) || /\.(pem|key|pfx|p12|kdbx)$/i.test(file)) {
      throw new HarnessError('PROTECTED', 'Credential, generated, internal, or reserved path is excluded.');
    }
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1) || !within(this.root, realpathSync(current))) {
          throw new HarnessError('SCOPE', 'Links and out-of-scope paths are excluded.');
        }
      } catch (error) {
        if (create && index === parts.length - 1 && error instanceof Error && 'code' in error && error.code === 'ENOENT') return file;
        throw error;
      }
    }
    return file;
  }
  files(folder = '.'): string[] {
    const files: string[] = [];
    let entries = 0;
    const walk = (input: string, depth: number) => {
      if (depth > 40) throw new HarnessError('FILE_LIMIT', 'Workspace depth limit reached.');
      for (const entry of readdirSync(this.resolve(input), { withFileTypes: true })) {
        if (++entries > this.config.limits.maxFiles * 4) throw new HarnessError('FILE_LIMIT', 'Directory-entry limit reached.');
        if (protectedName.test(entry.name) || generatedName.test(entry.name) || entry.isSymbolicLink()) continue;
        const relative = path.join(input, entry.name);
        try { this.resolve(relative); }
        catch (error) { if (error instanceof HarnessError && ['PROTECTED', 'SCOPE'].includes(error.code)) continue; throw error; }
        if (entry.isDirectory()) walk(relative, depth + 1);
        else if (entry.isFile()) {
          files.push(path.relative(this.root, this.resolve(relative)));
          if (files.length > this.config.limits.maxFiles) throw new HarnessError('FILE_LIMIT', 'Workspace file count limit reached.');
        }
      }
    };
    walk(folder, 0); return files.sort();
  }
  read(input: string): { text: string; hash: string } {
    const file = this.resolve(input);
    const fd = openSync(file, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.config.limits.maxFileBytes) throw new HarnessError('FILE_LIMIT', 'File type/size is not admitted.');
      const buffer = Buffer.alloc(this.config.limits.maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const bytes = buffer.subarray(0, length);
      if (length > this.config.limits.maxFileBytes) throw new HarnessError('FILE_LIMIT', 'File grew beyond the byte limit.');
      if (bytes.includes(0)) throw new HarnessError('FORMAT', 'Binary files are not admitted.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (Array.from(text).some(character => character.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(character))) throw new HarnessError('FORMAT', 'Only source/text content is admitted.');
      return { text, hash: digest(bytes) };
    } finally { closeSync(fd); }
  }
  patch(input: string, expectedHash: string, edits: { oldText: string; newText: string }[], content?: string, remove = false): { path: string; before: string; after: string; deleted: boolean } {
    const file = this.resolve(input, expectedHash === 'new');
    const lock = new Ownership(this.config.dataDir, `file:${file.toLowerCase()}`);
    try {
      const previous = expectedHash === 'new' ? null : this.read(input);
      if (previous?.hash !== expectedHash && expectedHash !== 'new') throw new HarnessError('STALE_WRITE', 'File changed since the approved version.');
      if (expectedHash === 'new' && existsSync(file)) throw new HarnessError('STALE_WRITE', 'New-file precondition no longer holds.');
      if (remove && (!previous || edits.length || content !== undefined)) throw new HarnessError('PATCH', 'Deletion requires an existing hash and no replacement.');
      let next = content ?? previous?.text ?? '';
      if (content !== undefined && expectedHash !== 'new') throw new HarnessError('PATCH', 'Existing files require precise edits, not full replacement.');
      for (const edit of edits) {
        if (edit.oldText === '' && next === '') next = edit.newText;
        else {
          if (!edit.oldText || next.split(edit.oldText).length !== 2) throw new HarnessError('PATCH', 'Each precise edit must match exactly once.');
          next = next.replace(edit.oldText, edit.newText);
        }
      }
      if (Buffer.byteLength(next) > this.config.limits.maxFileBytes) throw new HarnessError('FILE_LIMIT', 'Patch exceeds file size limit.');
      if (Array.from(next).some(character => character.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(character))) throw new HarnessError('FORMAT', 'Patches must contain source/text, not binary control data.');
      if (remove) unlinkSync(file);
      else if (expectedHash === 'new') writeFileSync(file, next, { flag: 'wx' });
      else {
        const temporary = path.join(path.dirname(file), `.harness-native-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, next, { flag: 'wx' });
          if (this.read(input).hash !== expectedHash) throw new HarnessError('STALE_WRITE', 'File changed before publication.');
          renameSync(temporary, file);
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
      return { path: input, before: previous?.hash ?? 'new', after: remove ? 'deleted' : digest(next), deleted: remove };
    } finally { lock.close(); }
  }
  mirror(destination: string): Map<string, string> {
    mkdirSync(destination, { recursive: false });
    const baseline = new Map<string, string>();
    let total = 0;
    for (const file of this.files()) {
      let source;
      try { source = this.read(file); }
      catch (error) { if (error instanceof HarnessError && error.code === 'FORMAT') continue; throw error; }
      total += Buffer.byteLength(source.text);
      if (total > this.config.limits.maxWorkspaceBytes) throw new HarnessError('WORKSPACE_LIMIT', 'Filtered workspace mirror exceeds its byte limit.');
      const target = path.join(destination, file);
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, source.text, { flag: 'wx' });
      baseline.set(file, source.hash);
    }
    return baseline;
  }
}
