// Isolated startup contract: loading and loaded panes share one native canvas.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
(async () => {
  const root = path.resolve(__dirname, '../app/web/static');
  const html = fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*src=[^>]*>[\s\S]*?<\/script>/g,'');
  const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
  const handoff = app.slice(app.indexOf('function hideAppPreloader('),app.indexOf('// ===== 三栏宽度拖拽与本地记忆 ====='));
  const useWebKit = process.env.MAILAI_PRELOADER_WEBKIT === '1';
  const browser = await (useWebKit ? webkit : chromium).launch({...(!useWebKit && !process.env.CI ? {channel:'chrome'} : {}),headless:true});
  try {
    for (const theme of ['light','dark']) {
      const page = await browser.newPage({viewport:{width:1440,height:900}});
      await page.addInitScript(theme => localStorage.setItem('mailai.preferences.theme.v1',theme),theme);
      await page.route('http://mailai.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:html});
        const file = path.join(root,url.pathname.replace('/static/',''));
        return fs.existsSync(file) ? route.fulfill({path:file}) : route.abort();
      });
      await page.goto('http://mailai.test/?shell=macos');
      assert(await page.locator('html').evaluate(el=>el.classList.contains('macos-native-window')), 'native layout must precede bridge readiness');
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      await page.addScriptTag({path:path.join(root,'companion.js')});
      await page.addScriptTag({content:handoff});
      await page.waitForTimeout(600);
      const geometry = await page.evaluate(() => {
        const root = document.documentElement;
        const start = document.querySelector('.preloader-brand strong').getBoundingClientRect();
        const end = document.querySelector('.topbar .brand strong').getBoundingClientRect();
        const panes = [...document.querySelectorAll('[data-startup-pane]')].map(el=>({
          loading:getComputedStyle(el).backgroundColor,
          loaded:getComputedStyle(document.querySelector('.layout>.'+el.dataset.startupPane)).backgroundColor,
        }));
        return {brand:[start.x-end.x,start.y-end.y,start.width-end.width,start.height-end.height],panes,
          backdrop:getComputedStyle(document.querySelector('.app-preloader'),'::before').backgroundImage,
          rail:getComputedStyle(root).getPropertyValue('--mac-rail').trim(),
          line:getComputedStyle(document.querySelector('.pane-resizer'),'::before').backgroundColor,
          headerLine:getComputedStyle(document.querySelector('.topbar'),'::after').display};
      });
      assert(geometry.brand.every(delta=>Math.abs(delta)<1),JSON.stringify(geometry.brand));
      for (const pane of geometry.panes) assert.equal(pane.loading,pane.loaded,'pane must retain its surface during reveal');
      assert(!geometry.backdrop.includes('radial-gradient'),'native startup must not return to ambient gradient wallpaper');
      assert.equal(geometry.line,'rgba(0, 0, 0, 0)');
      assert.equal(geometry.headerLine,'none');
      assert(!await page.locator('.preloader-brand img').isVisible());
      await page.screenshot({path:path.resolve(__dirname,`../build/native-startup-${theme}.png`)});
      await page.evaluate(()=>hideAppPreloader());
      await page.waitForFunction(()=>document.getElementById('app-preloader').dataset.handoff==='running');
      await page.waitForTimeout(650);
      await page.screenshot({path:path.resolve(__dirname,`../build/native-handoff-${theme}.png`)});
      await page.locator('.preloader-companion').evaluate(el=>el.getAnimations().forEach(a=>a.finish()));
      const from = await page.locator('.preloader-companion').boundingBox();
      const to = await page.locator('#assistant-orb .companion-art').boundingBox();
      for (const key of ['x','y','width','height']) assert(Math.abs(from[key]-to[key])<2,`mascot ${key} should land without a jump`);
      await page.locator('#app-preloader').waitFor({state:'detached'});
      await page.locator('.pane-resizer').first().hover();
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.pane-resizer i').first().evaluate(el=>getComputedStyle(el).opacity),'1','resize must remain discoverable');

      await page.emulateMedia({reducedMotion:'reduce'});
      await page.reload();
      await page.addScriptTag({path:path.join(root,'companion.js')});
      await page.addScriptTag({content:handoff});
      await page.evaluate(()=>hideAppPreloader());
      await page.locator('#app-preloader').waitFor({state:'detached',timeout:1000});
      // An ordinary macOS browser does not opt into native chrome.
      await page.goto('http://mailai.test/');
      assert(!await page.locator('html').evaluate(el=>el.classList.contains('macos-native-window')));
      await page.close();
    }
    console.log('native startup: first-paint theme/layout, surface continuity, brand alignment, handoff, resizing and reduced motion passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
