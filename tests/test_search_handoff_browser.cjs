// Run against the isolated workspace fixture. Model responses are intercepted.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:18795');await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.locator('#email-list .email-item').first().waitFor();
  const account=await page.evaluate(()=>activeMailAccount().id);
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  const sent=[];
  await page.route('**/api/assistant/ask-stream',async route=>{
   sent.push({body:route.request().postDataJSON(),account:route.request().headers()['x-mailai-account']});
   await route.fulfill({contentType:'application/x-ndjson',body:[
    {type:'meta',conversation_id:42},{type:'sources',sources:[{id:1,subject:'采购合同交期确认',from_addr:'colleague@example.test'}]},
    {type:'delta',content:'这封邮件提到了合同交期，可以打开原邮件核对。[email_id:1]'},{type:'done'},
   ].map(event=>JSON.stringify(event)).join('\n')+'\n'});
  });
  const input=page.locator('#global-search');
  const query='上次说交期后来改了的那封邮件';
  await input.fill(query);
  assert.equal(await page.locator('[data-search-recover=assistant]').count(),0,'No AI suggestion while loading');
  await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await page.locator('#email-list .email-item').count(),0);
  assert.equal(sent.length,0,'No automatic AI request for an empty result');
  assert(await page.locator('[data-search-recover=broaden]').isVisible());
  const handoff=page.locator('[data-search-recover=assistant]');assert(await handoff.isVisible());
  assert.match(await page.locator('.search-empty-ai small').innerText(),/example\.test/);
  for(const [width,theme]of [[1440,'light'],[390,'dark']]){
   await page.setViewportSize({width,height:960});await page.evaluate(theme=>applyTheme(theme),theme);
   assert(await page.locator('#email-list').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Suggestions fit the mail column');
   await page.screenshot({path:`build/search-handoff-${process.env.MAILAI_BROWSER||'chromium'}-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{
   _systemConfig.model={..._systemConfig.model,available:true,verified:true};
   assistantPinnedScope=[2];selectedEmailId=2;assistantHistoryLoaded=false;
   document.getElementById('assistant-scope').value='filtered';
  });
  await handoff.click();await page.waitForFunction(()=>!assistantController&&document.getElementById('mail-assistant').dataset.answerComplete==='true');
  assert.equal(sent.length,1);assert.equal(sent[0].body.question,query);assert.equal(sent[0].body.search_mode,true);
  assert.equal(sent[0].body.email_ids,null);assert.equal(sent[0].account,account);
  assert.deepEqual(sent[0].body.history,[]);assert.equal(sent[0].body.alert_context,false);
  assert.equal(await input.inputValue(),query,'The original search remains available');
  assert.equal(await page.locator('#assistant-scope').inputValue(),'account');
  await page.locator('.assistant-sources summary').click();
  await page.locator('.assistant-source-list [data-email-id="1"]').click();
  await page.locator('#reading-content .reading-header').waitFor();
  assert.match(await page.locator('#reading-content').innerText(),/采购合同/);
  await page.locator('#assistant-panel').waitFor({state:'hidden'});
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  await input.fill(query);await page.waitForFunction(()=>mailSearchState.phase==='done');
  // Opening fallback search must not interrupt another assistant request.
  await page.evaluate(()=>{assistantController=new AbortController();window.testBusyController=assistantController;});
  await handoff.click();assert.equal(await page.evaluate(()=>testBusyController.signal.aborted),false);
  assert.equal(sent.length,1);await page.evaluate(()=>{assistantController=null;});
  // If setup is needed, retain the query and open the existing model setup.
  await page.evaluate(()=>{_systemConfig.model.available=false;window.testSetupOpened=false;window.mailOnboarding.openModel=()=>{window.testSetupOpened=true;};});
  await handoff.click();assert(await page.evaluate(()=>testSetupOpened));
  assert.equal(await page.locator('#assistant-input').inputValue(),query);assert.equal(sent.length,1);
  await page.locator('#assistant-close').click();
  await page.route('**/api/emails/search?*',async route=>{
   if(new URL(route.request().url()).searchParams.get('q')==='fixture-search-failure')return route.fulfill({status:503,json:{detail:'fixture unavailable'}});
   return route.continue();
  });
  await input.fill('fixture-search-failure');await page.waitForFunction(()=>mailSearchState.phase==='error');
  assert.equal(await handoff.count(),0,'A failed request must not claim there were no matches');
  assert(await page.locator('[data-search-recover=retry]').isVisible());
  await page.unroute('**/api/emails/search?*');
  await page.locator('[data-search-recover=retry]').click();await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert(await handoff.isVisible());
  assert.deepEqual(errors,[]);
  console.log('PASS local-only empty search, helpful recovery, explicit AI transfer, fresh account scope, source opening, busy/setup handling, failure vs empty states and narrow layout');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
