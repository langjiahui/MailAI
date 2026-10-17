// MAILAI_SEARCH_FIXTURE=1 tests/workspace_preview.py: real routes, synthetic model/mail.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],requests=[];
  await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().endsWith('/api/assistant/ask-stream'))requests.push(r.postDataJSON());});
  await page.goto(process.env.MAILAI_FIXTURE_URL || 'http://127.0.0.1:18795');await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.locator('#email-list .email-item').first().waitFor();
  await page.evaluate(()=>setI18nLanguage(I18N_DEFAULT_LANG));
  const account=await page.evaluate(()=>_systemConfig.accounts[0].id);
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  await page.evaluate(()=>{_systemConfig.model={..._systemConfig.model,available:true,verified:true};});
  const input=page.locator('#global-search');
  await input.fill('闭环合同');await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert(await page.locator('#search-ai-assist').isVisible(),'AI discovery also works when literal results are not useful');
  await input.fill('找检索同事最近一周的闭环合同');await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(requests.length,0);assert(await page.locator('.search-empty-ai>b').isVisible());
  await page.screenshot({path:`build/search-loop-entry-${process.env.MAILAI_BROWSER||'chromium'}.png`});
  await page.setViewportSize({width:390,height:1000});
  assert(await page.locator('.search-empty-ai').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await page.screenshot({path:`build/search-loop-entry-${process.env.MAILAI_BROWSER||'chromium'}-390.png`});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-search-recover=assistant]').click();
  const last=()=>page.locator('.assistant-search-result').last();
  async function ready(){await page.waitForFunction(()=>!assistantController&&document.getElementById('mail-assistant').dataset.answerComplete==='true');}
  await ready();
  assert.equal(await last().locator('[data-search-loop-source]').count(),20);
  assert.equal(await last().locator('[data-search-source-details]:visible').count(),3);
  await last().locator('[data-search-loop-more]').click();assert.equal(await last().locator('[data-search-source-details]:visible').count(),20);
  await last().locator('[data-search-loop-more]').click();assert.equal(await last().locator('[data-search-source-details]:visible').count(),3);
  async function action(name){await last().locator(`[data-search-loop-action=${name}]`).click();await ready();}
  await action('exclude_results');assert.equal(await last().locator('[data-search-loop-source]').count(),5);
  assert.match(await last().locator('.assistant-search-skipped').innerText(),/20/);
  assert.equal(requests.at(-1).search_action,'exclude_results');assert(requests.at(-1).search_run_id);
  await action('relax_dates');assert.equal(await last().locator('[data-search-loop-source]').count(),20);
  assert.equal(await last().locator('[data-search-loop-action=relax_dates]').count(),0,'No date action after removing dates');
  await action('undo');assert.equal(await last().locator('[data-search-loop-source]').count(),5);
  assert(await last().locator('[data-search-loop-action=relax_dates]').isVisible());
  await last().locator('[data-search-loop-clue]').click();
  await last().locator('.assistant-search-clue select').selectOption('set_keywords');
  await last().locator('.assistant-search-clue input').fill('完全不存在的词xyz');
  await last().locator('.assistant-search-clue [type=submit]').click();await ready();
  assert.equal(await last().locator('[data-search-loop-source]').count(),0);
  await action('undo');assert.equal(await last().locator('[data-search-loop-source]').count(),5);
  // Failure keeps the exact refinement and offers an adjacent retry.
  await page.route('**/api/assistant/ask-stream',route=>route.fulfill({status:503,json:{detail:'fixture temporary failure'}}));
  await last().locator('[data-search-loop-action=relax_dates]').click();
  await page.locator('[data-search-loop-retry]').waitFor();
  const failedRequest=requests.at(-1);await page.unroute('**/api/assistant/ask-stream');
  await page.locator('[data-search-loop-retry]').click();await ready();
  assert.equal(requests.at(-1).search_run_id,failedRequest.search_run_id);
  assert.equal(requests.at(-1).search_action,'relax_dates');
  const run=await last().evaluate(n=>n.closest('[data-search-run-id]').dataset.searchRunId);
  const sourceId=Number(await last().locator('[data-search-loop-source]').first().getAttribute('data-search-loop-source'));
  let releaseOpen,signalOpen;
  const openStarted=new Promise(resolve=>signalOpen=resolve);
  await page.route('**/api/emails/'+sourceId,async route=>{
   const pending=new Promise(resolve=>releaseOpen=resolve);signalOpen();await pending;
   await route.fulfill({status:503,json:{detail:'fixture detail unavailable'}});
  });
  await last().locator('[data-search-source-details]').first().click();
  await last().locator('[data-search-loop-source]').first().click();
  await openStarted;
  assert.equal(await last().locator('[data-search-loop-source]').first().getAttribute('aria-busy'),'true');
  assert.equal(await last().locator('[data-search-loop-source]:enabled').count(),0,'Opening a source prevents repeated requests');
  releaseOpen();
  await page.locator('.assistant-search-open-error').waitFor();
  await page.waitForFunction(()=>!document.querySelector('.assistant-search-open-mail[aria-busy=true]'));
  assert.equal(await last().locator('[data-search-loop-source]').first().isEnabled(),true,'Failed source opening remains retryable');
  assert.equal(await last().locator('[data-search-loop-source]').count(),20,'A failed source load preserves candidates');
  await page.unroute('**/api/emails/'+sourceId);
  // Returning from a deep, expanded candidate preserves the exact card,
  // keyboard focus, expanded state and transcript position.
  await last().locator('[data-search-loop-more]').click();
  const reviewed=last().locator('[data-search-loop-source]').nth(11);
  const reviewedId=await reviewed.getAttribute('data-search-loop-source');
  assert.match(await reviewed.getAttribute('title'),/搜索闭环合同/,'Full subject is available when truncated');
  await last().locator('[data-search-source-details]').nth(11).click();
  await reviewed.scrollIntoViewIfNeeded();await reviewed.focus();
  const position=await page.locator('#assistant-messages').evaluate(host=>host.scrollTop);
  await reviewed.click();
  await page.locator('.assistant-search-return').waitFor();
  await page.locator('[data-search-return]').click();await last().waitFor();
  await page.waitForFunction(id=>document.activeElement?.dataset.searchSourceDetails===id,reviewedId);
  assert.equal(await last().evaluate(n=>n.closest('[data-search-run-id]').dataset.searchRunId),run);
  assert.equal(await last().locator('[data-search-source-details]:visible').count(),20);
  assert.equal(await last().locator('[data-search-loop-more]').getAttribute('aria-expanded'),'true');
  assert.equal(await reviewed.getAttribute('aria-current'),'true');
  assert(Math.abs(await page.locator('#assistant-messages').evaluate(host=>host.scrollTop)-position)<2,'Return to the original scroll position');
  await page.locator('#assistant-close').click();await page.locator('#assistant-panel').waitFor({state:'hidden'});
  await page.locator('[data-search-found]').click();await page.locator('.assistant-search-result.is-found').waitFor();
  assert.equal(await page.locator('.assistant-search-return').count(),0);
  const conv=await page.evaluate(()=>assistantConversationId);
  await page.evaluate(id=>loadAssistantConversation(id),conv);
  assert(await last().evaluate(n=>n.classList.contains('is-found')),'Completion survives reopening history');
  await last().locator('[data-search-loop-action=resume]').click();
  await page.waitForFunction(()=>document.querySelector('.assistant-search-result:last-child')&&!document.querySelector('.assistant-search-result.is-found'));
  assert.equal(await last().locator('[data-search-loop-source]').count(),20);
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.match(await last().locator('[data-search-loop-action=exclude_results]').innerText(),/Skip these/);
  await page.evaluate(()=>setI18nLanguage(I18N_DEFAULT_LANG));
  assert.match(await last().locator('[data-search-loop-action=exclude_results]').innerText(),/排除这批/);
  // Real search markup with long subjects/addresses must shrink inside the
  // conversation, not just keep the outer result section at the right width.
  await page.evaluate(()=>{
   document.querySelectorAll('.assistant-search-source').forEach(row=>{
    row.querySelector('b').textContent='回复: Re: 关于员工出差机票预订及报销流程规范与补充说明'.repeat(4);
    row.querySelector('small').textContent='long-sender-address-without-spaces'.repeat(6)+'@example.test · 2026-10-17';
   });
  });
  for(const [width,theme,scale]of [[1440,'light',1],[1024,'dark',1.2],[760,'light',1],[390,'dark',1.2]]){
   await page.setViewportSize({width,height:1000});await page.evaluate(({theme,scale})=>{applyTheme(theme);document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',String(scale));},{theme,scale});
   await page.evaluate(()=>window.mailaiAssistantSearch.focusLatest());
   const overflow=await page.locator('#assistant-messages').evaluate(host=>{
    const selectors=['#assistant-messages','.assistant-message','.assistant-bubble','.assistant-search-result','.assistant-search-source-list','.assistant-search-source'];
    return selectors.flatMap(selector=>[...(selector==='#assistant-messages'?[host]:host.querySelectorAll(selector))]
     .filter(node=>node.getClientRects().length&&node.scrollWidth>node.clientWidth+1)
     .map(node=>({selector,width:node.clientWidth,content:node.scrollWidth})));
   });
   assert.deepEqual(overflow,[],'Search cards and every conversation container must fit without horizontal scrolling');
   assert(await last().locator('.assistant-search-source:visible').evaluateAll(rows=>rows.every(row=>{
    const bounds=row.getBoundingClientRect(),list=row.parentElement.getBoundingClientRect();
    const arrow=row.lastElementChild.getBoundingClientRect();
    return bounds.left>=list.left-1&&bounds.right<=list.right+1&&arrow.right<=bounds.right+1;
   })),'Cards and open arrows stay inside the source list');
   await page.screenshot({path:`build/search-loop-results-${process.env.MAILAI_BROWSER||'chromium'}-${width}.png`});
  }
  assert.deepEqual(errors,[]);
  assert(requests.every(r=>r.search_mode&&r.email_ids===null),'Refinements never pin the empty list or trigger mail actions');
  console.log('PASS AI entry/discovery, live query snapshots, wrong results, date relaxation, undo, clue form, exact retry, source return, found confirmation/history and narrow/zoom layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
