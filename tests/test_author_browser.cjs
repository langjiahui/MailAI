// Isolated visual + navigation check; no real mailbox/model requests.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../app/web/static');
(async () => {
  const browser = await chromium.launch({headless:true, args:['--enable-unsafe-swiftshader'], ...(process.env.MAILAI_TEST_BROWSER_CHANNEL ? {channel:process.env.MAILAI_TEST_BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    const requests = [], errors = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      window.authorDraws = 0;
      for (const method of ['drawArrays','drawElements']) {
        const draw = WebGL2RenderingContext.prototype[method];
        WebGL2RenderingContext.prototype[method] = function(...args) {
          window.authorDraws++;
          return draw.apply(this,args);
        };
      }
    });
    await page.route('http://mailai.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, tag => /\/static\/(author-logo|settings-scroll)\.js\?/.test(tag) ? tag : '')});
      const file = path.join(root,url.pathname.replace('/static/',''));
      return fs.existsSync(file) ? route.fulfill({path:file}) : route.abort();
    });
    await page.goto('http://mailai.test/');
    await page.addScriptTag({url:'http://mailai.test/static/i18n.js'});
    assert(!requests.some(url=>url.includes('/vendor/three/')),'hidden author panel must not load the 3D runtime');
    const js = fs.readFileSync(path.join(root,'app.js'),'utf8');
    const select = js.slice(js.indexOf('function selectSystemTab('),js.indexOf('async function loadSystemConfig('));
    const handlers = js.slice(js.indexOf("document.getElementById('system-tabs').addEventListener"),js.indexOf("document.getElementById('show-server-folders').addEventListener"));
    await page.evaluate('(() => {\n' + select + '\nlet _systemTab; function loadBackups() { window.backupLoads = (window.backupLoads || 0) + 1; }\n' + handlers + '\n})()');
    await page.evaluate(() => {
      document.getElementById('app-preloader').remove();
      document.querySelector('.layout').classList.add('hidden');
      document.getElementById('system-view').classList.remove('hidden');
    });
    await page.locator('[data-system-tab="about"]').click();
    assert(await page.locator('.author-page').isVisible());
    const logo = page.locator('[data-author-logo]');
    await page.waitForFunction(()=>document.querySelector('[data-author-logo]').dataset.logoState==='ready');
    assert(await page.locator('.author-avatar').evaluate(el => el.complete && el.naturalWidth > 0));
    assert.equal(await logo.getAttribute('aria-pressed'),'true');
    const frameA = await logo.screenshot();
    await page.waitForTimeout(800);
    const frameB = await logo.screenshot();
    assert(!frameA.equals(frameB),'flowing highlights must visibly move at profile size');
    await logo.click();
    await page.mouse.move(0,0);
    await page.waitForTimeout(900);
    assert.equal(await logo.getAttribute('aria-pressed'),'false');
    const pausedA = await logo.screenshot();
    await page.waitForTimeout(150);
    assert(pausedA.equals(await logo.screenshot()),'pause must freeze the logo');
    const logoBounds = await logo.boundingBox();
    await page.mouse.move(logoBounds.x+logoBounds.width*.75,logoBounds.y+logoBounds.height*.3);
    await page.waitForTimeout(650);
    assert(!pausedA.equals(await logo.screenshot()),'pointer rotation must remain available with highlights paused');
    await page.mouse.down();
    await page.mouse.move(logoBounds.x+logoBounds.width*.94,logoBounds.y+logoBounds.height*.55,{steps:5});
    await page.mouse.up();
    assert.equal(await logo.getAttribute('aria-pressed'),'false','dragging must not toggle highlight playback');
    await page.mouse.move(0,0);
    await page.waitForTimeout(1000);
    assert(pausedA.equals(await logo.screenshot()),'leaving the logo must restore its exact front view');
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.match(await logo.getAttribute('aria-label'),/play animation/);
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    assert.equal(await page.locator('.author-signature').count(),0,'author identity should appear only once');
    assert.equal(await page.locator('.author-boundary').evaluate(el => getComputedStyle(el).borderLeftWidth),'0px');
    for (const theme of ['light','dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme=t,theme);
      await page.waitForTimeout(250);
      await page.screenshot({path:path.resolve(__dirname,`../build/author-${theme}.png`),fullPage:true});
      const colors = await page.locator('.author-page').evaluate(el => {
        const s=getComputedStyle(el); return ['--author-ink','--author-muted','--author-bg'].map(k=>s.getPropertyValue(k).trim());
      });
      const luminance = hex => {
        const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
        return c[0]*.2126+c[1]*.7152+c[2]*.0722;
      };
      for(const ink of colors.slice(0,2)) {
        const a=luminance(ink),b=luminance(colors[2]);
        assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${theme} text contrast`);
      }
    }
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    for (const width of [1920,2560,3440]) {
      await page.setViewportSize({width,height:1080});
      await page.waitForTimeout(200);
      const layout = await page.evaluate(()=>{
        const view=document.getElementById('system-view'),panel=document.querySelector('.author-page');
        const bounds=view.getBoundingClientRect(),content=panel.getBoundingClientRect();
        const tabs=view.querySelector('.system-tabs').getBoundingClientRect();
        return {edgeGap:bounds.right-content.right,navGap:content.left-tabs.right,overflow:panel.scrollWidth-panel.clientWidth};
      });
      assert(layout.edgeGap<=12,`${width}px: scroll gutter must remain at the workspace edge`);
      assert(layout.navGap<=32,`${width}px: content must use available width`);
      assert(layout.overflow<=1,`${width}px: no horizontal overflow`);
      if (width===1920) await page.screenshot({path:path.resolve(__dirname,'../build/author-wide.png'),fullPage:true});
    }
    await page.setViewportSize({width:1920,height:700});
    await page.waitForTimeout(200);
    const headerTop=await page.locator('.system-header').evaluate(el=>el.getBoundingClientRect().top);
    const panel=page.locator('.author-page');
    await panel.evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await page.waitForTimeout(100);
    assert(await panel.evaluate(el=>el.scrollTop>0),'short wide windows must still scroll');
    assert.equal(await page.locator('.system-header').evaluate(el=>el.getBoundingClientRect().top),headerTop,'settings header must remain fixed');
    assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),0,'the panel must own scrolling');
    assert(await panel.evaluate(el=>el.classList.contains('scrollbar-visible')),'scrolling must reveal the native thumb');
    await panel.evaluate(el=>{el.scrollTop=0;});
    await page.setViewportSize({width:1280,height:1000});
    await page.locator('[data-system-tab="maintenance"]').click();
    assert(await page.locator('[data-system-panel="maintenance"]').isVisible());
    assert.equal(await page.evaluate(()=>window.backupLoads),1);
    await page.locator('[data-system-tab="about"]').click();
    await logo.click();
    await page.locator('[data-about-target="guide"]').click();
    assert(await page.locator('[data-system-panel="guide"]').isVisible());
    await page.waitForTimeout(200);
    const hiddenDraws = await page.evaluate(()=>window.authorDraws);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.authorDraws),hiddenDraws,'hidden panels must stop GPU rendering');
    await page.locator('[data-system-tab="about"]').click();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForTimeout(200);
    assert.equal(await logo.getAttribute('aria-pressed'),'false','reduced motion must stop playback');
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(450);
    assert(await page.locator('.author-page').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.screenshot({path:path.resolve(__dirname,'../build/author-mobile.png'),fullPage:true});
    assert(!requests.some(url=>!url.startsWith('http://mailai.test/')),'logo must use only bundled local resources');
    assert.deepEqual(errors,[]);
    await logo.locator('canvas').evaluate(canvas=>canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await page.waitForFunction(()=>document.querySelector('[data-author-logo]').dataset.logoState==='fallback');
    assert(await page.locator('.author-avatar').isVisible(),'lost WebGL context must restore the static logo');
    assert(await logo.isDisabled());
    await page.screenshot({path:path.resolve(__dirname,'../build/author-fallback.png'),fullPage:true});
    console.log('Author: local 3D assets, lazy load, visible animation, pause, reduced motion, context fallback, hidden-panel suspension, navigation, 1920/2560/3440px layout, short-window scrolling, mobile, light/dark contrast passed');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
