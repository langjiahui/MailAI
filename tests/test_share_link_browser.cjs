// Run against tests/workspace_preview.py, never a live mailbox.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless:true, channel:'chrome'});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:18795');
    await page.locator('.email-item').first().waitFor();
    await page.evaluate(() => openCompose());
    assert.equal(await page.locator('#btn-add-share-link, #btn-attachment-options, #btn-paste-attachment').count(), 0);
    const fileChooser = page.waitForEvent('filechooser');
    await page.locator('#btn-add-attachment').click();
    assert.ok(await fileChooser);
    await page.locator('#compose-message').fill('已有网盘链接可直接贴在正文：https://example.test/file');
    await page.evaluate(async () => {
      const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'oversized.zip');
      await addComposeAttachments([file]);
    });
    assert.equal(await page.locator('#share-cos-file').evaluate(input => input.files[0]?.name), 'oversized.zip');
    assert.equal(await page.locator('#compose-attachments .compose-attachment-chip').count(), 0);
    await page.route('**/api/share-storage/upload', route => route.fulfill({status:502, contentType:'application/json', body:JSON.stringify({error:'上传失败'})}));
    await page.locator('#share-cos-form button[type=submit]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#compose-message a').count(), 0);
    assert.match(await page.locator('#compose-message').innerText(), /https:\/\/example\.test\/file/);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
