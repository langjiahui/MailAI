// Isolated fixture: query intent, explicit account choice and cross-account search.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium;
 const browser=await engine.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors=[],sent=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/assistant/ask-stream',async route=>{
   sent.push({body:route.request().postDataJSON(),account:route.request().headers()['x-mailai-account']});
   return route.fulfill({contentType:'application/x-ndjson',body:[{type:'meta',conversation_id:42},{type:'sources',sources:[]},{type:'delta',content:'fixture'},{type:'done'}].map(row=>JSON.stringify(row)).join('\n')+'\n'});
  });
  await page.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'hidden'});await page.evaluate(()=>initialLoad);await page.evaluate(()=>openUnifiedInbox());
  const accounts=await page.evaluate(()=>_systemConfig.accounts.map(a=>({id:a.id,user:a.user})));
  assert(accounts.length>=2);
  // The exact command from the report must become one sender condition.
  const query='找到发件人是项目同事的邮件';
  await page.locator('#global-search').fill(query);await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await page.evaluate(()=>mailSearchState.parsed.criteria.sender),'项目同事');
  assert.equal(await page.locator('#email-list .email-item').count(),24,'Unified search must include both accounts');
  assert.equal(sent.length,0,'Fast field search must not call a model');
  await page.evaluate(()=>{_systemConfig.model={..._systemConfig.model,available:true,verified:true};});
  const helper=page.locator('#search-ai-assist');await helper.click();
  const dialog=page.locator('.assistant-search-scope');await dialog.waitFor({state:'visible'});
  assert.equal(sent.length,0,'Unified search must not silently fall back to the active account');
  assert.equal(await dialog.locator('select').inputValue(),'','No account is selected by default');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(sent.length,0);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'search-ai-assist');
  // All-account continuation retains the exact query and submits the real search.
  await helper.click();await dialog.locator('[data-search-scope-all]').click();
  await page.locator('.productivity-result').first().waitFor();
  assert(await page.locator('#productivity-all-accounts').isChecked());
  assert.equal(await page.locator('[data-criterion=mailbox]').inputValue(),'inbox','All-inbox continuation preserves the original folder scope');
  assert.equal(await page.locator('[data-criterion=query]').inputValue(),query);
  assert.equal(await page.locator('.productivity-result').count(),24);
  await page.locator('[data-close-productivity]').click();
  // Narrow, enlarged and bilingual scope controls fit without hiding the choice.
  for(const language of ['zh-CN','en']){
   await page.evaluate(language=>setI18nLanguage(language),language);
   await helper.click();await page.setViewportSize({width:390,height:844});
   await page.evaluate(()=>{document.body.style.zoom=1.3;document.documentElement.style.setProperty('--fz','1.3');applyTheme('dark');});
   assert(await dialog.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1;}));
   await dialog.locator('[data-search-scope-cancel]').click();
   await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>{document.body.style.zoom=1;document.documentElement.style.setProperty('--fz','1');});
  }
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  // A removed account and a failed activation preserve the scope choice and
  // never issue an AI request against whichever account happens to be active.
  await helper.click();await dialog.locator('select').selectOption(accounts[1].id);
  await page.evaluate(id=>{window.scopeOriginalAccounts=_systemConfig.accounts;_systemConfig.accounts=_systemConfig.accounts.filter(a=>a.id!==id);},accounts[1].id);
  await dialog.locator('[data-search-scope-submit]').click();await dialog.locator('[role=alert]').waitFor({state:'visible'});
  assert.equal(sent.length,0);await page.evaluate(()=>{_systemConfig.accounts=scopeOriginalAccounts;delete window.scopeOriginalAccounts;});
  await dialog.locator('[data-search-scope-cancel]').click();
  const other=await page.evaluate(()=>_systemConfig.accounts.find(a=>a.id!==activeMailAccount().id).id);
  await helper.click();await dialog.locator('select').selectOption(other);
  await page.route('**/api/system/mail/preferred',route=>route.fulfill({status:503,json:{detail:'fixture account temporarily unavailable'}}));
  await dialog.locator('[data-search-scope-submit]').click();await dialog.locator('[role=alert]').waitFor({state:'visible'});
  assert.equal(sent.length,0);assert.equal(await page.evaluate(()=>unifiedMailbox),true);
  assert(await dialog.locator('[data-search-scope-submit]').isEnabled());
  await page.unroute('**/api/system/mail/preferred');await dialog.locator('[data-search-scope-cancel]').click();
  // Choosing another account visibly changes folder before sending the AI request.
  await helper.click();await dialog.locator('select').selectOption(accounts[0].id);
  await dialog.locator('[data-search-scope-submit]').click();
  await page.waitForFunction(()=>!assistantController&&document.getElementById('mail-assistant').dataset.answerComplete==='true');
  assert.equal(sent.length,1);assert.equal(sent[0].account,accounts[0].id);
  assert.equal(sent[0].body.question,query);assert.equal(sent[0].body.search_mode,true);
  assert.equal(await page.evaluate(()=>unifiedMailbox),false);
  assert.equal(await page.evaluate(()=>activeMailAccount().id),accounts[0].id);
  assert.deepEqual(errors,[]);
  console.log('PASS exact sender command, unified matches, no silent account narrowing, cancellation/focus, all-account continuation and explicit AI account handoff, bilingual narrow/130% layout');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
