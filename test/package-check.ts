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
  const v2Version = execFileSync(process.execPath, [path.join(directory, 'dist', 'v2', 'cli.js'), '--version'], { encoding: 'utf8' });
  if (!v2Version.includes('runtime 1.0.112') || !existsSync(path.join(directory, 'harness.v2.example.json')) ||
      !existsSync(path.join(directory, 'docs', 'V2.md')) || !existsSync(path.join(directory, 'SDK_FIRST_LIMITS_PLAN.md')) ||
      existsSync(path.join(directory, 'harness.v2.local.json'))) {
    throw new Error('V2 CLI/runtime pin, configuration, documentation or private-file exclusion failed.');
  }
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
  const v2Script = `
    const {V2Controller,parseV2Config}=await import(process.argv[1]);
    const {createServer}=await import('node:http');
    let calls=0,wire;
    const server=createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req){chunks.push(Buffer.from(chunk));}
      wire=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.headers.authorization!=='Bearer synthetic-installed-package-key'){res.writeHead(401).end();return;}
      calls++;
      const output=[{id:'installed_msg',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Installed Copilot runtime verified.',annotations:[]}]}];
      const event=(type,value)=>res.write('event: '+type+'\\ndata: '+JSON.stringify({type,...value})+'\\n\\n');
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      event('response.created',{response:{id:'installed_response',object:'response',status:'in_progress',output:[]}});
      event('response.output_item.added',{output_index:0,item:output[0]});
      event('response.content_part.added',{item_id:'installed_msg',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
      event('response.output_text.delta',{item_id:'installed_msg',output_index:0,content_index:0,delta:'Installed Copilot runtime verified.'});
      event('response.output_item.done',{output_index:0,item:output[0]});
      event('response.completed',{response:{id:'installed_response',object:'response',status:'completed',model:'synthetic-deployment',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});
      res.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=JSON.parse(process.argv[2]);
    const config=parseV2Config({...base,model:{baseURL:'http://127.0.0.1:'+server.address().port+'/v1',canonical:'gpt-6.1-sol',wire:'synthetic-deployment'}});
    const app=await V2Controller.open({config,apiKey:'synthetic-installed-package-key'});
    try{
      const result=await app.submit('Synthetic installed package verification.');
      if(result.status!=='completed'||result.usage.input!==10||calls!==1)throw new Error(JSON.stringify(result));
      if(config.limits.maxTokens!==undefined||wire.max_output_tokens!==undefined||app.inspect().budget.mode!=='none')throw new Error('SDK-first installed defaults were overridden.');
    }finally{
      await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', v2Script,
    pathToFileURL(path.join(directory, 'dist', 'v2', 'index.js')).href,
    JSON.stringify({ version: 3, workspace, dataDir: path.join(root, 'v2-state') })],
  { encoding: 'utf8', env, timeout: 30000, stdio: 'pipe' });
  console.log('PASS clean npm install: MVP approval/restart/output, V2 CLI/API/docs, bundled real Copilot runtime with synthetic BYOK/usage, SQLite/locks and private-file exclusion.');
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
