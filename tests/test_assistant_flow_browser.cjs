// MAILAI_SEARCH_FIXTURE=1 workspace_preview.py; synthetic model/mail only.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium,browser=await engine.launch();
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],writes=[];
  await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  p.on('pageerror',e=>errors.push(e.message));
  p.on('request',r=>{if(r.url().endsWith('/api/assistant/actions/execute'))writes.push(r);});
  await p.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18797');await p.locator('#app-preloader').waitFor({state:'detached'});
  await p.evaluate(()=>{
   window.__flowEvents=[];const original=window.fetch;
   window.fetch=async(...args)=>{const response=await original(...args);
    if(!String(args[0]).endsWith('/api/assistant/ask-stream'))return response;
    let text='';const decoder=new TextDecoder();
    const recorder=new TransformStream({transform(chunk,controller){text+=decoder.decode(chunk,{stream:true});controller.enqueue(chunk);},flush(){text+=decoder.decode();window.__flowEvents.push(text.trim().split('\n').map(s=>JSON.parse(s)));}});
    return new Response(response.body.pipeThrough(recorder),{status:response.status,headers:response.headers});
   };
  });
  const account=await p.evaluate(()=>_systemConfig.accounts[0].id);
  await p.evaluate(async id=>{await openAccountMailbox(id,'inbox');_systemConfig.model={..._systemConfig.model,available:true,verified:true};resetAssistantConversation({focus:false});openAssistant();},account);
  async function ask(question){
   const before=await p.evaluate(()=>window.__flowEvents.length);
   await p.locator('#assistant-input').fill(question);await p.locator('#assistant-send').click();
   await p.waitForFunction(before=>window.__flowEvents.length>before,before);
   const events=await p.evaluate(()=>window.__flowEvents.at(-1));
   await p.waitForFunction(()=>!assistantController&&document.getElementById('mail-assistant').dataset.answerComplete==='true');
   assert(!events.some(e=>e.type==='error'),JSON.stringify(events));
   return events;
  }
  const ids=events=>events.find(e=>e.type==='sources').sources.map(s=>s.id);
  const initial=await ask('找检索同事最近一周的闭环合同');
  const found=ids(initial),conv=await p.evaluate(()=>assistantConversationId);
  assert.equal(found.length,20);assert(initial.some(e=>e.type==='search'));
  assert.equal(await p.evaluate(()=>assistantSearchMode),true);
  assert.equal(await p.locator('.assistant-search-result').count(),1,'New natural searches still get search controls');
  for(const question of ['总结一下这些邮件','那我需要做什么？','列成待办','再说简单点','用三句话总结']){
   const events=await ask(question);
   assert.deepEqual(ids(events),found,question);
   assert(!events.some(e=>['search','action'].includes(e.type)),question);
   assert.equal(await p.evaluate(()=>assistantConversationId),conv,'Follow-ups stay in the same conversation');
   assert.equal(await p.evaluate(()=>assistantSearchMode),false);
   assert.deepEqual(await p.evaluate(()=>assistantPinnedScope),found);
  }
  const second=await ask('第二封要我做什么？');assert.deepEqual(ids(second),[found[1]]);
  // The reading pane wins over an older automatically pinned mail.
  await p.locator('#email-list .email-item').filter({hasText:'部门培训通知'}).first().click();
  await p.waitForFunction(()=>selectedEmailDetail?.subject==='部门培训通知');
  const opened=await p.evaluate(()=>selectedEmailId);
  const current=await ask('总结这封邮件');assert.deepEqual(ids(current),[opened]);
  assert.deepEqual(await p.evaluate(()=>assistantPinnedScope),[opened]);
  await p.setViewportSize({width:1920,height:1080});
  await p.locator('#email-list .email-item:visible').filter({hasText:'采购合同交期确认'}).first().click();
  await p.waitForFunction(()=>selectedEmailDetail?.subject==='采购合同交期确认');
  const switched=await p.evaluate(()=>selectedEmailId);
  const bare=await ask('那我需要做什么？');assert.deepEqual(ids(bare),[switched]);
  assert.deepEqual(await p.evaluate(()=>assistantPinnedScope),[switched]);
  assert.equal(await p.evaluate(()=>assistantConversationId),conv,'Opening another mail keeps the chat, and changes only its evidence scope');
  const todo=await ask('我今天要干啥？');
  assert(todo.some(e=>e.type==='delta'&&e.content.includes('确认合同交期')));
  assert.equal(await p.evaluate(()=>assistantPinnedScope),null,'Saved task list clears the old mail scope');
  const again=await ask('换个话题，找一下检索同事最近一周的闭环合同');
  assert(again.some(e=>e.type==='search'));assert.equal(ids(again).length,20);
  await p.evaluate(()=>{resetAssistantConversation({focus:false});resetReadingPane();});
  const missing=await ask('那我需要做什么？');
  assert.deepEqual(ids(missing),[]);assert(missing.some(e=>e.type==='delta'&&e.content.includes('先打开一封邮件')));
  assert.equal(writes.length,0);assert.deepEqual(errors,[]);
  console.log(`PASS ${engine.name()}: natural search -> same-source summary -> tasks -> shorter answer -> ordinal/current mail -> saved todos -> new search; same conversation and no writes`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
