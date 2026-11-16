import { expect, it, vi } from 'vitest';
import { WindowsInput, type ConsoleApi } from '../src/windows-input.js';
import { InputDecoder, type InputAction } from '../src/editor.js';

function key(char: string, virtualKey = char.charCodeAt(0), modifiers = 0): Buffer {
  const record = Buffer.alloc(20);
  record.writeUInt16LE(1); record.writeInt32LE(1, 4); record.writeUInt16LE(1, 8);
  record.writeUInt16LE(virtualKey, 10); record.writeUInt16LE(char.charCodeAt(0) || 0, 14); record.writeUInt32LE(modifiers, 16);
  return record;
}
function mouse(buttons: number): Buffer {
  const record = Buffer.alloc(20);
  record.writeUInt16LE(2); record.writeInt16LE(7, 4); record.writeInt16LE(11, 6); record.writeUInt32LE(buttons, 8);
  return record;
}
function consoleFixture() {
  let mode = 0x1f7;
  const modes: number[] = [];
  const queue: Buffer[] = [];
  const api: ConsoleApi = {
    getMode: () => mode,
    setMode(value) { mode = value; modes.push(value); },
    read: () => queue.shift() ?? Buffer.alloc(0),
    screen: () => ({ columns: 48, rows: 24, left: 2, top: 4 }),
  };
  return { api, queue, modes, mode: () => mode };
}
it('preserves atomic multiline input, Enter, navigation, focus keys and split Unicode without the Node TTY reader', async () => {
  const f = consoleFixture();
  const input = new WindowsInput(f.api); const decoder = new InputDecoder(); const actions: InputAction[] = [];
  input.setEncoding('utf8'); input.on('data', (data: string) => actions.push(...decoder.feed(data)));
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  try {
    input.setRawMode(true);
    f.queue.push(Buffer.concat(Array.from('one\rtwo', char => key(char))));
    f.queue.push(key('\r'));
    f.queue.push(Buffer.concat([key('\0', 0x25), key('\x14')]));
    f.queue.push(key('\ud83d')); f.queue.push(key('\ude80'));
    await vi.waitFor(() => expect(actions).toEqual([
      { type: 'insert', text: 'one\ntwo' }, { type: 'submit' }, { type: 'left' }, { type: 'traceFocus' },
      { type: 'insert', text: '\ud83d\ude80' },
    ]));
    expect(f.mode() & 0x10).toBe(0);
    expect(f.mode() & 7).toBe(0);
  } finally { input.destroy(); await closed; }
  expect(f.mode()).toBe(0x1f7);
});
it('reports viewport-relative mouse presses/releases only when enabled and restores the original console mode', async () => {
  const f = consoleFixture();
  const input = new WindowsInput(f.api); const decoder = new InputDecoder(); const actions: InputAction[] = [];
  input.setEncoding('utf8'); input.on('data', (data: string) => actions.push(...decoder.feed(data)));
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  try {
    input.setRawMode(true); input.setMouseTracking(true);
    expect(f.mode() & 0x10).toBe(0x10);
    f.queue.push(Buffer.concat([mouse(1), mouse(0)]));
    await vi.waitFor(() => expect(actions).toEqual([
      { type: 'mouse', x: 6, y: 8, button: 0, released: false },
      { type: 'mouse', x: 6, y: 8, button: 0, released: true },
    ]));
    const movement = mouse(1); movement.writeUInt32LE(1, 16);
    const releaseMovement = mouse(0); releaseMovement.writeUInt32LE(1, 16);
    f.queue.push(Buffer.concat([movement, releaseMovement, key('y')]));
    await vi.waitFor(() => expect(actions).toHaveLength(3));
    expect(actions[2]).toEqual({ type: 'insert', text: 'y' });
    input.setMouseTracking(false);
    expect(f.mode() & 0x10).toBe(0);
    f.queue.push(Buffer.concat([mouse(1), mouse(0), key('x')]));
    await vi.waitFor(() => expect(actions).toHaveLength(4));
    expect(actions[3]).toEqual({ type: 'insert', text: 'x' });
    input.setRawMode(false);
    expect(f.mode()).toBe(0x1f7);
  } finally { input.destroy(); await closed; }
});
it('surfaces console read failures and stops polling after restoring the input mode', async () => {
  const f = consoleFixture();
  const read = vi.fn((): Buffer => { throw new Error('Synthetic console disconnect.'); });
  const input = new WindowsInput({ ...f.api, read });
  const error = new Promise<Error>(resolve => input.once('error', resolve));
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  input.resume(); input.setRawMode(true);
  expect((await error).message).toBe('Synthetic console disconnect.');
  await closed;
  expect(f.mode()).toBe(0x1f7);
  expect(read).toHaveBeenCalledOnce();
});
it('still closes the stream and reports failure when the original console mode cannot be restored', async () => {
  const f = consoleFixture();
  const input = new WindowsInput({
    ...f.api,
    setMode(mode) {
      if (mode === 0x1f7) throw new Error('Synthetic mode restoration failure.');
      f.api.setMode(mode);
    },
  });
  const error = new Promise<Error>(resolve => input.once('error', resolve));
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  input.setRawMode(true); input.destroy();
  expect((await error).message).toContain('Console mode restoration failed');
  await closed;
});
