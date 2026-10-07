// Run against tests/workspace_preview.py; the fixture uses example.test accounts.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:600}});
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    const button = page.locator('#btn-filter-panel');
    const panel = page.locator('#workspace-filters');
    const clear = page.locator('#btn-reset-filter');
    const listTop = (await page.locator('#email-list').boundingBox()).y;
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert(await panel.evaluate(node => node.getAnimations().length) > 0, 'drawer opening should animate');
    await page.waitForTimeout(100);
    const midTop = (await page.locator('#email-list').boundingBox()).y;
    await page.waitForTimeout(300);
    const endTop = (await page.locator('#email-list').boundingBox()).y;
    assert(listTop < midTop && midTop < endTop, 'mail list should follow the opening drawer');
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('workspace-filters').getBoundingClientRect();
      const clear = document.getElementById('btn-reset-filter').getBoundingClientRect();
      const footer = document.querySelector('.list-footer').getBoundingClientRect();
      return {panelBottom:panel.bottom,clearBottom:clear.bottom,footerTop:footer.top};
    });
    assert(geometry.clearBottom < geometry.panelBottom && geometry.clearBottom < geometry.footerTop,
      'Clear all should remain above the panel edge and list footer');
    await page.locator('#filter-priority [data-value="高"]').click();
    assert.equal(await clear.isEnabled(), true);
    await page.locator('.filter-panel-content').evaluate(node => { node.scrollTop = 0; });
    await clear.click();
    assert.equal(await page.locator('#filter-priority [data-value=""]').evaluate(node => node.classList.contains('active')), true);
    await button.click();
    assert(await panel.evaluate(node => node.getAnimations().length) > 0, 'drawer closing should animate');
    await page.waitForFunction(() => document.getElementById('workspace-filters').classList.contains('hidden'));
    assert.equal((await page.locator('#email-list').boundingBox()).y, listTop);
    await button.click();
    await page.waitForTimeout(70);
    await button.click();
    await page.waitForFunction(() => document.getElementById('workspace-filters').classList.contains('hidden'));
    assert.equal(await button.getAttribute('aria-expanded'), 'false', 'a rapid reversal should end closed');
    await page.emulateMedia({reducedMotion:'reduce'});
    await button.click();
    assert.equal(await panel.evaluate(node => node.getAnimations().length), 0);
    assert.equal(await clear.isVisible(), true);
    await button.click();
    assert.equal(await panel.isVisible(), false);
    console.log('PASS filter drawer motion, list reflow and visible Clear all footer');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
