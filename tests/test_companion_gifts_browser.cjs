/* Start MAILAI_GIFT_FIXTURE=1 workspace_preview.py. All vouchers use ephemeral test keys. */
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18795/');await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(async()=>{setI18nLanguage('zh-CN');await mailaiPet.open()});
  const dialog=page.locator('#companion-growth-dialog');await dialog.locator('[data-pet-tab="gifts"]').click();
  const codes=await page.evaluate(()=>api('/fixture/gifts'));
  const before=await page.evaluate(()=>api('/api/companion/growth'));
  const identity=await dialog.locator('[data-pet-claim-code]').inputValue();assert.equal(identity,before.claim_code);
  const input=dialog.locator('[data-pet-gift-code]'),verify=dialog.locator('[data-pet-gift-preview]');
  assert(await verify.isDisabled(),'Empty entry cannot be submitted');
  assert(await dialog.locator('.pet-gift-identity').evaluate(n=>!n.open),'Recipient code stays compact by default');
  const fillCode=async code=>{await dialog.locator('.pet-gift-source').evaluate(n=>n.open=true);await input.fill(code)};
  await fillCode(codes.wrong);await verify.click();await page.waitForFunction(()=>document.querySelector('[data-pet-gift-error]')?.textContent.includes('不属于'));
  assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before);
  await fillCode(codes.exclusive+'!');await verify.click();await page.waitForFunction(()=>document.querySelector('[data-pet-gift-error]')?.textContent.includes('无效'));
  await fillCode(codes.exclusive);await verify.click();await dialog.locator('[data-pet-gift-claim]').waitFor({state:'visible'});
  assert.equal(await dialog.locator('.pet-gift-items article').count(),3);
  assert(await dialog.locator('.pet-gift-source').evaluate(n=>!n.open),'Verified code collapses behind the gift preview');
  await dialog.locator('.pet-gift-items [data-pet-preview="wings"]').click();
  assert(await dialog.locator('.pet-live-preview').isVisible());
  assert.equal(await dialog.locator('[data-pet-preview-select] option').count(),2,'Gift preview only includes outfits from this voucher');
  await dialog.locator('[data-pet-preview-close]').click();
  assert(await dialog.locator('[data-theme-preview="theme_baowu"]').isVisible());
  assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before,'Preview cannot spend or grant');
  await dialog.locator('[data-pet-gift-claim]').click();await dialog.locator('[data-pet-gift-wear]').waitFor({state:'visible'});
  const after=await page.evaluate(()=>api('/api/companion/growth'));
  assert.equal(after.stamps,before.stamps);assert.equal(after.xp,before.xp);assert.deepEqual(after.equipped,before.equipped);
  assert.equal(after.gifts.length,1);assert.equal(after.stage,1);
  assert(await dialog.locator('.pet-gift-success').isVisible());
  await page.screenshot({path:'/tmp/mailai-gift-desktop.png'});
  await dialog.locator('.pet-gift-items [data-pet-equip="orbit"]').click();
  await page.waitForFunction(()=>document.body.dataset.petEffect==='orbit');
  assert(await dialog.locator('.pet-gift-items [data-pet-equip="orbit"]').isDisabled());
  await dialog.locator('[data-pet-gift-wear]').click();
  assert.equal(await dialog.locator('[data-pet-item="wings"]').getAttribute('data-gift-focus'),'true');
  const wings=dialog.locator('[data-pet-equip="wings"]');assert(await wings.isEnabled(),'Gifted high-level wings can be worn at level 1');
  await wings.click();await page.waitForFunction(()=>document.body.dataset.petAccessory==='wings');
  await dialog.locator('[data-pet-tab="gifts"]').click();
  assert(await dialog.locator('.pet-history').isVisible());
  await page.evaluate(()=>setI18nLanguage('en'));
  assert(!/[\u3400-\u9fff]/.test((await dialog.locator('.pet-gift-panel').textContent()).replace('赠礼测试 exclusive','')));
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await page.screenshot({path:'/tmp/mailai-gift-mobile-dark.png'});
  await page.setViewportSize({width:1280,height:960});await page.evaluate(()=>setI18nLanguage('zh-CN'));
  await dialog.locator('[data-pet-gift-file]').setInputFiles({name:'bad.mailaigift',mimeType:'text/plain',buffer:Buffer.alloc(8193)});
  assert.equal(await dialog.locator('.pet-gift-result').count(),0,'Invalid replacement file must clear the old claim target');
  assert(await verify.isDisabled());
  assert.match(await dialog.locator('[data-pet-gift-error]').textContent(),/8 KB/);
  // Import a file, then simulate a committed claim whose response was lost.
  await dialog.locator('[data-pet-gift-file]').setInputFiles({name:'活动礼包.mailaigift',mimeType:'text/plain',buffer:Buffer.from(codes.campaign)});
  await dialog.locator('[data-pet-gift-claim]').waitFor({state:'visible'});
  assert.equal(await input.inputValue(),codes.campaign,'File contents are checked after import and automatic preview finish');
  await page.route('**/api/companion/gifts/claim',async route=>{await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:'{"detail":"fixture response lost"}'})});
  await dialog.locator('[data-pet-gift-claim]').click();await page.waitForFunction(()=>document.querySelector('[data-pet-gift-error]')?.textContent.includes('fixture response lost'));assert(await page.evaluate(()=>!!localStorage.getItem('mailai-companion-gift-pending')));
  await fillCode(codes.another);await verify.click();await dialog.locator('[data-pet-gift-claim]').waitFor({state:'visible'});
  assert(await dialog.locator('[data-pet-gift-claim]').isDisabled(),'Another voucher cannot replace an unresolved claim');
  assert.equal(await page.evaluate(()=>localStorage.getItem('mailai-companion-gift-pending')),codes.campaign);
  await page.unroute('**/api/companion/gifts/claim');await page.reload();await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>mailaiPet.open());await dialog.locator('[data-pet-tab="gifts"]').click();
  assert.equal(await input.inputValue(),codes.campaign);
  await dialog.locator('[data-pet-gift-reconcile]').click();await dialog.locator('[data-pet-gift-wear]').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>localStorage.getItem('mailai-companion-gift-pending')),null);
  assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).gifts.length,2);
  await page.evaluate(async()=>{const config=await api('/api/system/config');const other=config.accounts.find(a=>!a.active);await activateMailAccount(other.id,{quiet:true});await mailaiPet.refresh()});
  assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).claim_code,identity);
  assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).gifts.length,2);
  await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollTop=n.scrollHeight);await page.screenshot({path:'/tmp/mailai-gift-claim.png'});
  // A definite rejection must release a stale pending voucher instead of blocking all future gifts.
  await page.evaluate(code=>localStorage.setItem('mailai-companion-gift-pending',code),codes.expired);
  await page.reload();await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>mailaiPet.open());await dialog.locator('[data-pet-tab="gifts"]').click();
  await dialog.locator('[data-pet-gift-reconcile]').click();
  await page.waitForFunction(()=>/领取期限|deadline/.test(document.querySelector('[data-pet-gift-error]')?.textContent||''));
  assert.equal(await page.evaluate(()=>localStorage.getItem('mailai-companion-gift-pending')),null);
  await fillCode(codes.another);await verify.click();await dialog.locator('[data-pet-gift-claim]').waitFor({state:'visible'});
  // A request which never committed can also be reconciled and then safely claimed once.
  await page.route('**/api/companion/gifts/claim',route=>route.fulfill({status:503,contentType:'application/json',body:'{"detail":"fixture never committed"}'}));
  await dialog.locator('[data-pet-gift-claim]').click();await page.waitForFunction(()=>document.querySelector('[data-pet-gift-error]')?.textContent.includes('fixture never committed'));
  await page.unroute('**/api/companion/gifts/claim');await dialog.locator('[data-pet-gift-reconcile]').click();
  await page.waitForFunction(()=>!localStorage.getItem('mailai-companion-gift-pending'));
  assert(await dialog.locator('[data-pet-gift-claim]').isEnabled());
  await dialog.locator('[data-pet-gift-claim]').click();await dialog.locator('[data-pet-gift-wear]').waitFor({state:'visible'});
  assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).gifts.length,3);
  // Claimed gifts remain discoverable from history, without retaining the original voucher.
  await dialog.locator('.pet-history [data-pet-gift-outfits]').last().click();
  assert.equal(await dialog.locator('[data-pet-item="theme_baowu"]').getAttribute('data-gift-focus'),'true');
  await dialog.locator('[data-pet-equip="theme_baowu"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.rewardTheme==='theme_baowu');
  await dialog.locator('[data-pet-tab="gifts"]').click();await fillCode(codes.exclusive);await verify.click();
  await dialog.locator('[data-pet-gift-wear]').waitFor({state:'visible'});
  assert.match(await dialog.locator('.pet-gift-items [data-pet-equip="theme_baowu"]').textContent(),/正在使用|Active/);
  for(const language of ['zh-CN','en']){
   await page.evaluate(language=>setI18nLanguage(language),language);
   for(const theme of ['light','dark'])for(const reward of ['','theme_monochrome','theme_baowu']){
    await page.evaluate(({theme,reward})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.rewardTheme=reward},{theme,reward});
    for(const [width,height,scale] of [[360,740,1],[390,844,1.35],[800,550,1],[1280,900,1]]){
     await page.setViewportSize({width,height});
     await page.evaluate(scale=>{document.documentElement.style.setProperty('--fz',scale);document.body.style.zoom=String(scale)},scale);
     await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollTop=n.scrollHeight);
     assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'No hidden horizontal overflow with translated/scaled UI');
     const nav=await dialog.locator('.pet-tabs').boundingBox(),body=await dialog.locator('.pet-journal-body').boundingBox();
     assert(nav.y>=body.y-1 && nav.y+nav.height<=body.y+body.height+1,'Tab navigation stays available while reading gifts');
     assert(await dialog.locator('.pet-history [data-pet-gift-outfits]').first().isVisible());
    }
   }
  }
  await page.evaluate(()=>{document.documentElement.style.setProperty('--fz','1');document.body.style.zoom='1'});await page.setViewportSize({width:800,height:650});
  await dialog.locator('[data-pet-tab="gifts"]').click();
  await page.screenshot({path:'/tmp/mailai-gift-ux-en-dark.png'});
  assert.deepEqual(errors,[]);
  console.log('Gift UI: recipient, wrong/forged vouchers, free preview/claim, level-free wear, file import, themes, lost-response/reload recovery, mailbox sharing, history outfit navigation, scoped previews, localized dates, sticky tabs and 48 language/theme/size/scale layouts passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
