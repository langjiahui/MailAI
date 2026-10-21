/* Fitting-room actions reuse the real rig without buying or changing growth. */
const assert=require('node:assert/strict');
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
   await page.evaluate(async()=>{await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});await mailaiPet.refresh();await mailaiPet.openThemes();});
   const before=await page.evaluate(()=>api('/api/companion/growth')),mutations=[];
   page.on('request',r=>{if(/\/api\/companion\/(purchase|equip|style)$/.test(r.url()))mutations.push(r.url());});
   const dialog=page.locator('#companion-growth-dialog'),preview=dialog.locator('.pet-live-preview');
   assert.equal(await dialog.locator('.pet-collections article').count(),3);
   assert.equal(await dialog.locator('.pet-shop-item').count(),16);
   for(const [filter,count] of [['palette',3],['accessory',8],['effect',4],['owned',0],['all',16]]) {
    await dialog.locator(`[data-pet-shop-filter="${filter}"]`).click();assert.equal(await dialog.locator('.pet-shop-item').count(),count);
   }
   await dialog.locator('[data-pet-collection="mech_wings"]').click();assert(await preview.isVisible());
   const choice=preview.locator('[data-pet-preview-select]'),stageChoice=preview.locator('[data-pet-preview-stage]');
   assert.equal(await choice.inputValue(),'mech_wings');
   assert(await dialog.locator('[data-pet-buy="mech_wings"]').isDisabled(),'Future reward stays locked');
   for(const route of ['nature','ranger']) {
    await page.evaluate(route=>document.body.dataset.petStyle=route,route);
    for(let stage=1;stage<=7;stage++) {
     await stageChoice.selectOption(String(stage));
     assert.equal(await preview.locator('svg.mail-companion').getAttribute('data-evolution-stage'),String(stage));
     await preview.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.pet-live-art svg').dataset.rewardVisible==='true');
     await preview.locator('[data-pet-try-action="signature"]').click();
     const clip=await preview.locator('svg.mail-companion').getAttribute('data-motion-clip');
     assert.equal(clip,await page.evaluate(n=>mailaiCompanionMotion.signature(n),stage));
     const joints=await preview.evaluate(host=>{
      const svg=host.querySelector('svg'),torso=svg.querySelector('.companion-torso');
      const distance=(selector,x,y)=>{const p=new DOMPoint(x,y),a=p.matrixTransform(svg.querySelector(selector).getCTM()),b=p.matrixTransform(torso.getCTM());return Math.hypot(a.x-b.x,a.y-b.y);};
      return [distance('.companion-carry',84,66),distance('.companion-arm-left',31,63)];
     });assert(joints.every(n=>n<.05),'Action keeps both shoulders attached');
    }
   }
   const ids=before.items.filter(i=>i.slot!=='theme').map(i=>i.id);
   for(const id of ids){await choice.selectOption(id);await preview.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.pet-live-art svg').dataset.rewardVisible==='true');
    assert(await preview.locator('.pet-reward-motion').evaluateAll(nodes=>nodes.some(n=>n.getClientRects().length&&getComputedStyle(n).animationName!=='none')),`${id} has a live reward detail`);
   }
   await choice.selectOption('wings');await preview.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.pet-live-art svg').dataset.rewardVisible==='true');
   await preview.locator('[data-pet-try-action="travel"]').click();assert.equal(await preview.locator('svg.mail-companion').getAttribute('data-motion-clip'),'swim');
   await preview.locator('[data-pet-preview-play]').click();
   assert.equal(await preview.locator('svg.mail-companion').getAttribute('data-motion-clip'),null,'Pause stops body choreography too');
   await preview.locator('[data-pet-try-action="greet"]').click();
   await page.evaluate(()=>mailaiEnergy.nativeVisibility(1000,false));
   assert.equal(await preview.locator('svg.mail-companion').getAttribute('data-motion-clip'),null,'Hidden windows cancel finite actions');
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
   await dialog.locator('[data-pet-try-stage="7"]').click();assert.equal(await stageChoice.inputValue(),'7');
   await dialog.locator('[data-pet-close]').click();assert.equal(await preview.locator('svg.mail-companion').getAttribute('data-motion-clip'),null);
   assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: wardrobe filters, 16 rewards, 14 stage actions, joints, no spending, pause/hide, localization, mobile and journey preview`);
   await browser.close();browser=null;
  }
 }finally{if(browser)await browser.close();const done=once(fixture,'exit');fixture.kill('SIGTERM');await done;}
})().catch(e=>{console.error(e);process.exitCode=1;});
