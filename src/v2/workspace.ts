import {
  lstatSync, realpathSync, readdirSync, openSync, fstatSync, closeSync, readFileSync,
  writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync, readSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { HarnessError } from '../contracts.js';
import { within } from '../files.js';
import { Ownership } from '../ownership.js';
import type { V2Config } from './config.js';
import type { ActionBroker } from './policy.js';

export function digest(content: Buffer | string): string { return createHash('sha256').update(content).digest('hex'); }
const protectedName = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.copilot|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|harness\.local\.json|harness\.v2\.local\.json)$/i;
const generatedName = /^(?:node_modules|dist|build|coverage|\.next|\.venv|vendor)$/i;
export class Workspace {
  constructor(readonly config: V2Config, readonly root = config.workspace) {}
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
        const temporary = path.join(path.dirname(file), `.harness-v2-${randomUUID()}.tmp`);
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
  register(broker: ActionBroker): void {
    broker.register('workspace_list', 'List filtered source paths; **, * and ? globs. No content is read.', z.object({
      folder: z.string().default('.'), glob: z.string().max(200).default('**'), offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }).strict(), 'metadata', args => {
      const regex = new RegExp(`^${args.glob.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0\//g, '(?:.*/)?').replace(/\0/g, '.*')}$`);
      const files = this.files(args.folder).filter(file => regex.test(file.replaceAll('\\', '/')));
      return { files: files.slice(args.offset, args.offset + args.limit), next: args.offset + args.limit < files.length ? args.offset + args.limit : null };
    });
    broker.register('workspace_read', 'Read a bounded UTF-8 source range and its exact version hash.', z.object({
      path: z.string(), start: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(300).default(100),
    }).strict(), 'read', args => {
      const file = this.read(args.path); const lines = file.text.split('\n');
      return { path: args.path, hash: file.hash, start: args.start, lines: lines.slice(args.start - 1, args.start - 1 + args.lines),
        next: args.start - 1 + args.lines < lines.length ? args.start + args.lines : null };
    }, args => ({ paths: [String(args.path)] }));
    broker.register('workspace_search', 'Literal source-content search, bounded by file and result limits.', z.object({
      text: z.string().min(1).max(200), folder: z.string().default('.'),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30),
    }).strict(), 'read', args => {
      const matches: { path: string; line: number; text: string }[] = [];
      let bytes = 0;
      for (const file of this.files(args.folder)) {
        let content;
        try { content = this.read(file); }
        catch (error) { if (error instanceof HarnessError && error.code === 'FORMAT') continue; throw error; }
        bytes += Buffer.byteLength(content.text);
        if (bytes > this.config.limits.maxWorkspaceBytes) throw new HarnessError('SEARCH_LIMIT', 'Search content limit reached; narrow the folder.');
        for (const [index, line] of content.text.split('\n').entries()) if (line.includes(args.text)) {
          matches.push({ path: file, line: index + 1, text: line.slice(0, 1000) });
          if (matches.length >= args.offset + args.limit + 1) return { matches: matches.slice(args.offset, args.offset + args.limit), next: args.offset + args.limit };
        }
      }
      return { matches: matches.slice(args.offset, args.offset + args.limit), next: null };
    }, args => ({ paths: [String(args.folder)] }));
    broker.register('workspace_patch', 'Apply exact unique edits with a hash precondition; delete=true is destructive. Creates require expectedHash=new and content.', z.object({
      path: z.string(), expectedHash: z.string().regex(/^(new|[a-f0-9]{64})$/),
      edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict()).max(50).default([]),
      content: z.string().optional(), delete: z.boolean().default(false),
    }).strict(), 'write', args => this.patch(args.path, args.expectedHash, args.edits, args.content, args.delete));
  }
}
export async function safeGit(scope: Workspace, operation: 'status' | 'diff' | 'log', signal: AbortSignal, maxBytes: number, selected?: string[]): Promise<string> {
  const workspace = scope.root;
  const gitEntry = path.join(workspace, '.git');
  if (!lstatSync(gitEntry).isDirectory() || lstatSync(gitEntry).isSymbolicLink()) throw new HarnessError('GIT', 'Git inspection requires a normal .git directory at the selected root.');
  if (lstatSync(path.join(gitEntry, 'config')).isSymbolicLink()) throw new HarnessError('GIT_CONFIG', 'Linked repository configuration is not admitted.');
  const config = readFileSync(path.join(gitEntry, 'config'), 'utf8');
  if (/\b(?:include|includeIf|fsmonitor|sshCommand|command|textconv|external|worktreeConfig)\b/i.test(config)) {
    throw new HarnessError('GIT_CONFIG', 'Repository helper/include configuration is not admitted for inspection.');
  }
  const env = {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_ATTR_NOSYSTEM: '1',
  };
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => execFile('git', [
    '--no-pager', `--git-dir=${gitEntry}`, `--work-tree=${workspace}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'diff.external=', '-c', 'core.attributesFile=',
    '-c', 'core.untrackedCache=false', ...args,
  ], { cwd: workspace, env, signal, maxBuffer: maxBytes, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  if (operation === 'status') return run(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (operation === 'log') return run(['log', '-10', '--no-show-signature', '--format=%h %s']);
  const paths = (await run(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv'])).split('\0').filter(Boolean).filter(file => {
    try {
      scope.resolve(file, true);
      if (existsSync(path.join(workspace, file))) scope.read(file);
      return !selected || selected.includes(file) || selected.includes(file.replaceAll('/', '\\'));
    } catch (error) {
      if (error instanceof HarnessError && ['PROTECTED', 'SCOPE', 'FORMAT', 'PATH'].includes(error.code)) return false;
      throw error;
    }
  });
  if (!paths.length) return 'No admitted source-text diff. Credential, generated, binary, and linked paths are excluded.';
  if (paths.join(' ').length > 24000) throw new HarnessError('GIT_LIMIT', 'Diff path limit reached; select fewer paths.');
  return run(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...paths]);
}
