import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validationEnvironment, redactValidationLog } from './validation-runtime.mjs';
import { assertWindowsVcRuntimeLoaded } from './windows-vc-runtime.mjs';
import { copyWindowsDirectory } from './windows-copy.mjs';
import { _electron, expect } from '@playwright/test';
if (process.platform !== 'win32') throw new Error('This test must run on Windows');
const repo = fileURLToPath(new URL('../', import.meta.url));
const sourceApp = path.resolve(process.env.SI_TEST_APP_DIRECTORY || path.join(repo, 'desktop/out/super individual-win32-x64'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'si-windows-smoke-'));
// Exercise a complete copy outside the checkout, including spaces and non-ASCII paths.
const relativeSource = path.relative(repo, sourceApp);
const alreadyRelocated = relativeSource.startsWith('..' + path.sep) || path.isAbsolute(relativeSource);
const appDir = alreadyRelocated ? sourceApp : path.join(temp, '独立软件 super individual');
if (!alreadyRelocated) {
 console.log('Copying the complete portable application outside the checkout');
 await copyWindowsDirectory(sourceApp, appDir);
 console.log('Relocated application copy is complete');
}
const executable = path.join(appDir, 'super individual.exe');
const payload = path.join(appDir, 'resources/payload');
const require = createRequire(path.join(payload, 'server/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
await fs.mkdir('desktop/validation', {recursive:true});
const fake = path.join(temp, 'fake-cli.cjs');
const plan = {summary:'Windows connection verification',acceptance:'Plan saved without approval',steps:[{key:'check',title:'Check',description:'Inspect validation result',kind:'research',dependsOn:[]}]};
await fs.writeFile(fake, `const args=process.argv.slice(2);if(args.includes('--version'))console.log('2.1.273');else if(args[0]==='auth')console.log(JSON.stringify({loggedIn:true}));else if(args[0]==='login')console.log('Logged in');else{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const emit=()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:input.trim()==='Respond with hello.'?'hello':${JSON.stringify('```json\n'+JSON.stringify(plan)+'\n```')},session_id:'si-smoke',usage:{input_tokens:1,output_tokens:1}}));if(input.includes('SI_SMOKE_SLOW'))setTimeout(emit,120000);else emit();});}`);
for (const name of ['claude','codex']) await fs.writeFile(path.join(temp,name+'.cmd'), `@echo off\r\nchcp 65001 >nul\r\n"${path.join(payload,'bin/node.exe')}" "${fake}" %*\r\n`);
const home = path.join(temp, 'data');
const env = validationEnvironment(home, {PATH:[temp,path.join(process.env.SystemRoot,'System32'),process.env.SystemRoot].join(path.delimiter)});
const connectionFile = path.join(home, 'mcp/connection.json');
const processes=[];
let desktopApp;
async function start() {
 desktopApp=await _electron.launch({executablePath:executable,cwd:temp,env,timeout:180000});
 processes.push(desktopApp.process());
 // Capture the real tray object before the asynchronous backend startup completes.
 await desktopApp.evaluate(({Tray}) => {
   const original=Tray.prototype.on;
   Tray.prototype.on=function(event,listener){
     if(event==='click'){globalThis.__siValidationTray=this;Tray.prototype.on=original;}
     return original.call(this,event,listener);
   };
 });
 return desktopApp;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connection() {
 for(let i=0;i<360;i++) {try {const v=JSON.parse(await fs.readFile(connectionFile,'utf8'));const r=await fetch(v.origin+'/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok)return v;}catch{}await sleep(1000);}
 throw new Error('Packaged backend did not start');
}
async function api(c,route,body) {const r=await fetch(c.origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:c.origin},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
async function quit() {
 const postgresPid=Number((await fs.readFile(path.join(home,'instances/default/db/postmaster.pid'),'utf8')).split('\n')[0]);
 const p=spawn(executable,['--quit'],{cwd:temp,env,stdio:'ignore'});await new Promise(r=>p.once('exit',r));
 for(let i=0;i<60;i++){try{await fs.access(connectionFile);}catch{
   let stopped=false;for(let j=0;j<10;j++){try{process.kill(postgresPid,0);}catch(error){if(error.code==='ESRCH'){stopped=true;break;}throw error;}await sleep(500);}
   assert.ok(stopped,'Owned PostgreSQL remained alive after desktop exit');return;
 }await sleep(1000);}throw new Error('Desktop did not stop and revoke its capability');
}
async function tool(client,name,args={}){const v=await client.callTool({name,arguments:args});assert.ok(!v.isError,JSON.stringify(v));return JSON.parse(v.content[0].text);}
async function planReady(c,route) {
 let detail;for(let i=0;i<90;i++){detail=await api(c,route);if(['plan_review','blocked'].includes(detail.workflow.phase))break;await sleep(1000);}
 assert.equal(detail.workflow.phase,'plan_review',JSON.stringify({phase:detail.workflow.phase,error:detail.workflow.error,runs:detail.runs}));assert.ok(!detail.workflow.approvedRevision);
 assert.equal(detail.workflow.stages.filter(stage=>stage.role==='worker').length,0);
 return detail;
}
let client;
try {
 const firstStartedAt=Date.now();await start();let c=await connection();
 const firstStartupSeconds=Math.round((Date.now()-firstStartedAt)/1000);
 const postgresPid=Number((await fs.readFile(path.join(home,'instances/default/db/postmaster.pid'),'utf8')).split('\n')[0]);
 await assertWindowsVcRuntimeLoaded(postgresPid,path.join(payload,'server/node_modules/@embedded-postgres/windows-x64/native/bin'));
 let page=await desktopApp.firstWindow();
 await expect(page.getByRole('heading',{name:'创建你的个人工作区'})).toBeVisible();
 assert.equal(await page.evaluate(()=>window.superIndividual.runtimeStatus().then(value=>value.dataDirectory)),home);
 const engines=await api(c,'/individual/engines?refresh=true');assert.ok(engines.every(e=>e.available&&e.loggedIn),JSON.stringify(engines));
 await page.getByRole('textbox',{name:'工作区名称'}).fill('Windows verification');
 await page.getByRole('button',{name:'创建工作区',exact:true}).click();
 await expect(page.getByRole('button',{name:'创建任务',exact:true})).toBeEnabled();
 const company=(await api(c,'/companies'))[0];
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await page.getByLabel('任务名称',{exact:true}).fill('桌面创建任务');
 await page.getByLabel('需求与验收标准').fill('创建、编辑后重启，内容必须保留。');
 await page.getByLabel('选择总控').selectOption('claude');
 await page.getByPlaceholder('选择任务可读写的本机文件夹').fill(temp);
 await page.getByRole('button',{name:'创建并生成计划'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const uiTask=(await api(c,`/individual/${company.id}/tasks`)).find(task=>task.title==='桌面创建任务');
 assert.ok(uiTask);
 const uiRoute=`/individual/${company.id}/tasks/${uiTask.id}`;
 await planReady(c,uiRoute);
 await page.getByRole('button').filter({has:page.getByRole('heading',{name:'桌面创建任务',exact:true})}).click();
 await page.getByRole('tab',{name:'需求',exact:true}).click();
 await page.getByRole('button',{name:'编辑需求'}).click();
 await page.getByLabel('任务名称',{exact:true}).fill('桌面修改任务已保存');
 await page.getByRole('tabpanel',{name:'需求',exact:true}).locator('textarea').fill('Windows 中文内容已编辑并保存。');
 await page.getByRole('button',{name:'保存修改'}).click();
 await expect(page.getByRole('heading',{name:'桌面修改任务已保存',exact:true}).last()).toBeVisible();
 assert.equal((await api(c,uiRoute)).task.description,'Windows 中文内容已编辑并保存。');
 // The close button hides the window; the actual tray click handler restores it.
 await desktopApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 assert.equal(await desktopApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 assert.equal(await desktopApp.evaluate(()=>{if(!globalThis.__siValidationTray)return false;globalThis.__siValidationTray.emit('click');return true;}),true,'Real tray was not captured');
 assert.equal(await desktopApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
 await page.screenshot({path:path.join(repo,'desktop/validation/windows-smoke-ui.png')});
 client=new Client({name:'windows-distribution-test',version:'1'});
 await client.connect(new StdioClientTransport({command:path.join(payload,'bin/node.exe'),args:[path.join(payload,'si-mcp.mjs')],env}));
 assert.equal((await client.listTools()).tools.length,5);
 const request={companyId:company.id,requestId:randomUUID(),title:'Windows MCP verification',description:'Only generate a plan. Do not implement.',coordinator:'claude',directory:temp,priority:'low'};
 const task=await tool(client,'create_task',request);assert.equal((await tool(client,'create_task',request)).id,task.id);
 const submission={companyId:company.id,taskId:task.id,submissionId:randomUUID(),result:'Windows MCP writes succeeded',artifacts:[path.join(temp,'result.txt')]};
 const result=await tool(client,'report_result',submission);assert.equal((await tool(client,'report_result',submission)).commentId,result.commentId);
 const draft=await tool(client,'get_task',{companyId:company.id,taskId:task.id});assert.equal(draft.task.phase,'draft');assert.equal(draft.approvedRevision,null);
 const route=`/individual/${company.id}/tasks/${task.id}`;
 await api(c,route+'/plan',{});
 await planReady(c,route);
 const denied=await client.callTool({name:'approve_plan',arguments:{companyId:company.id,taskId:task.id}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/not found/);
 const prematureAcceptance=await fetch(c.origin+'/api'+route+'/accept',{method:'POST',headers:{'Content-Type':'application/json',Origin:c.origin},body:'{}'});assert.equal(prematureAcceptance.status,409);
 assert.equal((await api(c,route)).workflow.phase,'plan_review');
 const slowTask=await api(c,`/individual/${company.id}/tasks`,{title:'Exit pauses an active task',description:'SI_SMOKE_SLOW',coordinator:'claude',directory:temp,priority:'low'});
 const slowRoute=`/individual/${company.id}/tasks/${slowTask.id}`;
 await api(c,slowRoute+'/plan',{});
 let active;
 for(let i=0;i<60;i++){active=await api(c,slowRoute);assert.notEqual(active.workflow.phase,'blocked',active.workflow.error);if(active.runs.some(run=>run.status==='running'))break;await sleep(500);}
 assert.ok(active.runs.some(run=>run.status==='running'),'Slow fixture did not start');
 await desktopApp.evaluate(({dialog})=>{dialog.showMessageBox=async options=>({response:options.type==='question'?1:0});});
 await quit();
 const configFile=path.join(home,'instances/default/config.json');
 const previousConfig=JSON.parse(await fs.readFile(configFile,'utf8'));
 previousConfig.$meta.source='super individual';
 await fs.writeFile(configFile,JSON.stringify(previousConfig));
 const listener=net.createServer();await new Promise(r=>listener.listen(3100,'127.0.0.1',r));
 let restartStartupSeconds;
 try {const restartedAt=Date.now();await start();c=await connection();restartStartupSeconds=Math.round((Date.now()-restartedAt)/1000);assert.notEqual(new URL(c.origin).port,'3100');const before=c.pid;const p=spawn(executable,[],{cwd:temp,env,stdio:'ignore'});await new Promise(r=>p.once('exit',r));assert.equal((await connection()).pid,before);assert.equal((await tool(client,'get_task',{companyId:company.id,taskId:task.id})).task.id,task.id);assert.equal((await tool(client,'report_result',submission)).commentId,result.commentId);
   page=await desktopApp.firstWindow();await expect(page.getByRole('heading',{name:'桌面修改任务已保存',exact:true})).toBeVisible();
   assert.equal((await api(c,uiRoute)).task.description,'Windows 中文内容已编辑并保存。');
   assert.equal((await api(c,route)).workflow.phase,'plan_review');
   assert.equal((await api(c,slowRoute)).workflow.phase,'paused');
   const repairedConfig=JSON.parse(await fs.readFile(configFile,'utf8'));
   assert.equal(repairedConfig.$meta.source,'configure');
   previousConfig.$meta.source='configure';assert.deepEqual(repairedConfig,previousConfig);
 }finally{await new Promise(r=>listener.close(r));}
 await api(c,route+'/cancel',{});await api(c,slowRoute+'/cancel',{});await quit();
 await fs.writeFile('desktop/validation/windows-smoke.json',JSON.stringify({passed:true,platform:process.platform,arch:process.arch,firstStartupSeconds,restartStartupSeconds,vcRuntimeAppLocal:true,checks:['relocated packaged startup with restricted PATH','app-local Microsoft VC runtime loaded','fresh PostgreSQL','production UI rendered','UI workspace/task creation and editing','Windows cmd CLI discovery','MCP read/create/result','idempotent writes','human approval and acceptance gates','UI and database restart persistence','port conflict','single instance','window close hides and tray click restores','active task paused and saved on exit without automatic resume','graceful exit and capability revocation'],cliFixture:true,realProviderCredentialsUsed:false},null,2));
 console.log('Windows packaged application smoke test passed');
} catch(error) {
 const log=redactValidationLog(await fs.readFile(path.join(home,'logs/desktop-backend.log'),'utf8').catch(()=> 'No backend log'));
 await fs.writeFile('desktop/validation/windows-smoke-backend.log',log);console.error(log.slice(-10000));throw error;
} finally {await client?.close();for(const p of processes)if(p.exitCode===null)spawn('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
