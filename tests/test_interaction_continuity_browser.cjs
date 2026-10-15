// Temporary workspace fixture only; exercise polling, delayed saves and nested modals.
const assert = require('node:assert/strict');
const {chromium,webkit} = require('playwright');
const engine = process.env.MAILAI_BROWSER==='webkit' ? webkit : chromium;
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function awaitStart(gate, label) {
 let timer;
 try {await Promise.race([gate.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Request did not start: '+label)),15000);})]);}
 finally {clearTimeout(timer);}
}
(async()=>{
 const browser=await engine.launch({headless:true});
 const errors=[];
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18795/');await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  assert(await page.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
  const accountId=await page.evaluate(()=>activeMailAccount().id);
  const due=new Date(Date.now()+86400000).toISOString();
  let rows=Array.from({length:24},(_,i)=>({token:'continuity-'+i,status:'queued',subject:'Task '+i,to_addr:'recipient@example.test',due_at:due}));
  let actionError='Temporary error';
  await page.route('**/api/mail/outbox',r=>r.fulfill({json:rows}));
  await page.route('**/api/fetch_status',r=>r.fulfill({json:{running:false}}));
  await page.route('**/api/mail/action-sync*',r=>r.fulfill({json:{total:1,rows:[{id:1,subject:'Retry details',pending_error:actionError,pending_attempts:1}]}}));
  await page.evaluate(()=>openTaskCenter());
  const cancel=page.locator('[data-cancel-queue="continuity-0"]');
  await cancel.focus();
  await page.evaluate(()=>{window.uxFocus=document.activeElement;window.uxRow=document.activeElement.closest('[data-task-row]');document.querySelector('[data-task-row="action:1"] details').open=true;document.getElementById('task-center-list').scrollTop=150;});
  await page.evaluate(()=>refreshTaskCenter({lightweight:true}));
  assert(await page.evaluate(()=>document.activeElement===window.uxFocus && window.uxFocus.closest('[data-task-row]')===window.uxRow));
  // Updating another row must not destroy the control the user is working on.
  rows[1].subject='Changed by background job';actionError='Updated error';
  await page.evaluate(()=>refreshTaskCenter({lightweight:true}));
  assert(await page.evaluate(()=>document.activeElement===window.uxFocus));
  assert(await page.locator('[data-task-row="action:1"] details').evaluate(n=>n.open));
  assert.equal(await page.locator('#task-center-list').evaluate(n=>n.scrollTop),150);
  // Updating the focused row restores focus to its corresponding new action.
  rows[0].subject='Updated focused task';
  await page.evaluate(()=>refreshTaskCenter({lightweight:true}));
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.cancelQueue),'continuity-0');
  const started=deferred(),release=deferred();let cancelCalls=0;
  await page.route('**/api/mail/outbox/continuity-0/cancel',async r=>{cancelCalls++;started.resolve();await release.promise;await r.fulfill({status:503,json:{detail:'Fixture cancellation failed'}});});
  await page.locator('[data-cancel-queue="continuity-0"] span').click();await awaitStart(started,'started');
  rows[0].subject='Status changed during cancellation';
  await page.evaluate(()=>refreshTaskCenter({lightweight:true}));
  assert(await page.locator('[data-task-row="outbox:continuity-0"] button').evaluateAll(nodes=>nodes.every(n=>n.disabled)));
  await page.locator('[data-cancel-queue="continuity-0"] span').evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(cancelCalls,1);
  release.resolve();await page.waitForFunction(()=>!document.querySelector('[data-cancel-queue="continuity-0"]').disabled);
  assert.match(await page.locator('#toast').innerText(),/Fixture cancellation failed/);
  const syncStarted=deferred(),syncRelease=deferred();let syncCalls=0;
  await page.route('**/api/mail/action-sync/1/retry',async r=>{syncCalls++;syncStarted.resolve();await syncRelease.promise;await r.fulfill({status:503,json:{detail:'Fixture sync failed'}});});
  await page.locator('[data-action-sync-retry="1"]').click();await awaitStart(syncStarted,'syncStarted');
  actionError='Changed during retry';await page.evaluate(()=>refreshTaskCenter({lightweight:true}));
  assert(await page.locator('[data-task-row="action:1"] button').evaluateAll(nodes=>nodes.every(n=>n.disabled)));
  await page.locator('[data-action-sync-retry="1"]').evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(syncCalls,1);syncRelease.resolve();
  await page.waitForFunction(()=>!document.querySelector('[data-action-sync-retry="1"]').disabled);
  await page.evaluate(()=>closeTaskCenter());

  rows=[{token:'uncertain',status:'unknown',subject:'待核对的合同回复',to_addr:'recipient@example.test'}];
  let nativeDialogs=0,resolved=0;
  page.on('dialog',d=>{nativeDialogs++;d.dismiss();});
  await page.route('**/api/mail/outbox/uncertain/resolve*',r=>{resolved++;rows=[];return r.fulfill({json:{ok:true}});});
  await page.evaluate(()=>openTaskCenter());
  await page.locator('[data-resolve-send="uncertain:true"]').click();
  const question=page.locator('.mailai-question:open');await question.waitFor();
  assert.match(await question.innerText(),/待核对的合同回复/);
  if(engine===chromium)await page.screenshot({path:'build/ux-delivery-confirm.png'});
  await page.keyboard.press('Escape');await question.waitFor({state:'detached'});
  assert(await page.locator('#task-center').isVisible());assert.equal(resolved,0);
  await page.locator('[data-resolve-send="uncertain:true"]').click();
  await page.locator('.mailai-question [data-confirm]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-outbox-token="uncertain"]'));
  assert.equal(resolved,1);assert.equal(nativeDialogs,0);
  await page.evaluate(()=>closeTaskCenter());
  console.log('PASS polling preserves row identity, details, focus and scroll; pending actions survive redraw; modal Escape and outcome confirmation');
  // Changing task account while a draft loads must keep the new view in place.
  const draftStarted=deferred(),draftRelease=deferred();
  rows=[{token:'late-draft',status:'failed',draft_id:900,subject:'Old account draft'}];
  await page.route('**/api/drafts/900',async r=>{draftStarted.resolve();await draftRelease.promise;await r.fulfill({json:{id:900,subject:'Old account draft',body_html:'<p>old</p>'}});});
  await page.evaluate(()=>openTaskCenter());await page.locator('[data-outbox-draft="900"] span').click();await awaitStart(draftStarted,'draftStarted');
  const otherAccount=await page.evaluate(id=>_systemConfig.accounts.find(a=>a.id!==id).id,accountId);
  await page.locator('#task-center-account').selectOption(otherAccount);
  draftRelease.resolve();await page.waitForTimeout(200);
  assert(await page.locator('#task-center').isVisible());assert.equal(await page.locator('#task-center-account').inputValue(),otherAccount);
  assert(!(await page.evaluate(()=>document.body.classList.contains('compose-open'))));
  await page.evaluate(()=>closeTaskCenter());
  console.log('PASS late draft response cannot reopen the old account or close the newer task view');
  await page.unroute('**/api/mail/outbox');await page.unroute('**/api/fetch_status');await page.unroute('**/api/mail/action-sync*');


  const todoId=await page.evaluate(async accountId=>(await api('/api/todos?include_done=true',{accountId}))[0].id,accountId);
  await page.evaluate(({todoId,accountId})=>openTaskPlanner({todoId,accountId}),{todoId,accountId});
  const saveStarted=deferred(),saveRelease=deferred();let saves=0;
  await page.route('**/api/todos/'+todoId,async r=>{
   if(r.request().method()!=='PATCH')return r.continue();
   saves++;if(saves===1){saveStarted.resolve();await saveRelease.promise;}
   const result=await r.fetch();await r.fulfill({response:result});
  });
  await page.locator('#plan-title').fill('First save');await page.locator('#plan-save').click();await awaitStart(saveStarted,'saveStarted');
  await page.locator('#plan-title').fill('New edit during saving');
  await page.locator('#task-planner form').evaluate(n=>n.requestSubmit());assert.equal(saves,1);
  saveRelease.resolve();await page.waitForFunction(()=>!document.getElementById('plan-save').disabled);
  assert(await page.locator('#task-planner').isVisible());assert.equal(await page.locator('#plan-title').inputValue(),'New edit during saving');
  assert.match(await page.locator('#plan-error').innerText(),/当前编辑内容仍保留/);
  await page.locator('#plan-save').click();await page.waitForFunction(()=>!document.getElementById('task-planner').open);
  assert.equal(saves,2);
  assert.equal(await page.evaluate(async({todoId,accountId})=>(await api('/api/todos?include_done=true',{accountId})).find(row=>row.id===todoId).title,{todoId,accountId}),'New edit during saving');
  console.log('PASS delayed task save keeps newer input, rejects duplicate submit and allows saving the remaining edits');
  // A delayed first creation must become an edit of the same row on the next save.
  const createEmailId=2;
  const createStarted=deferred(),createRelease=deferred();let creations=0;
  await page.route('**/api/emails/'+createEmailId+'/todo',async r=>{creations++;createStarted.resolve();await createRelease.promise;const response=await r.fetch();await r.fulfill({response});});
  await page.evaluate(({emailId,accountId})=>openTaskPlanner({emailId,accountId}),{emailId:createEmailId,accountId});
  await page.locator('#plan-title').fill('First created task');await page.locator('#plan-save').click();await awaitStart(createStarted,'createStarted');
  await page.locator('#plan-title').fill('Updated new task');createRelease.resolve();
  await page.waitForFunction(()=>!document.getElementById('plan-save').disabled);
  assert(await page.locator('#task-planner').isVisible());
  await page.locator('#plan-save').click();await page.waitForFunction(()=>!document.getElementById('task-planner').open);
  assert.equal(creations,1);
  const created=await page.evaluate(async({emailId,accountId})=>(await api('/api/todos?include_done=true',{accountId})).filter(row=>row.email_id===emailId),{emailId:createEmailId,accountId});
  assert.equal(created.length,1);assert.equal(created[0].title,'Updated new task');
  // A response for a closed task must not repaint a different task editor.
  await page.evaluate(async({todoId,accountId})=>{await api(`/api/todos/${todoId}/done`,{accountId,method:'POST'});await openTaskPlanner({todoId,accountId});},{todoId,accountId});
  const reopenStarted=deferred(),reopenRelease=deferred();
  await page.route('**/api/todos/'+todoId+'/reopen',async r=>{reopenStarted.resolve();await reopenRelease.promise;const response=await r.fetch();await r.fulfill({response});});
  await page.locator('#plan-reopen').click();await awaitStart(reopenStarted,'reopenStarted');
  await page.locator('#task-planner [data-plan-close]').first().click();
  await page.evaluate(({todoId,accountId})=>openTaskPlanner({todoId,accountId}),{todoId:created[0].id,accountId});
  assert.equal(await page.locator('#plan-title').inputValue(),'Updated new task');
  reopenRelease.resolve();await page.waitForTimeout(200);
  assert.equal(await page.locator('#plan-title').inputValue(),'Updated new task');
  assert.equal(await page.locator('#plan-save').getAttribute('aria-busy'),null);
  await page.keyboard.press('Escape');
  console.log('PASS delayed task creation reuses one row; late reopen cannot overwrite a different editor');


  await page.evaluate(async accountId=>{await openAccountMailbox(accountId,'inbox');await selectEmail(1);},accountId);
  const restoreStarted=deferred(),restoreRelease=deferred();let restores=0;
  await page.route('**/api/emails/1/restore',async r=>{restores++;restoreStarted.resolve();await restoreRelease.promise;await r.fulfill({status:503,json:{detail:'Fixture restore failed'}});});
  await page.evaluate(()=>{
   const b=document.createElement('button');b.type='button';b.id='ux-restore';b.textContent='Restore test';
   b.onclick=()=>restoreEmail(1,b);document.getElementById('reading-content').append(b);
  });
  await page.locator('#ux-restore').click();await awaitStart(restoreStarted,'restoreStarted');
  assert(await page.locator('#ux-restore').isDisabled());assert.equal(await page.locator('#ux-restore').getAttribute('aria-busy'),'true');
  await page.evaluate(()=>restoreEmail(1,document.getElementById('ux-restore')));assert.equal(restores,1);
  restoreRelease.resolve();await page.waitForFunction(()=>!document.getElementById('ux-restore').disabled);
  assert.match(await page.locator('#toast').innerText(),/恢复未完成/);assert(await page.locator('#reading-content .body-section').isVisible());
  await page.unroute('**/api/emails/1/restore');
  const lateStarted=deferred(),lateRelease=deferred();
  await page.route('**/api/emails/1/restore',async r=>{lateStarted.resolve();await lateRelease.promise;await r.fulfill({json:{ok:true}});});
  await page.locator('#ux-restore').click();await awaitStart(lateStarted,'lateStarted');
  await page.evaluate(()=>selectEmail(2));
  lateRelease.resolve();await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>selectedEmailId),2);assert(await page.locator('#reading-content .body-section').isVisible());
  assert.deepEqual(errors,[]);
  console.log('PASS restoring mail shows progress, retains reading on failure, supports retry and cannot clear a newer reading selection');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
