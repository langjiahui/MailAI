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
    assert.equal(await summary.evaluate(node => node.open), false);
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    await summary.locator('summary').click();
    assert.equal(await summary.evaluate(node => node.open), true);
    await page.waitForFunction(() => localStorage.getItem('mailai-summary-expanded') === '1');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    await summary.waitFor();
    assert.equal(await summary.evaluate(node => node.open), true);
    await page.locator('#email-list .email-item').nth(1).click();
    await summary.waitFor();
    assert.equal(await summary.evaluate(node => node.open), true);
    await summary.locator('summary').click();
    await page.waitForFunction(() => localStorage.getItem('mailai-summary-expanded') === '0');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('#email-list .email-item').first().click();
    await summary.waitFor();
    assert.equal(await summary.evaluate(node => node.open), false);
    assert.equal(await page.locator('#reading-content .body-section .email-body').isVisible(), true);
    console.log('PASS optional summary defaults closed and persists across messages and reloads');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
