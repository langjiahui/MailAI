/* Dynamic reward previews never spend stamps or mutate the equipped outfit. */
const assert = require('node:assert/strict');
const {revealItem,selectTab}=require('./helpers/companion-ui.cjs');
const {chromium,webkit} = require('playwright');
(async()=>{
  const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(async()=>{
      setI18nLanguage('zh-CN');
      await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});
      await mailaiPet.refresh();await mailaiPet.open();
    });
    const before=await page.evaluate(()=>api('/api/companion/growth'));
    const dialog=page.locator('#companion-growth-dialog'), preview=dialog.locator('.pet-live-preview'),art=dialog.locator('.pet-center-companion .pet-live-art');
    await selectTab(dialog,'wardrobe');
    await revealItem(dialog,'wings');
    const select=preview.locator('[data-pet-preview-select]');
    assert(await preview.isHidden(),'Preview stays collapsed until an icon is clicked');
    const icon=dialog.locator('[data-pet-preview="wings"]');
    assert.equal((await icon.textContent()).trim(),'试穿','The artwork advertises try-on without adding a second button row');
    const iconBox=await icon.boundingBox(),artBox=await dialog.locator('[data-pet-item="wings"] .pet-item-art').boundingBox();
    assert(iconBox.width>=44&&iconBox.height>=44);assert(Math.abs(iconBox.width-artBox.width)<1&&Math.abs(iconBox.height-artBox.height)<1);
    const mutations=[];page.on('request',req=>{if(/\/api\/companion\/(purchase|equip|style)$/.test(req.url()))mutations.push(req.url());});
    assert(await dialog.locator('[data-pet-buy="wings"]').isDisabled(),'Locked wings must remain unpurchasable');
    await dialog.locator('[data-pet-preview="wings"]').click();
    assert.equal(await select.inputValue(),'wings');
    assert(await art.locator('.growth-wings').evaluate(n=>getComputedStyle(n).display!=='none'));
    await page.waitForFunction(()=>document.querySelector('.pet-live-art .mail-companion').dataset.rewardVisible==='true');
    const wing=art.locator('.pet-wing-left');
    const first=await wing.evaluate(n=>getComputedStyle(n).transform);
    // Rendering on a loaded CI host may not commit a frame within a fixed delay.
    // Still require an actual visible transform change, within a bounded wait.
    await page.waitForFunction(first=>getComputedStyle(document.querySelector('.pet-live-art .pet-wing-left')).transform!==first,first,{timeout:5000});
    assert.notEqual(await wing.evaluate(n=>getComputedStyle(n).transform),first,'Wing must visibly flap');
    await preview.locator('[data-pet-preview-play]').click();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.pet-live-art .pet-wing-left')).animationPlayState==='paused');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await art.locator('.companion-eyes').evaluate(n=>getComputedStyle(n).animationPlayState),'paused','Pause includes the normal blink');
    const frozen=await wing.evaluate(n=>getComputedStyle(n).transform);
    const frozenParts=await art.evaluate(host=>[...host.querySelectorAll('.growth-wings .pet-reward-motion')].map(n=>getComputedStyle(n).transform));
    await page.waitForTimeout(180);
    assert.equal(await wing.evaluate(n=>getComputedStyle(n).transform),frozen,'Pause must freeze the preview');
    assert.deepEqual(await art.evaluate(host=>[...host.querySelectorAll('.growth-wings .pet-reward-motion')].map(n=>getComputedStyle(n).transform)),frozenParts,'Pause freezes distal feather motion too');
    await preview.locator('[data-pet-preview-play]').click();
    const clips=new Set();
    for(const item of ['wings','mech_wings','sparkles','orbit','aurora','lightning','scarf','cap','satchel','visor','jacket','armor','sky','peach','midnight','berry','star_crest']) {
      await select.selectOption(item);
      await preview.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      const active=await art.evaluate(host=>[...host.querySelectorAll('.pet-reward-motion')].filter(n=>getComputedStyle(n).animationName!=='none'&&n.getClientRects().length).map(n=>({name:getComputedStyle(n).animationName,play:getComputedStyle(n).animationPlayState})));
      assert(active.length>0,`${item} must have its own visible animated details`);
      assert(active.every(n=>n.play==='running'),`${item} preview should run while visible`);
      active.forEach(n=>clips.add(n.name));
    }
    assert(clips.size>=12,'Rewards must offer distinct motion, not one shared opacity loop');
    await select.selectOption('orbit');
    const depth=await art.evaluate(host=>{
      const rear=host.querySelector('.pet-orbit-rear'), front=host.querySelector('.pet-orbit-front'), body=host.querySelector('.companion-figure');
      const rearStream=rear.querySelector('.pet-orbit-stream'), frontStream=front.querySelector('.pet-orbit-stream');
      return {
        rearBehind:!!(rear.compareDocumentPosition(body)&Node.DOCUMENT_POSITION_FOLLOWING),
        frontAhead:!!(body.compareDocumentPosition(front)&Node.DOCUMENT_POSITION_FOLLOWING),
        rearClip:getComputedStyle(rearStream).clipPath, frontClip:getComputedStyle(frontStream).clipPath,
        offsetGap:Math.abs(parseFloat(getComputedStyle(rearStream).strokeDashoffset)-parseFloat(getComputedStyle(frontStream).strokeDashoffset)),
      };
    });
    assert(depth.rearBehind&&depth.frontAhead,'Orbit must pass behind and in front of the body');
    assert.notEqual(depth.rearClip,'none');assert.notEqual(depth.frontClip,'none');assert.notEqual(depth.rearClip,depth.frontClip);
    assert(depth.offsetGap<.1,'Front/rear orbit trails must join without a phase jump');
    await select.selectOption('sparkles');
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(1000,false));
    assert.equal(await art.locator('.pet-star').first().evaluate(n=>getComputedStyle(n).animationName),'none','Native hidden windows stop the new layers');
    await page.evaluate(()=>mailaiEnergy.nativeVisibility(1001,true));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.querySelector('[data-pet-preview-play]').disabled);
    assert(await preview.locator('[data-pet-preview-play]').isDisabled());
    assert.equal(await art.locator('.pet-star').first().evaluate(n=>getComputedStyle(n).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>document.body.classList.add('companion-still'));
    await page.waitForFunction(()=>document.querySelector('[data-pet-preview-play]').disabled);
    assert(await preview.locator('[data-pet-preview-play]').isDisabled());
    await page.evaluate(()=>document.body.classList.remove('companion-still'));
    await preview.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.pet-live-art .pet-star')).animationPlayState==='running',null,{timeout:5000});
    const running=await art.locator('.pet-star').first().evaluate(n=>getComputedStyle(n).animationPlayState);
    assert.equal(running,'running');
    const originalAppearance=await page.evaluate(()=>({...document.body.dataset}));
    await preview.locator('[data-pet-preview-close]').click();
    await selectTab(dialog,'home');
    await page.evaluate(()=>delete document.body.dataset.petOutfits);
    await dialog.locator('.pet-hero-portrait').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('.pet-hero-portrait .mail-companion').dataset.rewardVisible==='true');
    for(const style of ['nature','ranger']) {
      for(const [slot,item,part] of [['petAccessory','wings','.pet-wing-left'],['petAccessory','mech_wings','.pet-mech-left'],['petEffect','sparkles','.pet-star'],['petEffect','orbit','.pet-orbit-stream'],['petEffect','aurora','.pet-aurora-ripple'],['petEffect','lightning','.pet-bolt']]) {
        await page.evaluate(({style,slot,item})=>{document.body.dataset.petStyle=style;document.body.dataset[slot]=item;},{style,slot,item});
        assert(await page.evaluate(()=>mailaiCompanionMotion.react('peek',document.querySelector('.pet-hero-portrait'))),'Visible equipped creature starts a finite reaction');
        const node=dialog.locator('.pet-hero-portrait .mail-companion '+part).first();
        assert.notEqual(await node.evaluate(n=>getComputedStyle(n).animationName),'none',`${style}/${item} must animate when equipped on the real companion`);
      }
    }
    await page.evaluate(saved=>Object.assign(document.body.dataset,saved),originalAppearance);
    await selectTab(dialog,'wardrobe');
    await revealItem(dialog,'sparkles');
    await dialog.locator('[data-pet-preview="sparkles"]').click();
    await art.evaluate(n=>n.style.transform='translateX(-200vw)');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.pet-live-art .pet-star')).animationPlayState==='paused',null,{timeout:5000});
    assert.equal(await art.locator('.pet-star').first().evaluate(n=>getComputedStyle(n).animationPlayState),'paused','Offscreen preview must stop');
    await art.evaluate(n=>n.style.transform='');
    await preview.scrollIntoViewIfNeeded();
    await page.evaluate(()=>setI18nLanguage('en'));
    assert(!/[\u3400-\u9fff]/.test(await preview.textContent()),'Preview must be fully localized');
    await page.setViewportSize({width:390,height:844});
    await preview.scrollIntoViewIfNeeded();
    assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before,'Previewing must keep the exact saved state');
    assert.deepEqual(mutations,[],'Previews must not call purchase, equip or style APIs');
    await page.setViewportSize({width:1280,height:1000});
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await select.selectOption('mech_wings');await preview.scrollIntoViewIfNeeded();
    await page.screenshot({path:'/tmp/mailai-reward-motion-preview.png'});
    const closed=await art.locator('svg').elementHandle();
    await preview.locator('[data-pet-preview-close]').click();
    assert(await preview.isHidden());
    assert(await closed.evaluate(svg=>!svg.isConnected && svg.getAnimations({subtree:true}).every(a=>a.playState!=='running')),'Closing try-on disposes all preview clocks');
    await dialog.locator('.pet-shop-item:not([hidden])').first().scrollIntoViewIfNeeded();
    await page.screenshot({path:'/tmp/mailai-reward-preview-icons.png'});
    assert.deepEqual(errors,[]);
    console.log('Reward motion: 17 outfits, unique animations, locked preview, no spending/equipping, pause, visibility, reduced motion, i18n and mobile passed');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
