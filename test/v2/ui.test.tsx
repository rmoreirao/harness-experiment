import { render } from 'ink-testing-library';
import { writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { V2TerminalApp } from '../../src/v2/ui.js';
import { V2Controller } from '../../src/v2/controller.js';
import { HarnessError } from '../../src/contracts.js';
import { z } from 'zod';
import { fixture, skillFile, ScriptRuntime } from './helpers.js';

async function settle() { await new Promise(resolve => setTimeout(resolve, 70)); }
describe('V2 A08 terminal continuity', () => {
  it('pages historical action errors and excludes successful actions and their private arguments', async () => {
    const f = fixture();
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async () => {}) });
    try {
      for (let index = 0; index < 21; index++) {
        app.store.event({ type: 'action', sessionId: app.id, objectiveId: null, data: {
          action: { id: `legacy-${index}`, callId: `call-${index}`, tool: 'legacy_tool',
            status: 'failed', error: `Legacy failure ${index}`, errorCode: 'LEGACY',
            args: { privateValue: 'PRIVATE_LEGACY_ARGUMENT' } },
        } });
      }
      const success = app.store.event({ type: 'action', sessionId: app.id, objectiveId: null,
        data: { action: { tool: 'successful_tool', status: 'completed' } } });
      const first = app.store.errors(app.id);
      expect(first.errors).toHaveLength(20);
      expect(first.errors[0]).toMatchObject({ source: 'tool', code: 'LEGACY', callId: 'call-20', message: 'Legacy failure 20' });
      expect(JSON.stringify(first)).not.toContain('PRIVATE_LEGACY_ARGUMENT');
      const last = app.store.errors(app.id, first.next!);
      expect(last.errors).toHaveLength(1);
      expect(last.errors[0]?.message).toBe('Legacy failure 0');
      expect(last.next).toBeNull();
      expect(() => app.store.error(app.id, `error-${success.sequence}`)).toThrow('belongs to this session');
    } finally { await app.close(); f.cleanup(); }
  });
  it('inspects persistent tool errors by ID across objectives without replaying them or exposing arguments', async () => {
    const f = fixture();
    let calls = 0;
    const runtimeFactory = () => new ScriptRuntime(async runtime => {
      if (calls === 0) await runtime.call('fixture_failure', { privateValue: 'PRIVATE_TOOL_ARGUMENT' });
      else runtime.message('Synthetic later objective.');
    });
    let app = await V2Controller.open({ config: f.config, apiKey: 'synthetic-ui-key', runtimeFactory });
    const sessionId = app.id;
    app.broker.register('fixture_failure', 'Synthetic failed tool.', z.object({ privateValue: z.string() }), 'internal',
      () => { calls++; throw new HarnessError('FIXTURE_FAILURE', 'Tool failed with synthetic-ui-key.'); });
    try {
      await app.submit('Record a synthetic failure.');
      const error = app.store.errors(app.id).errors.find(error => error.source === 'tool')!;
      expect(error).toMatchObject({ code: 'FIXTURE_FAILURE', tool: 'fixture_failure', status: 'failed' });
      expect(error.stack).toContain('HarnessError');
      expect(JSON.stringify(error)).not.toContain('PRIVATE_TOOL_ARGUMENT');
      expect(JSON.stringify(error)).not.toContain('synthetic-ui-key');
      const peer = await V2Controller.open({ config: f.config, runtimeFactory });
      try { expect(() => peer.store.error(peer.id, error.id)).toThrow('belongs to this session'); }
      finally { await peer.close(); }
      await app.close();
      app = await V2Controller.open({ config: f.config, sessionId, apiKey: 'synthetic-ui-key', runtimeFactory });
      expect(app.store.error(app.id, error.id)).toEqual(error);
      const screen = render(<V2TerminalApp controller={app} />);
      const send = async (input: string) => { screen.stdin.write(input); await settle(); screen.stdin.write('\r'); await settle(); };
      try {
        await settle();
        await send('Start a later objective.');
        await send('/errors');
        expect(screen.lastFrame()).toContain(error.id);
        expect(screen.lastFrame()).toContain('FIXTURE_FAILURE');
        await send(`/error ${error.id}`);
        expect(screen.lastFrame()).toContain(error.id);
        expect(calls).toBe(1);
        await send('/back');
        await send('/error invalid');
        expect(screen.lastFrame()).toContain('Use an error ID from /errors');
      } finally { screen.unmount(); }
    } finally { await app.close(); f.cleanup(); }
  });
  it('enables session-wide approval from the command, shows the mode, and can restore approval prompts', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('workspace_read', { path: 'notes.txt' });
      await runtime.call('workspace_read', { path: 'notes.txt' });
      runtime.message('Synthetic session-approved work.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<V2TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      await send('Read synthetic notes.');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      await send('/approve_all');
      expect(app.inspect().objective?.status).toBe('completed');
      expect(app.inspect().approveAll).toBe(true);
      expect(screen.lastFrame()?.split('\n')).toContain('APPROVE ALL: ENABLED');
      await send('Read synthetic notes again.');
      expect(app.inspect().objective?.status).toBe('completed');
      expect(app.inspect().pending).toHaveLength(0);
      await send('/status');
      screen.stdin.write('\x1b[5~'); await settle();
      expect(screen.lastFrame()?.split('\n')).toContain('APPROVE ALL: ENABLED');
      await send('/back');
      await send('/approve_all unknown');
      expect(screen.lastFrame()).toContain('Use /approve_all or /approve_all off.');
      expect(app.inspect().approveAll).toBe(true);
      await send('/approve_all off');
      expect(screen.lastFrame()).not.toContain('APPROVE ALL: ENABLED');
      await send('Read with per-call approval.');
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      expect(app.inspect().pending).toHaveLength(1);
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });

  it('shows the persisted approval indicator immediately after resume while idle', async () => {
    const f = fixture();
    const runtimeFactory = () => new ScriptRuntime(async runtime => runtime.message('Synthetic completed work.'));
    let app = await V2Controller.open({ config: f.config, runtimeFactory });
    const id = app.id;
    try {
      app.setApproveAll(true);
      await app.close();
      app = await V2Controller.open({ config: f.config, sessionId: id, runtimeFactory });
      const screen = render(<V2TerminalApp controller={app} />);
      try {
        await settle();
        expect(screen.lastFrame()?.split('\n')).toContain('APPROVE ALL: ENABLED');
        expect(screen.lastFrame()).toContain('idle');
      } finally { screen.unmount(); }
    } finally { await app.close(); f.cleanup(); }
  });

  it('lists skills, reloads edits/additions and exposes reload errors without losing the previous snapshot', async () => {
    const f = fixture();
    const file = skillFile(f.workspace, 'review-notes', 'Original guidance.');
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => new ScriptRuntime(async runtime => runtime.message('Synthetic completed objective.')) });
    const screen = render(<V2TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      await send('Complete the synthetic objective.');
      await send('/skills list');
      expect(screen.lastFrame()).toContain('review-notes');
      expect(screen.lastFrame()).toContain('Synthetic review-notes');
      const oldHash = app.listSkills().skills.find(skill => skill.name === 'review-notes')!.hash;
      skillFile(f.workspace, 'review-notes', 'Updated guidance.');
      skillFile(f.workspace, 'summarize-notes', 'New guidance.');
      await send('/skills reload');
      expect(screen.lastFrame()).toContain('summarize-notes');
      expect(app.listSkills().skills.find(skill => skill.name === 'review-notes')!.hash).not.toBe(oldHash);
      writeFileSync(file, 'Malformed skill.');
      await send('/skills reload');
      expect(screen.lastFrame()).toContain('Skills command failed');
      expect(screen.lastFrame()).toContain('frontmatter');
      expect(app.listSkills().skills).toHaveLength(5);
      await send('/skills unknown');
      expect(screen.lastFrame()).toContain('Use /skills list or /skills reload.');
      await send('/skills');
      expect(screen.lastFrame()).toContain('summarize-notes');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });
  it('retains safe paste, live request inspection/approval, plans, results and resize-safe scrolling', async () => {
    const f = fixture();
    const runtime = new ScriptRuntime(async runtime => {
      await runtime.call('workspace_read', { path: 'notes.txt' });
      runtime.message('Synthetic terminal evidence.');
    });
    const app = await V2Controller.open({ config: f.config, runtimeFactory: () => runtime });
    const screen = render(<V2TerminalApp controller={app} />);
    const send = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    try {
      await settle();
      screen.stdin.write('\x1b[200~Read\nsynthetic notes\x1b[201~'); await settle();
      expect(app.inspect().objective).toBeUndefined();
      expect(screen.lastFrame()).toContain('synthetic notes');
      screen.stdin.write('\r'); await settle();
      expect(screen.lastFrame()).toContain('APPROVAL REQUIRED');
      await send('/request');
      expect(screen.lastFrame()).toContain('workspace_read');
      await send('/approve');
      expect(app.inspect().objective?.status).toBe('completed');
      expect(screen.lastFrame()).toContain('Synthetic terminal evidence.');
      await send('/plan');
      await send('/back');
      expect(screen.lastFrame()).toContain('1 results');
    } finally { screen.unmount(); await app.close(); f.cleanup(); }
  });
});
