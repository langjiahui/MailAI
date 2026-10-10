/* Run MAILAI_GROWTH_FIXTURE=1 python tests/workspace_preview.py first. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage === '3');
    await page.locator('#assistant-orb').click();
    await page.locator('#companion-growth-launch').click();
    const dialog = page.locator('#companion-growth-dialog');
    await dialog.waitFor({state:'visible'});
    assert.match(await dialog.textContent(),/花苞伙伴/);
    assert.equal(await dialog.locator('.pet-hero .growth-flower').evaluate(n=>getComputedStyle(n).display),'block');
    await dialog.locator('[data-pet-tab="shop"]').click();
    assert.equal(await dialog.locator('[data-pet-buy="wings"]').isEnabled(),false);
    const before = await page.evaluate(()=>api('/api/companion/growth'));
    await dialog.locator('[data-pet-buy="scarf"]').click();
    await page.waitForFunction(()=>document.body.dataset.petAccessory === 'scarf');
    const bought = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(bought.stamps,before.stamps-80);
    assert.equal(bought.xp,before.xp);
    assert.equal(await dialog.locator('.pet-hero .growth-scarf').evaluate(n=>getComputedStyle(n).display),'block');
    await dialog.locator('[data-pet-buy="sky"]').click();
    await page.waitForFunction(()=>document.body.dataset.petPalette === 'sky');
    await dialog.locator('[data-pet-buy="berry"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStage === '4');
    assert.match(await dialog.textContent(),/星章邮差/);
    assert.match(await dialog.locator('.pet-milestone').textContent(),/新解锁/);
    await dialog.locator('[data-pet-buy="sparkles"]').click();
    await page.waitForFunction(()=>document.body.dataset.petEffect === 'sparkles');
    assert.equal(await dialog.locator('.pet-hero .growth-stars').evaluate(n=>getComputedStyle(n).animationName),'pet-twinkle');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await dialog.locator('.pet-hero .growth-stars').evaluate(n=>getComputedStyle(n).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>document.body.classList.add('companion-still'));
    assert.equal(await dialog.locator('.pet-hero .growth-stars').evaluate(n=>getComputedStyle(n).animationName),'none');
    await page.evaluate(()=>document.body.classList.remove('companion-still'));
    await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollTop=0);
    await page.waitForTimeout(350);
    await page.screenshot({path:'/tmp/mailai-pet-shop.png'});
    // Failed mutations keep the balance/outfit and surface the error.
    await page.route('**/api/companion/purchase',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({detail:'模拟兑换失败'})}));
    await dialog.locator('[data-pet-buy="peach"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-pet-message]')?.classList.contains('is-error'));
    assert.equal(await page.evaluate(()=>document.body.dataset.petPalette),'sky');
    await page.unroute('**/api/companion/purchase');
    // Pause survives reload and suppresses counters.
    await dialog.locator('[data-pet-enabled]').click();
    await page.waitForFunction(()=>document.querySelector('.pet-paused'));
    const paused = await page.evaluate(()=>api('/api/companion/growth'));
    const pauseTick = await page.evaluate(()=>api('/api/companion/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:crypto.randomUUID(),active:10,clicks:10})}));
    assert.deepEqual(pauseTick.today,paused.today);
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petPalette === 'sky');
    await page.evaluate(()=>window.mailaiPet.open());
    assert.match(await dialog.textContent(),/养成已暂停/);
    await dialog.locator('[data-pet-enabled]').click();
    await page.waitForFunction(()=>!document.querySelector('.pet-paused'));
    // Keyboard close, foreground reading and server-validated heartbeat.
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(),false);
    const readingOwner = await page.evaluate(()=>activeMailAccount().id);
    await page.locator(`.email-item[data-account-id="${readingOwner}"]`).first().click();
    await page.waitForFunction(()=>!!selectedEmailDetail);
    const beforeRead = await page.evaluate(()=>api('/api/companion/growth'));
    let afterRead;
    for (let attempt=0;attempt<25;attempt++) {
      await page.waitForTimeout(1000);
      afterRead = await page.evaluate(()=>api('/api/companion/growth'));
      if ((afterRead.today.counts.read || 0) > (beforeRead.today.counts.read || 0)) break;
    }
    assert((afterRead.today.counts.read || 0) > (beforeRead.today.counts.read || 0));
    assert(afterRead.today.counts.reading >= 8);
    // Learn an actual help topic while it remains expanded in the foreground.
    await page.evaluate(()=>showSystemView('guide'));
    const help = page.locator('.help-topic details').first();
    await help.locator('summary').click();
    let learned;
    for (let attempt=0;attempt<25;attempt++) {
      await page.waitForTimeout(1000);
      learned = await page.evaluate(()=>api('/api/companion/growth'));
      if (learned.today.counts.learn) break;
    }
    assert.equal(learned.today.counts.learn,1);
    assert(learned.quests.find(q=>q.id === 'student').complete);
    await page.evaluate(()=>hideSystemView(true));
    const beforeHidden = await page.evaluate(()=>api('/api/companion/growth'));
    // Native visibility is respected by the shared foreground scheduler.
    await page.evaluate(()=>window.mailaiEnergy.nativeVisibility(900,false));
    await page.waitForTimeout(11000);
    const hidden = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(hidden.today.counts.active,beforeHidden.today.counts.active);
    await page.evaluate(()=>window.mailaiEnergy.nativeVisibility(901,true));
    const resumed = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(resumed.today.counts.active,hidden.today.counts.active);
    await page.evaluate(()=>window.mailaiPet.open());
    await dialog.locator('[data-pet-tab="journey"]').click();
    await page.screenshot({path:'/tmp/mailai-pet-journey.png'});
    const beforeStyle = await page.evaluate(()=>api('/api/companion/growth'));
    await dialog.locator('[data-pet-style="ranger"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStyle === 'ranger');
    assert.match(await dialog.textContent(),/电光邮差/);
    assert.equal(await dialog.locator('.pet-hero .growth-flower').evaluate(n=>getComputedStyle(n).visibility),'hidden');
    assert.equal(await dialog.locator('.pet-hero .growth-ranger-brows').evaluate(n=>getComputedStyle(n).display),'block');
    const afterStyle = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(afterStyle.stamps,beforeStyle.stamps);
    assert.equal(afterStyle.xp,beforeStyle.xp);
    // Switching back restores cute details and keeps all earned/owned progress.
    await dialog.locator('[data-pet-style="nature"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStyle === 'nature');
    assert.equal(await dialog.locator('.pet-hero .growth-flower').evaluate(n=>getComputedStyle(n).visibility),'visible');
    assert.equal(await dialog.locator('.pet-hero .growth-ranger-brows').evaluate(n=>getComputedStyle(n).display),'none');
    const cute = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(cute.stamps,afterStyle.stamps);
    assert.equal(cute.xp,afterStyle.xp);
    assert.deepEqual(cute.equipped,afterStyle.equipped);
    await dialog.locator('[data-pet-style="ranger"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStyle === 'ranger');
    await dialog.locator('[data-pet-tab="shop"]').click();
    // CSS must respect redeemed palettes at EVERY stage, on BOTH routes.
    await page.emulateMedia({reducedMotion:'reduce'});
    const paletteMatrix = await page.evaluate(()=>{
      const body = document.body.dataset, saved = {...body}, results = [];
      try {
        for (const style of ['nature','ranger']) for (let stage=1;stage<=7;stage++) for (const palette of ['sky','peach','midnight']) {
          body.petStyle=style;body.petStage=String(stage);body.petPalette=palette;
          results.push({style,stage,palette,fill:getComputedStyle(document.querySelector('.pet-hero .growth-body')).fill});
        }
      } finally { Object.assign(body,saved); }
      return results;
    });
    for (const row of paletteMatrix) assert.equal(row.fill,{sky:'rgb(178, 215, 237)',peach:'rgb(241, 202, 185)',midnight:'rgb(106, 142, 172)'}[row.palette],JSON.stringify(row));
    const previews = await page.evaluate(()=>{
      const body=document.body.dataset,saved=body.petAccessory;
      try {
        body.petAccessory='cap';
        const crest=getComputedStyle(document.querySelector('[data-item-preview="scarf"] .growth-ranger-crest')).visibility;
        const cap=getComputedStyle(document.querySelector('[data-item-preview="cap"] .growth-ranger-crest')).visibility;
        body.petAccessory='satchel';
        const bag=getComputedStyle(document.querySelector('[data-item-preview="scarf"] .companion-bag rect')).fill;
        return {crest,cap,bag};
      } finally { body.petAccessory=saved; }
    });
    assert.deepEqual(previews,{crest:'visible',cap:'hidden',bag:'rgb(255, 245, 217)'},'Item previews must not inherit another equipped accessory');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await dialog.locator('[data-pet-buy="armor"]').click();
    await page.waitForFunction(()=>document.body.dataset.petAccessory === 'armor');
    await dialog.locator('[data-pet-buy="midnight"]').click();
    await page.waitForFunction(()=>document.body.dataset.petPalette === 'midnight');
    await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollTop=0);
    await page.waitForTimeout(250);
    await page.screenshot({path:'/tmp/mailai-pet-ranger.png'});
    // Live language changes render the entire journal, including dynamic goods.
    await page.evaluate(()=>setI18nLanguage('en'));
    await page.waitForFunction(()=>document.querySelector('#pet-journal-title')?.textContent === 'Growth journal');
    await dialog.locator('[data-pet-tab="shop"]').click();
    assert.match(await dialog.textContent(),/Messenger wings/);
    assert(!/[\u3400-\u9fff]/.test(await dialog.textContent()));
    await page.screenshot({path:'/tmp/mailai-pet-english.png'});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await page.screenshot({path:'/tmp/mailai-pet-dark-mobile.png'});
    assert(await dialog.evaluate(n=>n.scrollWidth <= n.clientWidth+1));
    assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth <= n.clientWidth+1));
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1280,height:900});
    // Switching accounts clears the previous companion immediately.
    await page.evaluate(async()=>{
      const config = await api('/api/system/config');
      const other = config.accounts.find(a=>!a.active);
      await api('/api/system/mail/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:other.id})});
      await loadSystemConfig();
    });
    await page.waitForFunction(()=>document.body.dataset.petStage === '1');
    assert.equal(await page.evaluate(()=>document.body.dataset.petPalette),'mint');
    await page.evaluate(()=>window.mailaiPet.open());
    const fresh = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(fresh.xp,0);
    assert.equal(fresh.stamps,0);
    assert.deepEqual(errors,[]);
    console.log('Pet journal: purchases, evolution, failure recovery, persistence, timers, motion, i18n, mobile and account isolation passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
