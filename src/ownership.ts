import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { tryLock, unlock } from 'fs-native-extensions';
import { HarnessError } from './contracts.js';
import { hash } from './config.js';

export class Ownership {
  private fd: number | undefined;
  constructor(dataDir: string, identity: string) {
    const dir = path.join(dataDir, 'locks');
    mkdirSync(dir, { recursive: true });
    const fd = openSync(path.join(dir, `${hash(identity)}.lock`), 'a+');
    try {
      if (!tryLock(fd)) throw new HarnessError('OWNED', 'This session or file is already owned by another operation.');
      this.fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  assert(): void {
    if (this.fd === undefined) throw new HarnessError('OWNERSHIP', 'Session ownership has been released.');
  }
  close(): void {
    if (this.fd !== undefined) {
      const fd = this.fd;
      this.fd = undefined;
      try { unlock(fd); } finally { closeSync(fd); }
    }
  }
  static held(dataDir: string, identity: string): boolean {
    try { const owner = new Ownership(dataDir, identity); owner.close(); return false; }
    catch (error) {
      if (error instanceof HarnessError && error.code === 'OWNED') return true;
      throw error;
    }
  }
}
