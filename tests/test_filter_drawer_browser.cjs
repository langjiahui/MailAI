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
      const content = document.querySelector('.filter-panel-content');
      return {panelTop:panel.top,panelRight:panel.right,panelBottom:panel.bottom,
        clearTop:clear.top,clearRight:clear.right,clearBottom:clear.bottom,footerTop:footer.top,
        contentScrollHeight:content.scrollHeight,contentHeight:content.clientHeight};
    });
    assert(geometry.clearTop >= geometry.panelTop && geometry.clearTop < geometry.panelTop + 50
      && geometry.panelRight - geometry.clearRight < 20,
    'Clear all should sit in the top-right corner of the filter drawer');
    assert(geometry.clearBottom < geometry.panelBottom && geometry.clearBottom < geometry.footerTop);
    assert(geometry.contentScrollHeight <= geometry.contentHeight + 1,
      'the full filter form should fit without an inner scrollbar at a normal desktop height');
    await page.locator('#filter-priority [data-value="高"]').click();
    assert.equal(await clear.isEnabled(), true);
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
    await page.setViewportSize({width:400,height:700});
    await button.dispatchEvent('click');
    await page.waitForTimeout(380);
    const narrow = await page.evaluate(() => {
      const list = document.getElementById('email-list').getBoundingClientRect();
      const panel = document.getElementById('workspace-filters').getBoundingClientRect();
      const clear = document.getElementById('btn-reset-filter');
      const clearTop = clear.getBoundingClientRect().top;
      const content = document.querySelector('.filter-panel-content');
      content.scrollTop = content.scrollHeight;
      return {listHeight:list.height,panelBottom:panel.bottom,clearBottom:clear.getBoundingClientRect().bottom,
        clearTop,clearTopAfterScroll:clear.getBoundingClientRect().top};
    });
    assert(narrow.listHeight >= 100, 'narrow screens should retain room for the mail list');
    assert(narrow.clearBottom < narrow.panelBottom, 'Clear all should remain visible on narrow screens');
    assert.equal(narrow.clearTopAfterScroll, narrow.clearTop, 'Clear all should stay in place while options scroll');
    console.log('PASS filter drawer motion, list reflow and persistent top-right Clear all');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
