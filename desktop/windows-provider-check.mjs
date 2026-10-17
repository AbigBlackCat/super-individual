// Manual live-provider acceptance. Uses the user's installed, logged-in CLI;
// the database and working directory are disposable. Never copy provider homes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { _electron, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 30000 });
const repo = fileURLToPath(new URL('../', import.meta.url));
const engine = process.argv[2] || 'codex';
assert.ok(['claude','codex'].includes(engine));
assert.equal(process.platform,'win32');
const appDir = path.resolve(process.env.SI_TEST_APP_DIRECTORY || path.join(repo,'desktop/out/super individual-win32-x64'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'si-live-provider-'));
const home = path.join(temp,'data'), work = path.join(temp,'work');
await fs.mkdir(work,{recursive:true});
const env = {...process.env};
for(const key of Object.keys(env))if(/^(?:PAPERCLIP_|SUPER_INDIVIDUAL_|SI_|PG|DATABASE_URL$|NODE_OPTIONS$|NODE_PATH$)/i.test(key))delete env[key];
Object.assign(env,{SI_DATA_DIRECTORY:home,PAPERCLIP_TELEMETRY_DISABLED:'1',NODE_ENV:'production'});
const executable=path.join(appDir,'super individual.exe');
const connectionFile=path.join(home,'mcp/connection.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let desktopApp,desktopProcess,connection,route;
const started=Date.now();
async function api(url,body){const response=await fetch(connection.origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:connection.origin},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const result=await response.json();assert.ok(response.ok,`HTTP ${response.status}`);return result;}
async function phase(expected){for(let i=0;i<300;i++){const detail=await api(route);if(detail.workflow.phase===expected)return detail;if(detail.workflow.phase==='blocked')throw new Error(`Live ${engine} stage blocked; inspect the isolated instance locally`);await sleep(2000);}throw new Error(`Live provider did not reach ${expected}`);}
try{
 desktopApp=await _electron.launch({executablePath:executable,cwd:work,env,timeout:180000});
 desktopProcess=desktopApp.process();
 for(let i=0;i<360;i++){try{connection=JSON.parse(await fs.readFile(connectionFile,'utf8'));if((await fetch(connection.origin+'/api/health',{signal:AbortSignal.timeout(1000)})).ok)break;connection=null;}catch{}await sleep(1000);}
 assert.ok(connection,'Live-provider desktop did not start');
 const engines=await api('/individual/engines?refresh=true');
 assert.ok(engines.some(item=>item.engine===engine&&item.available&&item.loggedIn),'Selected provider is not installed and logged in');
 const company=await api('/companies',{name:'Real provider acceptance'});
 const task=await api(`/individual/${company.id}/tasks`,{title:'Windows real provider verification',description:'只在当前工作目录创建 si-provider-result.txt，内容精确为 SI_WINDOWS_REAL_PROVIDER_OK。计划仅需一个 coding 步骤，不做其他改动。独立审查时读取该文件并检查内容。',coordinator:engine,directory:work,priority:'low'});
 route=`/individual/${company.id}/tasks/${task.id}`;
 await api(route+'/plan',{});
 const planned=await phase('plan_review');assert.ok(!planned.workflow.approvedRevision);
 assert.equal(planned.workflow.stages.filter(stage=>stage.role==='worker').length,0);
 const page=await desktopApp.firstWindow();await page.reload();
 await page.getByRole('button').filter({has:page.getByRole('heading',{name:task.title,exact:true})}).click();
 await page.getByRole('button',{name:'确认计划并执行'}).click();
 const reviewed=await phase('acceptance');
 assert.equal((await fs.readFile(path.join(work,'si-provider-result.txt'),'utf8')).trim(),'SI_WINDOWS_REAL_PROVIDER_OK');
 assert.notEqual(reviewed.task.status,'done');
 await expect(page.getByRole('button',{name:'验收通过',exact:true}).first()).toBeVisible({timeout:15000});
 await page.getByRole('button',{name:'验收通过',exact:true}).first().click();
 await phase('completed');
 const quit=spawn(executable,['--quit'],{cwd:work,env,stdio:'ignore'});await new Promise(resolve=>quit.once('exit',resolve));
 await expect.poll(async()=>fs.access(connectionFile).then(()=>false,()=>true),{timeout:45000}).toBe(true);
 await fs.mkdir(path.join(repo,'desktop/validation'),{recursive:true});
 await fs.writeFile(path.join(repo,`desktop/validation/windows-real-${engine}.json`),JSON.stringify({passed:true,engine,realProvider:true,credentialsBundled:false,elapsedSeconds:Math.round((Date.now()-started)/1000),checks:['installed CLI authenticated','real model plan','human plan approval through UI','real worker file output','independent review session','human final acceptance through UI','graceful exit']},null,2));
 console.log(`Live ${engine} planning, execution, review and human acceptance passed`);
}catch(error){
 console.error(String(error.stack || error));
 if(connection&&route){
  const detail=await api(route).catch(()=>null);
  if(detail)console.error(JSON.stringify({phase:detail.workflow.phase,error:detail.workflow.error,runs:detail.runs.map(run=>({status:run.status,error:run.error}))}).replace(/https?:\/\/[^\s"\\]+/g,'[endpoint redacted]'));
 }
 throw error;
}finally{
 if(desktopProcess?.exitCode===null){
  if(connection&&route)await api(route+'/cancel',{}).catch(()=>{});
  try {execFileSync('taskkill.exe',['/PID',String(desktopProcess.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});} catch {}
 }
 // Provider auth links and copied private CLI configuration belong only to
 // this disposable data home, never to the repository or release artifacts.
 await fs.rm(home,{recursive:true,force:true}).catch(()=>{});
}
