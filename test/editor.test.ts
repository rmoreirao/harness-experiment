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
