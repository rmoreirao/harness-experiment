import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { V2Controller } from '../../src/v2/controller.js';
import { parseV2Config } from '../../src/v2/config.js';
import { provider, complete, message } from '../provider-fixture.js';
import { fixture, skillFile, approve, ScriptRuntime } from './helpers.js';
import { HarnessError } from '../../src/contracts.js';

describe('V2 A01 real pinned Copilot SDK/runtime over synthetic Responses', () => {
  it('retrieves custom skills through the real runtime and observes a reload without reopening the session', async () => {
    const endpoint = await provider((response, _body, count) => count === 1 || count === 3
      ? complete(response, `resp_skill_${count}`, [{
        id: `fc_skill_${count}`, type: 'function_call', call_id: `call_skill_${count}`,
        name: 'harness_workflow_skill', arguments: '{"name":"review-notes"}', status: 'completed',
      }])
      : complete(response, `resp_skill_answer_${count}`, message('Synthetic skill retrieval completed.'), 'Synthetic skill retrieval completed.'));
    const f = fixture();
    skillFile(f.workspace, 'review-notes', 'Original synthetic skill instructions.');
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    try {
      expect((await app.submit('Read the custom skill.')).status).toBe('completed');
      expect(JSON.stringify(endpoint.requests[0])).toContain('Synthetic review-notes workflow guidance.');
      expect(JSON.stringify(endpoint.requests[1])).toContain('Original synthetic skill instructions.');
      skillFile(f.workspace, 'review-notes', 'Reloaded synthetic skill instructions.');
      app.reloadSkills();
      expect((await app.submit('Read the updated custom skill.')).status).toBe('completed');
      expect(JSON.stringify(endpoint.requests[3])).toContain('Reloaded synthetic skill instructions.');
      expect(app.store.events(app.id).filter(event => event.type === 'runtime' && event.data.state === 'creating')).toHaveLength(1);
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
    const f = fixture({ limits: { maxReplans: 0 } });
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); const id = app.id; approve(app);
    try {
      const failed = await app.submit('Retrieve the synthetic blocked destination.');
      expect(failed.status).toBe('partial');
      const output = JSON.stringify(endpoint.requests[1]);
      expect(output).toContain('DESTINATION');
      expect(output).toContain('https://blocked.example');
      expect(output).toContain('not configured');
      expect(app.inspect().actions[0]).toMatchObject({ status: 'failed', errorCode: 'DESTINATION' });
      const peer = await V2Controller.open({ config, runtimeFactory: () => new ScriptRuntime(async runtime => {
        await runtime.call('peer_failure', {});
      }) });
      try {
        peer.broker.register('peer_failure', 'Synthetic other-session error.', z.object({}).strict(), 'internal',
          () => { throw new HarnessError('PEER_PRIVATE', 'Other-session-only diagnostic.'); });
        await peer.submit('Record a separate-session diagnostic.');
      } finally { await peer.close(); }
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      await app.submit('Explain the earlier tool error without retrying the destination.');
      const recent = app.inspect().recentErrors;
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({ objectiveId: failed.id, tool: 'web_fetch', code: 'DESTINATION', origin: 'https://blocked.example' });
      expect(JSON.stringify(endpoint.requests[3])).toContain('recentErrors');
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
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
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

  it('uses BYOK identity, streaming, exact custom-tool policy, usage and a cold runtime resume without journal secrets', async () => {
    const endpoint = await provider((response, _body, count) => {
      if (count === 1 || count === 3) complete(response, `resp_v2_read_${count}`, [{
        id: `fc_v2_read_${count}`, type: 'function_call', call_id: `call_v2_read_${count}`,
        name: 'harness_workspace_read', arguments: JSON.stringify({ path: 'notes.txt', start: 1, lines: 20 }), status: 'completed',
      }]);
      else complete(response, `resp_v2_${count}`, message('Synthetic Copilot runtime result with recorded source evidence.'), 'Synthetic Copilot runtime result with recorded source evidence.');
    });
    const f = fixture();
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    let app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' });
    const id = app.id; const runtimeId = app.runtimeId;
    const events: string[] = []; app.subscribe(event => events.push(event.type));
    approve(app);
    try {
      const first = await app.submit('Read the synthetic notes using workspace_read, then answer.');
      expect(first.status, first.reason ?? '').toBe('completed');
      expect(first.usage.requests).toBe(2);
      expect(first.usage.input).toBe(200);
      expect(first.usage.output).toBe(80);
      expect(first.usage.reserved).toBe(0);
      expect(events).toContain('text');
      expect(app.inspect().actions.find(action => action.tool === 'workspace_read')?.status).toBe('completed');
      expect(endpoint.requests.every(request => request.model === 'synthetic-deployment')).toBe(true);
      const encoded = JSON.stringify(endpoint.requests);
      expect(encoded).toContain('workspace_read');
      expect(encoded).not.toContain('"name":"powershell"');
      expect(encoded).not.toContain('"name":"bash"');
      await app.close();
      app = await V2Controller.open({ config, sessionId: id, apiKey: 'synthetic-provider-wire-key' });
      approve(app);
      const second = await app.submit('Answer using the same synthetic session.');
      expect(second.status, second.reason ?? '').toBe('completed');
      expect(second.usage.requests).toBe(2);
      expect(app.inspect().actions.find(action => action.tool === 'workspace_read')?.status).toBe('completed');
      expect(app.runtimeId).toBe(runtimeId);
      await app.close();
      const scan = (directory: string): string => readdirSync(directory).map(name => {
        const file = path.join(directory, name);
        return statSync(file).isDirectory() ? scan(file) : readFileSync(file).toString('utf8');
      }).join('');
      expect(scan(f.dataDir)).not.toContain('synthetic-provider-wire-key');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);

  it('denies a real runtime custom call without reading content or falling back to host tools', async () => {
    const endpoint = await provider((response, _body, count) => count === 1
      ? complete(response, 'resp_denied', [{ id: 'fc_denied', type: 'function_call', call_id: 'call_denied',
        name: 'harness_workspace_read', arguments: '{"path":"notes.txt"}', status: 'completed' }])
      : complete(response, 'resp_after_denial', message('The content read was denied.'), 'The content read was denied.'));
    const f = fixture();
    const config = parseV2Config({ ...f.config, model: { ...f.config.model, baseURL: endpoint.baseURL } });
    const app = await V2Controller.open({ config, apiKey: 'synthetic-provider-wire-key' }); approve(app, 'deny');
    try {
      await app.submit('Attempt the synthetic read.');
      expect(app.inspect().actions.find(action => action.tool === 'workspace_read')?.status).toBe('denied');
      expect(JSON.stringify(endpoint.requests)).not.toContain('Synthetic reference evidence.');
    } finally { await app.close(); await endpoint.close(); f.cleanup(); }
  }, 60000);
});
