// Isolated workspace_preview.py only; model output is a locally controlled stream.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.locator('#email-list .email-item').first().waitFor();
  await page.evaluate(()=>setI18nLanguage(I18N_DEFAULT_LANG));
  assert((await page.evaluate(()=>api('/api/system/config'))).accounts.every(a=>a.user.endsWith('@example.test')));
  await page.locator('#email-list .email-item').first().click();
  await page.locator('#assistant-orb').click();
  await page.evaluate(()=>{
   resetAssistantConversation();_systemConfig.model={..._systemConfig.model,available:true,verified:true};
   const fetchOriginal=window.fetch;
   window.fetch=(url,options)=>{
    if(!String(url).endsWith('/api/assistant/ask-stream'))return fetchOriginal(url,options);
    return Promise.resolve(new Response(new ReadableStream({start(controller){
     const emit=event=>controller.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n'));
     window.fixtureAssistantStream={emit,finish(){emit({type:'done'});controller.close();}};
     options.signal.addEventListener('abort',()=>{try{controller.error(new DOMException('Stopped','AbortError'));}catch{}},{once:true});
     emit({type:'meta',conversation_id:90001});emit({type:'sources',sources:[]});
     emit({type:'status',state:'searching',message:'正在检索邮件…',message_en:'Searching mail…'});
    }}),{headers:{'Content-Type':'application/x-ndjson'}}));
   };
   askAssistant('请汇总项目安排');
  });
  await page.locator('.assistant-progress-copy b').filter({hasText:'正在检索邮件'}).waitFor();
  await page.evaluate(()=>fixtureAssistantStream.emit({type:'delta',content:Array.from({length:45},(_,i)=>`第 ${i+1} 项：确认项目交付安排，并保留采购评审记录。`).join('\n\n')}));
  await page.waitForFunction(()=>{const h=document.getElementById('assistant-messages');return h.scrollHeight>h.clientHeight*2;});
  const distance=()=>page.locator('#assistant-messages').evaluate(h=>h.scrollHeight-h.clientHeight-h.scrollTop);
  await page.waitForFunction(()=>mailaiAssistantScroll.isFollowing());
  assert(await distance()<25,'Live output follows to the end');
  await page.locator('#assistant-messages').evaluate(h=>{h.scrollTop=h.scrollHeight*.25;});
  await page.waitForFunction(()=>!mailaiAssistantScroll.isFollowing());
  const held=await page.locator('#assistant-messages').evaluate(h=>h.scrollTop);
  await page.evaluate(()=>fixtureAssistantStream.emit({type:'delta',content:'\n\n后续内容。'.repeat(50)}));
  await page.waitForFunction(()=>document.querySelector('.assistant-answer').textContent.includes('后续内容'));
  assert(Math.abs(await page.locator('#assistant-messages').evaluate(h=>h.scrollTop)-held)<2,'Streaming preserves the reading position');
  await page.locator('#assistant-jump-latest').waitFor();
  await page.evaluate(()=>fixtureAssistantStream.finish());
  await page.waitForFunction(()=>!assistantController);
  assert(Math.abs(await page.locator('#assistant-messages').evaluate(h=>h.scrollTop)-held)<2,'Completion does not pull the reader away');
  await page.locator('#assistant-jump-latest').click();
  assert(await distance()<25);assert.equal(await page.locator('#assistant-jump-latest').isVisible(),false);
  assert.equal(await page.locator('#assistant-messages').evaluate(h=>h===document.activeElement),true);
  // Keyboard scrolling releases live following; the same control works at zoom.
  await page.locator('#assistant-messages').press('Home');
  await page.locator('#assistant-jump-latest').waitFor();
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.match(await page.locator('#assistant-jump-latest').innerText(),/Jump to latest/);
  await page.evaluate(()=>setI18nLanguage(I18N_DEFAULT_LANG));
  for(const [width,theme,scale]of [[1440,'light',1],[390,'dark',1.2]]){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(({theme,scale})=>{applyTheme(theme);document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',String(scale));},{theme,scale});
   assert(await page.locator('#assistant-jump-latest').evaluate(button=>{const b=button.getBoundingClientRect(),p=document.getElementById('assistant-panel').getBoundingClientRect();return b.left>=p.left&&b.right<=p.right&&b.bottom<=p.bottom;}));
   await page.screenshot({path:`build/assistant-feedback-${process.env.MAILAI_BROWSER||'chromium'}-${width}.png`});
  }
  await page.locator('[data-secretary-view=briefing]').click();
  assert.equal(await page.locator('#assistant-jump-latest').isVisible(),false);
  await page.locator('[data-secretary-view=chat]').click();
  await page.evaluate(()=>{resetAssistantConversation();askAssistant('继续核对');});
  await page.locator('#assistant-stop').waitFor();
  await page.evaluate(()=>fixtureAssistantStream.emit({type:'delta',content:'这部分已完成核对。'}));
  await page.locator('.assistant-answer').filter({hasText:'这部分已完成核对'}).waitFor();
  await page.locator('#assistant-stop').click();
  await page.waitForFunction(()=>!assistantController);
  assert.match(await page.locator('.assistant-bubble').last().innerText(),/这部分已完成核对[\s\S]*已停止/);
  await page.locator('#assistant-new').click();
  assert.equal(await page.locator('#assistant-jump-latest').isVisible(),false);
  // Action notices keep their controls available while focused or hovered.
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>{document.body.style.zoom=1;document.documentElement.style.setProperty('--fz','1');closeAssistant();
   window.fixtureActionCalls=0;
   taskNotice('Fixture action','Run',()=>{fixtureActionCalls++;return new Promise(resolve=>{window.fixtureActionFinish=()=>{taskNotice('Fixture completed','',null,1500);resolve();};});},250);
   // Establish focus before the deliberately short lifetime can elapse between
   // browser RPCs on a busy runner. The following wait still exceeds that lifetime.
   document.querySelector('#workspace-notice button').focus();
  });
  const notice=page.locator('#workspace-notice');
  assert(await notice.locator('button').first().evaluate(button=>button===document.activeElement));
  await page.waitForTimeout(450);
  assert(await notice.isVisible(),'A focused action must not time out');
  await notice.locator('button').first().press('Enter');
  assert.equal(await notice.locator('[aria-busy=true]').count(),1);
  assert(await notice.locator('[aria-busy=true]').evaluate(button=>button===document.activeElement),'The pending action retains keyboard focus');
  assert.match(await notice.innerText(),/正在处理/);
  await page.evaluate(()=>document.querySelector('#workspace-notice button').click());
  assert.equal(await page.evaluate(()=>fixtureActionCalls),1,'Pending actions cannot be submitted twice');
  await page.evaluate(()=>fixtureActionFinish());
  assert.match(await notice.innerText(),/Fixture completed/);
  assert.equal(await notice.locator('[aria-busy=true]').count(),0);
  await page.evaluate(()=>{fixtureActionCalls=0;taskNotice('Fixture failure','Retry',async()=>{if(++fixtureActionCalls===1)throw new Error('fixture unavailable');taskNotice('Fixture recovered');});});
  await notice.locator('button').first().focus();await notice.locator('button').first().press('Enter');
  await page.waitForFunction(()=>document.getElementById('workspace-notice').dataset.state==='error');
  assert.match(await notice.innerText(),/fixture unavailable/);
  assert.equal(await notice.locator('button').first().isEnabled(),true);
  assert(await notice.locator('button').first().evaluate(button=>button===document.activeElement),'Failed actions keep focus for retry');
  await notice.locator('button').first().click();
  assert.match(await notice.innerText(),/Fixture recovered/);
  // A late action result cannot overwrite a newer notification.
  await page.evaluate(()=>taskNotice('Old action','Run',()=>new Promise((_,reject)=>window.fixtureRejectOld=reject)));
  await notice.locator('button').first().click();
  await page.evaluate(()=>{taskNotice('New operation');fixtureRejectOld(new Error('old failure'));});
  assert.match(await notice.innerText(),/New operation/);
  await page.locator('#global-search').focus();
  await page.evaluate(()=>taskNotice('Hover keeps this visible','',null,0));
  await notice.hover();await page.waitForTimeout(450);
  await page.evaluate(()=>{const host=document.getElementById('workspace-notice');host._remaining=250;scheduleTaskNotice(host);});
  await page.waitForTimeout(450);
  assert(await notice.isVisible(),'Hover pauses the dismissal timer');
  await page.mouse.move(5,5);await notice.waitFor({state:'hidden'});
  // Save a real synthetic task: pending/failure preserve the form; success
  // offers a direct route to the saved task without a second create request.
  await page.evaluate(async()=>{
   const tasks=await api('/api/todos?include_done=true');
   const rows=await api('/api/emails?limit=20');
   const email=rows.find(row=>!tasks.some(task=>task.email_id===row.id));
   await openTaskPlanner({emailId:email.id,title:'交互验证任务'});
  });
  await page.locator('#task-planner').waitFor();
  await page.locator('#plan-title').fill('交互验证任务');
  let releaseSave,signalSave;
  const saving=new Promise(resolve=>signalSave=resolve);
  await page.route('**/api/emails/*/todo',async route=>{
   const pending=new Promise(resolve=>releaseSave=resolve);signalSave();await pending;
   await route.fulfill({status:503,json:{detail:'fixture task unavailable'}});
  });
  await page.locator('#plan-save').click();await saving;
  assert.equal(await page.locator('#plan-save').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('#plan-save').isDisabled(),true);
  releaseSave();await page.locator('#plan-error').filter({hasText:'fixture task unavailable'}).waitFor();
  assert.equal(await page.locator('#plan-title').inputValue(),'交互验证任务');
  await page.unroute('**/api/emails/*/todo');
  await page.locator('#plan-save').click();await page.locator('#task-planner').waitFor({state:'hidden'});
  assert.match(await notice.innerText(),/任务已保存/);
  await notice.getByRole('button',{name:'查看待办',exact:true}).click();
  await page.locator('#todo-center').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('#todo-list .todo-title-input')].some(input=>input.value==='交互验证任务'));
  assert.deepEqual(errors,[]);
  console.log('PASS live follow, reader pause, keyboard/jump, stop/reset, narrow/zoom, localized controls, action feedback/retry and stale completion isolation');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
