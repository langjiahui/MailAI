/* Real purchases and saved outfits, using a separate disposable client profile. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium,webkit} = require('playwright');
const port=Number(process.env.MAILAI_EQUIPPED_FIXTURE_PORT || 18796);
const base=`http://127.0.0.1:${port}`;
const rewards=[
  ['accessory','scarf','.pet-scarf-tail'],['accessory','cap','.pet-cap-shine'],
  ['accessory','satchel','.pet-satchel-glint'],['accessory','visor','.pet-visor-scan'],
  ['accessory','jacket','.pet-jacket-trace'],['accessory','armor','.pet-armor-core'],
  ['accessory','wings','.pet-wing-left'],['accessory','mech_wings','.pet-mech-left'],
  ['effect','sparkles','.pet-star'],['effect','orbit','.pet-orbit-stream'],
  ['effect','aurora','.pet-aurora-ripple'],['effect','lightning','.pet-bolt'],
  ['palette','sky','.pet-palette-shine'],['palette','peach','.pet-palette-shine'],
  ['palette','midnight','.pet-palette-shine'],
];
async function checkMotion(page, hosts, part, context) {
  await page.evaluate(()=>mailaiCompanionMotion.wake());
  const selectors=hosts.map(host=>`${host} .mail-companion ${part}`);
  try { await page.waitForFunction(selectors=>{
    mailaiCompanionMotion.wake();
    return selectors.every(selector=>{
    const node=document.querySelector(selector);
    const svg=node?.closest('.mail-companion');
    return svg?.dataset.rewardVisible==='true' && svg.dataset.motionActive==='true' && getComputedStyle(node).visibility==='visible';
  });},selectors); } catch(error) {
    const state=await page.evaluate(selectors=>({body:document.body.className,dialogs:[...document.querySelectorAll("dialog[open]")].map(n=>n.id),nodes:selectors.map(selector=>{const n=document.querySelector(selector),svg=n?.closest(".mail-companion");return {selector,svg:svg?.dataset,box:svg?.getBoundingClientRect().toJSON(),visibility:n&&getComputedStyle(n).visibility};})}),selectors);
    throw new Error(`${context}: ${JSON.stringify(state)}`,{cause:error});
  }
  const sample=()=>page.evaluate(selectors=>{
    // Start a fresh finite reaction and sample in the same browser task. A wake
    // preserves an active clip, which may already be on its final frame.
    for (const selector of selectors) {
      const svg=document.querySelector(selector).closest(".mail-companion");
      if (!mailaiCompanionMotion.react("peek",svg)) throw new Error(`Cannot react: ${selector}`);
    }
    return selectors.map(selector=>{
    const node=document.querySelector(selector), css=getComputedStyle(node);
    const animation=node.getAnimations().find(a=>a.animationName===css.animationName);
    let visible=!!node.getClientRects().length, hidden=[];
    for(let ancestor=node;ancestor instanceof Element;ancestor=ancestor.parentElement) {
      const style=getComputedStyle(ancestor);
      if(style.display==='none'||style.visibility==='hidden'){visible=false;hidden.push(`${ancestor.tagName}.${ancestor.getAttribute('class')}: ${style.display}/${style.visibility}`);}
    }
    return {name:css.animationName,play:css.animationPlayState,time:animation?.currentTime,visible,hidden};
  });},selectors);
  const first=await sample();
  for(let i=0;i<selectors.length;i++) {
    const label=`${context}: ${selectors[i]}`;
    assert(first[i].visible,`${label} must be visible: ${JSON.stringify(first[i])}`);
    assert.notEqual(first[i].name,'none',`${label} must have an animation`);
    assert.equal(first[i].play,'running',`${label} must run while visible`);
  }
  // A panel can become visible before its first animation frame is committed.
  // Wait for actual progress instead of assuming a fixed CI rendering speed.
  try {
    await page.waitForFunction(({selectors,first})=>selectors.every((selector,index)=>{
      const node=document.querySelector(selector), css=getComputedStyle(node);
      const animation=node.getAnimations().find(a=>a.animationName===css.animationName);
      return css.animationPlayState==='running' && animation?.currentTime>first[index].time+40;
    }),{selectors,first},{timeout:5000});
  } catch(error) {
    throw new Error(`${context} must actually advance: before=${JSON.stringify(first)}, after=${JSON.stringify(await sample())}`,{cause:error});
  }
}
async function checkRestEffect(page, host, part, context) {
  // An owned item must remain visible after the finite interaction ends.
  // Blur releases the rig immediately, without waiting through ambient timers.
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  const sample=()=>page.locator(`${host} .mail-companion`).evaluate((svg,part)=>{
    const node=svg.querySelector(part);
    let opacity=1,visible=true;
    for(let parent=node;parent instanceof Element;parent=parent.parentElement){
      const css=getComputedStyle(parent);opacity*=Number(css.opacity);
      if(css.display==='none'||css.visibility==='hidden')visible=false;
    }
    return {visible,opacity,name:getComputedStyle(node).animationName,
      ripples:[...svg.querySelectorAll('.pet-aurora-ripple')].map(n=>getComputedStyle(n).transform)};
  },part);
  const still=await sample();
  assert(still.visible&&still.opacity>.1,`${context}: equipped effect must remain visible at rest: ${JSON.stringify(still)}`);
  assert.equal(still.name,'none',`${context}: static appearance must not require animation`);
  if(part==='.pet-aurora-ripple')assert.equal(new Set(still.ripples).size,3,'Three aurora rings keep distinct static sizes');
  await page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await sample();
  assert(reduced.visible&&reduced.opacity>.1,`${context}: reduced motion keeps the equipped appearance`);
  assert.equal(reduced.name,'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
}
(async()=>{
  const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{
    env:{...process.env,MAILAI_REWARD_MOTION_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let logs='';fixture.stdout.on('data',data=>logs+=data);fixture.stderr.on('data',data=>logs+=data);
  let browser;
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(fixture.exitCode!==null)throw new Error(logs);
      try { const response=await fetch(`${base}/api/health`);if(response.ok){ready=true;break;} } catch(_){}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert(ready,`Disposable fixture did not start: ${logs}`);
    browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.stack)});
    await page.goto(base);
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage==='6');
    assert(await page.locator('#assistant-orb .growth-wings').evaluate(n=>!!n.closest('.companion-torso')),'Shoulders follow the actual torso pose');
    assert(await page.locator('#assistant-orb .growth-visor').evaluate(n=>!!n.closest('.companion-head')),'Visor follows head turns');
    await page.evaluate(()=>mailaiPet.openThemes());
    const before=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(before.stamps,10000);assert.equal(before.enabled,false);
    let cost=0;
    for(const [slot,item] of rewards) {
      cost+=before.items.find(reward=>reward.id===item).cost;
      await page.locator(`[data-pet-buy="${item}"]`).click();
      await page.waitForFunction(({slot,item})=>document.body.dataset[`pet${slot[0].toUpperCase()+slot.slice(1)}`]===item,{slot,item});
      const saved=await page.evaluate(()=>api('/api/companion/growth'));
      assert.equal(saved.equipped[slot],item);
      assert(saved.items.find(reward=>reward.id===item).owned);
      assert.equal(saved.stamps,before.stamps-cost,'Purchase deducts the displayed cost once');
    }
    // Equipped is a completed state; the same card must remain usable to remove it.
    const outfitAction=id=>page.locator(`.pet-shop [data-pet-item-action="${id}"]`);
    const outfitStatus=id=>page.locator(`[data-pet-item="${id}"] .pet-equipped-status`);
    for(const id of ['mech_wings','lightning','midnight']) {
      assert.equal(await outfitAction(id).textContent(),'卸下');
      assert(await outfitAction(id).isEnabled());
      assert.equal(await outfitStatus(id).textContent(),'✓ 已穿戴');
    }
    let releaseEquip, equipCalls=0;
    const heldEquip=new Promise(resolve=>{releaseEquip=resolve;});
    await page.route('**/api/companion/equip',async route=>{equipCalls++;await heldEquip;await route.continue();});
    await outfitAction('lightning').click();
    await page.waitForFunction(()=>document.querySelector('[data-pet-item-action="lightning"]')?.getAttribute('aria-busy')==='true');
    assert.equal(await outfitAction('lightning').textContent(),'卸下中…');
    assert(await outfitAction('mech_wings').isDisabled(),'Other mutations pause only while a request is pending');
    await page.evaluate(()=>document.querySelector('[data-pet-item-action="lightning"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.equal(await outfitAction('lightning').textContent(),'Removing…');
    releaseEquip();
    await page.waitForFunction(()=>document.body.dataset.petEffect==='none' && !document.querySelector('[data-pet-item-action="lightning"]')?.disabled);
    assert.equal(equipCalls,1,'Repeated activation cannot submit twice');
    await page.unroute('**/api/companion/equip');
    assert.equal(await outfitAction('lightning').textContent(),'Equip');
    assert.equal(await outfitStatus('lightning').count(),0);
    assert.equal(await page.locator('.pet-shop [aria-busy="true"]').count(),0);
    assert.equal(await page.evaluate(()=>document.body.dataset.petAccessory),'mech_wings','Removing effects preserves accessories');
    await page.route('**/api/companion/equip',r=>r.fulfill({status:500,json:{detail:'Fixture equip failure'}}));
    await outfitAction('lightning').click();
    await page.waitForFunction(()=>document.querySelector('[data-pet-message]')?.classList.contains('is-error') && !document.querySelector('[data-pet-item-action="lightning"]')?.disabled);
    assert.equal(await page.evaluate(()=>document.body.dataset.petEffect),'none');
    assert.equal(await outfitAction('lightning').getAttribute('aria-busy'),null);
    await page.unroute('**/api/companion/equip');
    await outfitAction('lightning').click();
    await page.waitForFunction(()=>document.body.dataset.petEffect==='lightning' && !document.querySelector('[data-pet-item-action="lightning"]')?.disabled);
    assert.equal(await outfitStatus('lightning').textContent(),'✓ Equipped');
    for(const [slot,id,fallback] of [['accessory','mech_wings','none'],['effect','lightning','none'],['palette','midnight','mint']]) {
      await outfitAction(id).focus();await page.keyboard.press('Enter');
      await page.waitForFunction(({slot,fallback,id})=>document.body.dataset[`pet${slot[0].toUpperCase()+slot.slice(1)}`]===fallback && !document.querySelector(`[data-pet-item-action="${id}"]`)?.disabled,{slot,fallback,id});
      assert.equal(await outfitAction(id).textContent(),'Equip');
      await page.keyboard.press('Enter');
      await page.waitForFunction(({slot,id})=>document.body.dataset[`pet${slot[0].toUpperCase()+slot.slice(1)}`]===id && !document.querySelector(`[data-pet-item-action="${id}"]`)?.disabled,{slot,id});
      assert.equal(await outfitAction(id).textContent(),'Remove');
    }
    for(const language of ['zh-CN','en']) for(const theme of ['', 'theme_monochrome','theme_baowu']) for(const mode of ['light','dark']) for(const width of [390,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(({language,theme,mode})=>{
        setI18nLanguage(language);applyTheme(mode);
        if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;
      },{language,theme,mode});
      assert.equal(await outfitStatus('lightning').textContent(),language==='en'?'✓ Equipped':'✓ 已穿戴');
      assert.equal(await outfitAction('lightning').textContent(),language==='en'?'Remove':'卸下');
      const clipped=await page.locator('.pet-shop [data-pet-item-action]').evaluateAll(nodes=>nodes.filter(n=>n.scrollWidth>n.clientWidth+1 || n.getBoundingClientRect().right>innerWidth+1).map(n=>n.dataset.petItemAction));
      assert.deepEqual(clipped,[],JSON.stringify({language,theme,mode,width,clipped}));
    }
    await page.evaluate(()=>{setI18nLanguage('zh-CN');applyTheme('dark');});
    await page.locator('[data-pet-item="lightning"]').screenshot({path:`/tmp/mailai-outfit-state-${process.env.MAILAI_BROWSER||'chromium'}.png`});
    assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).stamps,before.stamps-cost,'Wearing and removing never spend stamps');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petPalette==='midnight');
    assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).stamps,before.stamps-cost);
    const mutate=async(path,body)=>page.evaluate(async({path,body})=>{
      await api(`/api/companion/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      await mailaiPet.refresh();
    },{path,body});
    for(const style of ['nature','ranger']) {
      await mutate('style',{style});
      for(const [slot,item,part] of rewards) {
        await mutate('equip',{slot,item});
        await checkMotion(page,['#assistant-orb'],part,`floating ${style}/${item}`);
        if(slot==='effect')await checkRestEffect(page,'#assistant-orb',part,`floating ${style}/${item}`);
      }
      await page.locator('#assistant-orb').click();
      await page.locator('#assistant-panel').waitFor({state:'visible'});
      await page.evaluate(()=>appendAssistantMessage('user','合成装扮测试'));
      for(const [slot,item,part] of rewards) {
        await mutate('equip',{slot,item});
        await checkMotion(page,['#assistant-panel .assistant-mini'],part,`chat ${style}/${item}`);
        if(slot==='effect')await checkRestEffect(page,'#assistant-panel .assistant-mini',part,`chat ${style}/${item}`);
      }
      assert.equal(await page.locator('#assistant-orb .pet-palette-shine').evaluate(n=>getComputedStyle(n).animationPlayState),'paused','Collapsed orb must pause while the chat is shown');
      await page.locator('#assistant-close').click();
    }
    // Opening the real writing assistant exposes its full avatar, with the same saved outfit.
    await page.locator('#btn-compose').click();
    await page.locator('#btn-compose-ai').click();
    await page.locator('#compose-ai-panel').waitFor({state:'visible'});
    for(const style of ['nature','ranger']) {
      await mutate('style',{style});
      for(const [slot,item,part] of rewards) {
        await mutate('equip',{slot,item});
        await checkMotion(page,['#compose-ai-panel .assistant-mini'],part,`writing ${style}/${item}`);
        if(slot==='effect')await checkRestEffect(page,'#compose-ai-panel .assistant-mini',part,`writing ${style}/${item}`);
      }
    }
    await mutate('equip',{slot:'accessory',item:'armor'});
    await page.locator('#compose-ai-panel .assistant-mini').screenshot({path:'/tmp/mailai-equipped-armor.png'});
    await mutate('equip',{slot:'accessory',item:'scarf'});
    await page.locator('#compose-ai-panel .assistant-mini').screenshot({path:'/tmp/mailai-equipped-scarf.png'});
    // Unwearing stops reward-specific motion. Hidden panels also stop consuming animation work.
    await mutate('equip',{slot:'accessory',item:''});
    assert.equal(await page.locator('#compose-ai-panel .pet-scarf-tail').evaluate(n=>getComputedStyle(n).animationName),'none');
    await mutate('equip',{slot:'effect',item:'orbit'});
    await page.locator('#btn-close-compose-ai').click();
    await page.waitForFunction(()=>document.querySelector('#compose-ai-panel .mail-companion').dataset.rewardVisible==='false');
    assert.equal(await page.locator('#compose-ai-panel .pet-orbit-stream').first().evaluate(n=>getComputedStyle(n).animationPlayState),'paused');
    assert.deepEqual(errors,[]);
    console.log('Equipped rewards: 15 real purchases, correct costs, reload persistence, both routes, 90 running animations across floating/chat/writing avatars, equipped labels, card removal, pending states, duplicate protection, failure retry, keyboard, 24 localized layouts, unwear and hidden pause passed');
  } finally {
    if(browser)await browser.close();
    const stopped=once(fixture,'exit');fixture.kill('SIGTERM');
    if(fixture.exitCode===null)await stopped;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
