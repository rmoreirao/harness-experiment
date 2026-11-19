import { vi } from 'vitest';
import { CopilotClient, type CopilotSession, type SessionConfig, type SessionEvent } from '@github/copilot-sdk';
import { CopilotRuntime } from '../src/runtime.js';
import { RUNTIME_VERSION } from '../src/config.js';
import type { RuntimeOptions, TaskMode } from '../src/contracts.js';
import { resourceFixture } from './resource-fixture.js';

export async function sdkFixture(overrides: Record<string, unknown> = {}, resume = false,
  setup?: (fixture: ReturnType<typeof resourceFixture>) => void) {
  const f = resourceFixture(overrides);
  setup?.(f);
  const signal = new AbortController().signal;
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  let clientOptions: Record<string, unknown> = {};
  let taskMode: TaskMode = 'interactive';
  let configuration: SessionConfig | undefined;
  const session = {
    permissionModeResult: { success: true, mode: 'allow-all' },
    sendAndWait: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getEvents: vi.fn(async () => []),
    rpc: {
      permissions: { setMode: vi.fn(async ({ mode }: { mode: string }) => ({ success: true, mode })) },
      mode: {
        set: vi.fn(async ({ mode }: { mode: TaskMode }) => { taskMode = mode; return { status: 'applied' }; }),
        get: vi.fn(async () => taskMode),
      },
      metadata: { contextInfo: vi.fn(async () => ({ contextInfo: null })) },
      skills: {
        list: vi.fn(async () => ({ skills: [{ name: 'workspace-skill', description: 'SDK-advertised guidance.',
          source: 'workspace', enabled: true, userInvocable: true }] })),
        reload: vi.fn(async () => ({ errors: [] as string[], warnings: [] as string[] })),
      },
      tasks: {
        refresh: vi.fn(async () => ({})),
        list: vi.fn(async (): Promise<{ tasks: { id: string; status: string }[] }> => ({ tasks: [] })),
        waitForPending: vi.fn(async () => ({})),
        cancel: vi.fn(async (_input: { id: string }) => ({})),
      },
      cancelAllBackgroundAgents: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => ({})),
      accounts: {
        get: vi.fn(async () => ({ kind: 'status', status: { isAuthenticated: false } })),
        login: {
          begin: vi.fn(async () => ({ flowId: 'flow-one', step: {
            kind: 'device-code', verificationUri: 'https://login.example.invalid/device',
            userCode: 'SYNTHETIC-DEVICE-CODE', expiresIn: 60, interval: 5,
          } } as Awaited<ReturnType<CopilotSession['rpc']['accounts']['login']['begin']>>)),
          advance: vi.fn(async (_input: { flowId: string; input?: string }) =>
            ({ kind: 'completed', result: { status: 'completed' } } as Awaited<ReturnType<CopilotSession['rpc']['accounts']['login']['advance']>>)),
          cancel: vi.fn(async (_input: { flowId: string }) => ({})),
        },
      },
      mcp: {
        list: vi.fn(async (): Promise<{ servers: { name: string; status: string; source?: string; url?: string; owned?: boolean }[] }> => ({ servers: [] })),
        oauth: {
          probe: vi.fn(async (_input: { serverName: string }) => ({
            status: 'authentication-required', httpResponse: { statusCode: 401,
              headers: { authorization: 'PRIVATE_PROBE_HEADER' }, body: 'PRIVATE_PROBE_BODY' },
          })),
          login: vi.fn(async (_input: { serverName: string; clientName: string; callbackSuccessMessage: string }) => ({
            authorizationUrl: 'https://auth.example.invalid/authorize?state=SYNTHETIC_OAUTH_STATE&client_id=public-client&code_challenge=S256_PUBLIC_CHALLENGE',
          })),
        },
      },
      model: { list: vi.fn(async () => ({ list: [{ id: f.config.model.canonical }] })) },
      plan: { read: vi.fn(async () => ({ content: 'Native SDK plan.' })), update: vi.fn(async () => ({})) },
    },
  };
  vi.spyOn(CopilotClient.prototype, 'start').mockImplementation(async function (this: CopilotClient) {
    clientOptions = (this as unknown as { options: Record<string, unknown> }).options;
  });
  vi.spyOn(CopilotClient.prototype, 'stop').mockResolvedValue([]);
  vi.spyOn(CopilotClient.prototype, 'getStatus').mockResolvedValue({
    version: RUNTIME_VERSION, hostDiagnostics: { errorReporting: 'disabled' },
  } as Awaited<ReturnType<CopilotClient['getStatus']>>);
  const create = vi.spyOn(CopilotClient.prototype, 'createSession').mockImplementation(async config => {
    configuration = config; return session as unknown as CopilotSession;
  });
  const restore = vi.spyOn(CopilotClient.prototype, 'resumeSession').mockImplementation(async (_id, config) => {
    configuration = config; return session as unknown as CopilotSession;
  });
  const permission = vi.fn<RuntimeOptions['permission']>(async () => ({ kind: 'reject' }));
  const options: RuntimeOptions = {
    sessionId: 'sdk-parent', resume, directory: f.dataDir, signal, permission,
    permissionMode: f.config.permissionMode, taskMode: f.config.taskMode,
    tools: [{ name: 'fixture_custom', description: 'Retained custom fixture.', parameters: { type: 'object' },
      invoke: async () => '{"text":"custom result"}' }],
    emit: (type, data) => emitted.push({ type, data: structuredClone(data) }),
    question: async () => 'Synthetic answer.', beforeStop: async () => null,
  };
  const runtime = new CopilotRuntime(f.config, 'SYNTHETIC_PROVIDER_KEY', f.resources, () => signal);
  try { await runtime.open(options); }
  catch (error) { vi.restoreAllMocks(); f.cleanup(); throw error; }
  return { ...f, runtime, session, options, emitted, permission, create, restore,
    configuration: () => configuration!,
    clientOptions: () => clientOptions,
    emitSdk: (sdkEvent: SessionEvent) => configuration!.onEvent!(sdkEvent),
    cleanup: async () => { try { await runtime.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); f.cleanup(); } },
  };
}
