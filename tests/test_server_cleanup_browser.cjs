// Only run with MAILAI_CLEANUP_FIXTURE=1 tests/workspace_preview.py.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto('http://127.0.0.1:18795');await page.waitForSelector('#email-list .email-item');
  const config=await page.evaluate(()=>api('/api/system/config'));assert.ok(config.accounts.every(a=>a.user.endsWith('@example.test')));
  for(const [index,theme] of ['light','dark'].entries()) {
   await page.evaluate(async({account,theme})=>{await openAccountMailbox(account,'inbox');applyTheme(theme);},{account:config.accounts[index].id,theme});
   await page.locator('#btn-preferences').click();await page.locator('[data-system-tab="maintenance"]').click();
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
   assert.equal(await page.locator('[data-account-action="local_archive"]').count(),0);
   await page.waitForFunction(()=>document.getElementById('list-title').textContent==='收件箱'&&document.querySelectorAll('#email-list .email-item').length===12);
   await page.locator('#email-list .email-item[data-id="1"]').click();await page.waitForSelector('[data-reading-action="favorite"]');
   const detail=await page.evaluate(()=>selectedEmailDetail);assert.equal(detail.is_local_archive,1);assert.ok(detail.attachments.length);
   assert.deepEqual(errors,[]);console.log('PASS '+theme+': manual preview, scope reset, typed approval, cleanup, history and mail retained in original inbox');
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
