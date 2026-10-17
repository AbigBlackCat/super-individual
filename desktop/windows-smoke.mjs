import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { desktopDataDirectory } from './runtime.mjs';
if (process.platform !== 'win32') throw new Error('This test must run on Windows');
const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]:)/i, '$1');
const appDir = path.resolve('desktop/out/super individual-win32-x64');
const executable = path.join(appDir, 'super individual.exe');
const payload = path.join(appDir, 'resources/payload');
const require = createRequire(path.join(payload, 'server/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'si-windows-smoke-'));
await fs.mkdir('desktop/validation', {recursive:true});
const fake = path.join(temp, 'fake-cli.cjs');
const plan = {summary:'Windows connection verification',acceptance:'Plan saved without approval',steps:[{key:'check',title:'Check',description:'Inspect validation result',kind:'research',dependsOn:[]}]};
await fs.writeFile(fake, `const args=process.argv.slice(2);if(args.includes('--version'))console.log('2.1.273');else if(args[0]==='auth')console.log(JSON.stringify({loggedIn:true}));else if(args[0]==='login')console.log('Logged in');else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify('```json\n'+JSON.stringify(plan)+'\n```')},session_id:'si-smoke',usage:{input_tokens:1,output_tokens:1}}));`);
for (const name of ['claude','codex']) await fs.writeFile(path.join(temp,name+'.cmd'), `@echo off\r\n"${path.join(payload,'bin/node.exe')}" "${fake}" %*\r\n`);
const env = {...process.env, PATH:temp+path.delimiter+process.env.PATH};
const connectionFile = path.join(desktopDataDirectory(), 'mcp/connection.json');
const processes=[];
function start() { const p=spawn(executable,[],{cwd:temp,env,stdio:'ignore'});processes.push(p);return p; }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connection() {
 for(let i=0;i<120;i++) {try {const v=JSON.parse(await fs.readFile(connectionFile,'utf8'));const r=await fetch(v.origin+'/api/health');if(r.ok)return v;}catch{}await sleep(1000);}
 throw new Error('Packaged backend did not start');
}
async function api(c,route,body) {const r=await fetch(c.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
async function quit() {
 const p=spawn(executable,['--quit'],{cwd:temp,env,stdio:'ignore'});await new Promise(r=>p.once('exit',r));
 for(let i=0;i<30;i++){try{await fs.access(connectionFile);}catch{return;}await sleep(1000);}throw new Error('Desktop did not stop and revoke its capability');
}
async function tool(client,name,args={}){const v=await client.callTool({name,arguments:args});assert.ok(!v.isError,JSON.stringify(v));return JSON.parse(v.content[0].text);}
let client;
try {
 start();let c=await connection();
 const engines=await api(c,'/individual/engines?refresh=true');assert.ok(engines.every(e=>e.available&&e.loggedIn),JSON.stringify(engines));
 const company=await api(c,'/companies',{name:'Windows verification'});
 client=new Client({name:'windows-distribution-test',version:'1'});
 await client.connect(new StdioClientTransport({command:path.join(payload,'bin/node.exe'),args:[path.join(payload,'si-mcp.mjs')]}));
 assert.equal((await client.listTools()).tools.length,5);
 const request={companyId:company.id,requestId:randomUUID(),title:'Windows MCP verification',description:'Only generate a plan. Do not implement.',coordinator:'claude',directory:temp,priority:'low'};
 const task=await tool(client,'create_task',request);assert.equal((await tool(client,'create_task',request)).id,task.id);
 const submission={companyId:company.id,taskId:task.id,submissionId:randomUUID(),result:'Windows MCP writes succeeded',artifacts:[path.join(temp,'result.txt')]};
 const result=await tool(client,'report_result',submission);assert.equal((await tool(client,'report_result',submission)).commentId,result.commentId);
 const route=`/individual/${company.id}/tasks/${task.id}`;
 await api(c,route+'/plan',{});
 let detail;for(let i=0;i<70;i++){detail=await api(c,route);if(['plan_review','blocked'].includes(detail.workflow.phase))break;await sleep(1000);}
 assert.equal(detail.workflow.phase,'plan_review',JSON.stringify(detail));assert.ok(!detail.workflow.approvedRevision);
 await quit();
 const listener=net.createServer();await new Promise(r=>listener.listen(3100,'127.0.0.1',r));
 try {start();c=await connection();assert.notEqual(new URL(c.origin).port,'3100');const before=c.pid;const p=start();await new Promise(r=>p.once('exit',r));assert.equal((await connection()).pid,before);assert.equal((await tool(client,'get_task',{companyId:company.id,taskId:task.id})).task.id,task.id);assert.equal((await tool(client,'report_result',submission)).commentId,result.commentId);}finally{await new Promise(r=>listener.close(r));}
 await api(c,route+'/cancel',{});await quit();
 await fs.writeFile('desktop/validation/windows-smoke.json',JSON.stringify({passed:true,platform:process.platform,arch:process.arch,checks:['packaged startup','fresh PostgreSQL','Windows cmd CLI discovery','MCP read/create/result','idempotent writes','human approval gate','restart persistence','port conflict','single instance','graceful exit'],cliFixture:true,realProviderCredentialsUsed:false},null,2));
 console.log('Windows packaged application smoke test passed');
} catch(error) {
 const log=await fs.readFile(path.join(desktopDataDirectory(),'logs/desktop-backend.log'),'utf8').catch(()=> 'No backend log');
 await fs.writeFile('desktop/validation/windows-smoke-backend.log',log);console.error(log.slice(-30000));throw error;
} finally {await client?.close();for(const p of processes)if(p.exitCode===null)spawn('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
