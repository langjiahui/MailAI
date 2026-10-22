/* Deferred download, truthful Installer handoff, and one progress monitor per page. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/web/static/app.js'), 'utf8');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    textContent:'', style:{}, dataset:{}, disabled:false, open:false, hidden:true,
    classList:{add(){},remove(){},toggle(){}}, setAttribute(){}, removeAttribute(){},
    close(){this.open=false;}, showModal(){this.open=true;},
  });
  return elements.get(id);
}
const messages = [], posts = [];
const release = {available:true, installable:true, current_version:'3.0.0', latest_version:'3.1.0'};
const idle = {status:'idle',phase:'idle',running:false};
const ready = {status:'completed',phase:'ready',running:false,version:'3.1.0',release,total:100,downloaded:100,percent:100};
const running = {...ready,status:'running',phase:'downloading',action:'download',running:true,downloaded:23,percent:23};
const ctx = {
  document:{getElementById:element,hidden:false}, appUpdateInstalling:false,
  appUpdateTask:idle,appUpdateMonitor:null,appUpdateStatusRevision:0,appUpdateLastCheck:null,
  availableAppUpdate:release, appUpdateCheckRevision:0,
  localStorage:{getItem:()=>null,setItem(){}},
  mailaiT:()=>null,mailaiText:text=>text,mailaiSystemMessage:text=>text,
  mailaiTemplate:(parts,...values)=>parts.reduce((s,p,i)=>s+p+(values[i]??''),''),
  mailaiBindUI:(node,key,reader)=>{node[key]=reader();},
  setLoading:(node,loading)=>{node.disabled=loading;},
  setTimeout:callback=>setImmediate(callback),
  toast:(message,kind)=>messages.push({message,kind}),
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/web/static/i18n-catalog.js'),'utf8'),ctx);
vm.runInContext(source.slice(source.indexOf('function updateFlowText('),source.indexOf('async function loadSystemConfig(')),ctx);
const click = {preventDefault(){}};
(async()=>{
  // Closing/reopening while downloading never resets progress or starts another request.
  ctx.appDeviceName = x=>x;
  ctx.api = async url=>{assert.equal(url,'/api/system/update/install/status');return running;};
  ctx.appUpdateTask = running;
  ctx.monitorAppUpdateInstall = ()=>Promise.resolve(running);
  ctx.showAppUpdate(release);
  await new Promise(setImmediate);
  assert.equal(element('btn-install-update').textContent,'下载中 23%');
  assert.equal(element('btn-install-update').disabled,true);
  assert.equal(element('btn-defer-update').textContent,'后台下载');
  element('update-dialog').close();ctx.deferAppUpdate();
  assert.equal(element('companion-update').hidden,false);
  assert.equal(element('companion-update-copy').textContent,'更新下载中 23%');
  ctx.showAppUpdate(release);await new Promise(setImmediate);
  assert.equal(ctx.appUpdateTask.percent,23);
  // Restore the real monitor and verify it is shared across opening/submit callers.
  vm.runInContext(source.slice(source.indexOf('function monitorAppUpdateInstall('),source.indexOf('async function checkForAppUpdate(')),ctx);
  ctx.api = async url=>{assert.equal(url,'/api/system/update/install/status');return ready;};
  const first=ctx.monitorAppUpdateInstall();assert.equal(ctx.monitorAppUpdateInstall(),first);
  await first;
  assert.equal(element('btn-install-update').textContent,'立即安装');
  assert.equal(element('btn-install-update').disabled,false);
  // First action downloads only. Ready never automatically invokes any install endpoint.
  ctx.appUpdateTask=idle;
  ctx.api=async(url,options)=>{
    if(options?.method==='POST'){posts.push(url);return running;}
    return ready;
  };
  await ctx.installAppUpdate(click);
  assert.deepEqual(posts,['/api/system/update/download']);
  assert.equal(ctx.appUpdateTask.phase,'ready');
  assert.equal(element('update-dialog').open,true);
  // An explicit second click opens Installer; canceling there allows reopening.
  ctx.api=async(url,options)=>{assert.equal(options?.method,'POST');posts.push(url);return {...ready,phase:'installer_opened',message:'Continue in Installer'};};
  await ctx.installAppUpdate(click);
  assert.equal(posts.at(-1),'/api/system/update/install/ready?version=3.1.0');
  assert.equal(element('update-dialog').open,true);
  assert.equal(element('btn-install-update').textContent,'重新打开安装器');
  assert.equal(messages.at(-1).kind,'info');
  await ctx.installAppUpdate(click);assert.equal(posts.length,3);
  // A rejected initial request must release the button instead of leaving a queued task forever.
  ctx.appUpdateTask=idle;
  ctx.api=async(url,options)=>{if(options?.method==='POST')throw Error('Offline');return idle;};
  await ctx.installAppUpdate(click);
  assert.equal(element('btn-install-update').disabled,false);
  assert.equal(element('update-progress-detail').textContent,'Offline');
  assert.equal(messages.at(-1).kind,'error');
  // A POST whose response was lost may already be running; recover instead of resetting it.
  ctx.api=async(url,options)=>{if(options?.method==='POST')throw Error('Response lost');return running;};
  ctx.monitorAppUpdateInstall=()=>Promise.resolve(running);
  await ctx.installAppUpdate(click);
  assert.equal(ctx.appUpdateTask.running,true);
  assert.equal(element('btn-install-update').disabled,true);
  // Offline discovery must still recover a locally prepared package after restarting the UI.
  ctx.appUpdateLastCheck=null;ctx.availableAppUpdate=null;ctx.appUpdateTask=idle;
  ctx.api=async url=>{if(url==='/api/system/update/install/status')return ready;throw Error('Discovery offline');};
  await ctx.checkForAppUpdate(false);
  assert.equal(ctx.appUpdateTask.phase,'ready');
  assert.equal(ctx.availableAppUpdate.latest_version,'3.1.0');
  // An old cached package must not label a newly discovered version as ready to install.
  ctx.appUpdateLastCheck={...release,latest_version:'3.2.0'};
  ctx.applyAppUpdateTask(ready);
  assert.equal(ctx.appUpdateTask.phase,'idle');
  assert.equal(ctx.availableAppUpdate.latest_version,'3.2.0');
  assert.equal(element('btn-install-update').textContent,'下载更新');
  // Windows still closes the dialog only after an explicit Installer handoff.
  ctx.appUpdateLastCheck=null;ctx.availableAppUpdate=release;ctx.appUpdateTask=ready;
  ctx.api=async()=>({...ready,phase:'launched',message:'Installer started'});
  ctx.monitorAppUpdateInstall=async()=>ctx.appUpdateTask;
  await ctx.installAppUpdate(click);
  assert.equal(element('update-dialog').open,false);
  assert.equal(messages.at(-1).kind,'success');
  console.log('PASS defer/reopen progress, mascot entry, single monitor, explicit install, cancellation retry and lost-response recovery');
})().catch(error=>{console.error(error);process.exitCode=1;});
