import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { V2Controller } from '../../src/v2/controller.js';
import { loadV2Config, parseV2Config } from '../../src/v2/config.js';
import { loadEnvironment } from '../../src/config.js';
import { errorText } from '../../src/contracts.js';
import { Redactor } from '../../src/privacy.js';
import { CopilotRuntime } from '../../src/v2/runtime.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'allow-spending': { type: 'boolean' }, 'max-tokens': { type: 'string' },
    'max-output-tokens': { type: 'string' },
    config: { type: 'string' }, 'output-dir': { type: 'string' },
  } });
  if (!values['allow-spending'] || !values['max-tokens'] || !values['output-dir']) {
    throw new Error('Live verification requires --allow-spending, --max-tokens and --output-dir. It is never part of the default test suite.');
  }
  const maximum = z.coerce.number().int().min(128).max(100000).parse(values['max-tokens']);
  const verificationBudget = { maxTokens: maximum,
    outputTokens: z.coerce.number().int().min(32).max(8192).parse(values['max-output-tokens'] ?? 2048) };
  loadEnvironment();
  const saved = loadV2Config(values.config);
  if (saved.version !== 3 || saved.limits.maxTokens !== undefined || saved.limits.maxCost !== undefined ||
      saved.model.contextTokens !== undefined || saved.model.outputTokens !== undefined) {
    throw new Error('Default-mode news verification requires a version-3 configuration without product token/currency budgets or prompt/output overrides. Existing explicit policies were not changed.');
  }
  const output = path.resolve(values['output-dir']); mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(path.join(output, 'globo-live-'));
  const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
  const config = parseV2Config({
    ...saved, workspace, dataDir: path.join(directory, 'state'), skillsDirectory: undefined,
    execution: undefined, browser: undefined, search: undefined, mcp: [],
  });
  const app = await V2Controller.open({ config, runtimeFactory: (resources, signal) =>
    new CopilotRuntime(config, process.env.OPENAI_API_KEY ?? '', resources, signal, verificationBudget) });
  const unsubscribe = app.subscribe(event => {
    if (event.type === 'request') {
      const request = app.inspect().pending.at(-1)!;
      if (request.kind === 'question') {
        const answer = 'A general overview of the current top headlines on Globo.com, across categories.';
        if (request.allowFreeform || !request.choices?.length) app.decide(request.id, request.revision, request.binding, answer);
        else void app.cancel();
      } else {
        const action = app.store.get('action', request.actionId, app.id);
        const url = typeof action.args.url === 'string' && URL.canParse(action.args.url) ? new URL(action.args.url) : null;
        const allowed = action.tool === 'web_fetch' && url?.protocol === 'https:' &&
          !url.username && !url.password && (url.hostname === 'globo.com' || url.hostname.endsWith('.globo.com'));
        app.decide(request.id, request.revision, request.binding, allowed ? 'approve' : 'deny');
      }
    }
    if (event.type === 'action') {
      const action = event.data.action;
      if (action && typeof action === 'object' && 'tool' in action && 'status' in action) {
        console.log(JSON.stringify({ tool: action.tool, status: action.status }));
      }
    }
  });
  try {
    const objective = await app.submit('what are latest news on globo.com?');
    const reports = app.inspect().results.filter(result => result.provenance.kind === 'research_report');
    const claims = app.store.list('claim', app.id, objective.id);
    const sources = app.store.list('source', app.id, objective.id);
    const supportedHeadlines = new Set(claims.flatMap(claim => claim.support.flatMap(reference => {
      const source = sources.find(source => source.id === reference.sourceId);
      return source?.evidence?.filter(evidence => evidence.url && evidence.quote === reference.quote).map(evidence => evidence.id) ?? [];
    })));
    const actions = app.inspect().actions;
    const cleanup: { state: 'pending' | 'completed' | 'failed'; error: string | null } = { state: 'pending', error: null };
    const summary = {
      prompt: objective.original, status: objective.status, reason: objective.reason, model: config.model.canonical,
      sessionId: app.id, objectiveId: objective.id, usage: objective.usage, productBudget: app.inspect().budget,
      modelLimits: app.inspect().modelLimits, verificationBudget,
      requests: app.store.list('model', app.id, objective.id).map(request => ({
        id: request.id, interaction: request.interaction, status: request.status, budgetScope: request.budgetScope,
        input: request.input, output: request.output,
      })),
      actions: { total: actions.length, completed: actions.filter(action => action.status === 'completed').length,
        failed: actions.filter(action => ['failed', 'denied', 'unknown'].includes(action.status)).length },
      failures: app.store.errors(app.id).errors.map(error => ({ id: error.id, code: error.code, source: error.source, message: error.message })),
      pendingRequests: app.inspect().pendingModelRequests, pendingDecisions: app.inspect().pending.length, cleanup,
      reports: reports.length, supportedHeadlines: supportedHeadlines.size,
      sources: sources.map(source => ({ url: source.finalUrl, retrieved: source.retrieved, evidence: source.evidence?.length ?? 0 })),
    };
    writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(summary, null, 2));
    writeFileSync(path.join(directory, 'answer.md'), objective.output);
    try { await app.close(); cleanup.state = 'completed'; }
    catch (error) { cleanup.state = 'failed'; cleanup.error = app.store.redactor.text(errorText(error)); throw error; }
    finally { writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(summary, null, 2)); }
    console.log(JSON.stringify({ ...summary, directory }, null, 2));
    if (objective.status !== 'completed' || !reports.length || supportedHeadlines.size < 3 ||
        summary.pendingRequests || summary.pendingDecisions ||
        objective.usage.unknown || objective.usage.reserved || objective.usage.input + objective.usage.output > maximum) {
      throw new Error('The exact news request did not pass live outcome verification. Inspect the retained verification and session evidence.');
    }
  } finally { unsubscribe(); await app.close(); }
}
main().catch(error => {
  console.error(new Redactor([process.env.OPENAI_API_KEY ?? '']).text(errorText(error)));
  process.exitCode = 1;
});
