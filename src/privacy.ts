import { stripVTControlCharacters } from 'node:util';
import { record } from './contracts.js';

export function terminalText(text: string): string {
  return Array.from(stripVTControlCharacters(text)).filter(c =>
    c === '\n' || c === '\t' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)).join('');
}
export class Redactor {
  constructor(private readonly secrets: string[] = []) {}
  add(...values: (string | undefined)[]): void {
    for (const value of values) if (value && !this.secrets.includes(value)) this.secrets.push(value);
  }
  text(value: string): string {
    let result = terminalText(value);
    for (const secret of this.secrets) {
      if (secret) result = result.replaceAll(secret, '[REDACTED]');
    }
    return result.replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+\S+)/g, '[REDACTED]');
  }
  value(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(v => this.value(v));
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, /api.?key|authorization|password|secret|access.?token/i.test(k) ? '[REDACTED]' : this.value(v)]));
    return value;
  }
}

// An OAuth authorization URL is deliberately delivered to the requesting host,
// never to ordinary events or model output. Other response fields stay redacted.
export function serializeHostMessage(redactor: Redactor, value: unknown, authorizationUrl?: string): string {
  const safe = redactor.value(value);
  if (authorizationUrl && record(value) && value.type === 'response' && record(value.result) &&
      value.result.authorizationUrl === authorizationUrl && record(safe) && record(safe.result)) {
    safe.result.authorizationUrl = authorizationUrl;
  }
  return JSON.stringify(safe);
}
