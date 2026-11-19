import { linkSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Skills, type NativeSkillOperations } from '../src/skills.js';
import { loadWorkspaceConfiguration } from '../src/workspace-config.js';
import { parseConfig } from '../src/config.js';
import { fixture, skillFile } from './helpers.js';

describe('Native SDK skill catalog', () => {
  const first = { name: 'review-notes', description: 'Review workspace notes.',
    source: 'workspace', enabled: true, userInvocable: true };
  const second = { name: 'summarize-notes', description: 'Summarize workspace notes.',
    source: 'workspace', enabled: false, userInvocable: false, path: '.github/skills/summarize-notes/SKILL.md' };

  it('lists the effective SDK catalog without inventing bundled snapshots or permissions', async () => {
    const list = vi.fn(async () => ({ skills: [second, first] }));
    const reload = vi.fn(async () => ({ errors: [], warnings: [] }));
    const skills = new Skills({ list, reload } as NativeSkillOperations);
    expect(await skills.list()).toEqual([first, second]);
    expect(list).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(skills).not.toHaveProperty('read');
  });

  it('observes SDK catalog changes only through the supported list and reload operations', async () => {
    const calls: string[] = [];
    let catalog = [first];
    const operations = {
      list: vi.fn(async () => { calls.push('list'); return { skills: catalog }; }),
      reload: vi.fn(async () => {
        calls.push('reload'); catalog = [{ ...second, enabled: true }]; return { errors: [], warnings: [] };
      }),
    };
    const skills = new Skills(operations as NativeSkillOperations);
    expect(await skills.list()).toEqual([first]);
    expect(await skills.reload()).toEqual([{ ...second, enabled: true }]);
    expect(calls).toEqual(['list', 'reload', 'list']);
  });

  it('uses only the configured workspace-relative directory and permits an absent default directory', () => {
    const f = fixture({ skillDirectories: ['local-skills'] });
    try {
      skillFile(f.workspace, 'review-notes', 'Default directory is not selected.');
      skillFile(f.workspace, 'summarize-notes', 'Explicit directory is selected.', 'local-skills');
      expect(loadWorkspaceConfiguration(f.config).skillDirectories).toEqual([path.join(f.workspace, 'local-skills')]);
      expect(() => parseConfig({ ...f.config, skillDirectories: ['..'] })).toThrow('relative paths');
      expect(() => parseConfig({ ...f.config, skillDirectories: [f.directory] })).toThrow('relative paths');
    } finally { f.cleanup(); }
    const empty = fixture();
    try { expect(loadWorkspaceConfiguration(empty.config).skillDirectories).toEqual([path.join(empty.workspace, '.github', 'skills')]); }
    finally { empty.cleanup(); }
  });

  it.each([
    'missing name', 'mismatched name', 'duplicate YAML key', 'empty instructions', 'executable YAML tag',
  ])('surfaces SDK reload diagnostics for %s instead of returning a stale success', async diagnostic => {
    const list = vi.fn(async () => ({ skills: [first] }));
    const reload = vi.fn(async () => ({ errors: [diagnostic], warnings: [] }));
    await expect(new Skills({ list, reload } as NativeSkillOperations).reload()).rejects.toThrow(diagnostic);
    expect(list).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('preserves SDK disabled state and accepts warnings without fabricating a catalog', async () => {
    const operations = {
      list: vi.fn(async () => ({ skills: [second] })),
      reload: vi.fn(async () => ({ errors: [], warnings: ['Optional skill asset unavailable.'] })),
    };
    expect(await new Skills(operations as NativeSkillOperations).reload()).toEqual([second]);
    expect(operations.list).toHaveBeenCalledOnce();
  });

  it('rejects linked skill folders and multiply-linked documents without following them', () => {
    const f = fixture();
    const file = skillFile(f.workspace, 'review-notes', 'Original.');
    try {
      linkSync(file, path.join(f.workspace, 'linked-skill.md'));
      expect(() => loadWorkspaceConfiguration(f.config)).toThrow('Linked');
    } finally { f.cleanup(); }
    const linked = fixture();
    try {
      mkdirSync(path.join(linked.workspace, '.github', 'skills'), { recursive: true });
      const external = path.join(linked.directory, 'external'); mkdirSync(external);
      symlinkSync(external, path.join(linked.workspace, '.github', 'skills', 'linked-skill'), 'junction');
      expect(() => loadWorkspaceConfiguration(linked.config)).toThrow('Linked');
    } finally { linked.cleanup(); }
  });

  it('propagates unavailable SDK catalogs instead of rebuilding a separate snapshot', async () => {
    const list = vi.fn(async () => { throw new Error('SDK skill catalog unavailable.'); });
    const reload = vi.fn(async () => ({ errors: [], warnings: [] }));
    await expect(new Skills({ list, reload } as NativeSkillOperations).list()).rejects.toThrow('SDK skill catalog unavailable');
    expect(reload).not.toHaveBeenCalled();
  });
});
