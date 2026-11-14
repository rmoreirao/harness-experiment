import { writeFileSync } from 'node:fs';
import { Ownership } from '../src/ownership.js';
import { SessionController } from '../src/controller.js';
import { loadConfig } from '../src/config.js';

const [action, ...args] = process.argv.slice(2);
if (action === 'lock') {
  const owner = new Ownership(args[0]!, args[1]!);
  console.log('READY');
  process.stdin.resume();
  process.once('SIGTERM', () => { owner.close(); process.exit(0); });
} else if (action === 'effect-crash') {
  const config = loadConfig(args[0]);
  const app = await SessionController.open({ config, tools: [{
    name: 'effect', description: 'Synthetic crash fixture',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    effect: 'external', approval: false,
    execute: () => { writeFileSync(args[1]!, 'one effect', { flag: 'wx' }); process.exit(17); },
  }] });
  const run = await app.submit('hello');
  app.store.putRun({ ...run, status: 'running' });
  app.store.putRequest({ id: 'synthetic-approval', runId: run.id, callId: 'crash-effect', tool: 'effect',
    kind: 'approval', args: {}, status: 'approved', answer: null, revision: 1 });
  console.log(JSON.stringify({ sessionId: app.id, runId: run.id }));
  await app.gateway.execute('effect', {}, run.id, 'crash-effect');
}
