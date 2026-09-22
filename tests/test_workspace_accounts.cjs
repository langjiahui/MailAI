const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const app = fs.readFileSync('app/web/static/app.js','utf8');
const workspace = fs.readFileSync('app/web/static/workspace.js','utf8');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end,source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
(async()=>{
  const nodes={'todo-list':{},'todo-center':{classList:{add(){}}}};
  let request=deferred(), renders=0;
  const calls=[];
  const c=vm.createContext({document:{getElementById:id=>nodes[id],body:{classList:{remove(){}}}},
    api:async (url, options)=>{calls.push(options.accountId);return request.promise;},esc:x=>x,
    updateTodoBatchToolbar(){},renderTodoCenter:()=>renders++,setTimeout,updateSidebar(){},toast(){},window:{mailaiTasksChanged(){}},selectedTodoIds:new Set()});
  vm.runInContext("let todoCenterLoading=false, todoBatchBusy=false; let todoCenterAccountId='a', todoCenterRevision=0, todoCenterRows=[];"+
    slice(app,'async function loadTodoCenter()', 'async function saveTodoItem(')+
    slice(app,'async function setTodoBatchStatus(', 'async function openTodoCenter()'),c);
  const first=c.loadTodoCenter(); const old=request;
  vm.runInContext("todoCenterAccountId='b'",c); request=deferred();
  const second=c.loadTodoCenter(); request.resolve([{id:1,title:'B'}]); await second;
  old.resolve([{id:1,title:'A'}]); await first;
  assert.equal(vm.runInContext('todoCenterRows[0].title',c),'B','Old account response cannot overwrite reopened center');
  assert.deepEqual(calls,['a','b']); assert.equal(renders,1);
  request=deferred(); const closed=c.loadTodoCenter(); c.closeTodoCenter(); request.reject(new Error('late error')); await closed;
  assert.ok(!nodes['todo-list'].innerHTML.includes('late error'),'Closed view ignores stale errors');
  // Every chunk remains attached to the original account even if the user reopens the center.
  const chunkAccounts=[];
  c.api=async(url,options)=>{chunkAccounts.push(options.accountId);vm.runInContext("todoCenterAccountId='c'; ++todoCenterRevision",c);return {updated:200};};
  await c.setTodoBatchStatus(Array.from({length:401},(_,i)=>i+1));
  assert.deepEqual(chunkAccounts,['b','b','b']);

  const host={dataset:{},innerHTML:'',querySelectorAll:()=>[]}; let scope='b'; let pending=deferred();
  const requests=[];
  const t=vm.createContext({taskPollActive:false,taskCenterReminders:[],taskCenterPollTimer:0,
    taskCenterScope:()=>scope,activeMailAccount:()=>({id:'a'}),_systemConfig:{accounts:[{id:'a',user:'A'},{id:'b',user:'B'}]},
    document:{getElementById:id=>id==='task-center-list'?host:{}},
    api:async(url,options)=>{requests.push([url,options.accountId]); if(url.includes('outbox')) return pending.promise; if(url.includes('reminders'))return [];return {};},
    esc:x=>x,mailaiT:()=>'',scheduleTaskCenterRefresh(){},clearTimeout,setTimeout,sessionStorage:{getItem:()=>true}});
  vm.runInContext(slice(workspace,'function actionableOutboxRows(', '\nfunction updateFilterChips'),t);
  const refresh=t.refreshTaskCenter(); pending.resolve([]);await refresh;
  assert.ok(requests.every(([,id])=>id==='b'),'Task requests use selected scope, not browsing account');
  assert.equal(host.dataset.accountId,'b'); assert.ok(host.innerHTML.includes('<b>B</b>'));
  pending=deferred();const stale=t.refreshTaskCenter();scope='a';host.innerHTML='new account loading';pending.reject(new Error('stale failure'));await stale;
  assert.equal(host.innerHTML,'new account loading','Old account failure must not replace new view');
  // A failed status source must not hide successfully loaded actions or imply health.
  for (const failure of ['/api/mail/outbox','/api/fetch_status','/api/reminders','/api/reminders/all','/api/trash/purge/status']) {
    const retryRequests=[];
    t.api=async(url)=>{
      retryRequests.push(url);
      if(url===failure) throw new Error('offline');
      if(url==='/api/mail/outbox') return [{token:'queued',subject:'待发送邮件',status:'queued'}];
      return url.includes('reminders') ? [] : {};
    };
    await t.refreshTaskCenter();
    assert.ok(host.innerHTML.includes('重新加载'));
    assert.ok(!host.innerHTML.includes('状态正常'));
    assert.ok(!host.innerHTML.includes('目前没有需要处理的任务'));
    if(failure!=='/api/mail/outbox') assert.ok(host.innerHTML.includes('data-cancel-queue="queued"'));
    retryRequests.length=0;
    await t.refreshTaskCenter({lightweight:true});
    assert.ok(retryRequests.includes('/api/reminders'),'Incomplete states must retry failed reminder reads');
  }
  t.api=async(url)=>url.includes('reminders') || url.includes('outbox') ? [] : {};
  await t.refreshTaskCenter();
  assert.ok(host.innerHTML.includes('状态正常'),'A successful retry can restore the healthy state');
  console.log('PASS tool account scopes, stale success/error responses, closed views and multi-chunk account isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
