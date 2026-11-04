/* Run MAILAI_GROWTH_FIXTURE=1 python tests/workspace_preview.py first. */
const assert = require('node:assert/strict');
const {revealItem,selectTab}=require('./helpers/companion-ui.cjs');
const {selectItem,redeemItem,removeItem}=require('./helpers/companion-backpack.cjs');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(process.env.MAILAI_TEST_BASE_URL || 'http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage === '3');
    await page.locator('#assistant-orb').click();
    await page.locator('#companion-growth-launch').click();
    const dialog = page.locator('#companion-growth-dialog');
    await dialog.waitFor({state:'visible'});
    assert.match(await dialog.textContent(),/青羽信使/);
    await selectTab(dialog,'settings');
    assert.match(await dialog.locator('.pet-settings-note').textContent(),/所有邮箱共用同一个小邮/);
    await selectTab(dialog,'home');
    assert.equal(await dialog.locator('.pet-hero .evolution-crest-one').evaluate(n=>getComputedStyle(n).display),'block');
    await selectTab(dialog,'wardrobe');
    await selectItem(dialog,'wings');assert.equal(await dialog.locator('[data-pet-purchase-open="wings"]').isEnabled(),false);
    const before = await page.evaluate(()=>api('/api/companion/growth'));
    // Passive activity may earn stamps during a slower CI render. Compare net
    // spend, not the wallet alone, so an exact debit is still required.
    const spent=profile=>profile.earned-profile.stamps;
    await selectItem(dialog,'scarf');
    assert.match(await dialog.locator('[data-pet-purchase-open="scarf"]').textContent(),/80.*兑换并穿戴/,'Cost and immediate equipping are explained before confirmation');
    const purchase=await redeemItem(dialog,'scarf');
    await page.waitForFunction(()=>document.body.dataset.petAccessory === 'scarf');
    const bought = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(spent(bought)-spent(before),80);
    assert.equal(bought.xp-before.xp,bought.today.xp-before.today.xp,'Purchasing adds no XP beyond recorded activity awards');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.petItemAction),'scarf','Card redemption keeps keyboard focus on the newly owned outfit');
    assert.match(await dialog.locator('[data-pet-message]').textContent(),new RegExp(`80.*${purchase.stamps}`),'Receipt shows the actual purchase cost and remaining balance');
    // The actual portrait, free removal and direct re-equipping share one page.
    assert.equal(await dialog.locator('.pet-hero .growth-scarf').evaluate(n=>getComputedStyle(n).display),'block');
    await removeItem(dialog,'scarf');
    await page.waitForFunction(()=>document.body.dataset.petAccessory==='none');
    assert.equal(spent(await page.evaluate(()=>api('/api/companion/growth'))),spent(bought),'Removing an owned outfit is free');
    assert.match(await dialog.locator('[data-pet-message]').textContent(),/已取下.*不花费/);
    await selectItem(dialog,'scarf');
    await page.waitForFunction(()=>document.body.dataset.petAccessory==='scarf');
    assert.equal(spent(await page.evaluate(()=>api('/api/companion/growth'))),spent(bought),'Direct re-equipping is free');
    const skyPurchase=await redeemItem(dialog,'sky');
    await page.waitForFunction(()=>document.body.dataset.petPalette === 'sky');
    const skyBought=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(spent(skyBought)-spent(bought),120);
    assert.match(await dialog.locator('[data-pet-message]').textContent(),new RegExp(`120.*${skyPurchase.stamps}`));
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.match(await dialog.locator('[data-pet-message]').textContent(),/Redemption confirmed:/);
    assert(!/[\u3400-\u9fff]/.test(await dialog.textContent()));
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await selectItem(dialog,'scarf');assert.equal(await dialog.locator('[data-pet-message]').count(),1);
    await selectItem(dialog,'sky');assert.equal(await dialog.locator('[data-pet-message]').count(),1,'Selecting the receipt item never duplicates feedback');
    await selectItem(dialog,'peach');await dialog.locator('[data-pet-trial-end]').click();
    assert.equal(await dialog.locator('[data-pet-message]').count(),1,'Ending a trial keeps a single purchase result');
    await redeemItem(dialog,'berry');
    await page.waitForFunction(()=>document.body.dataset.petStage === '4');
    assert.match(await dialog.textContent(),/灵羽伙伴/);
    assert.match(await dialog.locator('.pet-milestone').textContent(),/新解锁/);
    await dialog.locator('[data-pet-shop-filter="available"]').click();
    await redeemItem(dialog,'sparkles');
    await page.waitForFunction(()=>document.body.dataset.petEffect === 'sparkles');
    assert.equal(await dialog.locator('[data-pet-item="sparkles"]').count(),0,'Redeemed items leave the ready-to-redeem shelf');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.petShopFilter),'available','When the purchased card disappears, focus returns to its filter');
    await dialog.locator('[data-pet-shop-filter="all"]').click();
    // Equipped effects rest between finite interactions; only a visible reaction
    // should start their clocks. Background launchers stay quiet behind a dialog.
    // The actual equipped companion lives on the home page; browsing now
    // leaves the width to the shelf. All effect assertions still use the live rig.
    await selectTab(dialog,'home');
    await page.waitForFunction(()=>document.querySelector('.pet-hero .mail-companion').dataset.rewardVisible==='true');
    await page.waitForFunction(()=>document.querySelector('.pet-hero .mail-companion').dataset.motionActive==='false',null,{timeout:4000});
    assert.equal(await dialog.locator('.pet-hero .pet-star').first().evaluate(n=>getComputedStyle(n).animationName),'none');
    assert(await page.evaluate(()=>mailaiCompanionMotion.react('star',document.querySelector('.pet-hero-portrait'))));
    assert.equal(await dialog.locator('.pet-hero .pet-star').first().evaluate(n=>getComputedStyle(n).animationName),'pet-starlight');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>{const star=document.querySelector('.pet-hero .pet-star');return star && getComputedStyle(star).animationName==='none';});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>document.body.classList.add('companion-still'));
    await page.waitForFunction(()=>{const star=document.querySelector('.pet-hero .pet-star');return star && getComputedStyle(star).animationName==='none';});
    await page.evaluate(()=>document.body.classList.remove('companion-still'));
    await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollTop=0);
    await page.waitForTimeout(350);
    await page.screenshot({path:'/tmp/mailai-pet-shop.png'});
    // Failed mutations keep the balance/outfit and surface the error.
    await revealItem(dialog,'peach');
    await page.route('**/api/companion/purchase',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({detail:'模拟兑换失败'})}));
    await redeemItem(dialog,'peach');
    await page.waitForFunction(()=>document.querySelector('[data-pet-message]')?.classList.contains('is-error'));
    assert.equal(await page.evaluate(()=>document.body.dataset.petPalette),'sky');
    assert(!/已兑换|Redemption confirmed/.test(await dialog.locator('[data-pet-message]').textContent()),'Failed purchase never leaves a success receipt');
    await page.unroute('**/api/companion/purchase');
    // Pause survives reload and suppresses counters.
    await selectTab(dialog,'settings');
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
    await selectTab(dialog,'settings');
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
    await selectTab(dialog,'journey');
    await page.screenshot({path:'/tmp/mailai-pet-journey.png'});
    const beforeStyle = await page.evaluate(()=>api('/api/companion/growth'));
    await selectTab(dialog,'settings');
    await dialog.locator('[data-pet-style="ranger"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStyle === 'ranger');
    await selectTab(dialog,'home');
    assert.match(await dialog.textContent(),/星翼伙伴/);
    assert.equal(await dialog.locator('.pet-hero .evolution-crest-one').evaluate(n=>n.getBoundingClientRect().width>0),false);
    assert.equal(await dialog.locator('.pet-hero .evolution-fish-fin').evaluate(n=>getComputedStyle(n).display),'block');
    const afterStyle = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(spent(afterStyle),spent(beforeStyle));
    assert.equal(afterStyle.xp-beforeStyle.xp,afterStyle.today.xp-beforeStyle.today.xp);
    // Switching back restores cute details and keeps all earned/owned progress.
    await selectTab(dialog,'settings');
    await dialog.locator('[data-pet-style="nature"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStyle === 'nature');
    await selectTab(dialog,'home');
    assert.equal(await dialog.locator('.pet-hero .evolution-crest-one').evaluate(n=>n.getBoundingClientRect().width>0),true);
    assert.equal(await dialog.locator('.pet-hero .evolution-star-mark').evaluate(n=>getComputedStyle(n).display),'none');
    const cute = await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(spent(cute),spent(afterStyle));
    assert.equal(cute.xp-afterStyle.xp,cute.today.xp-afterStyle.today.xp);
    assert.deepEqual(cute.equipped,afterStyle.equipped);
    await selectTab(dialog,'settings');
    await dialog.locator('[data-pet-style="ranger"]').click();
    await page.waitForFunction(()=>document.body.dataset.petStyle === 'ranger');
    await selectTab(dialog,'home');
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
    for (const row of paletteMatrix) assert.equal(row.fill,{sky:'rgb(141, 196, 229)',peach:'rgb(229, 177, 187)',midnight:'rgb(167, 177, 212)'}[row.palette],JSON.stringify(row));
    await selectTab(dialog,'wardrobe');
    await selectItem(dialog,'cap');
    const capPreview=await dialog.locator('.pet-live-art .companion-leaves').first().evaluate(n=>getComputedStyle(n).visibility);
    assert.equal(capPreview,'hidden','Headwear trial hides the base leaf');
    await dialog.locator('[data-pet-trial-end]').click();
    assert.equal(await dialog.locator('.pet-live-art .companion-bag rect').first().evaluate(n=>getComputedStyle(n).fill.replace(/url\(.*#([^\"')]+)[\"']?\)/,'$1')),'pet-letter','Trial does not inherit the other item bag material');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await revealItem(dialog,'armor');
    await redeemItem(dialog,'armor');
    await page.waitForFunction(()=>document.body.dataset.petAccessory === 'armor');
    await revealItem(dialog,'midnight');
    await redeemItem(dialog,'midnight');
    await page.waitForFunction(()=>document.body.dataset.petPalette === 'midnight');
    await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollTop=0);
    await page.waitForTimeout(250);
    await page.screenshot({path:'/tmp/mailai-pet-ranger.png'});
    // Live language changes render the entire journal, including dynamic goods.
    await page.evaluate(()=>setI18nLanguage('en'));
    await page.waitForFunction(()=>document.querySelector('#pet-journal-title')?.textContent === 'XiaoYou');
    await selectTab(dialog,'wardrobe');
    assert.match(await dialog.textContent(),/Sunlit messenger wings/);
    assert(!/[\u3400-\u9fff]/.test(await dialog.textContent()));
    await page.screenshot({path:'/tmp/mailai-pet-english.png'});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await page.screenshot({path:'/tmp/mailai-pet-dark-mobile.png'});
    assert(await dialog.evaluate(n=>n.scrollWidth <= n.clientWidth+1));
    assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth <= n.clientWidth+1));
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1280,height:900});
    // Freeze legitimate heartbeat changes while checking exact client-wide
    // state equality; live heartbeat accumulation is exercised above.
    await page.evaluate(async()=>{
      await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});
      await mailaiPet.refresh();
    });
    // Switching mailboxes retains the client companion and its outfit.
    const shared = await page.evaluate(()=>api('/api/companion/growth'));
    await page.evaluate(async()=>{
      const config = await api('/api/system/config');
      const other = config.accounts.find(a=>!a.active);
      await api('/api/system/mail/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:other.id})});
      await loadSystemConfig();
    });
    await page.waitForFunction(stage=>document.body.dataset.petStage === String(stage),shared.stage);
    assert.equal(await page.evaluate(()=>document.body.dataset.petPalette),shared.equipped.palette || 'mint');
    await page.evaluate(()=>window.mailaiPet.open());
    const fresh = await page.evaluate(()=>api('/api/companion/growth'));
    await selectTab(dialog,'settings');
    assert.match(await dialog.locator('.pet-settings-note').textContent(),/All mailboxes share the same companion/);
    assert.deepEqual(fresh,shared);
    await page.evaluate(async()=>{
      await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});
      await mailaiPet.refresh();
    });
    assert.deepEqual(errors,[]);
    console.log('Pet journal: purchases, evolution, failure recovery, persistence, timers, motion, i18n, mobile and client-wide sharing passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
