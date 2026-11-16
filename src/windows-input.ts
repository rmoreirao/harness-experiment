import { Socket } from 'node:net';
import * as koffi from 'koffi';
import { HarnessError, errorText } from './contracts.js';

export interface ConsoleApi {
  getMode(): number;
  setMode(mode: number): void;
  read(): Buffer;
  screen(): { columns: number; rows: number; left: number; top: number };
}
const specialKeys: Readonly<Record<number, string>> = {
  0x21: '\x1b[5~', 0x22: '\x1b[6~', 0x23: '\x1b[F', 0x24: '\x1b[H',
  0x25: '\x1b[D', 0x26: '\x1b[A', 0x27: '\x1b[C', 0x28: '\x1b[B', 0x2e: '\x1b[3~',
};

function nativeConsole(): ConsoleApi {
  if (process.platform !== 'win32') throw new HarnessError('TERMINAL_INPUT', 'Native console input requires Windows.');
  const library = koffi.load('kernel32.dll');
  const getHandle: (id: number) => unknown = library.func('void * __stdcall GetStdHandle(int32_t id)');
  const getMode: (handle: unknown, mode: Buffer) => boolean = library.func('bool __stdcall GetConsoleMode(void *handle, void *mode)');
  const setMode: (handle: unknown, mode: number) => boolean = library.func('bool __stdcall SetConsoleMode(void *handle, uint32_t mode)');
  const countEvents: (handle: unknown, count: Buffer) => boolean =
    library.func('bool __stdcall GetNumberOfConsoleInputEvents(void *handle, void *count)');
  const readEvents: (handle: unknown, records: Buffer, count: number, read: Buffer) => boolean =
    library.func('bool __stdcall ReadConsoleInputW(void *handle, void *records, uint32_t count, void *read)');
  const screenInfo: (handle: unknown, info: Buffer) => boolean =
    library.func('bool __stdcall GetConsoleScreenBufferInfo(void *handle, void *info)');
  const lastError: () => number = library.func('uint32_t __stdcall GetLastError()');
  const input = getHandle(-10); const output = getHandle(-11);
  const count = Buffer.alloc(4); const records = Buffer.alloc(20 * 128); const screen = Buffer.alloc(22);
  const check = (ok: boolean, operation: string) => {
    if (!ok) throw new HarnessError('TERMINAL_INPUT', `${operation} failed (Windows error ${lastError()}).`);
  };
  return {
    getMode() { check(getMode(input, count), 'GetConsoleMode'); return count.readUInt32LE(0); },
    setMode(mode) { check(setMode(input, mode), 'SetConsoleMode'); },
    read() {
      check(countEvents(input, count), 'GetNumberOfConsoleInputEvents');
      const available = Math.min(128, count.readUInt32LE(0));
      if (!available) return records.subarray(0, 0);
      check(readEvents(input, records, available, count), 'ReadConsoleInputW');
      return records.subarray(0, count.readUInt32LE(0) * 20);
    },
    screen() {
      check(screenInfo(output, screen), 'GetConsoleScreenBufferInfo');
      const left = screen.readInt16LE(10); const top = screen.readInt16LE(12);
      return { left, top, columns: screen.readInt16LE(14) - left + 1, rows: screen.readInt16LE(16) - top + 1 };
    },
  };
}

// Node's Windows TTY reader drops MOUSE_EVENT records; read the console queue once,
// translating both keyboard and mouse input through the existing input decoder.
export class WindowsInput extends Socket {
  readonly isTTY = true;
  isRaw = false;
  private readonly originalMode: number;
  private timer?: ReturnType<typeof setInterval>;
  private referenced = true;
  private reading = false;
  private mouse = false;
  private buttons = 0;
  private surrogate = '';
  constructor(private readonly api: ConsoleApi = nativeConsole()) {
    super({ readable: true, writable: false });
    this.originalMode = api.getMode();
  }
  setRawMode(enabled: boolean): this {
    // Raw native events, without line editing, echo, quick-edit or VT input.
    this.api.setMode(enabled
      ? (this.originalMode & ~0x257) | 0x88 | (this.mouse ? 0x10 : 0)
      : this.originalMode);
    this.isRaw = enabled;
    if (enabled && !this.timer) {
      this.reading = true;
      this.timer = setInterval(() => this.poll(), 8);
      if (!this.referenced) this.timer.unref();
    } else if (!enabled) this.stop();
    return this;
  }
  setMouseTracking(enabled: boolean): void {
    this.mouse = enabled; this.buttons = 0;
    if (this.isRaw) this.setRawMode(true);
  }
  override ref(): this { this.referenced = true; this.timer?.ref(); return this; }
  override unref(): this { this.referenced = false; this.timer?.unref(); return this; }
  override _read(): void { this.reading = true; }
  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.reading = false;
  }
  private poll(): void {
    if (!this.isRaw || !this.reading) return;
    try {
      const records = this.api.read();
      let text = this.surrogate; this.surrogate = '';
      const flush = () => {
        if (text) { this.reading = this.push(text); text = ''; }
      };
      for (let offset = 0; offset < records.length; offset += 20) {
        const type = records.readUInt16LE(offset);
        if (type === 1) {
          const down = records.readInt32LE(offset + 4) !== 0;
          const key = records.readUInt16LE(offset + 10);
          const char = records.readUInt16LE(offset + 14);
          const modifiers = records.readUInt32LE(offset + 16);
          if (!down && !(key === 0x12 && char)) continue;
          const value = specialKeys[key] ?? (char ? String.fromCharCode(char) : '');
          text += (key === 0x0d && (modifiers & 3) ? '\x1b\r' : value).repeat(Math.max(1, records.readUInt16LE(offset + 8)));
        } else if (type === 2 && this.mouse) {
          const buttons = records.readUInt32LE(offset + 8);
          const modifiers = records.readUInt32LE(offset + 12);
          const flags = records.readUInt32LE(offset + 16);
          if (flags & 1) { this.buttons = buttons; continue; }
          flush();
          const screen = this.api.screen();
          const x = records.readInt16LE(offset + 4) - screen.left + 1;
          const y = records.readInt16LE(offset + 6) - screen.top + 1;
          const modifier = (modifiers & 0x10 ? 4 : 0) | (modifiers & 3 ? 8 : 0) | (modifiers & 0xc ? 16 : 0);
          if (flags & 4) this.reading = this.push(`\x1b[<${(records.readInt16LE(offset + 10) > 0 ? 64 : 65) | modifier};${x};${y}M`);
          else if ((buttons & 1) !== (this.buttons & 1)) {
            this.reading = this.push(`\x1b[<${modifier};${x};${y}${buttons & 1 ? 'M' : 'm'}`);
          }
          this.buttons = buttons;
        } else if (type === 4) {
          const screen = this.api.screen();
          for (const stream of [process.stdout, process.stderr]) {
            if (stream.isTTY) { stream.columns = screen.columns; stream.rows = screen.rows; stream.emit('resize'); }
          }
        }
      }
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) { this.surrogate = text.slice(-1); text = text.slice(0, -1); }
      flush();
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(errorText(error)));
    }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stop();
    try {
      if (this.isRaw) { this.api.setMode(this.originalMode); this.isRaw = false; }
    } catch (restore) {
      super._destroy(new HarnessError('TERMINAL_INPUT',
        `${error ? `${error.message}; ` : ''}Console mode restoration failed: ${errorText(restore)}`), callback); return;
    }
    super._destroy(error, callback);
  }
}
