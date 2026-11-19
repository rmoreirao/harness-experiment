import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Package verification targets Windows.');
const root = mkdtempSync(path.join(tmpdir(), 'harness-package-'));
const packageFile = process.argv[2] ?? 'harness-experiment-0.2.0.tgz';
if (!existsSync(packageFile)) throw new Error('Build and npm pack native version 0.2.0 before running verify:package.');
const packagePath = path.resolve(packageFile);
if (/["%\r\n]/.test(root + packagePath)) throw new Error('Unsafe package-test path.');
try {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'BRAVE_SEARCH_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_MODEL', 'HARNESS_WIRE_MODEL']) delete env[key];
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this check through npm run verify:package.');
  execFileSync(process.execPath, [npmCli, 'install', '--prefix', root, '--omit=dev', '--no-audit', '--no-fund', packagePath],
  { encoding: 'utf8', env, timeout: 180000, stdio: 'pipe' });
  const directory = path.join(root, 'node_modules', 'harness-experiment');
  const manifest: { version: string; bin: Record<string, string>; exports: Record<string, string>; dependencies: Record<string, string> } =
    JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== '0.2.0' || Object.keys(manifest.bin).join() !== 'harness' || !['./dist/cli.js', 'dist/cli.js'].includes(manifest.bin.harness ?? '') ||
      Object.keys(manifest.exports).join() !== '.' || manifest.exports['.'] !== './dist/index.js' ||
      '@openai/agents' in manifest.dependencies || 'openai' in manifest.dependencies) {
    throw new Error('Installed package must expose only the promoted CLI/API and no retired backend dependencies.');
  }
  for (const file of ['.env.example', 'harness.example.json', 'README.md', 'docs\\GUIDE.md',
    'PRODUCT.md', 'ARCHITECTURE.md', 'IMPLEMENTATION_PLAN.md', 'SDK_FIRST_LIMITS_PLAN.md', 'NATIVE_SDK_MIGRATION_PLAN.md']) {
    if (!existsSync(path.join(directory, file))) throw new Error(`Missing installed example/documentation: ${file}`);
  }
  for (const file of ['.env', 'harness.local.json', 'harness.v2.local.json', 'harness.v2.example.json',
    'src', 'dist\\v2', 'docs\\V2.md', ...['budget', 'context', 'gateway', 'model', 'storage', 'workflow', 'legacy']
      .flatMap(name => ['js', 'd.ts', 'js.map'].map(extension => `dist\\${name}.${extension}`))]) {
    if (existsSync(path.join(directory, file))) throw new Error(`Private or obsolete file entered the installed package: ${file}`);
  }
  const cli = path.join(directory, 'dist', 'cli.js');
  const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env, cwd: root });
  if (!version.includes('0.2.0') || !version.includes('SDK 1.0.34') || !version.includes('runtime 1.0.112')) {
    throw new Error('Installed CLI version/runtime pin check failed.');
  }
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env, cwd: root });
  if (!help.includes('harness sessions | resume') || /harness-v2|\blegacy\b|\bMVP\b/.test(help)) throw new Error('Installed CLI help still advertises a retired entry point.');
  const workspace = path.join(root, 'documents'); mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'notes.md'), 'Synthetic package acceptance document.');
  // The installed native DLLs must unload before Windows can remove the test installation.
  const script = `
    const api=await import('harness-experiment');
    const {SessionController,parseConfig}=api;
    for(const name of ['FakeModel','SqliteSession','Gateway','executeWorkflow','legacyHistory','V2Controller']){
      if(name in api)throw new Error('Retired export: '+name);
    }
    try { await import('harness-experiment/v2'); throw new Error('Retired subpath is still exported.'); }
    catch(error) { if(error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error; }
    const {createServer}=await import('node:http');
    let calls=0,wire;
    const server=createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req){chunks.push(Buffer.from(chunk));}
      wire=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.headers.authorization!=='Bearer synthetic-installed-package-key'){res.writeHead(401).end();return;}
      calls++;
      const messageId='installed_msg_'+calls,responseId='installed_response_'+calls;
      const output=[{id:messageId,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Installed Copilot runtime verified.',annotations:[]}]}];
      const event=(type,value)=>res.write('event: '+type+'\\ndata: '+JSON.stringify({type,...value})+'\\n\\n');
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      event('response.created',{response:{id:responseId,object:'response',status:'in_progress',output:[]}});
      event('response.output_item.added',{output_index:0,item:output[0]});
      event('response.content_part.added',{item_id:messageId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
      event('response.output_text.delta',{item_id:messageId,output_index:0,content_index:0,delta:'Installed Copilot runtime verified.'});
      event('response.output_item.done',{output_index:0,item:output[0]});
      event('response.completed',{response:{id:responseId,object:'response',status:'completed',model:'synthetic-deployment',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});
      res.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=JSON.parse(process.argv[1]);
    const config=parseConfig({...base,provider:{kind:'byok',baseURL:'http://127.0.0.1:'+server.address().port+'/v1'},
      model:{canonical:'gpt-6.1-sol',wire:'synthetic-deployment'}});
    let app=await SessionController.open({config,trusted:true,apiKey:'synthetic-installed-package-key'});
    try{
      const result=await app.submit('Synthetic installed package verification.');
      if(result.status!=='completed'||result.usage.input!==10||calls!==1)throw new Error(JSON.stringify(result));
      if(config.limits.maxTokens!==undefined||wire.max_output_tokens!==undefined||app.inspect().budget.mode!=='none')throw new Error('SDK-first installed defaults were overridden.');
      const saved=app.store.session(app.id);
      await app.close();
      app=await SessionController.open({config:saved.config,sessionId:saved.id,trusted:true,apiKey:'synthetic-installed-package-key'});
      if(app.store.session(app.id).runtimeId!==saved.runtimeId||app.inspect().objective.id!==result.id)throw new Error('Installed cold resume lost session identity or evidence.');
      const resumed=await app.submit('Synthetic installed package cold continuation.');
      if(resumed.status!=='completed'||calls!==2)throw new Error(JSON.stringify(resumed));
      console.log(saved.id);
    }finally{
      await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
  `;
  const dataDir = path.join(root, 'state');
  const id = execFileSync(process.execPath, ['--input-type=module', '-e', script,
    JSON.stringify({ version: 4, workspace, dataDir })],
  { encoding: 'utf8', env, cwd: root, timeout: 60000, stdio: 'pipe' }).trim();
  const sessions = execFileSync(process.execPath, [cli, 'sessions', '--data-dir', dataDir], { encoding: 'utf8', env, cwd: root });
  if (!sessions.includes(`${id}  saved`)) throw new Error('Installed CLI did not discover the API-created saved session.');
  console.log('PASS clean npm install: sole CLI/root API/docs, bundled real Copilot runtime, synthetic BYOK/usage, cold resume, SQLite/locks, obsolete-file and private-file exclusion.');
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
