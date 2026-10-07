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
    await summary.waitFor();
    assert.equal(await summary.locator('[data-summary-toggle]').getAttribute('aria-expanded'), 'false');
    assert((await summary.boundingBox()).height <= 60, 'collapsed summary should stay compact');
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    await summary.locator('[data-summary-toggle]').click();
    assert.equal(await summary.locator('[data-summary-toggle]').getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(() => document.querySelector('.primary-summary .summary-reveal').getAnimations().length > 0);
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    await page.waitForFunction(() => localStorage.getItem('mailai-summary-expanded') === '1');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    await summary.waitFor();
    assert.equal(await summary.locator('[data-summary-toggle]').getAttribute('aria-expanded'), 'true');
    await page.locator('#email-list .email-item').nth(1).click();
    await summary.waitFor();
    assert.equal(await summary.locator('[data-summary-toggle]').getAttribute('aria-expanded'), 'true');
    await summary.locator('[data-summary-toggle]').click();
    await page.waitForFunction(() => localStorage.getItem('mailai-summary-expanded') === '0');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    await summary.waitFor();
    assert.equal(await summary.locator('[data-summary-toggle]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    console.log('PASS optional summary defaults closed and persists across messages and reloads');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
