import { render } from 'ink-testing-library';
import { expect, it } from 'vitest';
import { SessionController } from '../src/controller.js';
import { TerminalApp } from '../src/ui.js';
import { FakeModel } from '../src/model.js';
import { fixture } from './helpers.js';

async function settle() { await new Promise(resolve => setTimeout(resolve, 70)); }
it('shows error IDs and inspects session history without sending another model request', async () => {
  const f = fixture();
  let calls = 0;
  const app = await SessionController.open({ config: f.config, model: new FakeModel(() => {
    calls++;
    throw Object.assign(new Error('Synthetic model request failed.'), { status: 401, requestID: 'ui-request-one' });
  }) });
  const screen = render(<TerminalApp controller={app} />);
  const send = async (input: string) => { screen.stdin.write(input); await settle(); screen.stdin.write('\r'); await settle(); };
  try {
    await settle();
    await send('/errors');
    expect(screen.lastFrame()).toContain('No recorded errors');
    await send('/back');
    await send('Synthetic user request.');
    const error = app.store.errors(app.id).errors[0]!;
    expect(screen.lastFrame()).toContain(`/error ${error.id}`);
    await send('/errors');
    expect(screen.lastFrame()).toContain(error.id);
    expect(screen.lastFrame()).toContain('Synthetic model request failed.');
    await send(`/error ${error.id}`);
    expect(screen.lastFrame()).toContain('ui-request-one');
    expect(calls).toBe(1);
    expect(app.store.errors(app.id).errors).toHaveLength(1);
    await send('/back');
    await send('/error invalid');
    expect(screen.lastFrame()).toContain('Use an error ID from /errors');
    expect(app.store.errors(app.id).errors[0]?.source).toBe('command');
  } finally { screen.unmount(); await app.close(); f.cleanup(); }
});
