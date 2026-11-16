import { activityDetail, activityLine, foldActivity, type Activity } from './activity.js';
import type { Config } from './config.js';

export type TraceTarget =
  | { key: 'root'; kind: 'root' }
  | { key: string; kind: 'history' }
  | { key: string; kind: 'call'; callId: string };
export interface DisplayLine { text: string; target?: TraceTarget }
export interface TraceView {
  open: boolean;
  historyExpanded: boolean;
  openCalls: ReadonlySet<string>;
  capacity: number;
  paged: boolean;
}

export function traceBlocks(calls: Activity[], config: Config, view: TraceView): DisplayLine[] {
  const models = calls.filter(call => call.kind === 'model').length;
  const issues = ['failed', 'denied', 'unknown', 'cancelled'].flatMap(status => {
    const count = calls.filter(call => call.status === status).length;
    return count ? [`${count} ${status}`] : [];
  });
  const lines: DisplayLine[] = [{
    text: `${view.open ? 'v' : '>'} Trace | ${models} model + ${calls.length - models} tool calls${view.paged ? ' (page)' : ''}${issues.length ? ` | ${issues.join(', ')}` : ''}`,
    target: { key: 'root', kind: 'root' },
  }];
  if (!view.open) return lines;
  const appendCall = (call: Activity) => {
    const open = view.openCalls.has(call.id);
    lines.push({ text: `  ${open ? 'v' : '>'} ${activityLine(call)}`, target: { key: `call:${call.id}`, kind: 'call', callId: call.id } });
    if (open) lines.push(...activityDetail(call, config).split('\n').slice(1).map(text => ({ text: `    ${text}` })));
  };
  let position = 0;
  for (const item of foldActivity(calls, view.capacity, false, view.openCalls)) {
    if (item.kind === 'group') {
      const count = item.models + item.tools;
      const members = calls.slice(position, position + count);
      lines.push({
        text: `  ${view.historyExpanded ? 'v' : '>'} Earlier success: ${item.models} model + ${item.tools} tool calls`,
        target: { key: `history:${members[0]!.id}`, kind: 'history' },
      });
      if (view.historyExpanded) for (const call of members) appendCall(call);
      position += count;
    } else {
      appendCall(item); position++;
    }
  }
  if (!calls.length) lines.push({ text: '  No recorded calls for this objective.' });
  return lines;
}
