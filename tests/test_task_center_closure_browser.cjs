// Isolated fixture only: clicks real nested labels and verifies durable outcomes.
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
const engine = process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium;
(async()=>{
 const browser = await engine.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:18795/');
  await page.locator('#app-preloader').waitFor({state:'detached'});
  const accountId=await page.evaluate(()=>activeMailAccount().id);
  assert(await page.evaluate(()=>_systemConfig.accounts.every(row=>row.user.endsWith('@example.test'))));
  const read = token=>page.evaluate(async({token,accountId})=>(await api('/api/mail/outbox',{accountId})).find(row=>row.token===token),{token,accountId});
  async function queue(action) {
   return page.evaluate(async({action,accountId})=>{
    const payload={to_addr:'recipient@example.test',subject:'Closure '+action,body_html:'<p>Confirmed.</p>',attachments:[],send_at:new Date(Date.now()+86400000).toISOString()};
    const draft=await api('/api/drafts',{accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const token='closure-'+action+'-'+Date.now();
    await api('/api/mail/outbox',{accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,id:draft.id,expected_revision:draft.revision,request_token:token})});
    await openTaskCenter();
    return {token,draftId:draft.id};
   },{action,accountId});
  }
  let task=await queue('cancel');
  await page.locator(`[data-cancel-queue="${task.token}"] span`).click();
  await page.waitForFunction(async({token,accountId})=>(await api('/api/mail/outbox',{accountId})).find(row=>row.token===token)?.status==='canceled', {...task,accountId});
  await page.evaluate(()=>closeTaskCenter());
  task=await queue('edit');
  await page.locator(`[data-edit-queue="${task.token}"] span`).click();
  await page.waitForFunction(()=>document.body.classList.contains('compose-open'));
  assert.equal((await read(task.token)).status,'canceled');
  assert.equal(await page.locator('#compose-subject').inputValue(),'Closure edit');
  await page.evaluate(()=>closeCompose());
  task=await queue('time');
  await page.locator(`[data-time-queue="${task.token}"] span`).click();
  await page.locator('[data-outbox-time]').waitFor({state:'attached'});
  assert(await page.locator('[data-save-time]').isVisible());
  await page.keyboard.press('Escape');await page.evaluate(()=>closeTaskCenter());

  // Retry and reminder buttons are also nested spans in the task center.
  const retryId=await page.evaluate(async accountId=>(await api('/api/drafts',{accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to_addr:'retry@example.test',subject:'failed draft',body_html:'<p>retry</p>'})})).id,accountId);
  await page.route('**/api/mail/outbox',route=>route.request().method()==='GET'?route.fulfill({json:[{token:'failed',status:'failed',draft_id:retryId,subject:'failed draft'}]}):route.continue());
  await page.evaluate(()=>openTaskCenter());
  await page.locator(`[data-outbox-draft="${retryId}"] span`).click();
  await page.waitForFunction(()=>document.body.classList.contains('compose-open'));
  assert.equal(await page.locator('#compose-subject').inputValue(),'failed draft');
  await page.evaluate(()=>closeCompose());await page.unroute('**/api/mail/outbox');
  await page.evaluate(async accountId=>{
   const tasks=await api('/api/todos?include_done=true',{accountId});
   for(const task of tasks.filter(row=>row.email_id===1 && row.status==='done'))
    await api(`/api/todos/${task.id}/reopen`,{accountId,method:'POST'});
   await api('/api/emails/1/remind',{accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:new Date(Date.now()+86400000).toISOString()})});
   await openTaskCenter();
  },accountId);
  await page.locator('[data-reminder-dismiss="1"] span').click();
  await page.waitForFunction(async accountId=>!(await api('/api/reminders',{accountId})).some(row=>row.email_id===1),accountId);
  await page.evaluate(()=>closeTaskCenter());
  // Failure recovery uses the same delegated label clicks; only network IO is mocked.
  let retried=0;
  await page.route('**/api/fetch_status',r=>r.fulfill({json:{running:false,error:'fixture offline',operation:'poll'}}));
  await page.route('**/api/poll',r=>{retried++;return r.fulfill({json:{ok:true}})});
  await page.evaluate(()=>openTaskCenter());await page.locator('[data-sync-retry] span').click();
  assert.equal(retried,1);await page.evaluate(()=>closeTaskCenter());
  await page.unroute('**/api/fetch_status');await page.unroute('**/api/poll');

  // Feed a real persisted partial-send result through the actual worker route.
  const sent=await page.evaluate(async accountId=>{
   const payload={to_addr:'ok@example.test',cc_addr:'blocked@example.test',bcc_addr:'private@example.test',subject:'partial closure',body_html:'<p>Confirmed.</p>'};
   const result=await api('/api/mail/send',{accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   return {payload,recordId:result.sent_record_id};
  },accountId);
  assert(sent.recordId);
  let acknowledged=false;
  const warning='部分收件人被拒绝：blocked@example.test。其他收件人已被服务器接受，请勿向全部收件人重复发送。';
  const row=()=>({token:'partial-closure',status:'sent',subject:'partial closure',sent_record_id:sent.recordId,warning_acknowledged:acknowledged?1:0,result:JSON.stringify({sent_record_id:sent.recordId,refused_recipients:['blocked@example.test','private@example.test'],warning})});
  await page.route('**/api/mail/outbox',r=>r.fulfill({json:[row()]}));
  await page.route('**/api/mail/sent/'+sent.recordId,r=>r.fulfill({json:{...sent.payload,id:sent.recordId,status:'sent',error:warning}}));
  await page.route('**/api/mail/outbox/partial-closure/retry-draft',r=>r.fulfill({json:{...sent.payload,id:null,to_addr:'',cc_addr:'blocked@example.test',bcc_addr:'private@example.test',attachments:[]}}));
  await page.route('**/api/mail/outbox/partial-closure/acknowledge',r=>{acknowledged=true;return r.fulfill({json:{ok:true}})});
  await page.evaluate(()=>openTaskCenter());
  const partial=page.locator('[data-outbox-token="partial-closure"]');
  await partial.waitFor();assert.match(await partial.innerText(),/需处理/);assert.match(await partial.innerText(),/blocked@example.test/);
  await page.evaluate(()=>setI18nLanguage('en'));
  await page.waitForFunction(()=>document.querySelector('[data-outbox-ack]')?.textContent.includes('Mark as handled'));
  assert.match(await partial.innerText(),/Needs attention/);
  assert.match(await page.locator('[data-outbox-refused]').innerText(),/Retry refused recipients only/);
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  assert.match(await page.locator('#btn-task-center').getAttribute('title'),/需处理/);
  await partial.locator('[data-outbox-sent] span').click();
  await page.waitForFunction(()=>document.getElementById('reading-content').textContent.includes('部分收件人被拒绝'));
  await page.evaluate(()=>openTaskCenter());
  await page.locator('[data-outbox-refused]').click();
  // An existing draft may still be saving as the replacement opens. Wait for
  // the requested draft, not merely the old composer's visible state.
  await page.waitForFunction(()=>document.body.classList.contains('compose-open') && document.getElementById('compose-subject').value==='partial closure');
  assert.equal(await page.locator('#compose-to').inputValue(),'');
  assert.equal(await page.locator('#compose-cc').inputValue(),'blocked@example.test');
  assert.equal(await page.locator('#compose-bcc').inputValue(),'private@example.test');
  await page.evaluate(()=>closeCompose());await page.evaluate(()=>openTaskCenter());
  await page.locator('[data-outbox-ack]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-outbox-token="partial-closure"]'));
  assert(acknowledged);
  assert.deepEqual(errors,[]);
  console.log('PASS nested task actions, canceled send/edit, schedule entry, failure recovery, reminder dismissal, persistent delivery warning, refused-only draft and acknowledgement');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
