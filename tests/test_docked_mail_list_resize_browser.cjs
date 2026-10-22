// Isolated workspace_preview.py fixture; never point this test at a real mailbox.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
  for(const engine of [chromium,webkit]){
    const browser=await engine.launch();
    try{
      const page=await browser.newPage({viewport:{width:2048,height:1000},reducedMotion:'reduce'});
      await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
      await page.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18799/');
      await page.locator('#app-preloader').waitFor({state:'hidden'});
      assert(await page.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
      const handle=page.locator('[data-resizer="list"]');
      const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const width=()=>page.locator('.list-pane').evaluate(n=>n.getBoundingClientRect().width/(parseFloat(getComputedStyle(document.body).zoom)||1));
      async function open(){
        await page.locator('#email-list .email-item').first().click();
        await page.waitForFunction(()=>!!selectedEmailDetail);
        await page.evaluate(()=>openAssistant());
        await page.waitForFunction(()=>document.body.classList.contains('assistant-docked'));
        await settle();
      }
      async function drag(delta){
        const box=await handle.boundingBox();
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
        await page.mouse.down();
        await page.mouse.move(box.x+box.width/2+delta,box.y+box.height/2,{steps:6});
        await page.mouse.up();await settle();
      }
      await open();const before=await width();
      await drag(80);assert(Math.abs(await width()-before-80)<2,'Opening the assistant must not lock the mail list width');
      await drag(-48);assert(Math.abs(await width()-before-32)<2,'List can also shrink while docked');
      await handle.focus();await page.keyboard.press('ArrowRight');await settle();
      const saved=await width();assert(Math.abs(saved-before-48)<2,'Keyboard resizing still changes the rendered width');
      await page.evaluate(()=>closeAssistant());await settle();assert(Math.abs(await width()-saved)<2);
      await page.reload();await page.locator('#app-preloader').waitFor({state:'hidden'});await open();
      assert(Math.abs(await width()-saved)<2,'Saved list width survives reopening and reload');
      for(const [viewport,zoom] of [[1600,1],[2048,1.25],[1280,1],[2048,1]]){
        await page.setViewportSize({width:viewport,height:1000});
        await page.evaluate(zoom=>{document.body.style.zoom=zoom;document.documentElement.style.setProperty('--fz',zoom);updateAssistantPlacement();},zoom);await settle();
        if(await handle.isVisible())await drag(36);
        const geometry=await page.evaluate(()=>{
          const zoom=parseFloat(getComputedStyle(document.body).zoom)||1;
          return {overflow:document.documentElement.scrollWidth>innerWidth+1,reading:document.querySelector('.reading-pane').getBoundingClientRect().width/zoom};
        });
        assert(!geometry.overflow&&geometry.reading>=439,JSON.stringify({viewport,zoom,geometry}));
      }
      console.log(`PASS ${engine.name()}: docked list drag, keyboard, reopen/reload, narrow layouts and zoom`);
    }finally{await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
