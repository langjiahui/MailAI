/* Preserve the ledge portrait while equipped wings extend outside its viewport. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {chromium,webkit} = require('playwright');
const port = Number(process.env.MAILAI_PERCH_FIXTURE_PORT || 18813);
(async()=>{
  const fixture=spawn(process.env.MAILAI_FIXTURE_PYTHON||'python3',['tests/workspace_preview.py'],{
    env:{...process.env,MAILAI_REWARD_MOTION_FIXTURE:'1',MAILAI_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let logs='',browser;fixture.stdout.on('data',d=>logs+=d);fixture.stderr.on('data',d=>logs+=d);
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(fixture.exitCode!==null)throw Error(logs);
      try {if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch(_){}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(ready,logs);
    browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('#app-preloader').waitFor({state:'detached'});
    const mutate=async(path,body)=>page.evaluate(async({path,body})=>{
      await api('/api/companion/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      await mailaiPet.refresh();
    },{path,body});
    for(const item of ['wings','mech_wings','orbit','theme_baowu'])await mutate('purchase',{item,token:crypto.randomUUID()});
    await mutate('equip',{slot:'theme',item:'theme_baowu'});
    await mutate('equip',{slot:'effect',item:'orbit'});
    await page.evaluate(()=>openCompose());
    for(const [style,item,part] of [['nature','wings','.growth-wings'],['ranger','mech_wings','.growth-mech-wings']]) {
      await mutate('style',{style});await mutate('equip',{slot:'accessory',item});
      // Live wings release their CSS loops at rest; inspect a real interaction.
      await page.evaluate(()=>mailaiCompanionMotion.react('greet',document.getElementById('btn-compose-ai')));
      await page.waitForFunction(part=>document.querySelector('#btn-compose-ai '+part+' .pet-reward-motion').getAnimations().length>0,part);
      for(const mode of ['light','dark']) {
        await page.evaluate(mode=>applyTheme(mode),mode);
        for(const phase of [0,.18,.34,.58,.84]) {
          const check=await page.locator('#btn-compose-ai .mail-companion').evaluate((svg,{part,phase})=>{
            for(const animation of svg.getAnimations({subtree:true})) {
              animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)*phase;
            }
            const wing=svg.querySelector(part), clipped=[];
            for(let n=wing;n&&n!==svg.parentElement;n=n.parentElement) {
              const s=getComputedStyle(n);
              if(s.clipPath!=='none'||n.hasAttribute('clip-path')||(n===svg&&s.overflow!=='visible'))clipped.push(n.getAttribute('class'));
            }
            const wingBox=wing.getBoundingClientRect(),card=svg.closest('.compose-card').getBoundingClientRect();
            const clip=svg.querySelector('#mailai-perch-body-clip rect');
            return {clipped,cutoff:Number(clip.getAttribute('y'))+Number(clip.getAttribute('height')),
              bodyClipped:svg.querySelector('.growth-body').closest('.companion-perch-body')?.hasAttribute('clip-path'),
              lowerBodyHidden:['.companion-foot-left','.companion-foot-right','.companion-tail'].every(selector=>getComputedStyle(svg.querySelector(selector)).display==='none'),
              inside:wingBox.left>=card.left&&wingBox.right<=card.right&&wingBox.top>=card.top&&wingBox.bottom<=card.bottom};
          },{part,phase});
          assert.deepEqual(check.clipped,[],`${style}/${mode}/${phase}: wings must not inherit portrait clipping`);
          assert.equal(check.cutoff,76);assert(check.bodyClipped&&check.lowerBodyHidden,'Body remains behind the ledge');
          assert(check.inside,`${style}/${mode}/${phase}: complete wings fit inside the writing window`);
        }
        await page.screenshot({path:`/tmp/mailai-perch-${item}-${mode}.png`});
      }
    }
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{document.body.style.zoom='1.25';document.documentElement.style.setProperty('--fz','1.25');});
    assert.equal(await page.locator('#btn-compose-ai .mail-companion').evaluate(n=>getComputedStyle(n).overflow),'visible');
    await page.screenshot({path:'/tmp/mailai-perch-compact.png'});
    assert.deepEqual(errors,[]);
    console.log('Perch wings: feather/mechanical wing phases, light/dark, independent body clipping, complete wing space and compact zoom passed');
  } finally {
    if(browser)await browser.close();
    const stopped=once(fixture,'exit');fixture.kill('SIGTERM');if(fixture.exitCode===null)await stopped;
  }
})().catch(e=>{console.error(e);process.exitCode=1});
