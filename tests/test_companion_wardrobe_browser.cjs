/* Fitting-room actions reuse the real rig without buying or changing growth. */
const assert=require('node:assert/strict');
const {revealItem,selectTab}=require('./helpers/companion-ui.cjs');
const {openStageFitting}=require('./helpers/companion-backpack.cjs');
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
   await page.evaluate(async()=>{setI18nLanguage('zh-CN');await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});await mailaiPet.refresh();await mailaiPet.open();});
   const before=await page.evaluate(()=>api('/api/companion/growth')),mutations=[];
   page.on('request',r=>{if(/\/api\/companion\/(purchase|equip|style)$/.test(r.url()))mutations.push(r.url());});
   const dialog=page.locator('#companion-growth-dialog'),preview=dialog.locator('.pet-live-preview'),art=dialog.locator('.pet-center-companion .pet-live-art');
   assert.equal(await dialog.locator('.pet-primary-nav button').count(),3);
   assert.equal(await dialog.locator('.pet-secondary-nav button').count(),3);
   assert.equal(await dialog.locator('.pet-tabs button').count(),3);
   assert.equal(await dialog.locator('.pet-tabs details').count(),0,'Three space sections stay directly visible');
   assert.equal(await dialog.getAttribute('data-pet-view'),'home');
   assert.equal(await dialog.locator('.pet-home-hero .pet-hero-portrait').count(),1);
   for(const name of ['home','dress','growth'])assert(await dialog.locator(`[data-pet-section="${name}"]`).isVisible());
   for(const name of ['gifts','themes','settings'])assert(await dialog.locator(`[data-pet-tab="${name}"]`).isVisible());
   // Settings show both real routes and keep preference controls compact.
   await selectTab(dialog,'settings');
   assert.equal(await dialog.locator('.pet-settings-style').count(),2);
   for(const style of ['nature','ranger']){
    const shape=await dialog.locator(`[data-style-preview="${style}"]`).evaluate(n=>({nature:getComputedStyle(n.querySelector('.companion-nature-only')).display,ranger:getComputedStyle(n.querySelector('.companion-ranger-only')).display}));
    assert.equal(shape.nature==='none',style==='ranger');assert.equal(shape.ranger==='none',style==='nature');
   }
   const selectedStyle=dialog.locator('.pet-settings-style[aria-pressed="true"]');
   assert(await selectedStyle.isEnabled(),'The selected look remains focusable and responds to the pointer');
   await selectedStyle.click();assert.deepEqual(mutations,[],'Selecting the current look cannot create another style request');
   async function hoverFeedback(button){
    await page.mouse.move(1,1);await button.scrollIntoViewIfNeeded();
    const appearance=()=>button.evaluate(n=>{const s=getComputedStyle(n),track=n.querySelector('.pet-switch-track');return [s.backgroundImage,s.color,s.textDecorationLine,s.opacity,track?getComputedStyle(track).backgroundColor:null];});
    const initial={appearance:await appearance(),box:await button.boundingBox()};
    await button.hover();await page.waitForTimeout(180);
    const hovered={appearance:await appearance(),box:await button.boundingBox()};
    assert.notDeepEqual(hovered.appearance,initial.appearance,'Every enabled control has a visible hover response');
    assert.deepEqual(hovered.box,initial.box,'Hover cannot move the control or adjacent content');
    await page.mouse.down();const pressed=await appearance();
    assert.notDeepEqual(pressed,hovered.appearance,'Press feedback is distinct from hover');
    const panel=await dialog.boundingBox();await page.mouse.move(panel.x+8,panel.y+8);await page.mouse.up();
    assert(await dialog.isVisible(),'A press preview never activates the button');
    await page.evaluate(()=>getSelection()?.removeAllRanges());
   }
   for(const target of [selectedStyle,dialog.locator('.pet-settings-style[aria-pressed="false"]'),dialog.locator('[data-pet-life-action="sound"]'),dialog.locator('[data-pet-enabled]'),dialog.locator('[data-pet-close]'),dialog.locator('[data-pet-tab="gifts"]')])await hoverFeedback(target);
   // WebKit on macOS uses Option-Tab to include buttons in focus navigation.
   await selectedStyle.focus();await page.keyboard.press(engine.name()==='webkit'?'Alt+Tab':'Tab');
   const focusState=await dialog.evaluate(d=>{const target=document.activeElement,visual=target.matches('[data-pet-life-chatter]')?target.nextElementSibling:target;return {inside:d.contains(target),tag:target.tagName,control:target.outerHTML.slice(0,160),outline:getComputedStyle(visual).outlineStyle};});
   assert(focusState.inside&&focusState.outline!=='none','Keyboard focus remains visible: '+JSON.stringify(focusState));
   await page.mouse.move(1,1);await page.evaluate(()=>document.activeElement.blur());await page.waitForTimeout(180);
   await page.screenshot({path:`output/xiaoyou-evolution/settings-${engine.name()}.png`});
   await selectTab(dialog,'home');
   await hoverFeedback(dialog.locator('.pet-life-actions .pet-primary'));
   await hoverFeedback(dialog.locator('.pet-home-dress'));
   const fixedTop=(await dialog.boundingBox()).y;
   await selectTab(dialog,'history');
   assert.equal(await dialog.locator('.pet-record-panels>section').count(),2,'Growth days and purchases remain distinct, readable groups');
   assert(Math.abs((await dialog.boundingBox()).y-fixedTop)<1,'Compact pages keep the header in place');
   const emptyAction=dialog.locator('.pet-record-empty [data-pet-go="shop"]');
   if(await emptyAction.count()){
    await emptyAction.click();assert.equal(await dialog.getAttribute('data-pet-view'),'shop','The empty purchase history leads to collections');
   }
   await selectTab(dialog,'today');
   assert.equal(await dialog.locator('.pet-quest progress').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length>0).length),before.quests.length,'Every daily goal shows its own progress');
   await selectTab(dialog,'wardrobe');

   assert.equal(await dialog.locator('.pet-backpack-companion').count(),1,'Saved portrait stays beside the shelf');
   assert.equal(await dialog.locator('.pet-backpack-slots button').count(),6);
   assert.equal(await dialog.locator('[data-pet-preview-mode]').count(),0,'Daily wardrobe has no fitting mode switches');
   assert.equal(await dialog.locator('.pet-shop-item').count(),17);
   for(const [category,count] of [['palette',3],['accessory',9],['head',3],['neck',1],['body',3],['back',2],['effect',4],['all',17]]) {
    await dialog.locator('[data-pet-category]').selectOption(category);assert.equal(await dialog.locator('.pet-shop-item').count(),count);
   }
   await dialog.locator('[data-pet-category]').selectOption('accessory');
   await dialog.locator('[data-pet-shop-filter="owned"]').click();
   assert.equal(await dialog.locator('.pet-shop-item').count(),0,'Ownership and physical category combine');
   assert.equal(await dialog.locator('[data-pet-category]').inputValue(),'accessory');
   await dialog.locator('[data-pet-browse-all]').click();
   assert.equal(await dialog.locator('[data-pet-category]').inputValue(),'all');
   assert.equal(await dialog.locator('.pet-shop-item').count(),17);
   await dialog.locator('[data-pet-shop-filter="available"]').click();
   const available=before.items.filter(item=>item.slot!=='theme'&&!item.owned&&item.stage<=before.stage&&item.cost<=before.stamps&&!(item.id==='berry'&&before.berry_today>=3));
   assert.equal(await dialog.locator('.pet-shop-item').count(),available.length);
   if(!available.length){assert(await dialog.locator('.pet-shop-empty').isVisible());await dialog.locator('[data-pet-browse-all]').click();}
   else await dialog.locator('[data-pet-shop-filter="all"]').click();
   await revealItem(dialog,'scarf');
   const tryOn=dialog.locator('.pet-shop [data-pet-preview="scarf"]');
   const hitBox=await tryOn.boundingBox(),artBox=await dialog.locator('[data-pet-item="scarf"] .pet-equipment-art').boundingBox();
   assert(hitBox.width>=44&&hitBox.height>=44);assert(hitBox.height>=artBox.height,'The full tile is the interaction target');
   await tryOn.click();
   assert.match(await dialog.locator('.pet-backpack-look-label').textContent(),/尚未拥有/);
   assert.equal(await art.locator('.growth-scarf').evaluate(n=>getComputedStyle(n).display),'block');
   assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before,'A trial never grants or wears an item');
   await dialog.locator('[data-pet-trial-end]').click();
   assert.equal(await art.locator('.growth-scarf').evaluate(n=>getComputedStyle(n).display),'none');
   await revealItem(dialog,'mech_wings');await dialog.locator('[data-pet-preview="mech_wings"]').click();
   assert(await dialog.locator('[data-pet-purchase-open="mech_wings"]').isDisabled());
   assert(await dialog.locator('[data-pet-earn]').isVisible());
   await dialog.locator('[data-pet-earn]').scrollIntoViewIfNeeded();
   const savedScroll=await dialog.locator('.pet-tab-content').evaluate(n=>n.scrollTop);
   await dialog.locator('[data-pet-earn]').click();assert.equal(await dialog.getAttribute('data-pet-view'),'today');
   assert.equal(await dialog.locator('.pet-quests .pet-quest').count(),before.quests.length);
   await page.evaluate(()=>setI18nLanguage('en'));assert(!/[\u3400-\u9fff]/.test(await dialog.locator('.pet-earn-return').textContent()));
   await page.evaluate(()=>setI18nLanguage('zh-CN'));await dialog.locator('[data-pet-return-shop]').click();
   assert.equal(await dialog.getAttribute('data-pet-view'),'wardrobe');
   assert(Math.abs((await dialog.locator('.pet-tab-content').evaluate(n=>n.scrollTop))-savedScroll)<2);
   await selectTab(dialog,'shop');await dialog.locator('[data-pet-series="star"]').click();
   await dialog.locator('[data-pet-preview="mech_wings"]').click();
   assert.match(await dialog.locator('[data-pet-back-collection]').textContent(),/返回套系收藏/);
   await dialog.locator('[data-pet-back-collection]').click();
   assert.equal(await dialog.getAttribute('data-pet-view'),'shop');
   assert.equal(await dialog.locator('[data-pet-series="star"]').getAttribute('aria-pressed'),'true');
   // Stage exploration remains in the growth journey, with no changes to the
   // 17-item, two-route, seven-stage rig and animation coverage below.
   await openStageFitting(dialog);
   const choice=preview.locator('[data-pet-preview-select]'),stageChoice=preview.locator('[data-pet-preview-stage]');
   await stageChoice.selectOption('7');assert(await preview.locator('[data-pet-reset-stage]').isVisible());
   await preview.locator('[data-pet-reset-stage]').click();assert.equal(await stageChoice.inputValue(),String(before.stage));
   await choice.selectOption('mech_wings');
   assert(await preview.locator('[data-pet-preview-action="mech_wings"]').isDisabled(),'Advanced preview cannot purchase a locked reward');
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
   await selectTab(dialog,'journey');assert.equal(await dialog.locator('[data-pet-try-stage]').count(),7);
   await dialog.locator('[data-pet-journey-stage="7"]').click();
   await dialog.locator('[data-pet-try-stage="7"]').click();assert.equal(await stageChoice.inputValue(),'7');
   assert.match(await preview.locator('[data-pet-back-shelf]').textContent(),/Back to evolution/);
   await preview.locator('[data-pet-back-shelf]').click();
   assert.equal(await dialog.getAttribute('data-pet-view'),'journey');
   assert.equal(await dialog.locator('[data-pet-journey-stage="7"]').getAttribute('aria-pressed'),'true');
   assert.equal(await page.evaluate(()=>document.activeElement.dataset.petTryStage),'7');
   await dialog.locator('[data-pet-try-stage="7"]').click();
   await page.evaluate(()=>window.closedFittingRig=document.querySelector('.pet-live-art svg'));
   await dialog.locator('[data-pet-close]').click();assert.equal(await page.evaluate(()=>closedFittingRig.dataset.motionClip||null),null);
   await page.evaluate(()=>{document.documentElement.style.setProperty('--fz','1');document.body.style.zoom='1';});
   await page.setViewportSize({width:1440,height:1000});
   await page.evaluate(()=>mailaiPet.open());
   await selectTab(dialog,'shop');
   await dialog.locator('[data-pet-series="star"]').click();
   for(const language of ['zh-CN','en'])for(const theme of ['light','dark'])for(const reward of ['','theme_monochrome','theme_baowu']) {
    await page.evaluate(({language,theme,reward})=>{setI18nLanguage(language);document.documentElement.dataset.theme=theme;if(reward)document.documentElement.dataset.rewardTheme=reward;else delete document.documentElement.dataset.rewardTheme;},{language,theme,reward});
    for(const [width,height,scale]of [[1440,1000,1],[1280,900,1.5],[800,650,1],[390,844,1],[390,844,1.35],[360,740,2]]) {
     await page.setViewportSize({width,height});
     await page.evaluate(scale=>{document.documentElement.style.setProperty('--fz',scale);document.body.style.zoom=String(scale);},scale);
     const bounds=await dialog.evaluate(d=>{
      const body=d.querySelector('.pet-journal-body'),main=d.querySelector('.pet-center-main'),nav=d.querySelector('.pet-tabs');
      return {dialog:d.scrollWidth<=d.clientWidth+1,body:body.scrollWidth<=body.clientWidth+1,main:main.scrollWidth<=main.clientWidth+1,bounded:body.scrollHeight<=body.clientHeight+1,nav:nav.getBoundingClientRect().bottom<=body.getBoundingClientRect().bottom+1};
     });
     assert(Object.values(bounds).every(Boolean),JSON.stringify({language,theme,reward,width,height,scale,bounds}));
     assert.equal(await dialog.locator('[data-pet-wear-collection="star"]').count(),0,'An unowned full-set preview cannot equip items');
     assert(await dialog.locator('[data-pet-collection]').isEnabled(),'The first-piece preview is reachable at every size');
    }
   }
   await page.evaluate(()=>{document.documentElement.style.setProperty('--fz','1');document.body.style.zoom='1';setI18nLanguage('zh-CN');});
   await page.setViewportSize({width:1280,height:1000});
   assert.deepEqual(await page.evaluate(()=>api('/api/companion/growth')),before,'Layout and full-set previews never mutate progress');
   await auditSpaceThemes(page,dialog);
   // Drain live profile reads before the synthetic legacy-equipment matrix; a
   // late real response must not overwrite the mocked cross-slot outfit.
   await page.evaluate(()=>mailaiEnergy.reschedule('companion-growth',3600000));
   await page.waitForLoadState('networkidle');
   // Synthetic owned equipment exercises composition without changing inventory.
   const fitted={...before,style:'nature',equipped:{accessory:'scarf',palette:'sky',effect:'sparkles'},items:before.items.map(item=>({...item,owned:['scarf','sky','sparkles'].includes(item.id)||item.owned}))};
   await page.route('**/api/companion/growth',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(fitted)}));
   await page.evaluate(async()=>{await mailaiPet.refresh();await mailaiPet.open();});
   await openStageFitting(dialog);
   await preview.locator('[data-pet-preview-select]').selectOption('cap');
   const display=selector=>art.locator(selector).first().evaluate(n=>getComputedStyle(n).display);
   const bodyColor=()=>art.locator('.mail-companion').evaluate(n=>getComputedStyle(n).getPropertyValue('--pet-body').trim());
   assert.equal(await display('.growth-cap'),'block');assert.equal(await display('.growth-scarf'),'block','Headwear combines with the equipped scarf: '+await art.getAttribute('data-fitting-outfits'));
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
