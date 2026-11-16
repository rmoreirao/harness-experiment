import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { z } from 'zod';
import { HarnessError, errorText } from './contracts.js';
import { Semaphore } from './resources.js';
import { digest } from './workspace.js';
import { runtimeEnvironment } from './runtime.js';
import type { Store } from './store.js';
import type { ProtectedNetwork } from './network.js';
import type { ActionBroker, ToolContext } from './policy.js';

const requestSchema = z.object({
  url: z.string().url(), method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/).default(digest('')),
}).strict();
type BrowserRequest = z.infer<typeof requestSchema>;
interface Observation { id: string; url: string; hash: string; snapshot: string }
export class ControlledBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private observation?: Observation;
  private gate = new Semaphore(1);
  private active?: { requests: BrowserRequest[]; signal: AbortSignal; errors: string[] };
  constructor(readonly store: Store, readonly sessionId: string, readonly network: ProtectedNetwork) {}
  private async open(): Promise<Page> {
    if (this.page) return this.page;
    const config = this.network.config;
    if (!config.browser) throw new HarnessError('BROWSER_DISABLED', 'No reviewed browser executable has been configured.');
    const directory = path.join(config.dataDir, 'browser', this.sessionId);
    mkdirSync(directory, { recursive: true });
    this.browser = await chromium.launch({
      executablePath: config.browser.executablePath, headless: true, chromiumSandbox: true,
      env: runtimeEnvironment(directory), timeout: config.limits.toolTimeoutMs,
    });
    if (this.browser.version() !== config.browser.version) {
      await this.close();
      throw new HarnessError('BROWSER_COMPATIBILITY', 'Browser version differs from the explicitly pinned version; no fallback or download was attempted.');
    }
    this.context = await this.browser.newContext({
      javaScriptEnabled: config.browser.javaScript, serviceWorkers: 'block', acceptDownloads: false,
    });
    await this.context.routeWebSocket('**/*', socket => socket.close());
    await this.context.route('**/*', async route => {
      const request = route.request(); const active = this.active;
      try {
        if (!active) throw new HarnessError('BROWSER_NETWORK', 'Browser background network activity is not authorized.');
        const body = request.postDataBuffer() ?? Buffer.alloc(0);
        const index = active.requests.findIndex(item =>
          item.url === request.url() && item.method === request.method() && item.bodyHash === digest(body));
        if (index < 0) throw new HarnessError('BROWSER_NETWORK', 'Browser request did not match the approved exact URL, method and body hash.');
        active.requests.splice(index, 1);
        const headers: Record<string, string> = {};
        const incoming = request.headers();
        for (const name of ['accept', 'content-type', 'cookie']) if (incoming[name]) headers[name] = incoming[name]!;
        const result = await this.network.retrieve(request.url(), active.signal, {
          method: request.method(), body: body.length ? body : undefined, headers, redirects: false,
        });
        const safeHeaders = { ...result.headers };
        for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) delete safeHeaders[name];
        await route.fulfill({ status: result.status, headers: safeHeaders, body: result.body });
      } catch (error) {
        active?.errors.push(errorText(error));
        await route.abort('blockedbyclient');
      }
    });
    this.context.on('page', popup => { if (this.page && popup !== this.page) void popup.close(); });
    this.page = await this.context.newPage();
    this.page.on('dialog', dialog => { void dialog.dismiss(); });
    this.page.on('download', download => { void download.cancel(); });
    this.page.setDefaultTimeout(config.limits.toolTimeoutMs);
    return this.page;
  }
  private async snapshot(): Promise<Observation> {
    const page = await this.open();
    const snapshot = await page.locator('body').ariaSnapshot();
    if (Buffer.byteLength(snapshot) > this.network.config.limits.maxOutputBytes) throw new HarnessError('BROWSER_OUTPUT', 'Snapshot is too large; observation was not recorded.');
    const observation = { id: randomUUID(), url: page.url(), hash: digest(page.url() + snapshot), snapshot };
    this.observation = observation; return observation;
  }
  private async current(id: string): Promise<Page> {
    const expected = this.observation;
    if (!expected || expected.id !== id) throw new HarnessError('STALE_OBSERVATION', 'Observe this session page before acting.');
    const page = await this.open();
    const snapshot = await page.locator('body').ariaSnapshot();
    if (digest(page.url() + snapshot) !== expected.hash) {
      this.observation = undefined;
      throw new HarnessError('STALE_OBSERVATION', 'Page changed after observation. Observe and approve a new action.');
    }
    return page;
  }
  private async operation<T>(context: ToolContext, requests: BrowserRequest[], run: () => Promise<T>): Promise<T> {
    const release = await this.gate.acquire(context.signal);
    this.active = { requests: structuredClone(requests), signal: context.signal, errors: [] };
    const abort = () => { void this.close(); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await run();
      if (this.active.errors.length) throw new HarnessError('BROWSER_NETWORK', this.active.errors.join('; '));
      context.signal.throwIfAborted(); return result;
    } finally {
      context.signal.removeEventListener('abort', abort); this.active = undefined; release();
    }
  }
  register(broker: ActionBroker): void {
    if (!this.network.config.browser) return;
    broker.register('browser_navigate', 'Navigate in a clean browser. Authorize the exact target and optional exact resource/redirect requests; no ambient network.', z.object({
      url: z.string().url(), requests: z.array(requestSchema).max(50).default([]),
    }).strict(), 'network', (args, context) => this.operation(context, [
      { url: new URL(args.url).href, method: 'GET', bodyHash: digest('') }, ...args.requests,
    ], async () => {
      await this.network.destination(args.url);
      const page = await this.open(); await page.goto(args.url, { waitUntil: 'domcontentloaded' }); return this.snapshot();
    }));
    broker.register('browser_snapshot', 'Observe accessibility state in this session only. Returns a fresh action-precondition identity.', z.object({}).strict(), 'read',
      (_args, context) => this.operation(context, [], () => this.snapshot()));
    broker.register('browser_action', 'Act only on a fresh observation. Typing/clicks can disclose data and require separate exact approval. Network requests must match disclosed URL/method/body hashes. No uploads, scripts or arbitrary selectors.', z.object({
      observation: z.string().uuid(),
      selector: z.string().regex(/^(?:#[a-zA-Z0-9_-]+|\[data-testid="[a-zA-Z0-9_-]+"\]|(?:input|button|a|select)\[name="[a-zA-Z0-9_-]+"\])$/),
      action: z.enum(['click', 'type', 'select']), text: z.string().max(8000).optional(),
      requests: z.array(requestSchema).max(50).default([]),
    }).strict(), 'submit', (args, context) => this.operation(context, args.requests, async () => {
      const page = await this.current(args.observation); const element = page.locator(args.selector);
      if (await element.count() !== 1) throw new HarnessError('BROWSER_TARGET', 'Selector must match exactly one observed element.');
      if (args.action === 'click') await element.click();
      else {
        if (args.text === undefined) throw new HarnessError('BROWSER_ACTION', 'Typing/select requires explicit text.');
        if (await element.getAttribute('type') === 'file') throw new HarnessError('UPLOAD_DISABLED', 'File uploads are not implemented.');
        if (args.action === 'type') await element.fill(args.text);
        else await element.selectOption(args.text);
      }
      return this.snapshot();
    }));
    broker.register('browser_wait', 'Wait for a bounded observed page condition; no fixed sleeps or network authority is added.', z.object({
      observation: z.string().uuid(), text: z.string().min(1).max(500), timeoutMs: z.number().int().min(50).max(10000).default(2000),
    }).strict(), 'read', (args, context) => this.operation(context, [], async () => {
      const page = await this.current(args.observation); await page.getByText(args.text, { exact: true }).waitFor({ timeout: args.timeoutMs }); return this.snapshot();
    }));
    broker.register('browser_screenshot', 'Capture a screenshot artifact with page/observation provenance.', z.object({
      observation: z.string().uuid(),
    }).strict(), 'read', (args, context) => this.operation(context, [], async () => {
      const page = await this.current(args.observation);
      const bytes = await page.screenshot({ fullPage: false, timeout: this.network.config.limits.toolTimeoutMs });
      return this.store.result(this.sessionId, context.action.objectiveId, context.action.id, bytes,
        { kind: 'browser_screenshot', url: page.url(), observation: args.observation }, 'image/png');
    }));
    broker.register('browser_download', 'Retrieve a separately approved download into quarantined result storage. It is not executed or published to the workspace.', z.object({
      url: z.string().url(),
    }).strict(), 'network', async (args, context) => {
      const response = await this.network.retrieve(args.url, context.signal);
      const executable = response.body.subarray(0, 2).toString() === 'MZ' || response.body.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]));
      return this.store.result(this.sessionId, context.action.objectiveId, context.action.id, response.body,
        { kind: 'quarantined_download', url: args.url, finalUrl: response.finalUrl, executable, declaredType: response.headers['content-type'] ?? null,
          publication: 'disabled; inspect through result_read; never automatically executable' }, 'application/octet-stream');
    });
    broker.register('browser_verify', 'Verify user-supplied acceptance text against a fresh observed page; preserves the observation as evidence.', z.object({
      observation: z.string().uuid(),
    }).strict(), 'read', (args, context) => this.operation(context, [], async () => {
      await this.current(args.observation);
      const objective = this.store.get('objective', context.action.objectiveId, this.sessionId);
      const observation = this.observation!;
      if (!objective.criteria.length || objective.criteria.some(criterion => !observation.snapshot.includes(criterion))) {
        throw new HarnessError('BROWSER_VERIFICATION', 'All original user acceptance-text criteria must appear in the observed page.');
      }
      return { kind: 'browser_verification', observation, criteria: objective.criteria, verified: true };
    }));
  }
  async close(): Promise<void> {
    const browser = this.browser; this.browser = undefined; this.context = undefined; this.page = undefined; this.observation = undefined;
    await browser?.close();
  }
}
