const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached',timeout:20000});
    const config = await page.evaluate(() => api('/api/system/config'));
    assert(config.accounts.every(a => a.user.endsWith('@example.test')));
    await page.evaluate(async id => openAccountMailbox(id,'inbox'), config.accounts[0].id);
    const row = await page.evaluate(() => ({...allEmails[0],status:'trash',subject:'本地已删除测试邮件'}));
    await page.route('**/api/emails?**', route => {
      if (new URL(route.request().url()).searchParams.get('status') === 'trash') return route.fulfill({json:[row]});
      return route.continue();
    });
    let pending;
    await page.route('**/api/mail/folders', route => { pending = route; });
    await page.evaluate(id => { window.navigationTest = openAccountMailbox(id,'trash'); }, config.accounts[0].id);
    await page.getByText('本地已删除测试邮件', {exact:true}).waitFor();
    assert.equal(await page.locator('#list-title').innerText(), '已删除');
    assert(await page.locator('#btn-empty-trash').isVisible());
    assert(pending, 'Folder discovery should still be pending after local mail appears');
    await pending.fulfill({status:502,json:{detail:'fixture timeout'}});
    await page.evaluate(() => window.navigationTest);
    assert(await page.getByText('本地已删除测试邮件', {exact:true}).isVisible());
    assert.match(await page.locator('#toast').innerText(), /已显示本地已删除邮件/);
    assert.deepEqual(errors, []);
    console.log('PASS real trash navigation renders local mail before stalled IMAP discovery and preserves it on failure');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
