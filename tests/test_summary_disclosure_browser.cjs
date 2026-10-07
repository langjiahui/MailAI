// Run against tests/workspace_preview.py; no real mail is accessed.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    const summary = page.locator('#reading-content .optional-mail-summary');
    const toggle = page.locator('#reading-content .reading-summary-control');
    await summary.waitFor({state:'attached'});
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert((await summary.boundingBox()).height < 2, 'collapsed summary should take no reading space');
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    const positions = await page.evaluate(() => {
      const more = document.querySelector('.reading-header .reading-more-actions').getBoundingClientRect();
      const toggle = document.querySelector('.reading-summary-control').getBoundingClientRect();
      return {gap:more.left - toggle.right, row:Math.abs(more.top - toggle.top)};
    });
    assert(positions.gap < 20 && positions.row < 2, 'More should sit next to the summary control');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(() => document.querySelector('.primary-summary .summary-reveal').getAnimations().length > 0);
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    await page.waitForFunction(() => localStorage.getItem('mailai-summary-expanded') === '1');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    await summary.waitFor({state:'attached'});
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.locator('#email-list .email-item').nth(1).click();
    await summary.waitFor({state:'attached'});
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    await page.waitForFunction(() => localStorage.getItem('mailai-summary-expanded') === '0');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    await summary.waitFor({state:'attached'});
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    console.log('PASS optional summary defaults closed and persists across messages and reloads');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
