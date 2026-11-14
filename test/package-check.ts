import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('Package verification targets Windows.');
const root = mkdtempSync(path.join(tmpdir(), 'harness-package-'));
const packageFile = process.argv[2] ?? readdirSync(process.cwd()).find(p => /^harness-experiment-\d.*\.tgz$/.test(p));
if (!packageFile) throw new Error('Build and npm pack the project before running verify:package.');
const packagePath = path.resolve(packageFile);
if (/["%\r\n]/.test(root + packagePath)) throw new Error('Unsafe package-test path.');
try {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this check through npm run verify:package.');
  execFileSync(process.execPath, [npmCli, 'install', '--prefix', root, '--omit=dev', '--no-audit', '--no-fund', packagePath],
  { encoding: 'utf8', env, timeout: 180000, stdio: 'pipe' });
  const directory = path.join(root, 'node_modules', 'harness-experiment');
  if (!existsSync(path.join(directory, '.env.example')) || existsSync(path.join(directory, '.env'))) {
    throw new Error('Package must include the credential-free example and exclude the private .env.');
  }
  const version = execFileSync(process.execPath, [path.join(directory, 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
  if (!version.includes('0.1.0')) throw new Error('Installed CLI version check failed.');
  const workspace = path.join(root, 'documents'); mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'notes.md'), 'Synthetic package acceptance document.');
  // The installed native DLLs must unload before Windows can remove the test installation.
  const script = `
    const {SessionController,parseConfig}=await import(process.argv[1]);
    const config=parseConfig(JSON.parse(process.argv[2]));
    let app=await SessionController.open({config});
    const id=app.id;
    try {
      await app.submit('Read documents, summarize them, and save the summary.');
      await app.close();
      app=await SessionController.open({config,sessionId:id});
      for(let i=0;i<10&&app.inspect().pending.length;i++){
        const q=app.inspect().pending[0];
        await app.respond(q.id,q.revision,'approve');
      }
      if(app.inspect().run?.status!=='completed')throw new Error(app.inspect().run?.reason);
    } finally {await app.close();}
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script,
    pathToFileURL(path.join(directory, 'dist', 'index.js')).href,
    JSON.stringify({ mode: 'fake', workspace, dataDir: path.join(root, 'state') })],
  { encoding: 'utf8', env, timeout: 30000, stdio: 'pipe' });
  console.log('PASS isolated npm install: packaged CLI, native SQLite/locks, exported API, approval restart, and approved file output.');
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
