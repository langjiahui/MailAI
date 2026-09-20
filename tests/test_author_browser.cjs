// Isolated visual + navigation check; no real mailbox/model requests.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../app/web/static');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.MAILAI_TEST_BROWSER_CHANNEL ? {channel:process.env.MAILAI_TEST_BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    await page.route('http://mailai.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')});
      const file = path.join(root,url.pathname.replace('/static/',''));
      return fs.existsSync(file) ? route.fulfill({path:file}) : route.abort();
    });
    await page.goto('http://mailai.test/');
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
    assert(await page.locator('.author-avatar').evaluate(el => el.complete && el.naturalWidth > 0));
    assert.equal(await page.locator('.author-signature').count(),0,'author identity should appear only once');
    assert.equal(await page.locator('.author-boundary').evaluate(el => getComputedStyle(el).borderLeftWidth),'0px');
    for (const theme of ['light','dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme=t,theme);
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
    await page.locator('[data-system-tab="maintenance"]').click();
    assert(await page.locator('[data-system-panel="maintenance"]').isVisible());
    assert.equal(await page.evaluate(()=>window.backupLoads),1);
    await page.locator('[data-system-tab="about"]').click();
    await page.locator('[data-about-target="guide"]').click();
    assert(await page.locator('[data-system-panel="guide"]').isVisible());
    await page.locator('[data-system-tab="about"]').click();
    await page.setViewportSize({width:390,height:844});
    assert(await page.locator('.author-page').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.screenshot({path:path.resolve(__dirname,'../build/author-mobile.png'),fullPage:true});
    console.log('Author: assets, navigation, responsive layout, light/dark text contrast passed');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
