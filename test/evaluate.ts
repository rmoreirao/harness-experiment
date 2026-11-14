import { SessionController } from '../src/controller.js';
import { fixture, approveAll } from './helpers.js';

const results: Record<string, unknown>[] = [];
for (const scenario of ['reference', 'denied-read', 'token-limit'] as const) {
  const f = fixture(scenario === 'token-limit' ? { limits: { maxTokens: 128 } } : {});
  const app = await SessionController.open({ config: f.config });
  try {
    const run = await app.submit('Read documents, summarize them, and save the summary.');
    if (scenario === 'reference') await approveAll(app);
    if (scenario === 'denied-read') {
      const request = app.inspect().pending[0]!;
      await app.respond(request.id, request.revision, 'reject');
    }
    const result = app.inspect().run!;
    const expected = scenario === 'reference' ? 'completed' : scenario === 'denied-read' ? 'partial' : 'failed';
    const passed = result.status === expected && (scenario !== 'reference' || app.store.artifacts(run.id).length === 1);
    results.push({ scenario, configurationVersion: f.config.version, model: f.config.model,
      runId: run.id, sessionId: app.id, status: result.status, expected, passed, traceEvents: app.store.trace(run.id).length, usage: result.usage });
    if (!passed) process.exitCode = 1;
  } finally { await app.close(); f.cleanup(); }
}
console.log(JSON.stringify(results, null, 2));
