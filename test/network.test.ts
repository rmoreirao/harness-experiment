import { describe, it, expect } from 'vitest';
import { allowsHttpsOrigin, parseConfig } from '../src/config.js';
import { ProtectedNetwork } from '../src/network.js';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';

describe('Wildcard public-network policy', () => {
  it('admits arbitrary public HTTPS origins without enumerating each site', async () => {
    const f = fixture({ network: { origins: ['*'] } });
    const network = new ProtectedNetwork(f.config);
    try {
      for (const origin of ['https://www.globo.com', 'https://g1.globo.com', 'https://other.example:8443']) {
        expect(allowsHttpsOrigin(f.config.network.origins, origin)).toBe(true);
      }
      expect(await network.destination('https://8.8.8.8/document')).toMatchObject({ address: '8.8.8.8', family: 4 });
      expect(await network.destination('https://[2606:4700:4700::1111]/document')).toMatchObject({ family: 6 });
    } finally { f.cleanup(); }
  });

  it('does not admit HTTP, credentials, private/metadata addresses or private DNS through the wildcard', async () => {
    const f = fixture({ network: { origins: ['*'] } });
    const network = new ProtectedNetwork(f.config);
    try {
      for (const url of [
        'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.169.254', 'https://168.63.129.16',
        'https://100.100.100.200', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://localhost',
      ]) await expect(network.destination(url), url).rejects.toThrow('Private');
      for (const url of ['http://8.8.8.8', 'file:///C:/Windows/win.ini', 'https://user:password@8.8.8.8', 'https://8.8.8.8/#fragment']) {
        await expect(network.destination(url), url).rejects.toThrow();
      }
      expect(allowsHttpsOrigin(['*'], '*')).toBe(false);
      expect(allowsHttpsOrigin(['*'], 'https://example.com/path')).toBe(false);
    } finally { f.cleanup(); }
  });

  it('preserves deny-by-default/exact-origin modes and requires literal fixture scopes', async () => {
    const f = fixture();
    try {
      await expect(new ProtectedNetwork(f.config).destination('https://8.8.8.8')).rejects.toThrow('not configured');
      const exact = parseConfig({ ...f.config, network: { origins: ['https://8.8.8.8'] } });
      expect(await new ProtectedNetwork(exact).destination('https://8.8.8.8')).toMatchObject({ address: '8.8.8.8' });
      await expect(new ProtectedNetwork(exact).destination('https://1.1.1.1')).rejects.toThrow('not configured');
      expect(() => parseConfig({ ...f.config, network: { localFixtureOrigins: ['*'] } })).toThrow();
      expect(() => parseConfig({ ...f.config, network: { origins: ['*', 'http://example.com'] } })).toThrow('HTTPS');
    } finally { f.cleanup(); }
  });

  it('permits explicitly configured HTTPS search/MCP connectors without removing their trust/URL restrictions', () => {
    const f = fixture({ network: { origins: ['*'] } });
    try {
      expect(parseConfig({ ...f.config, search: { provider: 'brave' },
        mcp: [{ name: 'selected', url: 'https://service.example/mcp', tools: ['lookup'], trusted: true }],
      }).search?.provider).toBe('brave');
      for (const url of ['http://service.example/mcp', 'https://user:password@service.example/mcp', 'https://service.example/mcp?token=private']) {
        expect(() => parseConfig({ ...f.config, mcp: [{ name: 'selected', url, tools: ['lookup'], trusted: true }] }), url).toThrow();
      }
      expect(() => parseConfig({ ...f.config, mcp: [{ name: 'selected', url: 'https://service.example/mcp', tools: ['lookup'], trusted: false }] })).toThrow();
    } finally { f.cleanup(); }
  });

  it('persists wildcard sessions without broadening previously saved session configurations', () => {
    const f = fixture();
    let store = new Store(f.dataDir);
    try {
      const old = store.createSession(f.config);
      const current = store.createSession(parseConfig({ ...f.config, network: { origins: ['*'] } }));
      store.close(); store = new Store(f.dataDir);
      expect(store.session(old.id).config.network.origins).toEqual([]);
      expect(store.session(current.id).config.network.origins).toEqual(['*']);
      expect(allowsHttpsOrigin(store.session(old.id).config.network.origins, 'https://www.globo.com')).toBe(false);
    } finally { store.close(); f.cleanup(); }
  });
});
