import { fixture } from './helpers.js';
import { Store } from '../src/store.js';
import { Resources } from '../src/resources.js';
import type { Objective } from '../src/contracts.js';
import { Redactor } from '../src/privacy.js';

export function resourceFixture(overrides: Record<string, unknown> = {}, secrets: string[] = []) {
  const f = fixture(overrides);
  const store = new Store(f.dataDir, new Redactor(secrets));
  const sessionId = store.createSession(f.config).id;
  const objective: Objective = {
    id: 'synthetic-objective', sessionId, original: 'Verify native request accounting.',
    domain: 'general', criteria: [], status: 'running', created: Date.now(),
    deadline: Date.now() + 600000, plan: null, replans: 0, actions: 0,
    output: '', reason: null,
    usage: { input: 0, output: 0, requests: 0, reserved: 0, cost: 0, unknown: false },
  };
  store.put('objective', objective);
  const resources = new Resources(store, f.config, sessionId, () => objective.id);
  return { ...f, store, sessionId, objective, resources,
    cleanup: () => { store.close(); f.cleanup(); } };
}
