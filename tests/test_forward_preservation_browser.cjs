// Run against tests/workspace_preview.py; no live mailbox or SMTP access.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless:true, channel:'chrome'});
  try {
    const page = await browser.newPage();
    await page.route('**/api/emails/902/attachments/0*', route => route.fulfill({body:'forwarded file', contentType:'text/plain'}));
    await page.goto('http://127.0.0.1:18795');
    await page.locator('.email-item').first().waitFor();
    await page.evaluate(() => {
      selectedEmailDetail = {id:902, subject:'Original', from_addr:'sender@example.test',
        to_addr:'work@example.test', date:new Date().toISOString(), body_text:'Styled original',
        quote_html:'<p><strong>Styled original</strong></p>',
        attachments:[{name:'original.txt', size:14, content_type:'text/plain'}],
        _account_id:activeMailAccount().id};
    });
    await page.evaluate(() => composeFromEmail('forward'));
    assert.equal(await page.locator('#compose-subject').inputValue(), 'Fwd: Original');
    assert.match(await page.locator('#compose-quote-content').innerHTML(), /<strong>Styled original<\/strong>/);
    assert.equal(await page.evaluate(() => atob(composeAttachments[0].data_base64)), 'forwarded file');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
