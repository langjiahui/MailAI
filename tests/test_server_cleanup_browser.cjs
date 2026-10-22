// Only run with MAILAI_CLEANUP_FIXTURE=1 tests/workspace_preview.py.
const {chromium,webkit}=require('playwright');const assert=require('node:assert/strict');
(async()=>{
 const useWebkit=process.env.MAILAI_BROWSER==='webkit';
 const browser=await (useWebkit?webkit:chromium).launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto('http://127.0.0.1:18795');await page.waitForSelector('#email-list .email-item');
  const config=await page.evaluate(()=>api('/api/system/config'));assert.ok(config.accounts.every(a=>a.user.endsWith('@example.test')));
  for(const [index,theme] of ['light','dark'].entries()) {
   await page.evaluate(async({account,theme})=>{await openAccountMailbox(account,'inbox');applyTheme(theme);},{account:config.accounts[index].id,theme});
   const archiveEntries=await page.locator('[data-account-action="local_archive"]').count();
   await page.locator('#btn-preferences').click();await page.locator('[data-system-tab="maintenance"]').click();
   await page.waitForFunction(()=>document.getElementById('cleanup-mode-badge').textContent==='自动清理已关闭');
   await page.locator('#btn-cleanup-automation').click();await page.waitForFunction(()=>cleanupAutoLoaded&&!cleanupAutoBusy);
   assert.equal(await page.locator('#cleanup-auto-enabled').isChecked(),false);
   assert.equal(await page.locator('#cleanup-auto-days').inputValue(),'90');
   await page.locator('#cleanup-auto-enabled').check();
   assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),false);
   await page.locator('#cleanup-auto-days').selectOption('30');await page.locator('#cleanup-auto-interval').selectOption('7');
   await page.locator('#cleanup-auto-ack').check();await page.locator('#cleanup-auto-email').fill('wrong@example.test');
   assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),false);
   await page.locator('#cleanup-auto-email').fill(config.accounts[index].user);
   assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),true);
   await page.locator('#cleanup-auto-days').selectOption('60');
   assert.equal(await page.locator('#cleanup-auto-ack').isChecked(),false);
   assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),false);
   await page.locator('#cleanup-auto-days').selectOption('30');await page.locator('#cleanup-auto-ack').check();
   await page.locator('#cleanup-auto-email').fill(config.accounts[index].user);
   await page.screenshot({path:`build/server-cleanup-auto-${theme}.png`});
   for(const language of ['en','zh-CN']) for(const [width,height,scale] of [[390,844,1],[720,844,1.25],[1440,1000,1]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(({language,scale})=>{setI18nLanguage(language);document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale))},{language,scale});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const bounds=await page.locator('#cleanup-auto-dialog').evaluate(dialog=>{
     const r=dialog.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:dialog.scrollWidth>dialog.clientWidth+1};
    });
    assert.ok(bounds.left>=-1&&bounds.right<=bounds.width+1&&bounds.top>=-1&&bounds.bottom<=bounds.height+1&&!bounds.overflow,JSON.stringify({language,width,scale,bounds}));
    await page.locator('#cleanup-auto-save').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),true);
    if(language==='en'&&width===390) {
     assert.equal(await page.locator('#cleanup-auto-title').innerText(),'Automatic cleanup settings');
     await page.screenshot({path:`build/server-cleanup-auto-narrow-${theme}.png`});
    }
   }
   await page.locator('#cleanup-auto-save').click();await page.waitForFunction(()=>!document.getElementById('cleanup-auto-dialog').open);
   assert.equal(await page.locator('#cleanup-mode-badge').innerText(),'自动清理已开启');
   assert.ok((await page.locator('#cleanup-auto-summary').innerText()).includes('保留最近 30 天'));
   const policy=await page.evaluate(()=>api('/api/system/server-cleanup/automation'));
   assert.equal(policy.enabled,true);assert.equal(policy.interval_days,7);assert.equal(policy.days,30);
   await page.locator('#btn-cleanup-automation').click();await page.waitForFunction(()=>cleanupAutoLoaded&&!cleanupAutoBusy);
   assert.equal(await page.locator('#cleanup-auto-enabled').isChecked(),true);
   assert.equal(await page.locator('#cleanup-auto-interval').inputValue(),'7');
   assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),false);
   await page.locator('#cleanup-auto-close').click();
   // A failed settings load cannot overwrite the saved rule.
   await page.route('**/api/system/server-cleanup/automation',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'fixture unavailable'})}));
   await page.locator('#btn-cleanup-automation').click();await page.waitForFunction(()=>!cleanupAutoBusy);
   assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),false);
   await page.locator('#cleanup-auto-close').click();await page.unroute('**/api/system/server-cleanup/automation');
   // Disabling remains possible when the server folder list cannot be fetched.
   await page.route('**/api/mail/folders',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'fixture offline'})}));
   await page.locator('#btn-cleanup-automation').click();await page.waitForFunction(()=>cleanupAutoLoaded&&!cleanupAutoBusy);
   await page.locator('#cleanup-auto-enabled').uncheck();assert.equal(await page.locator('#cleanup-auto-save').isEnabled(),true);
   await page.locator('#cleanup-auto-save').click();await page.waitForFunction(()=>!document.getElementById('cleanup-auto-dialog').open);
   await page.unroute('**/api/mail/folders');
   assert.equal(await page.locator('#cleanup-mode-badge').innerText(),'自动清理已关闭');
   await page.locator('#btn-server-cleanup').click();
   await page.waitForFunction(()=>!cleanupBusy);
   assert.equal(await page.locator('#cleanup-age').inputValue(),'30');
   assert.equal(await page.locator('#cleanup-include-favorites').isChecked(),false);
   assert.equal(await page.locator('#cleanup-execute').isEnabled(),false);
   await page.locator('#cleanup-preview').click();await page.waitForFunction(()=>!cleanupBusy&&cleanupPreview?.count===1);
   assert.equal(await page.locator('#cleanup-execute').isEnabled(),false);
   // Exercise pagination while the fixture only has one eligible message.
   await page.route('**/api/system/server-cleanup/preview', async route=>{
    const response=await route.fetch(); const body=await response.json();
    if (!route.request().postDataJSON().offset) body.more=true;
    await route.fulfill({response,json:body});
   });
   await page.locator('#cleanup-preview').click();await page.waitForFunction(()=>!cleanupBusy&&cleanupPreview?.more);
   await page.locator('[data-cleanup-page="next"]').click();await page.waitForFunction(()=>!cleanupBusy&&cleanupPreview?.offset===50);
   assert.equal(await page.locator('#cleanup-execute').isEnabled(),false);
   await page.locator('[data-cleanup-page="previous"]').click();await page.waitForFunction(()=>!cleanupBusy&&cleanupPreview?.offset===0);
   await page.unroute('**/api/system/server-cleanup/preview');
   // Changing scope discards the previous approval and server-bound token.
   await page.locator('#cleanup-age').selectOption('60');await page.waitForFunction(()=>cleanupPreview===null);
   assert.equal(await page.locator('#cleanup-confirmation').isVisible(),false);
   await page.locator('#cleanup-age').selectOption('30');await page.locator('#cleanup-preview').click();
   await page.waitForFunction(()=>!cleanupBusy&&cleanupPreview?.count===1);
   await page.locator('#cleanup-ack').check();await page.locator('#cleanup-confirm-email').fill('wrong@example.test');
   assert.equal(await page.locator('#cleanup-execute').isEnabled(),false);
   const account=await page.evaluate(()=>cleanupPreview.account);await page.locator('#cleanup-confirm-email').fill(account);
   assert.equal(await page.locator('#cleanup-execute').isEnabled(),true);
   await page.screenshot({path:`build/server-cleanup-${theme}.png`});
   await page.locator('#cleanup-execute').click();await page.waitForFunction(()=>!cleanupBusy&&document.getElementById('cleanup-result').textContent.includes('清理完成'));
   assert.equal(await page.locator('#cleanup-execute').isEnabled(),false);
   assert.ok((await page.locator('#server-cleanup-history').innerText()).includes('最近清理记录'));
   await page.locator('#cleanup-close').click();await page.locator('#btn-close-system').click();
   assert.equal(await page.locator('[data-account-action="local_archive"]').count(),archiveEntries);
   await page.waitForFunction(()=>document.getElementById('list-title').textContent==='收件箱'&&document.querySelectorAll('#email-list .email-item').length===12);
   await page.locator('#email-list .email-item[data-id="1"]').click();await page.waitForFunction(()=>selectedEmailDetail?.id===1&&selectedEmailDetail.attachments?.length);
   const detail=await page.evaluate(()=>selectedEmailDetail);assert.equal(detail.is_local_archive,1);assert.ok(detail.attachments.length);
   assert.deepEqual(errors,[]);console.log('PASS '+theme+': automatic opt-in, persistence, validation, offline disable, manual cleanup and mail retained in original inbox');
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
