const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/system/model-usage*',r=>r.fulfill({json:{total:128600,input:100000,output:28600,calls:52,unreported:2,accounts:['work@example.test'],started_at:Date.now()/1000,rows:[{provider:'custom',endpoint:'https://example.test/v1/chat/completions',model:'mail-model',total:128600,input:100000,output:28600,calls:52,unreported:2}]}}));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached',timeout:15000});
    await page.evaluate(()=>showSystemView('maintenance'));
    await page.locator('#model-usage-open').scrollIntoViewIfNeeded();
    await page.locator('#model-usage-open').click();
    await page.waitForFunction(()=>document.querySelector('#usage-body').textContent.includes('128,600'));
    assert.match(await page.locator('#usage-body').textContent(), /2 次未报告/);
    for (const theme of ['light','dark']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.screenshot({path:`build/model-usage-${theme}.png`});
    }
    await page.setViewportSize({width:600,height:800});
    assert(await page.locator('#model-usage-dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
    await page.keyboard.press('Escape');
    assert(!await page.locator('#model-usage-dialog').isVisible());
    assert.deepEqual(errors,[]);
    console.log('PASS usage dialog, totals, themes, narrow layout and keyboard dismissal');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
