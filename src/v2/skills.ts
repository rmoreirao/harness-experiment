import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';
import { HarnessError, errorText } from '../contracts.js';
import { DEFAULT_SKILLS_DIRECTORY, type V2Config } from './config.js';
import { digest, Workspace } from './workspace.js';

export const reviewedSkills = Object.freeze({
  coding: `Inspect relevant source before editing. Reproduce the bug with a genuine failing check.
Make the smallest precise patch and preserve unrelated edits. Run relevant checks in the isolated provider.
Commands cannot access the host or network. Inspect mirror changes and publish only exact approved hashes.
Review the resulting diff. Reference actual command output/result IDs and disclose missing toolchains or checks.`,
  research: `Search only through the configured connector; no snippets count as retrieved evidence.
Retrieve primary sources where available. Record exact supporting quotes and retrieval times.
Compare independent origins; repeated pages from the same origin do not provide independent confirmation.
Record contradictory evidence and uncertainty. Use research_report and [source:ID] citations.
State missing search credentials or unavailable sources explicitly. Never invent retrievals.`,
  browser: `Use a clean session browser and observe accessibility state before each action.
Use the fresh observation ID, one exact selector, and disclose exact network requests and data transfers.
Navigation never authorizes submissions, uploads, downloads or script execution.
Re-observe changed pages; never replay stale selectors. Preserve screenshot/download provenance.
Verify the user's original acceptance text against observed state, not an assumed successful click.`,
});

const descriptions = {
  coding: 'Inspect source, make precise changes and verify them in isolated execution.',
  research: 'Retrieve sources, compare evidence and produce citation-backed research.',
  browser: 'Observe and verify browser workflows through controlled actions.',
};
const metadataSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().trim().min(1).max(1024),
}).passthrough();
export interface SkillInfo {
  name: string; description: string; source: string; hash: string;
}
interface Skill extends SkillInfo { content: string }

export class Skills {
  readonly directory: string;
  private snapshot = new Map<string, Skill>();
  constructor(private readonly config: V2Config) {
    this.directory = config.skillsDirectory ?? DEFAULT_SKILLS_DIRECTORY;
    this.reload();
  }
  list(): SkillInfo[] {
    return [...this.snapshot.values()].map(({ name, description, source, hash }) => ({ name, description, source, hash }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  read(name: string): Skill {
    const skill = this.snapshot.get(name);
    if (!skill) throw new HarnessError('SKILL', `Unknown skill "${name}". Use a name from the current skill catalog.`);
    return { ...skill };
  }
  reload(): SkillInfo[] {
    const next = new Map<string, Skill>((['coding', 'research', 'browser'] as const).map(name => [
      name, { name, description: descriptions[name], source: 'bundled', hash: digest(reviewedSkills[name]), content: reviewedSkills[name] },
    ]));
    const workspace = new Workspace(this.config);
    let folder: string;
    try { folder = workspace.resolve(this.directory); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT' &&
          path.resolve(this.config.workspace, this.directory) === path.resolve(this.config.workspace, DEFAULT_SKILLS_DIRECTORY))) throw error;
      this.snapshot = next; return this.list();
    }
    if (!lstatSync(folder).isDirectory()) throw new HarnessError('SKILL', 'Skills directory must be a normal workspace directory.');
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > this.config.limits.maxFiles) throw new HarnessError('SKILL_LIMIT', 'Skills directory exceeds the entry limit.');
    let bytes = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new HarnessError('SCOPE', `Linked skill path is excluded: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const source = path.join(this.directory, entry.name, 'SKILL.md');
      let file: ReturnType<Workspace['read']>;
      try { file = workspace.read(source); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      bytes += Buffer.byteLength(file.text);
      if (bytes > this.config.limits.maxWorkspaceBytes) throw new HarnessError('SKILL_LIMIT', 'Skills exceed the aggregate byte limit.');
      try {
        const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(file.text);
        if (!match) throw new Error('SKILL.md requires YAML frontmatter and Markdown instructions.');
        const metadata = metadataSchema.parse(load(match[1]!, { schema: JSON_SCHEMA }));
        if (metadata.name !== entry.name) throw new Error('Skill name must match its directory name.');
        const content = match[2]!.trim();
        if (!content) throw new Error('Skill instructions must not be empty.');
        if (next.has(metadata.name)) throw new Error(`Duplicate or reserved bundled skill name "${metadata.name}".`);
        next.set(metadata.name, {
          name: metadata.name, description: metadata.description, source, hash: file.hash, content,
        });
      } catch (error) { throw new HarnessError('SKILL', `${source}: ${errorText(error)}`); }
    }
    this.snapshot = next;
    return this.list();
  }
}
