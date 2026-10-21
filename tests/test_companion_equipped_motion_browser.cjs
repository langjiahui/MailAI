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
  try { await page.waitForFunction(selectors=>selectors.every(selector=>{
    const node=document.querySelector(selector);
    const svg=node?.closest('.mail-companion');
    return svg?.dataset.rewardVisible==='true' && svg.dataset.motionActive==='true' && getComputedStyle(node).visibility==='visible';
  }),selectors); } catch(error) {
    const state=await page.evaluate(selectors=>({body:document.body.className,dialogs:[...document.querySelectorAll("dialog[open]")].map(n=>n.id),nodes:selectors.map(selector=>{const n=document.querySelector(selector),svg=n?.closest(".mail-companion");return {selector,svg:svg?.dataset,box:svg?.getBoundingClientRect().toJSON(),visibility:n&&getComputedStyle(n).visibility};})}),selectors);
    throw new Error(`${context}: ${JSON.stringify(state)}`,{cause:error});
  }
  const sample=()=>page.evaluate(selectors=>selectors.map(selector=>{
    const node=document.querySelector(selector), css=getComputedStyle(node);
    const animation=node.getAnimations().find(a=>a.animationName===css.animationName);
    let visible=!!node.getClientRects().length, hidden=[];
    for(let ancestor=node;ancestor instanceof Element;ancestor=ancestor.parentElement) {
      const style=getComputedStyle(ancestor);
      if(style.display==='none'||style.visibility==='hidden'){visible=false;hidden.push(`${ancestor.tagName}.${ancestor.getAttribute('class')}: ${style.display}/${style.visibility}`);}
    }
    return {name:css.animationName,play:css.animationPlayState,time:animation?.currentTime,visible,hidden};
  }),selectors);
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
      }
      await page.locator('#assistant-orb').click();
      await page.locator('#assistant-panel').waitFor({state:'visible'});
      await page.evaluate(()=>appendAssistantMessage('user','合成装扮测试'));
      for(const [slot,item,part] of rewards) {
        await mutate('equip',{slot,item});
        await checkMotion(page,['#assistant-panel .assistant-mini'],part,`chat ${style}/${item}`);
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
    console.log('Equipped rewards: 15 real purchases, correct costs, reload persistence, both routes, 90 running animations across floating/chat/writing avatars, unwear and hidden pause passed');
  } finally {
    if(browser)await browser.close();
    const stopped=once(fixture,'exit');fixture.kill('SIGTERM');
    if(fixture.exitCode===null)await stopped;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
