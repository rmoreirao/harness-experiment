import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { SessionController } from '../src/controller.js';
import { loadConfig, loadEnvironment, parseConfig } from '../src/config.js';
import { errorText } from '../src/contracts.js';
import { Redactor } from '../src/privacy.js';
import { fixture } from './helpers.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    live: { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean' },
    'max-tokens': { type: 'string' }, 'max-requests': { type: 'string' },
  } });
  if (values.help) {
    console.log('node --import tsx .\\test\\live-check.ts --live --config .\\harness.local.json\nOr: node --import tsx .\\test\\live-check.ts --live --max-tokens 20000 --max-requests 10\nLoads .env. Requires an explicitly authorized currency budget with prices, or an explicit token cap (currency cost then remains unknown). Sends synthetic data only.');
    return;
  }
  if (!values.live) throw new Error('Live verification is opt-in. Supply --live only after authorizing an explicit currency or token budget.');
  const positiveInteger = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer.`);
    return Number(value);
  };
  const maxTokens = positiveInteger(values['max-tokens'], '--max-tokens');
  const maxRequests = positiveInteger(values['max-requests'], '--max-requests');
  loadEnvironment();
  if (!process.env.OPENAI_API_KEY) throw new Error('Provide OPENAI_API_KEY securely in the launching environment.');
  const f = fixture();
  let app: SessionController | undefined;
  try {
    const base = loadConfig(values.config, {
      mode: 'openai', workspace: f.config.workspace, dataDir: f.config.dataDir, mcp: [],
      enabledTools: ['read_documents', 'write_file', 'ask_user'],
      instructions: 'This is a short verification task with known filenames. Read notes.md directly, cite it, and save a concise summary to summary.md after separate read and save approvals. Do not list directories or create a task list for this short check. Return one short confirmation after a successful save.',
      outputSchema: undefined,
    });
    if (base.limits.maxCost === undefined && maxTokens === undefined) {
      throw new Error('Live verification requires an explicit maxCost with prices, or an explicitly authorized --max-tokens cap.');
    }
    const config = parseConfig({ ...base, limits: {
      ...base.limits,
      maxTokens: Math.min(base.limits.maxTokens, maxTokens ?? base.limits.maxTokens),
      maxIterations: Math.min(base.limits.maxIterations, maxRequests ?? (maxTokens !== undefined ? 10 : base.limits.maxIterations)),
    } });
    app = await SessionController.open({ config });
    const run = await app.submit('Read notes.md, summarize the launch date with a source reference, and save the summary as summary.md.');
    let clarificationCount = 0;
    let interactionFailure: string | null = null;
    for (let i = 0; i < 20 && app.inspect().pending.length; i++) {
      const request = app.inspect().pending[0]!;
      if (request.kind === 'question' && request.tool === 'ask_user' && clarificationCount < 2) {
        clarificationCount++;
        await app.respond(request.id, request.revision, { answer: 'Use only notes.md in the synthetic workspace. Summarize its launch date, cite notes.md, and save to a new summary.md. Request read and write tool approvals separately through the runtime.' });
        continue;
      }
      if (request.kind !== 'approval' || !['read_documents', 'search_documents', 'write_file'].includes(request.tool)) {
        interactionFailure = `Unexpected ${request.kind} interaction for ${request.tool}; no action was approved.`;
        break;
      }
      await app.respond(request.id, request.revision, 'approve');
    }
    const result = app.inspect().run!;
    const artifacts = app.store.artifacts(run.id);
    const readWasApproved = app.store.requests(run.id).some(r => r.tool === 'read_documents' && r.status === 'approved');
    const saveWasApproved = app.store.requests(run.id).some(r => r.tool === 'write_file' && r.status === 'approved');
    const content = artifacts[0] ? readFileSync(artifacts[0].path, 'utf8') : '';
    const passed = !interactionFailure && result.status === 'completed' && readWasApproved && saveWasApproved && /Monday/i.test(content) && /notes\.md/i.test(content);
    console.log(JSON.stringify({ passed, model: config.model, runId: run.id, status: result.status,
      reason: interactionFailure ?? result.reason, approvedRead: readWasApproved, approvedSave: saveWasApproved,
      answeredClarifications: clarificationCount, usage: result.usage,
      limits: { maxTokens: config.limits.maxTokens, maxRequests: config.limits.maxIterations, maxCost: config.limits.maxCost ?? null },
      tools: app.store.invocations(run.id).map(i => ({ tool: i.tool, status: i.status })),
      finalOutput: result.finalOutput }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally { await app?.close(); f.cleanup(); }
}
main().catch(error => {
  console.error(new Redactor([process.env.OPENAI_API_KEY ?? '']).text(errorText(error)));
  process.exitCode = 1;
});
