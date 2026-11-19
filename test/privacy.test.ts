import { describe, expect, it } from 'vitest';
import { Redactor, serializeHostMessage } from '../src/privacy.js';

describe('Host-only OAuth presentation', () => {
  const authorizationUrl = 'https://auth.example.invalid/authorize?client_id=public-client&state=SYNTHETIC_STATE&code_challenge=S256_PUBLIC_VALUE';

  it('delivers only the exact requested OAuth URL while redacting tokens and ordinary fields', () => {
    const redactor = new Redactor([authorizationUrl, 'SYNTHETIC_STATE']);
    const value = { type: 'response', id: 'mcp-login', result: {
      authorizationUrl, accessToken: 'SYNTHETIC_ACCESS_TOKEN', note: 'State SYNTHETIC_STATE', redirectUrl: authorizationUrl,
    } };
    expect(JSON.parse(serializeHostMessage(redactor, value, authorizationUrl))).toEqual({
      type: 'response', id: 'mcp-login', result: {
        authorizationUrl, accessToken: '[REDACTED]', note: 'State [REDACTED]', redirectUrl: '[REDACTED]',
      },
    });
    expect(value.result.accessToken).toBe('SYNTHETIC_ACCESS_TOKEN');
    expect(value.result.authorizationUrl).toBe(authorizationUrl);
  });

  it('never restores an OAuth URL into ordinary events or model output', () => {
    const redactor = new Redactor([authorizationUrl]);
    for (const type of ['event', 'text']) {
      const value = { type, result: { authorizationUrl, accessToken: 'SYNTHETIC_ACCESS_TOKEN' } };
      expect(JSON.parse(serializeHostMessage(redactor, value, authorizationUrl))).toEqual({
        type, result: { authorizationUrl: '[REDACTED]', accessToken: '[REDACTED]' },
      });
    }
  });

  it('requires an exact direct-response URL match rather than trusting another supplied URL', () => {
    const value = { type: 'response', result: {
      authorizationUrl: 'https://unrequested.example.invalid/authorize', accessToken: 'SYNTHETIC_ACCESS_TOKEN',
    } };
    expect(JSON.parse(serializeHostMessage(new Redactor(), value, authorizationUrl))).toEqual({
      type: 'response', result: { authorizationUrl: '[REDACTED]', accessToken: '[REDACTED]' },
    });
  });

  it('redacts authorization URLs when no explicit host exception was requested', () => {
    const value = { type: 'response', result: { authorizationUrl, accessToken: 'SYNTHETIC_ACCESS_TOKEN' } };
    expect(JSON.parse(serializeHostMessage(new Redactor(), value))).toEqual({
      type: 'response', result: { authorizationUrl: '[REDACTED]', accessToken: '[REDACTED]' },
    });
  });
});
