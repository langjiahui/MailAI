/* After the ordinary growth browser test, exercise real server failures and recovery. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const base = 'http://127.0.0.1:18795/';
(async()=>{
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let failedLoad=false, reads=0;
    await page.route('**/api/companion/growth',async route=>{
      reads++;
      if (!failedLoad) { failedLoad=true;await route.fulfill({status:503,contentType:'application/json',body:'{"detail":"fixture transient load failure"}'}); }
      else await route.continue();
    });
    await page.goto(base);
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>!!document.body.dataset.petStage,{timeout:20000});
    assert(reads>=2,'A failed initial load must retry without reopening the journal');
    await page.unroute('**/api/companion/growth');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    // Use the seeded work account for affordable consumables.
    await page.evaluate(async()=>{
      const config=await api('/api/system/config');
      const work=config.accounts.find(account=>account.user === 'work@example.test');
      if (!work.active) { await activateMailAccount(work.id,{quiet:true}); }
      await window.mailaiPet.refresh();
    });
    await page.waitForFunction(()=>document.body.dataset.petStage !== '1');
    await page.evaluate(()=>window.mailaiPet.open());
    const dialog=page.locator('#companion-growth-dialog');
    await page.clock.install();
    // Another window pauses/resumes; this window must converge automatically.
    await page.evaluate(()=>api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})}));
    await page.clock.fastForward(35000);
    await page.evaluate(()=>window.mailaiEnergy.run('companion-growth',true));
    await page.waitForFunction(()=>!!document.querySelector('.pet-paused'));
    // Clicks and help dwell while paused must not be queued for a later resume.
    const resumedBatches=[];
    page.on('request',request=>{if(request.url().endsWith('/api/companion/heartbeat'))resumedBatches.push(request.postDataJSON());});
    await page.keyboard.press('Escape');
    await page.locator('#global-search').click();
    await page.clock.fastForward(1000);
    await page.locator('#global-search').click();
    await page.evaluate(()=>showSystemView('guide'));
    await page.locator('.help-topic details').first().locator('summary').click();
    await page.clock.fastForward(10000);
    await page.evaluate(()=>window.mailaiPet.open());
    await page.evaluate(()=>api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})}));
    await page.clock.fastForward(35000);
    await page.evaluate(()=>window.mailaiEnergy.run('companion-growth',true));
    await page.waitForFunction(()=>!document.querySelector('.pet-paused'));
    // The first sample after a preference transition resets the clock; only
    // the following foreground interval can contribute new activity.
    await page.keyboard.press('Shift');
    await page.waitForTimeout(100);
    await page.evaluate(()=>window.mailaiEnergy.run('companion-growth',true));
    await page.clock.fastForward(10000);
    await page.evaluate(()=>window.mailaiEnergy.run('companion-growth',true));
    for(let attempt=0;attempt<20 && !resumedBatches.length;attempt++)await page.waitForTimeout(100);
    assert(resumedBatches.length,'Resuming should allow new heartbeat batches: '+JSON.stringify(await page.evaluate(()=>({active:window.mailaiEnergy.active(),focused:document.hasFocus(),hidden:document.hidden,now:performance.now(),day:Date.now(),account:activeMailAccount()?.id,paused:!!document.querySelector('.pet-paused')}))));
    assert(resumedBatches.every(batch=>batch.clicks===0 && !batch.learn),'Paused clicks and learning must not be awarded after resuming');
    await page.evaluate(()=>hideSystemView(true));
    // Committed purchase whose response is lost: recover the SAME request after reload.
    await dialog.locator('[data-pet-tab="shop"]').click();
    const before=await page.evaluate(()=>api('/api/companion/growth'));
    assert(before.berry_today<3);
    let purchaseToken;
    await page.route('**/api/companion/purchase',async route=>{
      purchaseToken=route.request().postDataJSON().token;
      const committed=await route.fetch();
      assert.equal(committed.status(),200);
      await route.fulfill({status:503,contentType:'application/json',body:'{"detail":"fixture response lost after commit"}'});
    });
    await dialog.locator('[data-pet-buy="berry"]').click();
    await dialog.locator('[data-pet-reconcile]').waitFor({state:'visible'});
    assert(await dialog.locator('[data-pet-buy="peach"]').isDisabled());
    assert(await dialog.locator('[data-pet-equip="scarf"]').isEnabled(),'Pending purchases must allow owned outfits');
    const committed=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(committed.stamps,before.stamps-120);
    assert.equal(committed.berry_today,before.berry_today+1);
    await page.unroute('**/api/companion/purchase');
    await page.clock.resume();
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>window.mailaiPet.open());
    await dialog.locator('[data-pet-reconcile]').waitFor({state:'visible'});
    const replayTokens=[];
    page.on('request',request=>{if(request.url().endsWith('/api/companion/purchase'))replayTokens.push(request.postDataJSON().token);});
    // Permission/network errors cannot prove whether the ORIGINAL purchase committed.
    await page.route('**/api/companion/purchase',route=>route.fulfill({status:403,contentType:'application/json',body:'{"detail":"fixture temporary permission failure"}'}));
    await dialog.locator('[data-pet-reconcile]').click();
    await page.waitForFunction(()=>document.querySelector('[data-pet-message]')?.classList.contains('is-error'));
    assert(await dialog.locator('[data-pet-reconcile]').isVisible(),'A permission error must preserve the original intent');
    await page.unroute('**/api/companion/purchase');
    await dialog.locator('[data-pet-reconcile]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-pet-reconcile]'));
    const recovered=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(recovered.stamps,committed.stamps);
    assert.equal(recovered.berry_today,committed.berry_today);
    assert.equal(replayTokens[0],purchaseToken);
    assert.equal(replayTokens[1],purchaseToken);
    await dialog.locator('[data-pet-tab="history"]').click();
    assert.match(await dialog.textContent(),/兑换记录/);
    assert.match(await dialog.textContent(),/−120 邮票/);
    // A hanging heartbeat must time out, retry its token, and allow later batches.
    const tokens=[];let release;
    await page.route('**/api/companion/heartbeat',async route=>{
      tokens.push(route.request().postDataJSON().token);
      if(tokens.length===1){await new Promise(resolve=>{release=resolve;});try{await route.abort();}catch{}}
      else await route.continue();
    });
    await page.keyboard.press('Escape');
    await page.locator('#assistant-orb').click();
    await page.clock.fastForward(10000);
    for(let attempt=0;attempt<20 && !tokens.length;attempt++)await page.waitForTimeout(100);
    assert.equal(tokens.length,1);
    await page.clock.fastForward(13000);
    await page.waitForTimeout(100);
    await page.evaluate(()=>window.mailaiEnergy.run('companion-growth',true));
    for(let attempt=0;attempt<20 && tokens.length<2;attempt++)await page.waitForTimeout(100);
    assert.equal(tokens[1],tokens[0],'A timeout retries the original batch token');
    release();
    await page.waitForTimeout(200);
    await page.clock.fastForward(10000);
    await page.evaluate(()=>window.mailaiEnergy.run('companion-growth',true));
    for(let attempt=0;attempt<20 && tokens.length<3;attempt++)await page.waitForTimeout(100);
    assert(tokens.length>=3,'A hanging request must not permanently stop growth');
    assert.notEqual(tokens[2],tokens[0]);
    assert.deepEqual(errors,[]);
    console.log('Growth recovery: automatic load retry, cross-window preferences, lost purchase response/reload, receipts and hung heartbeat recovery passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
