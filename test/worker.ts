import { Ownership } from '../src/ownership.js';

const [action, ...args] = process.argv.slice(2);
if (action === 'lock') {
  const owner = new Ownership(args[0]!, args[1]!);
  console.log('READY');
  process.stdin.resume();
  process.once('SIGTERM', () => { owner.close(); process.exit(0); });
} else throw new Error('Unsupported worker operation.');
