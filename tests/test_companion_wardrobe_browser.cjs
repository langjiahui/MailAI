/* Fitting-room actions reuse the real rig without buying or changing growth. */
const assert=require('node:assert/strict');
const {revealItem}=require('./helpers/companion-ui.cjs');
const {auditSpaceThemes}=require('./helpers/companion-themes.cjs');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium,webkit}=require('playwright');
const port=Number(process.env.MAILAI_WARDROBE_FIXTURE_PORT||18863);
(async()=>{
 const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'.venv-build/bin/python',['tests/workspace_preview.py'],{env:{...process.env,MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let logs='',browser;fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
 try {
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}await new Promise(r=>setTimeout(r,100));}assert(ready,logs);
  for(const engine of [chromium,webkit]) {
   browser=await engine.launch();const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}`);await page.locator('#app-preloader').waitFor({state:'hidden'});
   await page.evaluate(async()=>{await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});await mailaiPet.refresh();await mailaiPet.open();});
   const before=await page.evaluate(()=>api('/api/companion/growth')),mutations=[];
   page.on('request',r=>{if(/\/api\/companion\/(purchase|equip|style)$/.test(r.url()))mutations.push(r.url());});
   const dialog=page.locator('#companion-growth-dialog'),preview=dialog.locator('.pet-live-preview'),art=dialog.locator('.pet-center-companion .pet-live-art');
   await dialog.locator('[data-pet-tab="shop"]').click();
   assert.equal(await dialog.locator('[data-pet-series]').count(),3);
   await dialog.locator('[data-pet-tab="wardrobe"]').click();
   assert.equal(await dialog.locator('.pet-shop-item').count(),17);
   for(const [filter,count] of [['palette',3],['accessory',9],['effect',4],['owned',0],['all',17]]) {
    await dialog.locator(`[data-pet-shop-filter="${filter}"]`).click();assert.equal(await dialog.locator('.pet-shop-item').count(),count);
   }
   await dialog.locator('[data-pet-shop-filter="available"]').click();
   const available=before.items.filter(item=>item.slot!=='theme'&&!item.owned&&item.stage<=before.stage&&item.cost<=before.stamps&&!(item.id==='berry'&&before.berry_today>=3));
   assert.equal(await dialog.locator('.pet-shop-item').count(),available.length);
   if(!available.length){assert(await dialog.locator('.pet-shop-empty').isVisible());await dialog.locator('[data-pet-browse-all]').click();}
   else await dialog.locator('[data-pet-shop-filter="all"]').click();
   assert.equal(await dialog.locator('.pet-shop-wallet b').textContent(),before.stamps.toLocaleString());
   assert.equal(await dialog.locator('.pet-wearing-slots>div').count(),6);
   const scarf=before.items.find(item=>item.id==='scarf');
   if(before.stamps<scarf.cost){
    const card=dialog.locator('[data-pet-item="scarf"]');assert.equal(await card.getAttribute('data-item-state'),'short');
    assert.match(await card.locator('.pet-item-price small').textContent(),new RegExp(String(scarf.cost-before.stamps)));
   }
   const tryOn=dialog.locator('[data-pet-preview="scarf"]');
   const hitBox=await tryOn.boundingBox(),artBox=await dialog.locator('[data-pet-item="scarf"] .pet-item-art').boundingBox();
   assert(hitBox.width>=44&&hitBox.height>=44);
   assert(Math.abs(hitBox.width-artBox.width)<1&&Math.abs(hitBox.height-artBox.height)<1,'The whole artwork opens try-on');
   await tryOn.click();
   assert.equal(await preview.locator('.pet-fitting-extras').evaluate(n=>n.open),false,'Stage and move controls stay secondary');
   assert.equal(await preview.locator('[data-requirement="stage"]').getAttribute('data-ready'),String(before.stage>=scarf.stage));
   assert.equal(await preview.locator('[data-requirement="balance"]').getAttribute('data-ready'),String(before.stamps>=scarf.cost));
   await revealItem(dialog,'mech_wings');
   assert(await dialog.locator('[data-pet-buy="mech_wings"]').isDisabled(),'Future reward stays locked');
   await dialog.locator('[data-pet-tab="shop"]').click();
   await dialog.locator('[data-pet-series="star"]').click();
   await dialog.locator('[data-pet-preview="mech_wings"]').click();assert(await preview.isVisible());
   const choice=preview.locator('[data-pet-preview-select]'),stageChoice=preview.locator('[data-pet-preview-stage]');
   assert(await preview.locator('[data-pet-earn]').isVisible());
   await preview.locator('[data-pet-earn]').scrollIntoViewIfNeeded();
   const savedScroll=await dialog.locator('.pet-tab-content').evaluate(n=>n.scrollTop);
   await preview.locator('[data-pet-earn]').click();
   assert(await dialog.locator('.pet-earn-return').isVisible());assert.equal(await dialog.getAttribute('data-pet-view'),'today');
   assert.equal(await dialog.locator('.pet-quests .pet-quest').count(),before.quests.length);
   await page.evaluate(()=>setI18nLanguage('en'));assert(!/[\u3400-\u9fff]/.test(await dialog.locator('.pet-earn-return').textContent()));
   await page.evaluate(()=>setI18nLanguage('zh-CN'));
   await dialog.locator('[data-pet-return-shop]').click();
   assert.equal(await dialog.getAttribute('data-pet-view'),'wardrobe');assert.equal(await choice.inputValue(),'mech_wings');
   assert(await page.evaluate(()=>document.activeElement?.hasAttribute('data-pet-earn')),'Returning to a locked look restores focus to the visible next step');
   assert(Math.abs((await dialog.locator('.pet-tab-content').evaluate(n=>n.scrollTop))-savedScroll)<2,'Returning from goals preserves the shopping position');
   await preview.locator('.pet-fitting-extras summary').click();
   await stageChoice.selectOption('7');
   assert(await preview.locator('[data-pet-reset-stage]').isVisible());
   await preview.locator('[data-pet-reset-stage]').click();assert.equal(await stageChoice.inputValue(),String(before.stage));
   assert.equal(await preview.locator('[data-pet-reset-stage]').count(),0);
   assert.equal(await choice.inputValue(),'mech_wings');
   assert(await preview.locator('[data-pet-preview-action="mech_wings"]').isDisabled(),'Preview cannot purchase a locked reward');
   for(const route of ['nature','ranger']) {
    await page.evaluate(route=>document.body.dataset.petStyle=route,route);
    for(let stage=1;stage<=7;stage++) {
     await stageChoice.selectOption(String(stage));
     assert.equal(await art.locator('svg.mail-companion').getAttribute('data-evolution-stage'),String(stage));
     await preview.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.pet-live-art svg').dataset.rewardVisible==='true');
     await preview.locator('[data-pet-try-action="signature"]').click();
     const clip=await art.locator('svg.mail-companion').getAttribute('data-motion-clip');
     assert.equal(clip,await page.evaluate(n=>mailaiCompanionMotion.signature(n),stage));
     const joints=await art.evaluate(host=>{
      const svg=host.querySelector('svg'),torso=svg.querySelector('.companion-torso');
      const distance=(selector,x,y)=>{const p=new DOMPoint(x,y),a=p.matrixTransform(svg.querySelector(selector).getCTM()),b=p.matrixTransform(torso.getCTM());return Math.hypot(a.x-b.x,a.y-b.y);};
      return [distance('.companion-carry',84,66),distance('.companion-arm-left',31,63)];
     });assert(joints.every(n=>n<.05),'Action keeps both shoulders attached');
    }
   }
   const ids=before.items.filter(i=>i.slot!=='theme').map(i=>i.id);
   for(const id of ids){await choice.selectOption(id);await preview.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.pet-live-art svg').dataset.rewardVisible==='true');
    assert(await art.locator('.pet-reward-motion').evaluateAll(nodes=>nodes.some(n=>n.getClientRects().length&&getComputedStyle(n).animationName!=='none')),`${id} has a live reward detail`);
   }
   await choice.selectOption('wings');await preview.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.pet-live-art svg').dataset.rewardVisible==='true');
   await preview.locator('[data-pet-try-action="travel"]').click();assert.equal(await art.locator('svg.mail-companion').getAttribute('data-motion-clip'),'swim');
   await preview.locator('[data-pet-preview-play]').click();
   assert.equal(await art.locator('svg.mail-companion').getAttribute('data-motion-clip'),null,'Pause stops body choreography too');
   await preview.locator('[data-pet-try-action="greet"]').click();
   await page.evaluate(()=>mailaiEnergy.nativeVisibility(1000,false));
   assert.equal(await art.locator('svg.mail-companion').getAttribute('data-motion-clip'),null,'Hidden windows cancel finite actions');
   await page.evaluate(()=>mailaiEnergy.nativeVisibility(1001,true));
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.waitForFunction(()=>document.querySelector('[data-pet-try-action="signature"]').disabled);
   assert(await preview.locator('[data-pet-try-action="signature"]').isDisabled());
   await page.emulateMedia({reducedMotion:'no-preference'});
   await page.evaluate(()=>setI18nLanguage('en'));assert(!/[\u3400-\u9fff]/.test(await dialog.locator('.pet-tab-content').textContent()),'New shop copy is localized');
   await page.setViewportSize({width:390,height:844});await preview.scrollIntoViewIfNeeded();
   assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
   await page.evaluate(()=>document.documentElement.dataset.theme='dark');
   await page.screenshot({path:`output/xiaoyou-evolution/wardrobe-mobile-${engine.name()}.png`});
   const fresh=await page.evaluate(()=>api('/api/companion/growth'));assert.deepEqual(fresh,before);assert.deepEqual(mutations,[]);
   await dialog.locator('[data-pet-tab="journey"]').click();assert.equal(await dialog.locator('[data-pet-try-stage]').count(),7);
   await dialog.locator('[data-pet-journey-stage="7"]').click();
   await dialog.locator('[data-pet-try-stage="7"]').click();assert.equal(await stageChoice.inputValue(),'7');
   await page.evaluate(()=>window.closedFittingRig=document.querySelector('.pet-live-art svg'));
   await dialog.locator('[data-pet-close]').click();assert.equal(await page.evaluate(()=>closedFittingRig.dataset.motionClip||null),null);
   await page.evaluate(()=>{document.documentElement.style.setProperty('--fz','1');document.body.style.zoom='1';});
   await page.setViewportSize({width:1440,height:1000});
   await page.evaluate(()=>mailaiPet.open());
   await dialog.locator('[data-pet-tab="shop"]').click();
   await dialog.locator('[data-pet-series="star"]').click();
   for(const language of ['zh-CN','en'])for(const theme of ['light','dark'])for(const reward of ['','theme_monochrome','theme_baowu']) {
    await page.evaluate(({language,theme,reward})=>{setI18nLanguage(language);document.documentElement.dataset.theme=theme;document.documentElement.dataset.rewardTheme=reward;},{language,theme,reward});
    for(const [width,height,scale]of [[1440,1000,1],[1280,900,1.5],[800,650,1],[390,844,1],[390,844,1.35],[360,740,2]]) {
     await page.setViewportSize({width,height});
     await page.evaluate(scale=>{document.documentElement.style.setProperty('--fz',scale);document.body.style.zoom=String(scale);},scale);
     const bounds=await dialog.evaluate(d=>{
      const body=d.querySelector('.pet-journal-body'),main=d.querySelector('.pet-center-main'),nav=d.querySelector('.pet-tabs');
      return {dialog:d.scrollWidth<=d.clientWidth+1,body:body.scrollWidth<=body.clientWidth+1,main:main.scrollWidth<=main.clientWidth+1,bounded:body.scrollHeight<=body.clientHeight+1,nav:nav.getBoundingClientRect().bottom<=body.getBoundingClientRect().bottom+1};
     });
     assert(Object.values(bounds).every(Boolean),JSON.stringify({language,theme,reward,width,height,scale,bounds}));
     assert(await dialog.locator('[data-pet-wear-collection="star"]').isDisabled(),'An unowned full-set preview cannot equip or buy items');
    }
   }
   await page.evaluate(()=>{document.documentElement.style.setProperty('--fz','1');document.body.style.zoom='1';setI18nLanguage('zh-CN');});
   await page.setViewportSize({width:1280,height:1000});
   assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before,'Layout and full-set previews never mutate progress');
   await auditSpaceThemes(page,dialog);
   // Synthetic owned equipment exercises composition without changing inventory.
   const fitted={...before,style:'nature',equipped:{accessory:'scarf',palette:'sky',effect:'sparkles'},items:before.items.map(item=>({...item,owned:['scarf','sky','sparkles'].includes(item.id)||item.owned}))};
   await page.route('**/api/companion/growth',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(fitted)}));
   await page.evaluate(async()=>{await mailaiPet.refresh();await mailaiPet.open();});
   await revealItem(dialog,'cap');
   await dialog.locator('[data-pet-preview="cap"]').click();
   const display=selector=>art.locator(selector).first().evaluate(n=>getComputedStyle(n).display);
   const bodyColor=()=>art.locator('.mail-companion').evaluate(n=>getComputedStyle(n).getPropertyValue('--pet-body').trim());
   assert.equal(await display('.growth-cap'),'block');assert.equal(await display('.growth-scarf'),'block','Headwear combines with the equipped scarf');
   assert.equal(await display('.growth-stars'),'block');
   const skyColor=await art.locator('.mail-companion').evaluate(n=>getComputedStyle(n).getPropertyValue('--pet-body').trim());
   assert.equal(await bodyColor(),skyColor,'Accessory try-on keeps the equipped palette');
   await preview.locator('[data-pet-preview-select]').selectOption('peach');
   assert.equal(await display('.growth-scarf'),'block');assert.equal(await display('.growth-stars'),'block');
   assert.notEqual(await bodyColor(),skyColor,'Palette try-on replaces only the palette');
   await preview.locator('[data-pet-preview-select]').selectOption('orbit');
   assert.equal(await display('.growth-orbit'),'block');assert.equal(await display('.growth-stars'),'none');
   assert.equal(await display('.growth-scarf'),'block');assert.equal(await bodyColor(),skyColor);
   await preview.locator('[data-pet-preview-mode="single"]').click();
   assert.equal(await display('.growth-orbit'),'block');assert.equal(await display('.growth-scarf'),'none');
   assert.notEqual(await bodyColor(),skyColor,'Single-item mode uses the original palette');
   assert.equal(await preview.locator('[data-pet-preview-mode="single"]').getAttribute('aria-pressed'),'true');
   // Both creature routes keep costume wings, head leaves and bag materials scoped.
   for(const style of ['nature','ranger']) {
    fitted.style=style;
    await page.evaluate(()=>mailaiPet.refresh());
    await preview.locator('[data-pet-preview-mode="combined"]').click();
    assert.equal(await bodyColor(),skyColor,'Both creature routes preserve the purchased palette');
    if(await preview.locator('[data-pet-preview-play]').getAttribute('aria-pressed')==='true')await preview.locator('[data-pet-preview-play]').click();
    await preview.locator('[data-pet-preview-mode="single"]').click();
    assert.equal(await preview.locator('[data-pet-preview-play]').getAttribute('aria-pressed'),'false','Changing mode respects paused motion');
    await preview.locator('[data-pet-preview-mode="combined"]').click();
    assert.equal(await preview.locator('[data-pet-preview-play]').getAttribute('aria-pressed'),'false');
    for(const accessory of ['cap','wings','mech_wings','satchel']) {
     fitted.equipped.accessory=accessory;await page.evaluate(()=>mailaiPet.refresh());
     await preview.locator('[data-pet-preview-mode="combined"]').click();
     const target={cap:'.growth-cap',wings:'.growth-wings',mech_wings:'.growth-mech-wings',satchel:'.growth-postbag'}[accessory];
     assert.equal(await display(target),'block');
     assert.equal(await art.locator('.companion-leaves').first().evaluate(n=>getComputedStyle(n).visibility),accessory==='cap'?'hidden':'visible');
     assert.equal(await art.locator('.evolution-peng-wing').first().evaluate(n=>getComputedStyle(n).visibility),['wings','mech_wings'].includes(accessory)?'hidden':'visible');
     await preview.locator('[data-pet-preview-mode="single"]').click();assert.equal(await display(target),'none');
     assert.equal(await art.locator('.companion-leaves').first().evaluate(n=>getComputedStyle(n).visibility),'visible');
     assert.equal(await art.locator('.evolution-peng-wing').first().evaluate(n=>getComputedStyle(n).visibility),'visible');
    }
   }
   await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.evaluate(()=>setI18nLanguage('en'));
   assert(!/[\u3400-\u9fff]/.test(await dialog.locator('.pet-tab-content').textContent()));
   assert(await dialog.locator('.pet-journal-body').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
   assert.deepEqual(mutations,[],'Mode switching and composed try-ons never purchase or equip');
   await page.unroute('**/api/companion/growth');
   assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before);
   assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: wardrobe filters, 17 rewards, 14 stage actions, joints, no spending, pause/hide, localization, mobile and journey preview`);
   await browser.close();browser=null;
  }
 }finally{if(browser)await browser.close();const done=once(fixture,'exit');fixture.kill('SIGTERM');await done;}
})().catch(e=>{console.error(e);process.exitCode=1;});
