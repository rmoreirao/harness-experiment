import type { CopilotSession } from '@github/copilot-sdk';
import { HarnessError } from './contracts.js';

export const reviewedSkills = Object.freeze({
  coding: 'Inspect relevant source, preserve unrelated edits, make precise changes and verify the requested behavior with relevant checks. Report missing verification honestly.',
  research: `Retrieve primary sources where available and record exact supporting quotes and retrieval times.
Compare independent origins, record contradictory evidence and uncertainty, and never invent retrievals.
Use research_report and [source:ID] citations for evidence verified through the research tools.
Native browsing alone does not create verified research evidence. State missing credentials or unavailable sources explicitly.`,
  browser: `Observe the current page before acting and verify the user's acceptance criteria against the resulting state.
Navigation alone does not authorize submissions or data transfers. Preserve screenshot and download provenance.`,
});

export interface SkillInfo {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  userInvocable: boolean;
  path?: string;
}

export type NativeSkillOperations = Pick<CopilotSession['rpc']['skills'], 'list' | 'reload'>;

export class Skills {
  constructor(private readonly operations: NativeSkillOperations) {}

  async list(): Promise<SkillInfo[]> {
    const { skills } = await this.operations.list();
    return skills.map(({ name, description, source, enabled, userInvocable, path }) => ({
      name, description, source, enabled, userInvocable, ...(path !== undefined ? { path } : {}),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async reload(): Promise<SkillInfo[]> {
    const diagnostics = await this.operations.reload();
    if (diagnostics.errors.length) throw new HarnessError('SKILL', `SDK skill reload failed: ${diagnostics.errors.join('; ')}`);
    return this.list();
  }
}
