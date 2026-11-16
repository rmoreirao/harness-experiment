import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { HarnessError } from './contracts.js';
import { allowsHttpsOrigin, type Config } from './config.js';

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6) return /^[23][a-f0-9]{0,3}:/i.test(address) && !/^2001:(?:0*:|db8:|10:|20:)/i.test(address) && !/^2002:/i.test(address);
  if (family !== 4) return false;
  if (address === '168.63.129.16') return false;
  const [a = 0, b = 0] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) ||
    a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) ||
    a === 203 && b === 0);
}
export interface Retrieved {
  url: string; finalUrl: string; status: number; headers: Record<string, string>;
  body: Buffer; redirects: string[];
}
export class ProtectedNetwork {
  constructor(readonly config: Config) {}
  async destination(input: string): Promise<{ url: URL; address: string; family: number }> {
    const url = new URL(input);
    if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) {
      throw new HarnessError('DESTINATION', 'Credentials, fragments, and non-HTTP destinations are not admitted.');
    }
    const fixture = this.config.network.localFixtureOrigins.includes(url.origin);
    if (!fixture && !allowsHttpsOrigin(this.config.network.origins, url.origin)) {
      throw new HarnessError('DESTINATION', `Destination origin ${url.origin} is not configured in this session's network allowlist. Review network.origins and start a new session; tool approval cannot broaden network policy.`);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address) && !fixture)) {
      throw new HarnessError('PRIVATE_NETWORK', 'Private, metadata, reserved, and mixed-DNS destinations are blocked.');
    }
    const selected = addresses[0]!;
    if (fixture && !['127.0.0.1', '::1'].includes(selected.address)) throw new HarnessError('DESTINATION', 'Fixture does not resolve to its exact loopback address.');
    return { url, ...selected };
  }
  async retrieve(input: string, signal: AbortSignal,
    options: { method?: string; headers?: Record<string, string>; body?: Buffer; redirects?: boolean } = {}): Promise<Retrieved> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.network.timeoutMs)]);
    let target = input;
    const redirects: string[] = [];
    for (let count = 0; ; count++) {
      deadline.throwIfAborted();
      const { url, address, family } = await this.destination(target);
      deadline.throwIfAborted();
      const result = await new Promise<Retrieved>((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
          method: options.method ?? 'GET', agent: false, signal: deadline, family,
          lookup: (_host, _options, callback) => callback(null, address, family),
          headers: { 'User-Agent': 'harness/0.1', ...options.headers },
        }, response => {
          const chunks: Buffer[] = []; let bytes = 0;
          response.once('error', reject);
          const length = Number(response.headers['content-length'] ?? 0);
          if (length > this.config.network.maxBytes) {
            response.destroy(new HarnessError('BODY_LIMIT', `Response body declares ${length} bytes, exceeding network.maxBytes=${this.config.network.maxBytes}. Increase the bounded limit in configuration and start a new session.`)); return;
          }
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.config.network.maxBytes) response.destroy(new HarnessError('BODY_LIMIT', `Response body exceeded network.maxBytes=${this.config.network.maxBytes} after ${bytes} bytes. Increase the bounded limit in configuration and start a new session.`));
            else chunks.push(chunk);
          });
          response.once('end', () => resolve({
            url: input, finalUrl: url.href, status: response.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
              .map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : value])),
            body: Buffer.concat(chunks), redirects: [...redirects],
          }));
        });
        req.once('error', reject);
        req.end(options.body);
      });
      if (result.status >= 300 && result.status < 400 && result.headers.location) {
        if (options.redirects === false) return result;
        if (count >= this.config.network.redirects) throw new HarnessError('REDIRECT_LIMIT', 'Redirect cap reached.');
        const next = new URL(result.headers.location, target);
        if (next.origin !== new URL(target).origin) {
          throw new HarnessError('REDIRECT', `Cross-origin redirect from ${target} to ${next.href} requires a separately approved retrieval. Use web_fetch with the destination URL; this request did not follow it.`);
        }
        if ((options.method ?? 'GET') !== 'GET') throw new HarnessError('REDIRECT', 'Submissions are not replayed through redirects.');
        target = next.href; redirects.push(target); continue;
      }
      if (result.status < 200 || result.status >= 300) throw new HarnessError('HTTP', `Retrieval failed with HTTP ${result.status}.`);
      return result;
    }
  }
}
