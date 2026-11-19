import type { ActivityRecord, Decision, Objective } from './contracts.js';
import type { Config } from './config.js';
import { terminalText } from './privacy.js';

export interface Activity {
  id: string;
  shortId: string;
  kind: 'tool' | 'model';
  name: string;
  status: 'queued' | 'approval' | 'input' | 'running' | 'completed' | 'failed' | 'denied' | 'unknown' | 'resolved' | 'cancelled';
  successful: boolean;
  started?: number;
  finished?: number;
  detail: ActivityRecord;
}
export interface ActivityGroup { kind: 'group'; models: number; tools: number }
export interface ActivityContext {
  model: Config['model'];
  pending: Decision[];
  status?: Objective['status'];
}
const active = ['preparing', 'running', 'awaiting_approval', 'awaiting_input'];

export function projectActivity(item: ActivityRecord, context: ActivityContext): Activity {
  const value = item.value;
  const live = context.status !== undefined && active.includes(context.status);
  let status: Activity['status'];
  let successful: boolean;
  if (item.kind === 'tool') {
    if (item.value.status === 'started') status = !live ? 'unknown'
      : item.value.tool === 'work_question' && context.pending.some(decision => decision.kind === 'question') ? 'input' : 'running';
    else if (item.value.status === 'pending') {
      status = !live ? 'unknown'
        : context.pending.some(decision => decision.actionId === value.id && decision.kind === 'approval') ? 'approval' : 'queued';
    } else status = item.value.status;
    successful = status === 'completed';
  } else {
    const request = item.value;
    status = request.status === 'started' || request.status === 'reserved'
      ? live ? 'running' : 'unknown'
      : request.outcome && request.outcome !== 'running' ? request.outcome
      : request.error ? 'failed'
      : request.status === 'completed' ? 'completed' : request.status === 'failed' ? 'failed' : 'unknown';
    successful = status === 'completed' && request.status === 'completed' && request.reportedUsage !== false;
  }
  return {
    id: value.id, shortId: `${item.kind === 'tool' ? 't' : 'm'}-${value.id.slice(0, 8)}`,
    kind: item.kind, name: item.kind === 'tool' ? item.value.tool : item.value.model ?? context.model.canonical,
    status, successful, started: value.started, finished: value.finished, detail: item,
  };
}

export function foldActivity(items: Activity[], capacity: number, expanded: boolean, pinned?: ReadonlySet<string>): (Activity | ActivityGroup)[] {
  if (expanded || items.length <= capacity) return items;
  const newestSuccess = items.findLastIndex(item => item.successful);
  let overflow = items.length - capacity;
  const rows: (Activity | ActivityGroup)[] = [];
  for (let index = 0; index < items.length;) {
    const start = index;
    while (index < items.length && index !== newestSuccess && items[index]!.successful && !pinned?.has(items[index]!.id)) index++;
    const count = index - start;
    if (count > 1 && overflow > 0) {
      const tools = items.slice(start, index).filter(item => item.kind === 'tool').length;
      rows.push({ kind: 'group', tools, models: count - tools });
      overflow -= count - 1;
    } else rows.push(...items.slice(start, index));
    if (index < items.length) rows.push(items[index++]!);
  }
  return rows;
}

function elapsed(item: Activity, now: number): string {
  const end = item.finished ?? (item.status === 'running' ? now : undefined);
  if (item.started === undefined || end === undefined) return 'time unavailable';
  const ms = Math.max(0, end - item.started);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function activityLine(item: Activity | ActivityGroup, now = Date.now()): string {
  if (item.kind === 'group') return `> Earlier success: ${item.models} model + ${item.tools} tool calls | /trace expand`;
  const label = item.status === 'completed' ? 'done' : item.status === 'running' ? 'run'
    : item.status === 'approval' ? 'wait approval' : item.status === 'input' ? 'waiting for input' : item.status;
  const action = item.detail.kind === 'tool' ? item.detail.value : undefined;
  const target = action && typeof action.args.path === 'string' ? ` ${action.args.path.slice(0, 120)}` : '';
  const usage = item.detail.kind === 'model' && item.status === 'completed' && !item.successful ? ' | usage unknown' : '';
  const actor = item.detail.value.actorId ? ` | worker ${item.detail.value.actorId.slice(0, 12)}` : '';
  return terminalText(`[${label}] ${item.kind.toUpperCase()} ${item.shortId} ${item.name}${target} | ${elapsed(item, now)}${actor}${usage}`);
}

export function activityDetail(item: Activity, config: Config): string {
  const record = item.detail;
  const lines = [
    `${item.kind.toUpperCase()} ${item.shortId} ${item.name}`,
    `ID: ${item.id}`, `Status: ${item.status}`, `Duration: ${elapsed(item, Date.now())}`,
    `Started: ${item.started === undefined ? 'unavailable' : new Date(item.started).toISOString()}`,
    `Finished: ${item.finished === undefined ? 'unavailable' : new Date(item.finished).toISOString()}`,
    `Actor: ${record.value.actorId ?? 'parent'}`,
  ];
  if (record.kind === 'tool') {
    const action = record.value;
    const args = JSON.stringify(action.args, null, 2);
    lines.push(`Runtime call ID: ${action.callId}`, `Runtime session: ${action.runtimeSessionId ?? 'parent'}`,
      `Origin: ${action.origin ?? 'custom'}`, `Effect: ${action.effect}`,
      `Arguments (redacted):\n${args.slice(0, 8192)}${args.length > 8192 ? '\n[arguments truncated]' : ''}`,
      `Result: ${action.resultId ? `/inspect ${action.resultId}` : 'unavailable'}`);
  } else {
    const request = record.value;
    const reported = request.reportedUsage ?? request.status === 'completed';
    const model = request.model ?? config.model.canonical;
    const entry = config.models.find(item => item.id === model);
    const inputRate = entry?.inputPerMillion ?? (model === config.model.canonical ? config.limits.inputPerMillion : undefined);
    const outputRate = entry?.outputPerMillion ?? (model === config.model.canonical ? config.limits.outputPerMillion : undefined);
    const price = reported && config.provider.kind === 'byok' && inputRate !== undefined && outputRate !== undefined
      ? (request.input * inputRate + request.output * outputRate) / 1e6 : null;
    lines.push(`Provider: ${request.provider ?? config.provider.kind}`, `Model: ${model}`, `Wire model: ${request.wireModel ?? config.model.wire}`,
      `Interaction: ${request.interaction === 'model-or-auxiliary' ? 'unavailable' : request.interaction}`,
      `Input tokens: ${reported ? request.input : 'unknown'}`, `Output tokens: ${reported ? request.output : 'unknown'}`,
      `Cost: ${price === null ? 'unknown' : `${price} (configured pricing)`}`,
      'Raw prompts and hidden reasoning are not included.');
  }
  if (record.value.error) lines.push(`Error: ${record.value.error.slice(0, 2048)}`);
  return terminalText(lines.join('\n'));
}
