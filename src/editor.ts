import { terminalText } from './privacy.js';

export type InputAction =
  | { type: 'insert'; text: string }
  | { type: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'backspace' | 'delete' | 'submit' | 'cancel' | 'exit' | 'pageUp' | 'pageDown' | 'redraw' };

export class InputDecoder {
  private buffer = '';
  private pasting = false;
  feed(data: string): InputAction[] {
    // ConPTY removes bracket markers in Node's Win32 input mode, but delivers the pasted text together.
    if (!this.pasting && !this.buffer && data.length > 1 && /[\r\n]/.test(data) && !data.includes('\x1b')) {
      return [{ type: 'insert', text: terminalText(data.replace(/\r\n?/g, '\n')) }];
    }
    this.buffer += data;
    const actions: InputAction[] = [];
    const sequences: Record<string, InputAction['type']> = {
      '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
      '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end',
      '\x1b[3~': 'delete', '\x1b[5~': 'pageUp', '\x1b[6~': 'pageDown',
    };
    while (this.buffer) {
      if (this.pasting) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) break;
        const text = this.buffer.slice(0, end).replace(/\r\n?/g, '\n');
        actions.push({ type: 'insert', text: terminalText(text) });
        this.buffer = this.buffer.slice(end + 6);
        this.pasting = false;
        continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) {
        this.pasting = true; this.buffer = this.buffer.slice(6); continue;
      }
      if (this.buffer.startsWith('\x1b')) {
        const sequence = Object.keys(sequences).find(s => this.buffer.startsWith(s));
        if (sequence) {
          actions.push({ type: sequences[sequence]! } as InputAction);
          this.buffer = this.buffer.slice(sequence.length); continue;
        }
        if (this.buffer === '\x1b' || '\x1b[200~'.startsWith(this.buffer) ||
            Object.keys(sequences).some(s => s.startsWith(this.buffer))) break;
        if (this.buffer.startsWith('\x1b\r')) {
          actions.push({ type: 'insert', text: '\n' }); this.buffer = this.buffer.slice(2); continue;
        }
        this.buffer = this.buffer.slice(1); continue;
      }
      const codepoint = Array.from(this.buffer)[0]!;
      this.buffer = this.buffer.slice(codepoint.length);
      if (codepoint === '\r') actions.push({ type: 'submit' });
      else if (codepoint === '\n') actions.push({ type: 'insert', text: '\n' });
      else if (codepoint === '\x03') actions.push({ type: 'cancel' });
      else if (codepoint === '\x04') actions.push({ type: 'exit' });
      else if (codepoint === '\x0c') actions.push({ type: 'redraw' });
      else if (codepoint === '\x7f' || codepoint === '\x08') actions.push({ type: 'backspace' });
      else if (codepoint === '\x01') actions.push({ type: 'home' });
      else if (codepoint === '\x05') actions.push({ type: 'end' });
      else if (codepoint.charCodeAt(0) >= 32 || codepoint === '\t') actions.push({ type: 'insert', text: codepoint });
    }
    return actions;
  }
}
export interface EditorState { text: string; cursor: number; history: string[]; historyIndex: number; draft: string }
export function emptyEditor(history: string[] = []): EditorState {
  return { text: '', cursor: 0, history, historyIndex: history.length, draft: '' };
}
export function edit(state: EditorState, action: InputAction): EditorState {
  const chars = Array.from(state.text);
  let cursor = state.cursor;
  switch (action.type) {
    case 'insert': chars.splice(cursor, 0, ...Array.from(action.text)); cursor += Array.from(action.text).length; break;
    case 'left': cursor = Math.max(0, cursor - 1); break;
    case 'right': cursor = Math.min(chars.length, cursor + 1); break;
    case 'home': cursor = chars.lastIndexOf('\n', cursor - 1) + 1; break;
    case 'end': { const end = chars.indexOf('\n', cursor); cursor = end < 0 ? chars.length : end; break; }
    case 'backspace': if (cursor > 0) chars.splice(--cursor, 1); break;
    case 'delete': chars.splice(cursor, 1); break;
    case 'up':
    case 'down': {
      const before = chars.slice(0, cursor).join('');
      const after = chars.slice(cursor).join('');
      const up = action.type === 'up';
      if ((up && before.includes('\n')) || (!up && after.includes('\n'))) {
        const lines = state.text.split('\n');
        const row = before.split('\n').length - 1;
        const column = Array.from(before.split('\n').at(-1) ?? '').length;
        const target = row + (up ? -1 : 1);
        cursor = lines.slice(0, target).reduce((n, l) => n + Array.from(l).length + 1, 0) +
          Math.min(column, Array.from(lines[target] ?? '').length);
      } else {
        const index = Math.max(0, Math.min(state.history.length, state.historyIndex + (up ? -1 : 1)));
        const draft = state.historyIndex === state.history.length ? state.text : state.draft;
        const text = index === state.history.length ? draft : state.history[index] ?? '';
        return { ...state, text, cursor: Array.from(text).length, historyIndex: index, draft };
      }
      break;
    }
    default: return state;
  }
  return { ...state, text: chars.join(''), cursor };
}
