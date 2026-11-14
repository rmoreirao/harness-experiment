import { HarnessError } from './contracts.js';

export interface WorkflowStep {
  id: string;
  dependsOn?: string[];
  when?: (results: ReadonlyMap<string, unknown>) => boolean;
  execute: (signal: AbortSignal, results: ReadonlyMap<string, unknown>) => Promise<unknown>;
}
export async function executeWorkflow(steps: WorkflowStep[], concurrency: number, signal: AbortSignal): Promise<Map<string, unknown>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new HarnessError('WORKFLOW', 'Concurrency must be a positive integer.');
  const remaining = new Map(steps.map(s => [s.id, s]));
  if (remaining.size !== steps.length || steps.some(s => s.dependsOn?.some(d => !remaining.has(d)))) {
    throw new HarnessError('WORKFLOW', 'Step IDs must be unique and dependencies must exist.');
  }
  const results = new Map<string, unknown>();
  while (remaining.size) {
    signal.throwIfAborted();
    const ready = [...remaining.values()].filter(s => (s.dependsOn ?? []).every(d => results.has(d))).slice(0, concurrency);
    if (!ready.length) throw new HarnessError('WORKFLOW', 'Workflow has a dependency cycle.');
    await Promise.all(ready.map(async step => {
      if (step.when && !step.when(results)) results.set(step.id, { skipped: true });
      else results.set(step.id, await step.execute(signal, results));
      remaining.delete(step.id);
    }));
  }
  return results;
}
