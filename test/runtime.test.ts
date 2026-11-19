import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { CopilotClient } from '@github/copilot-sdk';
import { TrustedSessionController as SessionController } from './helpers.js';
import { parseConfig } from '../src/config.js';
import { provider, complete, message, memoryProvider } from './provider-fixture.js';
import { fixture, skillFile, approve, ScriptRuntime } from './helpers.js';
import { HarnessError, record } from '../src/contracts.js';
import { CopilotRuntime } from '../src/runtime.js';
import { runtimeEnvironment } from '../src/runtime.js';
import type { SessionEvent } from '@github/copilot-sdk';
import { sdkFixture } from './sdk-fixture.js';
import { resourceFixture } from './resource-fixture.js';
import type { RuntimeOptions } from '../src/contracts.js';

describe('Native SDK boundary contracts', () => {
  it('rejects ambient private SDK MCP declarations before client startup without altering their file', async () => {
    const f = resourceFixture();
    const file = path.join(f.dataDir, 'mcp-config.json');
    const marker = path.join(f.workspace, 'MUST_NOT_START_AMBIENT_MCP');
    const original = JSON.stringify({ mcpServers: { ambient: {
      type: 'stdio', command: process.execPath,
      args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)},"executed")`],
    } } });
    writeFileSync(file, original);
    const start = vi.spyOn(CopilotClient.prototype, 'start').mockResolvedValue(undefined);
    const create = vi.spyOn(CopilotClient.prototype, 'createSession').mockRejectedValue(new Error('Session creation must not run.'));
    vi.spyOn(CopilotClient.prototype, 'stop').mockResolvedValue([]);
    const signal = new AbortController().signal;
    const runtime = new CopilotRuntime(f.config, 'SYNTHETIC_KEY', f.resources, () => signal);
    const options: RuntimeOptions = {
      sessionId: 'sdk-parent', resume: false, directory: f.dataDir, signal, tools: [],
      emit: () => {}, question: async () => 'Synthetic answer.', beforeStop: async () => null,
      permission: async () => ({ kind: 'reject' }), permissionMode: 'allow-all', taskMode: 'interactive',
    };
    try {
      await expect(runtime.open(options)).rejects.toThrow(/MCP|discovery|configuration/i);
      expect(start).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(existsSync(marker)).toBe(false);
    } finally { await runtime.close(); vi.restoreAllMocks(); f.cleanup(); }
  });

  it('permits an empty native SDK state file without loading ambient MCP sources', async () => {
    const f = await sdkFixture({}, false, f => writeFileSync(path.join(f.dataDir, 'mcp-config.json'), '{}'));
    try {
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.configuration().mcpServers).toEqual({});
      expect(readFileSync(path.join(f.dataDir, 'mcp-config.json'), 'utf8')).toBe('{}');
    } finally { await f.cleanup(); }
  });

  it('keeps identical custom tool call IDs distinct across child SDK sessions', async () => {
    const f = await sdkFixture();
    const invoke = vi.spyOn(f.options.tools[0]!, 'invoke');
    try {
      const tool = f.configuration().tools![0]!;
      for (const agentId of ['child-one', 'child-two']) await tool.handler!({}, {
        sessionId: 'sdk-parent', agentId, toolCallId: 'same-custom-call',
        toolName: tool.name, arguments: {}, signal: new AbortController().signal,
      });
      expect(invoke.mock.calls.map(call => call[1])).toEqual(['same-custom-call', 'same-custom-call']);
      expect(invoke.mock.calls.map(call => call[3]?.runtimeSessionId)).toEqual(['child-one', 'child-two']);
      expect(invoke.mock.calls.map(call => call[3]?.actorId)).toEqual(['child-one', 'child-two']);
      expect(invoke.mock.calls.map(call => call[0])).toEqual([{}, {}]);
    } finally { await f.cleanup(); }
  });

  it('keeps configured MCP OAuth URLs host-only and strips probe headers and bodies', async () => {
    const f = await sdkFixture({ mcpServers: {
      fixture: { type: 'http', url: 'https://mcp.example.invalid/tools' },
    } });
    f.session.rpc.mcp.list.mockResolvedValue({ servers: [
      { name: 'fixture', url: 'https://mcp.example.invalid/tools', status: 'disconnected', source: 'workspace' },
    ] });
    try {
      expect(await f.runtime.mcp('status', 'fixture')).toEqual({
        serverName: 'fixture', status: 'authentication-required', httpStatus: 401,
      });
      expect(f.session.rpc.mcp.oauth.probe).toHaveBeenCalledExactlyOnceWith({ serverName: 'fixture' });
      const login = await f.runtime.mcp('login', 'fixture');
      expect(login).toEqual({ serverName: 'fixture', state: 'authorization-required',
        authorizationUrl: 'https://auth.example.invalid/authorize?state=SYNTHETIC_OAUTH_STATE&client_id=public-client&code_challenge=S256_PUBLIC_CHALLENGE' });
      expect(f.session.rpc.mcp.oauth.login).toHaveBeenCalledExactlyOnceWith({
        serverName: 'fixture', clientName: 'Harness', callbackSuccessMessage: 'Return to Harness.',
      });
      expect(JSON.stringify(f.emitted)).not.toContain('SYNTHETIC_OAUTH_STATE');
      expect(JSON.stringify(f.emitted)).not.toContain('PRIVATE_PROBE');
      expect(f.store.redactor.text('SYNTHETIC_OAUTH_STATE')).toBe('[REDACTED]');
      expect(f.store.redactor.text('public-client S256_PUBLIC_CHALLENGE')).toBe('public-client S256_PUBLIC_CHALLENGE');
    } finally { await f.cleanup(); }
  });

  it.each(['personal', 'owned', 'wrong-url', 'plugin', 'builtin', 'managed'])(
    'refuses MCP OAuth for an untrusted %s source before any network operation', async invalid => {
      const f = await sdkFixture({ mcpServers: {
        fixture: { type: 'http', url: 'https://mcp.example.invalid/tools' },
      } });
      f.session.rpc.mcp.list.mockResolvedValue({ servers: [{
        name: invalid === 'personal' ? 'personal' : 'fixture',
        url: invalid === 'wrong-url' ? 'https://unconfigured.example.invalid/tools' : 'https://mcp.example.invalid/tools',
        source: ['plugin', 'builtin', 'managed'].includes(invalid) ? invalid : 'workspace',
        owned: invalid === 'owned', status: 'disconnected',
      }] });
      try {
        await expect(f.runtime.mcp('login', invalid === 'personal' ? 'personal' : 'fixture')).rejects.toThrow('configured');
        expect(f.session.rpc.mcp.oauth.login).not.toHaveBeenCalled();
        expect(f.session.rpc.mcp.oauth.probe).not.toHaveBeenCalled();
        if (invalid === 'personal') expect(f.session.rpc.mcp.list).not.toHaveBeenCalled();
      } finally { await f.cleanup(); }
    },
  );

  it('rejects OAuth status and login for configured stdio MCP servers', async () => {
    const f = await sdkFixture({ mcpServers: { local: { type: 'stdio', command: 'node' } } });
    f.session.rpc.mcp.list.mockResolvedValue({ servers: [{ name: 'local', status: 'connected', source: 'workspace' }] });
    try {
      await expect(f.runtime.mcp('status', 'local')).rejects.toThrow('not stdio');
      await expect(f.runtime.mcp('login', 'local')).rejects.toThrow('not stdio');
      expect(f.session.rpc.mcp.oauth.probe).not.toHaveBeenCalled();
      expect(f.session.rpc.mcp.oauth.login).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('settles compaction waits after a successful summary without requiring the later completion event', async () => {
    const f = await sdkFixture({ limits: { timeoutMs: 1000 } });
    const base = { parentId: null, timestamp: '2026-11-19T09:00:00.000Z' };
    try {
      f.emitSdk({ ...base, id: 'compaction-start', type: 'session.compaction_start',
        data: { compactionAttemptId: 'attempt-one' } } as SessionEvent);
      let arrived!: () => void;
      const observed = new Promise<void>(resolve => { arrived = resolve; });
      f.session.rpc.tasks.list.mockImplementation(async () => { arrived(); return { tasks: [] }; });
      const work = f.runtime.send('Finish after the authoritative summary.');
      await observed;
      f.emitSdk({ ...base, id: 'compaction-summary', type: 'session.compaction_summarized',
        data: { compactionAttemptId: 'attempt-one', success: true } } as SessionEvent);
      await work;
      expect(f.emitted.find(event => event.data.state === 'session.compaction_summarized')).toMatchObject({
        type: 'runtime', data: { attemptId: 'attempt-one', success: true },
      });
      expect(f.emitted.some(event => event.data.state === 'session.compaction_complete')).toBe(false);
    } finally { await f.cleanup(); }
  });

  it.each(['plaintext consent', 'account selection'])('requires explicit authentication input before %s', async scenario => {
    const f = await sdkFixture({ provider: { kind: 'copilot' } });
    const question = vi.spyOn(f.options, 'question');
    try {
      f.session.rpc.accounts.login.begin.mockResolvedValueOnce({ flowId: 'flow-one', step: {
        kind: 'completed', result: scenario === 'plaintext consent' ? { status: 'needs-plaintext-consent' } :
          { status: 'needs-account-selection', accounts: [{ login: 'synthetic-login', selectionId: 'selected-account' }] },
      } } as Awaited<ReturnType<typeof f.session.rpc.accounts.login.begin>>);
      await f.runtime.auth('login');
      expect(await f.runtime.auth('advance')).toMatchObject({ state: 'input-required',
        message: expect.stringContaining('never approves plaintext') });
      expect(f.session.rpc.accounts.login.advance).not.toHaveBeenCalled();
      expect(question).not.toHaveBeenCalled();
      expect(await f.runtime.auth('advance', scenario === 'plaintext consent' ? 'no' : 'synthetic-login')).toMatchObject({ state: 'completed' });
      expect(f.session.rpc.accounts.login.advance).toHaveBeenCalledExactlyOnceWith({
        flowId: 'flow-one', input: scenario === 'plaintext consent' ? 'no' : 'selected-account',
      });
    } finally { await f.cleanup(); }
  });

  it('keeps resolved workspace MCP secrets ephemeral and redacts their subsequent output', async () => {
    const secret = 'SYNTHETIC_WORKSPACE_MCP_SECRET';
    const f = await sdkFixture({}, false, f => {
      mkdirSync(path.join(f.workspace, '.github'), { recursive: true });
      writeFileSync(path.join(f.workspace, '.github', 'mcp.json'), JSON.stringify({ mcpServers: {
        ephemeral: { type: 'http', url: 'https://mcp.example.invalid/tools', headers: { authorization: secret } },
      } }));
    });
    try {
      expect(f.configuration().mcpServers).toMatchObject({
        ephemeral: { headers: { authorization: secret } },
      });
      expect(f.store.redactor.text(`MCP output ${secret}`)).toBe('MCP output [REDACTED]');
      expect(f.config.mcpServers).toEqual({});
      expect(JSON.stringify(f.store.session(f.sessionId).config)).not.toContain(secret);
      expect(f.store.db.prepare<[string], { config: string }>('SELECT config FROM sessions WHERE id=?').get(f.sessionId)!.config)
        .not.toContain(secret);
    } finally { await f.cleanup(); }
  });

  it('opens native SDK capabilities in the real workspace with additive guidance', async () => {
    const f = await sdkFixture({ models: [{ id: 'worker-model', wire: 'worker-wire' }],
      agents: [{ name: 'writer', prompt: 'Write the assigned file.', tools: ['powershell'], model: 'worker-model' }] });
    try {
      const config = f.configuration();
      expect(f.clientOptions().mode).toBe('copilot-cli');
      expect(f.clientOptions().workingDirectory).toBe(f.workspace);
      expect(config).toMatchObject({
        workingDirectory: f.workspace, systemMessage: { mode: 'append' },
        availableTools: ['builtin:*', 'custom:*', 'mcp:*'],
        allowedModels: ['harness/gpt-6.1-sol', 'harness/worker-model'],
        customAgents: [{ name: 'writer', model: 'harness/worker-model', modelPolicy: 'required', tools: ['powershell'] }],
        enableConfigDiscovery: false, enableOnDemandInstructionDiscovery: false, enableFileHooks: false,
        skipCustomInstructions: true, enableSkills: true,
        skillDirectories: [path.join(f.workspace, '.github', 'skills')],
        hookDirectories: [path.join(f.workspace, '.github', 'hooks')],
      });
      expect(config.excludedTools).toBeUndefined();
      expect(config.includedBuiltinAgents).toBeUndefined();
      expect(config.includedBuiltinSkills).toBeUndefined();
      expect(config.enableExperimentalMode).toBeUndefined();
      expect(config.tools![0]).not.toHaveProperty('skipPermission');
      expect(JSON.stringify(config.systemMessage)).not.toContain('Never use a host shell');
      expect(JSON.stringify(config)).not.toContain('SYNTHETIC_PROVIDER_KEY');
    } finally { await f.cleanup(); }
  });

  it('routes native and retained custom permissions through one SDK decision callback', async () => {
    const f = await sdkFixture();
    try {
      const request = { kind: 'custom-tool' as const, toolName: 'harness_fixture_custom',
        toolDescription: 'Retained fixture.', toolCallId: 'permission-one' };
      const result = await f.configuration().onPermissionRequest!(request, { sessionId: 'child-sdk-session' });
      expect(result).toEqual({ kind: 'reject' });
      expect(f.permission).toHaveBeenCalledExactlyOnceWith(request, { sessionId: 'child-sdk-session' });
      expect(f.configuration().tools![0]).not.toHaveProperty('skipPermission');
    } finally { await f.cleanup(); }
  });

  it('ignores worker assistant deltas and final messages in parent output', async () => {
    const f = await sdkFixture();
    try {
      const base = { parentId: null, timestamp: '2026-11-19T09:00:00.000Z' };
      for (const [id, data, agentId] of [
        ['worker-final', { content: 'WORKER_FINAL' }, 'worker-one'],
        ['nested-final', { content: 'NESTED_FINAL', parentToolCallId: 'delegation-one' }, undefined],
        ['parent-final', { content: 'PARENT_FINAL' }, undefined],
      ] as const) f.emitSdk({ ...base, id, type: 'assistant.message', data, ...(agentId ? { agentId } : {}) } as SessionEvent);
      f.emitSdk({ ...base, id: 'worker-delta', type: 'assistant.message_delta',
        agentId: 'worker-one', data: { deltaContent: 'WORKER_DELTA' } } as SessionEvent);
      expect(f.emitted.filter(event => event.type === 'text').map(event => event.data)).toEqual([{ message: 'PARENT_FINAL' }]);
    } finally { await f.cleanup(); }
  });

  it('resumes with callbacks restored and pending native work replay disabled', async () => {
    const f = await sdkFixture({}, true);
    try {
      expect(f.create).not.toHaveBeenCalled();
      expect(f.restore).toHaveBeenCalledOnce();
      expect(f.restore.mock.calls[0]![0]).toBe('sdk-parent');
      expect(f.restore.mock.calls[0]![1]).toMatchObject({
        continuePendingWork: false, allowTranscriptRecovery: false, permissionMode: 'allow-all',
        workingDirectory: f.workspace, onPermissionRequest: expect.any(Function), onEvent: expect.any(Function),
        hooks: { onPreToolUse: expect.any(Function), onSubagentStart: expect.any(Function), onSubagentStop: expect.any(Function) },
      });
      expect(f.session.sendAndWait).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('preserves developer profile paths and filters harness credentials without mutating environment', () => {
    const keys = ['OPENAI_API_KEY', 'BRAVE_SEARCH_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN',
      'COPILOT_HOME', 'CUSTOM_PROVIDER_KEY', 'HARNESS_MCP_FIXTURE_TOKEN'];
    try {
      for (const key of keys) vi.stubEnv(key, `SYNTHETIC_${key}`);
      vi.stubEnv('mixed_case_provider_token', 'SYNTHETIC_MIXED_CASE_TOKEN');
      vi.stubEnv('HOME', 'C:\\developer-home');
      vi.stubEnv('USERPROFILE', 'C:\\developer-profile');
      vi.stubEnv('APPDATA', 'C:\\developer-appdata');
      vi.stubEnv('LOCALAPPDATA', 'C:\\developer-local');
      vi.stubEnv('GIT_CONFIG_GLOBAL', 'C:\\developer-home\\.gitconfig');
      vi.stubEnv('NPM_CONFIG_USERCONFIG', 'C:\\developer-home\\.npmrc');
      const before = { ...process.env };
      const environment = runtimeEnvironment('C:\\private-sdk-state', ['CUSTOM_PROVIDER_KEY', 'MIXED_CASE_PROVIDER_TOKEN']);
      const observed = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'GIT_CONFIG_GLOBAL',
        'NPM_CONFIG_USERCONFIG', 'COPILOT_TELEMETRY_LEVEL', 'OTEL_SDK_DISABLED'].map(key => [key, environment[key]]));
      expect(observed).toEqual({
        HOME: 'C:\\developer-home', USERPROFILE: 'C:\\developer-profile', APPDATA: 'C:\\developer-appdata',
        LOCALAPPDATA: 'C:\\developer-local', GIT_CONFIG_GLOBAL: 'C:\\developer-home\\.gitconfig',
        NPM_CONFIG_USERCONFIG: 'C:\\developer-home\\.npmrc', COPILOT_TELEMETRY_LEVEL: 'off', OTEL_SDK_DISABLED: 'true',
      });
      for (const key of keys) expect(Object.keys(environment).map(name => name.toUpperCase())).not.toContain(key);
      expect(Object.keys(environment).map(name => name.toUpperCase())).not.toContain('MIXED_CASE_PROVIDER_TOKEN');
      expect(Object.values(environment).includes('SYNTHETIC_MIXED_CASE_TOKEN')).toBe(false);
      expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
      for (const key of Object.keys(before)) expect(process.env[key] === before[key], `Parent environment entry ${key} changed`).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it('surfaces device sign-in steps directly without journaling their codes and cancels owned flows', async () => {
    const f = await sdkFixture({ provider: { kind: 'copilot' } });
    try {
      const login = await f.runtime.auth('login');
      expect(login).toMatchObject({ provider: 'copilot', state: 'device-code',
        step: { userCode: 'SYNTHETIC-DEVICE-CODE', verificationUri: 'https://login.example.invalid/device' } });
      expect(JSON.stringify(f.emitted)).not.toContain('SYNTHETIC-DEVICE-CODE');
      expect(await f.runtime.auth('cancel')).toEqual({ provider: 'copilot', state: 'cancelled' });
      expect(f.session.rpc.accounts.login.cancel).toHaveBeenCalledWith({ flowId: 'flow-one' });
      await expect(f.runtime.auth('advance')).rejects.toThrow('No sign-in flow is active');
    } finally { await f.cleanup(); }
  });

  it('rejects expired sign-in codes without advancing or silently starting another provider', async () => {
    vi.useFakeTimers();
    const f = await sdkFixture({ provider: { kind: 'copilot' } });
    try {
      await f.runtime.auth('login');
      vi.advanceTimersByTime(60001);
      expect(await f.runtime.auth('advance')).toMatchObject({ provider: 'copilot', state: 'expired' });
      expect(f.session.rpc.accounts.login.advance).not.toHaveBeenCalled();
      expect(f.session.rpc.accounts.login.cancel).toHaveBeenCalledExactlyOnceWith({ flowId: 'flow-one' });
      expect(f.session.sendAndWait).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('rejects unauthenticated and unavailable Copilot models before dispatch', async () => {
    const f = await sdkFixture({ provider: { kind: 'copilot' },
      models: [{ id: 'unavailable-worker', wire: 'unavailable-worker' }] });
    try {
      await expect(f.runtime.send('Require sign-in.')).rejects.toThrow('Copilot sign-in is required');
      expect(f.session.sendAndWait).not.toHaveBeenCalled();
      f.session.rpc.accounts.get.mockResolvedValue({ kind: 'status', status: { isAuthenticated: true } });
      await expect(f.runtime.send('Validate the required worker model.')).rejects.toThrow('unavailable-worker');
      expect(f.session.sendAndWait).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('reports the effective SDK task mode instead of pretending a rejected change succeeded', async () => {
    const f = await sdkFixture();
    try {
      f.session.rpc.mode.get.mockResolvedValue('interactive');
      await expect(f.runtime.setTaskMode('autopilot')).rejects.toThrow('did not apply task mode');
      expect(f.session.rpc.mode.set).toHaveBeenCalledWith({ mode: 'autopilot' });
    } finally { await f.cleanup(); }
  });

  it('cancels owned running and idle reusable workers during shutdown', async () => {
    const f = await sdkFixture();
    try {
      const tasks = [
        { id: 'running-worker', status: 'running' }, { id: 'idle-worker', status: 'idle' },
        { id: 'completed-worker', status: 'completed' },
      ];
      f.session.rpc.tasks.list.mockImplementation(async () => ({ tasks }));
      f.session.rpc.tasks.cancel.mockImplementation(async ({ id }) => {
        tasks.find(task => task.id === id)!.status = 'cancelled'; return {};
      });
      await f.runtime.abort();
      expect(f.session.rpc.cancelAllBackgroundAgents).toHaveBeenCalledOnce();
      expect(f.session.rpc.tasks.cancel.mock.calls.map(([args]) => args.id)).toEqual(['running-worker', 'idle-worker']);
      expect(f.emitted.at(-1)).toMatchObject({ type: 'runtime', data: { state: 'cancelled', unresolved: false } });
    } finally { await f.cleanup(); }
  });

  it('refuses a clean cancellation claim when the SDK still reports a running task', async () => {
    const f = await sdkFixture();
    try {
      f.session.rpc.tasks.list.mockResolvedValue({ tasks: [{ id: 'unconfirmed-worker', status: 'running' }] });
      await expect(f.runtime.abort()).rejects.toThrow('could not be confirmed stopped');
      expect(f.session.rpc.tasks.cancel).toHaveBeenCalledWith({ id: 'unconfirmed-worker' });
    } finally { f.session.rpc.tasks.list.mockResolvedValue({ tasks: [] }); await f.cleanup(); }
  });
});

describe('A01 real pinned Copilot SDK/runtime over synthetic Responses', () => {
  it('runs native PowerShell and a custom SDK worker on its required model without overwriting the parent answer', async () => {
    let parents = 0, workers = 0;
    const endpoint = memoryProvider((response, body, count) => {
      const worker = body.model === 'worker-wire';
      const turn = worker ? ++workers : ++parents;
      const tool = !worker && turn === 2 ? 'task' : 'powershell';
      const args = tool === 'task' ? {
        name: 'native-test-worker', description: 'Check native worker integration',
        prompt: 'Run the harmless worker marker command and report it.', agent_type: 'fixture-worker',
      } : {
        command: `Write-Output '${worker ? 'WORKER_NATIVE_MARKER' : 'PARENT_NATIVE_MARKER'}'`,
        description: 'Read a harmless synthetic marker.', initial_wait: 30,
      };
      if (turn === 1 || !worker && turn === 2) complete(response, `native_worker_${count}`, [{
        id: `native_worker_call_${count}`, call_id: `native_worker_call_${count}`, type: 'function_call',
        name: tool, arguments: JSON.stringify(args), status: 'completed',
      }]);
      else {
        const answer = worker ? 'WORKER_OUTPUT_NOT_PARENT_FINAL' : 'PARENT_NATIVE_WORKER_VERIFIED';
        complete(response, `native_worker_answer_${count}`, message(answer), answer);
      }
    });
    vi.stubGlobal('fetch', endpoint.fetch);
    const f = fixture({ models: [{ id: 'gpt-6.1-sol-fast', wire: 'worker-wire' }],
      agents: [{ name: 'fixture-worker', description: 'Synthetic worker.', prompt: 'Run the assigned harmless probe.',
        model: 'gpt-6.1-sol-fast' }],
      model: { canonical: 'gpt-6.1-sol', wire: 'synthetic-deployment', outputTokens: 512 },
      limits: { maxRequests: 8, timeoutMs: 30000, workerConcurrency: 1 },
    });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const objective = await app.submit('Run parent and worker native marker probes.');
      expect(objective.status, objective.reason ?? '').toBe('completed');
      expect(objective.output).toBe('PARENT_NATIVE_WORKER_VERIFIED');
      expect(objective.usage).toMatchObject({ requests: 5, input: 500, output: 200, unknown: false, reserved: 0 });
      expect([parents, workers]).toEqual([3, 2]);
      const worker = app.inspect().workers[0]!;
      expect(worker).toMatchObject({ name: 'fixture-worker', model: 'harness/gpt-6.1-sol-fast', status: 'completed' });
      const actions = app.inspect().actions.filter(action => action.origin === 'native');
      const childCommand = actions.find(action => action.tool === 'powershell' && action.actorId === worker.id)!;
      expect(childCommand).toMatchObject({ status: 'completed', parentCallId: 'native_worker_call_2' });
      expect(app.store.readResult(app.id, childCommand.resultId!).text).toContain('WORKER_NATIVE_MARKER');
      expect(actions.find(action => action.tool === 'powershell' && !action.actorId)).toMatchObject({ status: 'completed' });
      expect(new Set(actions.map(action => `${action.runtimeSessionId}:${action.callId}`)).size).toBe(actions.length);
      expect(app.store.list('model', app.id, objective.id).filter(request => request.actorId === worker.id)
        .map(request => [request.model, request.wireModel])).toEqual([
        ['gpt-6.1-sol-fast', 'worker-wire'], ['gpt-6.1-sol-fast', 'worker-wire'],
      ]);
    } finally { await app.close(); await endpoint.close(); vi.unstubAllGlobals(); f.cleanup(); }
  }, 60000);

  it('records a model call as running through streamed headers and settles it only after the body completes', async () => {
    let finish: (() => void) | undefined;
    const text = 'Synthetic streamed trace evidence.';
    const endpoint = await provider(response => {
      const event = (type: string, data: Record<string, unknown>) => response.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      event('response.created', { response: { id: 'trace-stream', object: 'response', status: 'in_progress', output: [] } });
      finish = () => {
        const item = message(text)[0]!;
        event('response.output_item.added', { output_index: 0, item });
        event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] } });
        event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
        event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response: { id: 'trace-stream', object: 'response', status: 'completed', output: [item],
          usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } } });
        response.end();
      };
    });
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const work = app.submit('Inspect synthetic streamed lifecycle.');
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { timeout: 5000 });
      const started = app.trace().items.find(item => item.kind === 'model')!;
      expect(started.value).toMatchObject({ outcome: 'running', started: expect.any(Number) });
      expect(started.value.finished).toBeUndefined();
      expect(app.store.events(app.id).filter(event => event.data.state === 'model_request')).toHaveLength(1);
      finish!();
      expect((await work).status).toBe('completed');
      const ended = app.trace().items.find(item => item.kind === 'model')!;
      expect(ended.value).toMatchObject({ id: started.value.id, outcome: 'completed', input: 100, output: 40, finished: expect.any(Number) });
      expect(app.store.events(app.id).filter(event => event.data.state === 'model_request')).toHaveLength(2);
      expect(JSON.stringify(app.store.events(app.id).filter(event => event.data.state === 'model_request')))
        .not.toContain('Inspect synthetic streamed lifecycle.');
    } finally { if (app.inspect().busy) finish?.(); await work; await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('starts an isolated SDK conversation after clear and cold resume without replaying prior prompts, answers or tool results', async () => {
    const oldPrompt = 'OLD_CONTEXT_USER_96b13';
    const oldAnswer = 'OLD_CONTEXT_ASSISTANT_96b13';
    const oldTool = 'OLD_CONTEXT_TOOL_RESULT_96b13';
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'before_clear_tool', [{ id: 'old_context_tool', call_id: 'old_context_tool',
        type: 'function_call', name: 'harness_fixture_context', arguments: '{}', status: 'completed' }])
      : complete(response, `clear_answer_${count}`, message(count === 2 ? oldAnswer : 'Fresh answer.'),
        count === 2 ? oldAnswer : 'Fresh answer.'));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    let app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const id = app.id;
    app.broker.register('fixture_context', 'Return synthetic evidence.', z.object({}).strict(), 'internal', () => ({ text: oldTool }));
    try {
      const old = await app.submit(oldPrompt);
      expect(old.status, old.reason ?? '').toBe('completed');
      expect(JSON.stringify(endpoint.requests[1])).toContain(oldTool);
      const oldResults = app.store.list('result', id, old.id);
      const previousRuntime = app.runtimeId;
      const stop = vi.spyOn(CopilotClient.prototype, 'stop').mockResolvedValueOnce([new Error('Injected child shutdown failure.')]);
      await expect(app.clearContext()).rejects.toThrow('did not stop cleanly');
      expect(app.runtimeId).toBe(previousRuntime);
      await expect(app.submit('Blocked until reset succeeds.')).rejects.toThrow('Retry /clear');
      await app.clearContext();
      expect(stop).toHaveBeenCalledTimes(2);
      stop.mockRestore();
      const freshRuntime = app.runtimeId;
      expect(freshRuntime).not.toBe(previousRuntime);
      expect(endpoint.requests).toHaveLength(2);
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective).toBeUndefined();
      const fresh = await app.submit('NEW_CONTEXT_USER_96b13');
      expect(fresh.status, fresh.reason ?? '').toBe('completed');
      const request = JSON.stringify(endpoint.requests[2]);
      expect(request).toContain('NEW_CONTEXT_USER_96b13');
      expect(request).toContain('You are GitHub Copilot');
      expect(request).toContain('SDK-native tools, shells and built-in/workspace agents are available');
      for (const previous of [oldPrompt, oldAnswer, oldTool, old.id]) expect(request).not.toContain(previous);
      expect(app.runtimeId).toBe(freshRuntime);
      expect(app.store.get('objective', old.id, id)).toEqual(old);
      expect(app.store.list('result', id, old.id)).toEqual(oldResults);
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      const resumed = await app.submit('Resume only the fresh context.');
      expect(resumed.status, resumed.reason ?? '').toBe('completed');
      const resumedRequest = JSON.stringify(endpoint.requests[3]);
      expect(resumedRequest).toContain('NEW_CONTEXT_USER_96b13');
      for (const previous of [oldPrompt, oldAnswer, oldTool]) expect(resumedRequest).not.toContain(previous);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('uses SDK defaults and finishes a real tool turn above 100,000 cumulative reported tokens without reservations', async () => {
    const text = 'SDK-owned context and uncapped cumulative usage verified.';
    const usage = { input_tokens: 40000, output_tokens: 2000, total_tokens: 42000 };
    const endpoint = await provider((response, _body, count) => count < 3
      ? complete(response, `auto_tool_${count}`, [{ id: `auto_call_${count}`, call_id: `auto_call_${count}`,
        type: 'function_call', name: 'harness_work_inspect', arguments: '{}', status: 'completed' }], undefined, usage)
      : complete(response, 'auto_answer', message(text), text, usage));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const result = await app.submit('Exercise the actual SDK-first default path.');
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(result.usage).toMatchObject({ input: 120000, output: 6000, requests: 3, reserved: 0, unknown: false });
      expect(endpoint.requests).toHaveLength(3);
      expect(endpoint.requests.every(request => request.max_output_tokens === undefined)).toBe(true);
      expect(app.store.list('model', app.id, result.id).every(request => request.reservation === 0 && request.budgetScope === 'none')).toBe(true);
      expect(app.inspect()).toMatchObject({ budget: { mode: 'none', maxTokens: null, maxCost: null },
        modelLimits: { providerCapacityVerified: false, prompt: { source: 'runtime reported' },
          output: { limit: null, source: 'SDK/provider default' } } });
      expect(app.inspect().modelLimits.prompt.limit).toBeGreaterThan(32000);
      const activity = app.store.events(app.id).filter(event => event.data.state === 'model_request');
      expect(activity).toHaveLength(6);
      expect(activity.filter(event => record(event.data.request) && event.data.request.outcome === 'running')).toHaveLength(3);
      for (const request of app.store.list('model', app.id, result.id)) {
        expect(request).toMatchObject({ outcome: 'completed', started: expect.any(Number), finished: expect.any(Number) });
        expect(request.finished!).toBeGreaterThanOrEqual(request.started!);
        expect(activity.filter(event => record(event.data.request) && event.data.request.id === request.id)).toHaveLength(2);
      }
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('lets the SDK compact reported context pressure and cold-resume without rewriting objective evidence or resetting usage', async () => {
    let app: SessionController;
    let produced = false;
    const text = 'Synthetic compaction preserved the requested objective.';
    const endpoint = await provider((response, _body, count) => {
      const request = app.store.list('model', app.id, app.inspect().objective!.id).at(-1)!;
      if (request.interaction.includes('compaction')) {
        complete(response, `compact_${count}`, message('Synthetic summary: the generated-context tool completed; preserve the original objective and recorded product evidence.'),
          'Synthetic summary: the generated-context tool completed; preserve the original objective and recorded product evidence.');
      } else if (!produced) {
        produced = true;
        complete(response, 'large_context', [{ id: 'large_context_call', call_id: 'large_context_call', type: 'function_call',
          name: 'harness_fixture_context', arguments: '{}', status: 'completed' }], undefined,
        { input_tokens: 110000, output_tokens: 1000, total_tokens: 111000 });
      } else complete(response, `after_compaction_${count}`, message(text), text);
    });
    const f = fixture({ version: 4, limits: { maxRequests: 8 } });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    app.broker.register('fixture_context', 'Generate disposable synthetic context.', z.object({}).strict(), 'internal',
      () => ({ generated: 'Synthetic context-pressure fixture.' }));
    try {
      const first = await app.submit('Preserve this exact synthetic objective through SDK compaction.');
      expect(first.status, first.reason ?? '').toBe('completed');
      const events = app.store.events(id);
      const records = app.store.list('model', id, first.id);
      expect(events.some(event => event.type === 'runtime' && event.data.state === 'session.compaction_summarized' && event.data.success),
        JSON.stringify({ states: events.filter(event => event.type === 'runtime').map(event => event.data.state),
          limits: app.inspect().modelLimits, interactions: records.map(request => request.interaction) })).toBe(true);
      expect(records.some(request => request.interaction.includes('compaction'))).toBe(true);
      expect(first.usage.requests).toBe(records.length);
      expect(first.usage.input).toBe(records.reduce((sum, request) => sum + request.input, 0));
      expect(first.usage.output).toBe(records.reduce((sum, request) => sum + request.output, 0));
      expect(app.inspect().pendingModelRequests).toBe(0);
      const second = await app.submit('Let the SDK apply its settled background summary.');
      expect(second.status, second.reason ?? '').toBe('completed');
      expect(app.store.events(id).some(event => event.type === 'runtime' && event.data.state === 'session.compaction_complete' && event.data.success)).toBe(true);
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective).toEqual(second);
      expect((await app.submit('Continue with the native compacted conversation.')).status).toBe('completed');
      expect(app.store.get('objective', first.id, id)).toEqual(first);
      expect(app.store.list('model', id, first.id)).toEqual(records);
      expect(app.inspect().modelLimits.prompt.source).toBe('runtime reported');
      await app.clearContext();
      const requestCount = endpoint.requests.length;
      const fresh = await app.submit('Fresh context after native compaction.');
      expect(fresh.status, fresh.reason ?? '').toBe('completed');
      const freshRequests = JSON.stringify(endpoint.requests.slice(requestCount));
      expect(freshRequests).not.toContain('Synthetic summary:');
      expect(freshRequests).not.toContain(first.original);
      expect(freshRequests).not.toContain(second.original);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('cancels owned model work while waiting for background compaction instead of hanging or completing early', async () => {
    let compacting = false;
    const endpoint = await provider((response, _body, count) => {
      const request = app.store.list('model', app.id, app.inspect().objective!.id).at(-1)!;
      if (request.interaction.includes('compaction')) {
        compacting = true; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
      } else if (count === 1) {
        complete(response, 'cancel_context', [{ id: 'cancel_context_call', call_id: 'cancel_context_call', type: 'function_call',
          name: 'harness_work_inspect', arguments: '{}', status: 'completed' }], undefined,
        { input_tokens: 110000, output_tokens: 1000, total_tokens: 111000 });
      } else complete(response, 'cancel_wait', message('Wait for the owned compaction request.'), 'Wait for the owned compaction request.');
    });
    const f = fixture({ version: 4, limits: { toolTimeoutMs: 10000 } });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const work = app.submit('Cancel safely while background compaction is pending.');
      await vi.waitFor(() => expect(compacting).toBe(true), { timeout: 5000 });
      expect(app.inspect().busy).toBe(true);
      expect(app.inspect().pendingModelRequests).toBe(1);
      await app.cancel();
      const objective = await work;
      expect(objective.status).toBe('cancelled');
      expect(objective.usage).toMatchObject({ reserved: 0, unknown: true, cost: null });
      expect(app.inspect().pendingModelRequests).toBe(0);
      expect(app.trace().items.some(item => item.kind === 'model' && item.value.outcome === 'cancelled')).toBe(true);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('labels unknown-model fallback metadata as runtime-reported, never provider-verified capacity', async () => {
    const endpoint = await provider(response => complete(response, 'unknown_model', message('Synthetic unknown-model answer.'), 'Synthetic unknown-model answer.'));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL },
      model: { ...f.config.model, canonical: 'harness-unknown-model' } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      expect((await app.submit('Use the selected synthetic unknown model.')).status).toBe('completed');
      expect(app.inspect().modelLimits).toMatchObject({ model: 'harness-unknown-model', providerCapacityVerified: false,
        prompt: { source: 'runtime reported' }, output: { limit: null, source: 'SDK/provider default' } });
      expect(endpoint.requests[0]).toMatchObject({ model: 'synthetic-deployment' });
      expect(endpoint.requests[0]).not.toHaveProperty('max_output_tokens');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it.each(['missing', 'failed'])('keeps %s cached context metadata nonfatal and explicitly unavailable', async mode => {
    const original = CopilotClient.prototype.createSession;
    const spy = vi.spyOn(CopilotClient.prototype, 'createSession').mockImplementation(async function(this: CopilotClient, config) {
      const session = await original.call(this, config);
      session.rpc.metadata.contextInfo = async () => {
        if (mode === 'failed') throw new Error('Synthetic context metadata unavailable.');
        return { contextInfo: null };
      };
      return session;
    });
    const endpoint = await provider(response => complete(response, 'metadata_unknown', message('Metadata is optional.'), 'Metadata is optional.'));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const result = await app.submit('Complete without capacity metadata.');
      expect(result.status, result.reason ?? '').toBe('completed');
      expect(app.inspect().modelLimits.prompt).toEqual({ limit: null, used: null, source: 'unavailable' });
      if (mode === 'failed') expect(app.store.events(app.id).some(event => event.data.state === 'context_unavailable' && event.data.diagnostic)).toBe(true);
    } finally { await app.close(); spy.mockRestore(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('allows verified uncapped answers with unknown billing across cold resume without converting uncertainty to zero', async () => {
    const endpoint = await provider(response => complete(response, 'uncapped_no_usage', message('Synthetic answer with missing billing.'), 'Synthetic answer with missing billing.', false));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    let app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    try {
      const first = await app.submit('Complete an uncapped objective with missing billing.');
      expect(first).toMatchObject({ status: 'completed', usage: { unknown: true, cost: null, requests: 1 } });
      expect(app.store.list('model', id, first.id)[0]).toMatchObject({
        status: 'unknown', outcome: 'completed', reportedUsage: false, finished: expect.any(Number),
      });
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect(app.inspect().objective?.usage).toMatchObject({ unknown: true, cost: null });
      const second = await app.submit('Start another objective without inventing prior billing.');
      expect(second).toMatchObject({ status: 'completed', usage: { unknown: true, cost: null, requests: 1 } });
      expect(endpoint.requests).toHaveLength(2);
      expect(app.store.list('model', id, first.id)).toHaveLength(1);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('restores deliberate prompt/output overrides on cold resume without adding a task budget', async () => {
    const endpoint = await provider((response, _body, count) => complete(response, `explicit_${count}`, message('Explicit SDK limits retained.'), 'Explicit SDK limits retained.'));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL },
      model: { ...f.config.model, contextTokens: 48000, outputTokens: 1536 } });
    let app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id;
    try {
      expect((await app.submit('Use explicit request settings.')).status).toBe('completed');
      expect(app.inspect().modelLimits).toMatchObject({ prompt: { limit: 48000, source: 'explicit override' },
        output: { limit: 1536, source: 'explicit override' } });
      await app.close();
      await expect(SessionController.open({ config: parseConfig({ ...config, model: { ...config.model, contextTokens: 64000 } }), sessionId: id }))
        .rejects.toThrow('exact saved');
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      expect((await app.submit('Retain the same explicit settings after restart.')).status).toBe('completed');
      expect(app.inspect().modelLimits.prompt).toMatchObject({ limit: 48000, source: 'explicit override' });
      expect(endpoint.requests).toHaveLength(2);
      expect(endpoint.requests.every(request => request.max_output_tokens === 1536)).toBe(true);
      expect(app.inspect().budget.mode).toBe('none');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it.each([
    { label: 'token budget', limits: { maxTokens: 100000 } },
    { label: 'currency budget', limits: { maxCost: 1, inputPerMillion: 1, outputPerMillion: 2 } },
  ])('refuses an explicit $label without a finite SDK output bound before dispatch', async ({ limits }) => {
    const endpoint = await provider(response => complete(response, 'not_admitted', message('Unexpected dispatch.')));
    const f = fixture({ version: 4, limits });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      const result = await app.submit('Do not invent an output limit to enforce a budget.');
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('finite request output bound');
      expect(result.usage.requests).toBe(0);
      expect(endpoint.requests).toHaveLength(0);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 30000);

  it('keeps operator verification ceilings outside product policy and refuses an exhausted verifier before dispatch', async () => {
    const endpoint = await provider(response => complete(response, 'verified_default', message('Bounded verification only.'), 'Bounded verification only.'));
    const f = fixture({ version: 4 });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    try {
      for (const maxTokens of [100000, 128]) {
        const verification = { maxTokens, outputTokens: 128 };
        const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key',
          runtimeFactory: (resources, signal) => new CopilotRuntime(config, 'synthetic-provider-wire-key', resources, signal, verification) });
        try {
          const result = await app.submit('Exercise the separate operator spending guard.');
          expect(result.status).toBe(maxTokens === 128 ? 'failed' : 'completed');
          expect(app.inspect().budget).toEqual({ mode: 'none', maxTokens: null, maxCost: null,
            scope: 'intercepted model and explicitly priced domain requests', externalCharges: 'not covered' });
          expect(app.config.model.outputTokens).toBeUndefined();
          expect(app.inspect().modelLimits).toMatchObject({ verification, output: { limit: null, source: 'SDK/provider default' } });
          if (maxTokens !== 128) expect(app.store.list('model', app.id, result.id)[0]).toMatchObject({ budgetScope: 'verification' });
          else expect(result.reason).toContain('Insufficient tokens');
        } finally { await app.close(); }
      }
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]?.max_output_tokens).toBe(128);
      expect(config.limits.maxTokens).toBeUndefined();
    } finally { await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('retrieves workspace skills through native SDK tools and reloads without changing session identity', async () => {
    const endpoint = await provider((response, _body, count) => count === 1 || count === 3
      ? complete(response, `resp_skill_${count}`, [{
        id: `fc_skill_${count}`, type: 'function_call', call_id: `call_skill_${count}`,
        name: 'skill', arguments: '{"skill":"review-notes"}', status: 'completed',
      }])
      : complete(response, `resp_skill_answer_${count}`, message('Synthetic skill retrieval completed.'), 'Synthetic skill retrieval completed.'));
    const f = fixture();
    skillFile(f.workspace, 'review-notes', 'Original synthetic skill instructions.');
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const identity = { sessionId: app.id, runtimeId: app.runtimeId };
    try {
      expect((await app.submit('Read the custom skill.')).status).toBe('completed');
      expect(JSON.stringify(endpoint.requests[0])).toContain('Synthetic review-notes workflow guidance.');
      expect(JSON.stringify(endpoint.requests[1])).toContain('Original synthetic skill instructions.');
      skillFile(f.workspace, 'review-notes', 'Reloaded synthetic skill instructions.');
      await app.reloadSkills();
      expect((await app.submit('Read the updated custom skill.')).status).toBe('completed');
      expect(JSON.stringify(endpoint.requests[3])).toContain('Reloaded synthetic skill instructions.');
      expect({ sessionId: app.id, runtimeId: app.runtimeId }).toEqual(identity);
      expect(app.store.events(app.id).some(event => event.type === 'runtime' && event.data.state === 'creating' && event.data.resume)).toBe(true);
      expect(app.inspect().pending).toEqual([]);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);
  it('returns the specific network-policy failure to the model and makes earlier errors inspectable after cold resume without refetching', async () => {
    const endpoint = await provider((response, _body, count) => {
      if (count === 1) complete(response, 'resp_blocked_fetch', [{
        id: 'fc_blocked_fetch', type: 'function_call', call_id: 'call_blocked_fetch',
        name: 'harness_web_fetch', arguments: '{"url":"https://blocked.example/"}', status: 'completed',
      }]);
      else if (count === 3) complete(response, 'resp_inspect_error', [{
        id: 'fc_inspect_error', type: 'function_call', call_id: 'call_inspect_error',
        name: 'harness_work_inspect', arguments: '{}', status: 'completed',
      }]);
      else complete(response, `resp_error_${count}`, message('The configured network policy blocked the destination.'), 'The configured network policy blocked the destination.');
    });
    const f = fixture({ network: { origins: [] }, limits: { maxReplans: 0 } });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    let app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id; approve(app);
    try {
      const failed = await app.submit('Retrieve the synthetic blocked destination.');
      expect(failed.status).toBe('partial');
      const output = JSON.stringify(endpoint.requests[1]);
      expect(output).toContain('DESTINATION');
      expect(output).toContain('https://blocked.example');
      expect(output).toContain('not configured');
      expect(app.inspect().actions[0]).toMatchObject({ status: 'failed', errorCode: 'DESTINATION' });
      const peer = await SessionController.open({ config, runtimeFactory: () => new ScriptRuntime(async runtime => {
        await runtime.call('peer_failure', {});
      }) });
      try {
        peer.broker.register('peer_failure', 'Synthetic other-session error.', z.object({}).strict(), 'internal',
          () => { throw new HarnessError('PEER_PRIVATE', 'Other-session-only diagnostic.'); });
        await peer.submit('Record a separate-session diagnostic.');
      } finally { await peer.close(); }
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      await app.submit('Explain the earlier tool error without retrying the destination.');
      const recent = app.inspect().recentErrors;
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({ objectiveId: failed.id, tool: 'web_fetch', code: 'DESTINATION', origin: 'https://blocked.example' });
      expect(JSON.stringify(app.store.errors(id))).toContain('DESTINATION');
      expect(JSON.stringify(endpoint.requests[3])).toContain('DESTINATION');
      expect(JSON.stringify(endpoint.requests[3])).not.toContain('Other-session-only diagnostic.');
      expect(app.store.list('action', id).filter(action => action.tool === 'web_fetch')).toHaveLength(1);
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('returns explicit redacted SDK failure results instead of masking them or exposing credentials/control sequences', async () => {
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'resp_redacted_failure', [{
        id: 'fc_redacted_failure', type: 'function_call', call_id: 'call_redacted_failure',
        name: 'harness_fixture_failure', arguments: '{}', status: 'completed',
      }])
      : complete(response, 'resp_explained_failure', message('The synthetic tool failed.'), 'The synthetic tool failed.'));
    const f = fixture({ limits: { maxReplans: 0 } });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    app.broker.register('fixture_failure', 'Synthetic failure with sensitive error content.', z.object({}).strict(), 'internal',
      () => { throw new HarnessError('FIXTURE_FAILURE', 'Sensitive diagnostic synthetic-provider-wire-key\u001b[31m' + 'x'.repeat(10000) + 'TRUNCATED_DIAGNOSTIC_TAIL'); });
    try {
      await app.submit('Explain the synthetic controlled failure.');
      const output = JSON.stringify(endpoint.requests[1]);
      expect(output).toContain('FIXTURE_FAILURE');
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('synthetic-provider-wire-key');
      expect(output).not.toContain('\\u001b');
      expect(output).toContain('[truncated]');
      expect(output).not.toContain('TRUNCATED_DIAGNOSTIC_TAIL');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('uses BYOK identity native PowerShell streaming usage and cold resume without journal secrets', async () => {
    const endpoint = await provider((response, _body, count) => {
      if (count === 1 || count === 3) complete(response, `resp_v2_read_${count}`, [{
        id: `fc_v2_read_${count}`, type: 'function_call', call_id: `call_v2_read_${count}`,
        name: 'powershell', arguments: JSON.stringify({
          command: "Get-Content -LiteralPath 'notes.txt'", description: 'Read the disposable source evidence.', initial_wait: 30,
        }), status: 'completed',
      }]);
      else complete(response, `resp_v2_${count}`, message('Synthetic Copilot runtime result with recorded source evidence.'), 'Synthetic Copilot runtime result with recorded source evidence.');
    });
    const f = fixture();
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    let app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const id = app.id; const runtimeId = app.runtimeId;
    const events: string[] = []; app.subscribe(event => events.push(event.type));
    approve(app);
    try {
      const first = await app.submit('Read the synthetic notes using native PowerShell, then answer.');
      expect(first.status, first.reason ?? '').toBe('completed');
      expect(first.usage.requests).toBe(2);
      expect(first.usage.input).toBe(200);
      expect(first.usage.output).toBe(80);
      expect(first.usage.reserved).toBe(0);
      expect(events).toContain('text');
      expect(app.inspect().actions.find(action => action.tool === 'powershell')?.status).toBe('completed');
      expect(endpoint.requests.every(request => request.model === 'synthetic-deployment')).toBe(true);
      const encoded = JSON.stringify(endpoint.requests);
      expect(encoded).not.toContain('harness_workspace_read');
      expect(encoded).toContain('"name":"powershell"');
      expect(encoded).toContain('Synthetic reference evidence.');
      await app.close();
      app = await SessionController.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      approve(app);
      const second = await app.submit('Answer using the same synthetic session.');
      expect(second.status, second.reason ?? '').toBe('completed');
      expect(second.usage.requests).toBe(2);
      expect(app.inspect().actions.find(action => action.tool === 'powershell')?.status).toBe('completed');
      expect(app.runtimeId).toBe(runtimeId);
      await app.close();
      const scan = (directory: string): string => readdirSync(directory).map(name => {
        const file = path.join(directory, name);
        return statSync(file).isDirectory() ? scan(file) : readFileSync(file).toString('utf8');
      }).join('');
      expect(scan(f.dataDir)).not.toContain('synthetic-provider-wire-key');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('denies a real runtime native shell call without reading content or falling back to custom wrappers', async () => {
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'resp_denied', [{ id: 'fc_denied', type: 'function_call', call_id: 'call_denied',
        name: 'powershell', arguments: JSON.stringify({
          command: "Get-Content -LiteralPath 'notes.txt'; Set-Content -LiteralPath 'DENIED_SIDE_EFFECT.txt' -Value 'MUST_NOT_WRITE'",
          description: 'Read and write only after an explicit SDK permission.', initial_wait: 30,
        }), status: 'completed' }])
      : complete(response, 'resp_after_denial', message('The content read was denied.'), 'The content read was denied.'));
    const f = fixture({ permissionMode: 'manual' });
    const config = parseConfig({ ...f.config, provider: { kind: 'byok', baseURL: endpoint.baseURL } });
    const app = await SessionController.open({ config, apiKey: 'synthetic-provider-wire-key' }); approve(app, 'deny');
    let decisions = 0;
    app.subscribe(event => { if (event.type === 'request') decisions++; });
    try {
      await app.submit('Attempt the synthetic read.');
      expect(decisions).toBe(1);
      const action = app.inspect().actions.find(action => action.tool === 'powershell')!;
      expect(action?.status, `${action?.errorCode ?? 'no-code'}: ${action?.error ?? 'no-error'}`).toBe('denied');
      expect(JSON.stringify(endpoint.requests)).not.toContain('Synthetic reference evidence.');
      expect(existsSync(path.join(f.workspace, 'DENIED_SIDE_EFFECT.txt'))).toBe(false);
      expect(readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8')).toBe('Synthetic reference evidence.\nValue: 2\n');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);
});
