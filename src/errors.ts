import { HarnessError, errorText, record } from './contracts.js';
import { Redactor } from './privacy.js';

type ErrorContext = {
  source?: string; operation?: string; tool?: string; invocationId?: string;
  callId?: string; model?: string; status?: string; streamStarted?: boolean;
};
export type ErrorDiagnostic = ErrorContext & {
  source: string; message: string; name?: string; code?: string; httpStatus?: number;
  providerRequestId?: string; stack?: string; cause?: ErrorDiagnostic;
};
export type ErrorRecord = ErrorDiagnostic & {
  id: string; at: number; sessionId: string; runId: string | null; objectiveId: string | null;
};
export type ErrorRow = {
  sequence: number; at: number; sessionId: string; runId: string | null;
  objectiveId: string | null; data: string;
};
export type ErrorPage = { errors: ErrorRecord[]; next: string | null };
export interface ErrorStore {
  errors(sessionId: string, before?: string): ErrorPage;
  error(sessionId: string, id: string): ErrorRecord;
}

export function errorId(sequence: number): string { return `error-${sequence}`; }
export function errorSequence(id: string): number {
  const sequence = /^error-([1-9]\d*)$/.exec(id)?.[1];
  if (!sequence || !Number.isSafeInteger(Number(sequence))) {
    throw new HarnessError('ERROR_ID', 'Use an error ID from /errors, for example error-12.');
  }
  return Number(sequence);
}
export function errorDiagnostic(error: unknown, redactor: Redactor, context: ErrorContext = {}, depth = 0): ErrorDiagnostic {
  const value = record(error) ? error : {};
  const text = (input: unknown, limit: number): string | undefined => {
    if (typeof input !== 'string') return undefined;
    const clean = redactor.text(input);
    return clean.length > limit ? `${clean.slice(0, limit)} [truncated]` : clean;
  };
  const status = value.httpStatus ?? value.status ?? value.statusCode;
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const diagnostic: ErrorDiagnostic = {
    source: text(context.source ?? value.source, 100) ?? (httpStatus ? 'model' : 'harness'),
    message: text(typeof value.message === 'string' ? value.message : errorText(error), 2048)!,
  };
  const supplied: Record<string, unknown> = context;
  for (const field of ['name', 'code', 'stack', 'providerRequestId', 'operation', 'tool', 'invocationId', 'callId', 'model', 'status'] as const) {
    const input = field === 'providerRequestId'
      ? value.providerRequestId ?? value.requestID ?? value.request_id ?? value.requestId
      : supplied[field] ?? value[field];
    const clean = text(input, field === 'stack' ? 8192 : 256);
    if (clean !== undefined) diagnostic[field] = clean;
  }
  if (httpStatus !== undefined) diagnostic.httpStatus = httpStatus;
  const streamStarted = context.streamStarted ?? value.streamStarted;
  if (typeof streamStarted === 'boolean') diagnostic.streamStarted = streamStarted;
  if (value.cause !== undefined && depth < 3) diagnostic.cause = errorDiagnostic(value.cause, redactor, {}, depth + 1);
  return diagnostic;
}
export function storedError(row: ErrorRow, redactor: Redactor): ErrorRecord {
  const value: unknown = JSON.parse(row.data);
  const data = record(value) ? value : {};
  const action = record(data.action) ? data.action : undefined;
  const diagnostic = record(data.diagnostic) ? data.diagnostic : action ? {
    source: 'tool', tool: action.tool, invocationId: action.id, callId: action.callId,
    status: action.status, message: action.error, code: action.errorCode,
  } : data;
  return {
    ...errorDiagnostic(diagnostic, redactor), id: errorId(row.sequence), at: row.at,
    sessionId: row.sessionId, runId: row.runId, objectiveId: row.objectiveId,
  };
}
export function errorPage(rows: ErrorRow[], redactor: Redactor): ErrorPage {
  const errors = rows.slice(0, 20).map(row => storedError(row, redactor));
  return { errors, next: rows.length > 20 ? errors.at(-1)!.id : null };
}
export function errorInspector(input: string, store: ErrorStore, sessionId: string): string | null {
  const [command, id, ...extra] = input.trim().split(/\s+/);
  if (command !== '/errors' && command !== '/error') return null;
  if (extra.length || (command === '/error' && !id)) throw new HarnessError('ERROR_COMMAND', 'Use /errors [BEFORE_ID] or /error ERROR_ID.');
  if (command === '/error') return JSON.stringify(store.error(sessionId, id!), null, 2);
  const page = store.errors(sessionId, id);
  if (!page.errors.length) return 'No recorded errors in this session.';
  return [
    'Latest session errors (newest at bottom):',
    ...[...page.errors].reverse().map(error => {
      const message = error.message.replace(/\s+/g, ' ');
      return `${error.id} | ${new Date(error.at).toISOString()} | ${error.source}${error.tool ? `:${error.tool}` : ''}${error.code ? ` | ${error.code}` : ''}\n${message.slice(0, 240)}${message.length > 240 ? ' [truncated]' : ''}`;
    }),
    'Use /error ERROR_ID for details.',
    ...(page.next ? [`Older errors: /errors ${page.next}`] : []),
  ].join('\n\n');
}
export function errorNotice(data: Record<string, unknown>): string {
  return `${String(data.message ?? 'Operation failed.')}${typeof data.errorId === 'string' ? `\nDetails: /error ${data.errorId}` : ''}`;
}
