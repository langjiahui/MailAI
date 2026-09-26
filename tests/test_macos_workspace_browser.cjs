// Requires the isolated workspace_preview fixture; never connects to a mailbox.
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
(async () => {
  const shell = process.env.MAILAI_DESKTOP_SHELL || 'macos';
  const useWebKit = process.env.MAILAI_PRELOADER_WEBKIT === '1';
  const browser = await (useWebKit ? webkit : chromium).launch({...(!useWebKit && !process.env.CI ? {channel:'chrome'} : {})});
  const errors = [];
  try {
    const page = await browser.newPage();
    if (shell === 'windows') await page.addInitScript(() => {
      const state = {ok:true,fullscreen:false,maximized:false};
      window.nativeCalls = [];
      window.pywebview = {api:{
        set_window_theme:async (...args)=>{nativeCalls.push(['theme',...args]);return {ok:true};},
        get_window_state:async ()=>({...state}),
        toggle_window_maximized:async ()=>{nativeCalls.push(['maximize']);state.maximized=!state.maximized;return {...state};},
        toggle_window_fullscreen:async ()=>{nativeCalls.push(['fullscreen']);state.fullscreen=!state.fullscreen;return {...state};},
      }};
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:18795/?shell=${shell}`);
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    const commands = ['btn-compose','btn-contacts','btn-attachments','btn-todos','btn-preferences'];
    if (shell === 'windows') commands.push('btn-window-fullscreen');
    for (const width of [900,1200,1512]) {
      await page.setViewportSize({width,height:width === 900 ? 640 : 949});
      for (const theme of ['light','dark']) {
        await page.evaluate(theme=>applyTheme(theme),theme);
        for (const scale of [0.9,1,1.3]) {
          await page.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);},scale);
          await page.waitForTimeout(150);
          const geometry = await page.evaluate(commands=>{
            const rect = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
            return {search:rect('.global-search'),actions:rect('.global-actions'),header:rect('.topbar'),commands:commands.map(id=>rect('#'+id)),overflow:document.documentElement.scrollWidth>innerWidth};
          },commands);
          assert(!geometry.overflow,`overflow: ${width}/${theme}/${scale}`);
          assert(Math.abs(geometry.header.height-52)<1,'native controls and web header must share a fixed physical height');
          assert(geometry.search.right<=geometry.actions.x+1,'search overlaps actions');
          for(const r of geometry.commands) assert(r.width>0 && r.x>=0 && r.right<=width+1 && r.y>=0 && r.bottom<=53,JSON.stringify({width,theme,scale,r}));
        }
        await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');});
        for (const [open,close,root] of [
          ['btn-contacts','btn-close-contacts','contact-center'],
          ['btn-attachments','btn-close-attachments','attachment-center'],
          ['btn-todos','btn-close-todos','todo-center'],
          ['btn-compose','btn-close-compose','compose-modal'],
        ]) {
          await page.locator('#'+open).click();
          await page.waitForTimeout(250);
          const dialog = await page.locator('#'+root+' [role=dialog]:visible').first().boundingBox();
          const button = await page.locator('#'+close).boundingBox();
          const height = page.viewportSize().height;
          assert(dialog.x>=-1 && dialog.y>=-1 && dialog.x+dialog.width<=width+1 && dialog.y+dialog.height<=height+1,JSON.stringify({root,width,theme,dialog}));
          assert(button.y>=0 && button.y+button.height<=height,'close must remain reachable');
          await page.locator('#'+close).click();
        }
      }
    }
    await page.setViewportSize({width:1512,height:949});
    if (shell === 'macos') for (const theme of ['light','dark']) {
      await page.evaluate(theme=>applyTheme(theme),theme);
      const before = await page.locator('.global-search').boundingBox();
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('mailai:native-fullscreen',{detail:{fullscreen:true}})));
      await page.waitForTimeout(200);
      const brand = await page.locator('.topbar .brand').boundingBox();
      const after = await page.locator('.global-search').boundingBox();
      assert(Math.abs(brand.x-20)<1,'full screen should reclaim the traffic light space');
      assert(await page.locator('.topbar .logo').isVisible(),'full screen brand icon is visible');
      assert(Math.abs(before.x-after.x)<1,'search remains aligned with the mail column');
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('mailai:native-fullscreen',{detail:{fullscreen:false}})));
      await page.waitForTimeout(200);
      assert((await page.locator('.topbar .brand').boundingBox()).x>=108,'restore native traffic light clearance');
      assert(!await page.locator('.topbar .logo').isVisible());
    }
    if (shell === 'windows') {
      assert(!await page.locator('html').evaluate(el=>el.classList.contains('macos-native-window')));
      const calls = () => page.evaluate(()=>nativeCalls.filter(call=>call[0]==='maximize').length);
      await page.locator('.topbar .brand').dblclick();
      assert.equal(await calls(),1);
      await page.locator('.global-search input').dblclick();
      assert.equal(await calls(),1,'search must never maximize the window');
      await page.locator('.topbar .brand').dblclick();
      assert.equal(await calls(),2);
      await page.keyboard.press('F11');
      await page.waitForFunction(()=>document.documentElement.classList.contains('windows-native-fullscreen'));
      assert.equal(await page.locator('#btn-window-fullscreen').getAttribute('aria-pressed'),'true');
      await page.locator('.topbar .brand').dblclick();
      assert.equal(await calls(),2,'double-click is inert in full screen');
      await page.locator('#btn-window-fullscreen').click();
      await page.waitForFunction(()=>!document.documentElement.classList.contains('windows-native-fullscreen'));
      for (const theme of ['light','dark']) {
        await page.evaluate(theme=>applyTheme(theme),theme);
        await page.waitForFunction(theme=>nativeCalls.some(call=>call[0]==='theme' && call[1]===theme),theme);
        await page.waitForTimeout(600); // Capture settled theme colors, not transition frames.
        await page.screenshot({path:`build/windows-workspace-${theme}.png`});
      }
    }
    assert.deepEqual(errors,[]);
    console.log(`${shell} workspace: themes, 900–1512px windows, 90–130% font scaling and primary dialogs passed`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
