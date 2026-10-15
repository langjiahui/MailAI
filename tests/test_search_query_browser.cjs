// Run against tests/workspace_preview.py; never connects to a live mailbox.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.locator('.email-item').first().waitFor();
  const account=await page.evaluate(()=>activeMailAccount().id);
  const user=await page.evaluate(()=>activeMailAccount().user);
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  const input=page.locator('#global-search');
  async function search(text,count){
   await input.fill(text);
   await page.waitForFunction(()=>mailSearchState.phase==='done');
   assert.equal(await page.locator('#email-list .email-item').count(),count,text);
   assert(await page.locator('#search-error').isHidden(),text);
  }
  await search('发件人是项目同事',12);
  assert.match(await page.locator('[data-remove-search-token=sender]').innerText(),/项目同事/);
  await page.locator('#email-list .email-item').first().click();
  await page.locator('#reading-content .reading-header').waitFor();
  await search('发送人：项目同事，标题包含采购合同 最近7天 有附件',1);
  for(const key of ['sender','subject','after','before','has_attachment'])assert(await page.locator(`[data-remove-search-token=${key}]`).isVisible());
  await page.screenshot({path:`build/natural-search-${process.env.MAILAI_BROWSER||'chromium'}.png`});
  await page.locator('.search-filter-button').click();
  assert.equal(await page.locator('[data-criterion=sender]').inputValue(),'项目同事');
  assert.equal(await page.locator('[data-criterion=subject]').inputValue(),'采购合同');
  assert.equal(await page.locator('[data-criterion=query]').inputValue(),'');
  assert.equal(await page.locator('[data-criterion=mailbox]').inputValue(),'inbox');
  await page.locator('[data-close-productivity]').click();
  await page.locator('[data-remove-search-token=subject]').click();
  await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await page.locator('#email-list .email-item').count(),1);
  assert.doesNotMatch(await input.inputValue(),/(?:from|subject|after|before|has):/,'Removing a condition must keep the query readable');
  await page.locator('[data-remove-search-token=has_attachment]').click();
  await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await page.locator('#email-list .email-item').count(),12);
  await search('发件人是不存在的人 标题包含采购合同',0);
  await search('收件人是'+user,12);
  await page.evaluate(()=>openUnifiedInbox());
  await search('项目同事发来的邮件',24);
  assert.equal(await page.evaluate(()=>unifiedMailbox),true);
  // The same structured query also searches local sent records and drafts.
  await page.evaluate(id=>openAccountMailbox(id,'sent'),account);
  await search('标题包含交付',1);
  await page.locator('#email-list .email-item').first().click();
  await page.locator('.special-mail-detail').waitFor();
  assert.match(await page.locator('.special-mail-detail h1').innerText(),/项目交付/);
  const draft=await page.evaluate(()=>api('/api/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:'检索测试草稿',to_addr:'customer@example.test',body_html:'<p>草稿完整内容</p>'})}));
  try{
   await page.evaluate(id=>openAccountMailbox(id,'drafts'),account);
   await search('主题包含检索测试',1);
   await page.locator('#email-list .email-item').first().click();
   await page.locator('.special-mail-detail').waitFor();
   assert.match(await page.locator('.special-mail-detail h1').innerText(),/检索测试草稿/);
  }finally{await page.evaluate(id=>api('/api/drafts/'+id,{method:'DELETE'}),draft.id);}
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  // A canceled interpretation may not restore its tags or results.
  let started,release;
  const seen=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>release=resolve);
  await page.route('**/api/productivity/search/interpret?*',async route=>{
   if(new URL(route.request().url()).searchParams.get('q')!=='from:slow')return route.continue();
   started();await hold;await route.fulfill({json:{structured:true,criteria:{sender:'slow'},tokens:[{field:'sender',value:'slow',canonical:'from:slow'}]}}).catch(()=>{});
  });
  await input.fill('from:slow');await seen;
  await search('来自项目同事的邮件',12);release();
  await page.waitForTimeout(100);
  assert.match(await page.locator('[data-remove-search-token=sender]').innerText(),/项目同事/);
  await page.unroute('**/api/productivity/search/interpret?*');
  await input.fill('from:"未闭合');await page.waitForFunction(()=>mailSearchState.phase==='error');
  assert(await page.locator('#search-error').isVisible());
  await search('采购',12);
  assert.deepEqual(errors,[]);
  console.log('PASS natural variants, combined conditions, removable tags, advanced form handoff, exact identity, account scope, sent/draft opening, stale interpretation cancellation and error recovery');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
