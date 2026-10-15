// Real account IDs overlap on purpose; native clicks must retain their mailbox.
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
(async () => {
  const browser = await (process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium).launch({headless:true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.MAILAI_BASE_URL || 'http://127.0.0.1:18795');
    await page.waitForFunction(() => typeof window.mailaiOpenMailNotification === 'function' &&
      document.querySelectorAll('#account-mailbox-nav [data-account-action="inbox"]').length >= 2);
    const accounts = await page.evaluate(() => _systemConfig.accounts.map(account => account.id));
    // A notification arriving while Settings is open must return to the mail.
    await page.evaluate(() => showSystemView('about'));
    const opened = await page.evaluate(async accounts => {
      const results = await Promise.all([
        window.mailaiOpenMailNotification({accountId:accounts[1], emailId:2}),
        window.mailaiOpenMailNotification({accountId:accounts[0], emailId:1}),
      ]);
      return {results, owner:activeMailAccount()?.id, id:selectedEmailId,
              recipient:selectedEmailDetail?.to_addr,
              settingsHidden:document.getElementById('system-view').classList.contains('hidden')};
    }, accounts);
    assert.deepEqual(opened.results, [true, true]);
    assert.equal(opened.owner, accounts[0]);
    assert.equal(opened.id, 1);
    assert(opened.settingsHidden);
    const owner = await page.evaluate(() => activeMailAccount().user);
    assert.equal(opened.recipient, owner);
    // Deleted accounts and malformed/summary targets cannot select another mail.
    assert.equal(await page.evaluate(() => window.mailaiOpenMailNotification({accountId:'removed', emailId:1})), false);
    assert.equal(await page.evaluate(() => window.mailaiOpenMailNotification({emailId:1})), false);
    assert.equal(await page.evaluate(() => selectedEmailId), 1);
    // Historical mail outside the initial list is fetched directly on click.
    assert.equal(await page.evaluate(accountId => window.mailaiOpenMailNotification({accountId, emailId:12}), accounts[1]), true);
    assert.equal(await page.evaluate(() => activeMailAccount().id), accounts[1]);
    assert.equal(await page.evaluate(() => selectedEmailId), 12);
    assert.deepEqual(errors, []);
    console.log('PASS native notification clicks: queued accounts, overlapping IDs, settings, missing account, direct mail lookup');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
