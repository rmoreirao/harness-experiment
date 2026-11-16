import { expect, it } from 'vitest';
import { InputDecoder, edit, emptyEditor } from '../src/editor.js';

it('keeps multiline bracketed paste atomic across chunks and never submits it', () => {
  const decoder = new InputDecoder();
  expect(decoder.feed('\x1b[20')).toEqual([]);
  expect(decoder.feed('0~first\r\nsecond\rthird')).toEqual([]);
  expect(decoder.feed('\x1b[201~')).toEqual([{ type: 'insert', text: 'first\nsecond\nthird' }]);
  expect(decoder.feed('\r')).toEqual([{ type: 'submit' }]);
});
it('treats a native ConPTY multiline input batch as paste rather than Enter commands', () => {
  const decoder = new InputDecoder();
  expect(decoder.feed('first line\r\nsecond line\r')).toEqual([{ type: 'insert', text: 'first line\nsecond line\n' }]);
  expect(decoder.feed('\r')).toEqual([{ type: 'submit' }]);
});
it('decodes fragmented SGR clicks and releases without inserting mouse reports into the draft', () => {
  const decoder = new InputDecoder();
  expect(decoder.feed('\x1b[')).toEqual([]);
  expect(decoder.feed('<0;5;')).toEqual([]);
  expect(decoder.feed('12M\x1b[<0;5;12m')).toEqual([
    { type: 'mouse', button: 0, x: 5, y: 12, released: false },
    { type: 'mouse', button: 0, x: 5, y: 12, released: true },
  ]);
  expect(decoder.feed('\x1b[<64;1;2M\x14')).toEqual([
    { type: 'mouse', button: 64, x: 1, y: 2, released: false }, { type: 'traceFocus' },
  ]);
  expect(decoder.feed('\x1b[<0;0;2M\x1b[<999;5;2M\x1b[<0;5;2Xok')).toEqual([
    { type: 'insert', text: 'o' }, { type: 'insert', text: 'k' },
  ]);
});
it('does not interpret mouse-looking text or control keys inside bracketed paste as actions', () => {
  const decoder = new InputDecoder();
  const actions = decoder.feed('\x1b[200~hello\x1b[<0;5;12M\x14world\x1b[201~');
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe('insert');
  expect(decoder.feed('\r')).toEqual([{ type: 'submit' }]);
});
it('supports cursor edits, multiline navigation, deletion, and input history without losing drafts', () => {
  let state = emptyEditor(['old request']);
  state = edit(state, { type: 'insert', text: 'one\ntwo' });
  state = edit(state, { type: 'up' });
  expect(state.cursor).toBe(3);
  state = edit(state, { type: 'backspace' });
  expect(state.text).toBe('on\ntwo');
  state = edit(state, { type: 'home' });
  state = edit(state, { type: 'up' });
  expect(state.text).toBe('old request');
  state = edit(state, { type: 'down' });
  expect(state.text).toBe('on\ntwo');
});
