// Run against tests/workspace_preview.py. Synthetic mailboxes only.
const {chromium,webkit}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1360,height:1000},reducedMotion:'reduce'});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:18795');await page.locator('.email-item').first().waitFor();await page.locator('#app-preloader').waitFor({state:'hidden'});
  const originalAccount=await page.evaluate(()=>activeMailAccount().id);
  await page.locator('.search-filter-button').click();
  const dialog=page.locator('#productivity-dialog'),sender=page.locator('[data-criterion=sender]'),subject=page.locator('[data-criterion=subject]');
  const submit=page.locator('#productivity-search-form [type=submit]');
  await sender.fill('项目同事');await submit.click();await page.locator('.productivity-result').first().waitFor();
  assert.equal(await page.locator('.productivity-result').count(),12);assert(await sender.isVisible(),'Searching must keep conditions visible');
  assert.match(await page.locator('[data-search-applied]').innerText(),/项目同事/);assert.match(await page.locator('.productivity-result').first().innerText(),/项目同事/);
  await page.screenshot({path:'build/advanced-search-name-light.png'});
  await subject.fill('没有这份主题');await page.getByText('条件已修改，请点击搜索更新结果',{exact:true}).waitFor();
  await submit.click();await page.locator('.advanced-search-empty').waitFor();assert(await sender.isVisible());
  await page.locator('[data-search-reset]').click();assert.equal(await sender.inputValue(),'');assert.equal(await subject.inputValue(),'');assert.equal(await page.locator('.productivity-result').count(),0);
  // Conflicts and invalid dates are errors, including all-account searches.
  await sender.fill('项目同事');await page.locator('[data-criterion=query]').fill('from:另一个人');await page.locator('#productivity-all-accounts').check();await submit.click();
  await page.getByText('搜索语法与表单条件冲突，请清空重复条件后重试',{exact:true}).waitFor();
  await page.locator('[data-search-reset]').click();
  await page.evaluate(()=>{for(const [key,value]of [['after','2026-10-16'],['before','2026-10-15']]){const input=document.querySelector(`[data-criterion=${key}]`);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}});
  await submit.click();await page.getByText('开始日期不能晚于结束日期',{exact:true}).waitFor();
  await page.locator('[data-search-reset]').click();assert.equal(await page.locator('[data-criterion=after]').inputValue(),'');
  // Editing while an old response is in flight must immediately allow a new search.
  let releaseSlow;const slow=new Promise(resolve=>releaseSlow=resolve);let seenSlow;
  const started=new Promise(resolve=>seenSlow=resolve);
  await page.route('**/api/productivity/search',async route=>{
   if(route.request().postDataJSON().criteria.sender!=='slow')return route.continue();
   seenSlow();await slow;await route.fulfill({json:{items:[{id:999,kind:'email',subject:'过时结果'}],has_more:false,criteria:{sender:'slow'}}}).catch(()=>{});
  });
  await sender.fill('slow');await submit.click();await started;await sender.fill('项目同事');assert(await submit.isEnabled());await submit.click();await page.locator('.productivity-result').first().waitFor();
  releaseSlow();await page.waitForTimeout(120);assert.equal(await page.getByText('过时结果',{exact:true}).count(),0);
  await page.unroute('**/api/productivity/search');
  // Saved searches retain their account scope and use one stable selection handler.
  await page.locator('#productivity-all-accounts').check();
  await page.locator('.advanced-search-saved summary').click();
  await page.evaluate(()=>{window.mailaiAsk=async()=> 'Saved sender search';});
  await page.locator('[data-productivity-action=save-search]').click();await page.getByText('搜索条件已保存',{exact:true}).waitFor();
  const savedValue=await page.locator('#productivity-saved-search option').last().getAttribute('value');
  await page.locator('#productivity-all-accounts').uncheck();
  const request=page.waitForRequest(r=>r.url().includes('/api/productivity/search')&&r.method()==='POST'&&!r.url().includes('/searches'));
  await page.locator('#productivity-saved-search').selectOption(savedValue);assert.equal((await request).postDataJSON().all_accounts,true);
  await page.locator('.productivity-result').first().waitFor();assert(await page.locator('#productivity-all-accounts').isChecked());
  assert.match(await page.locator('[data-search-applied]').innerText(),/所有可见账号/);
  // Explicit collapsing is reversible; no automatic collapse after a search.
  await page.locator('[data-search-expand]').click();assert.equal(await page.locator('[data-criterion=sender]').isVisible(),false);
  await page.locator('[data-search-expand]').click();assert(await page.locator('[data-criterion=sender]').isVisible());
  for(const [width,mode,theme,scale]of [[1360,'dark','',1],[390,'dark','theme_baowu',1.25],[390,'light','theme_monochrome',1]]){
   await page.setViewportSize({width,height:950});await page.evaluate(({mode,theme,scale})=>{applyTheme(mode);if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale));},{mode,theme,scale});
   assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Dialog must not overflow horizontally');
   assert(await dialog.evaluate(n=>{const b=n.getBoundingClientRect();return b.left>=-1&&b.right<=innerWidth+1&&b.top>=-1&&b.bottom<=innerHeight+1;}),'Dialog fits viewport at enlarged font size');
   await page.screenshot({path:`build/advanced-search-${width}-${mode}.png`});
  }
  await page.evaluate(()=>{document.body.style.zoom='';document.documentElement.style.removeProperty('--fz');});await page.setViewportSize({width:1360,height:1000});
  await page.locator('.productivity-result').filter({hasText:'personal@example.test'}).first().click();
  await page.waitForFunction(()=>activeMailAccount().user==='personal@example.test'&&!document.querySelector('#productivity-dialog').open);
  await page.evaluate(async({id,account})=>api('/api/productivity/searches/'+id,{method:'DELETE',accountId:account}),{id:savedValue,account:originalAccount});
  assert.deepEqual(errors,[]);
  console.log('PASS Chinese sender results, visible/applied criteria, empty/reset/errors, canceled stale search, saved account scope, explicit collapse, cross-account opening and dark/narrow/zoom layout');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
