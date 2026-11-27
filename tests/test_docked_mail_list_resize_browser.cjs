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
        if(await handle.isVisible()) {
          const beforeZoomDrag=await width();
          await drag(-36);
          if(viewport===2048)assert(Math.abs(await width()-beforeZoomDrag+36/zoom)<2,`Drag follows physical pointer distance at UI zoom: ${zoom}, before ${beforeZoomDrag}, after ${await width()}`);
        }
        const geometry=await page.evaluate(()=>{
          const zoom=parseFloat(getComputedStyle(document.body).zoom)||1;
          return {overflow:document.documentElement.scrollWidth>innerWidth+1,reading:document.querySelector('.reading-pane').getBoundingClientRect().width/zoom};
        });
        assert(!geometry.overflow&&geometry.reading>=439,JSON.stringify({viewport,zoom,geometry}));
      }
      const sidebarHandle=page.locator('[data-resizer="sidebar"]');
      const rail=page.locator('#mailbox-rail');
      const folders=rail.locator('#mailbox-rail-folders');
      await page.setViewportSize({width:1280,height:900});
      await settle();
      const stretch=async (delta, cancel=false)=>{
        const box=await sidebarHandle.boundingBox();
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
        await page.mouse.down();
        await page.mouse.move(box.x+box.width/2+delta,box.y+box.height/2,{steps:8});
        if(cancel) await page.keyboard.press('Escape');
        await page.mouse.up();
        await settle();
      };
      assert(!await rail.isVisible(),'The standard sidebar is expanded by default');
      await stretch(-150,true);
      assert(!await rail.isVisible(),'Canceled drag leaves the expanded sidebar in place');
      await stretch(-150);
      assert(await rail.isVisible(),'Dragging left reveals the icon rail');
      assert(await handle.isVisible(),'The collapsed sidebar allows the list to stay visible beside the assistant');
      assert.equal(await sidebarHandle.getAttribute('aria-valuenow'),'56');
      const bounds=await page.evaluate(()=>{
        const nodes=['#mailbox-rail','.list-pane','.reading-pane','#assistant-panel'];
        return nodes.map(selector=>{
          const rect=document.querySelector(selector).getBoundingClientRect();
          return {left:rect.left,right:rect.right,width:rect.width};
        });
      });
      assert(bounds.every((rect,i)=>rect.width>0 && (i===0 || rect.left>=bounds[i-1].right-1)),JSON.stringify(bounds));
      assert(Math.abs(bounds[2].right-bounds[3].left)<2 && bounds[2].width>=439,JSON.stringify(bounds));
      await folders.click();
      assert.equal(await folders.getAttribute('aria-expanded'),'true');
      assert(await page.locator('#account-mailbox-nav').isVisible());
      await page.evaluate(()=>setI18nLanguage('en'));
      await settle();
      assert.equal(await folders.getAttribute('data-tooltip'),'Accounts and folders');
      assert(Math.abs((await page.locator('#assistant-panel').boundingBox()).width-bounds[3].width)<2,
        'The folder flyout does not reserve space in the docked layout');
      await page.evaluate(()=>setI18nLanguage('zh-CN'));
      assert.equal(await folders.getAttribute('data-tooltip'),'邮箱与文件夹');
      await page.keyboard.press('Escape');
      assert.equal(await folders.getAttribute('aria-expanded'),'false');
      assert(await folders.evaluate(button=>button===document.activeElement));
      await folders.click();
      await page.locator('#account-mailbox-nav .unified-inbox-button').click();
      await page.waitForFunction(()=>unifiedMailbox);
      assert.equal(await folders.getAttribute('aria-expanded'),'false');
      await rail.locator('[data-rail-folder="sent"]').click();
      await page.waitForFunction(()=>specialMailbox==='sent');
      assert.equal(await rail.locator('[data-rail-folder="sent"]').getAttribute('aria-current'),'page');
      await page.setViewportSize({width:1100,height:900});
      await page.waitForFunction(()=>document.body.classList.contains('assistant-rail-overlay'));
      assert(await rail.isVisible());
      assert(await page.locator('.list-pane').isVisible());
      assert(!await page.locator('#assistant-dock-divider').isVisible());
      await page.setViewportSize({width:900,height:900});
      assert(!await rail.isVisible());
      await page.setViewportSize({width:1280,height:900});
      assert(await rail.isVisible());
      await page.reload();
      await page.locator('#app-preloader').waitFor({state:'hidden'});
      assert(await rail.isVisible(),'The manually collapsed state survives reload');
      await stretch(150);
      assert(!await rail.isVisible(),'Dragging right expands the normal sidebar');
      await sidebarHandle.focus();
      await page.keyboard.press('Home');
      assert(await rail.isVisible(),'The separator can collapse with the keyboard');
      await page.keyboard.press('ArrowRight');
      assert(!await rail.isVisible(),'The separator can expand with the keyboard');
      console.log(`PASS ${engine.name()}: docked list drag, keyboard, reopen/reload, narrow layouts and zoom`);
    }finally{await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
