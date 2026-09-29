// Run only against tests/workspace_preview.py; fixture accounts use example.test.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({...(!process.env.CI ? {channel:'chrome'} : {})});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    const accounts = await page.evaluate(() => _systemConfig.accounts.map(({id,user}) => ({id,user})));
    assert.equal(accounts.length, 2);
    assert(accounts.every(account => account.user.endsWith('@example.test')));
    await page.route(/\/api\/emails\?/, async route => {
      await new Promise(resolve => setTimeout(resolve, 350));
      await route.continue();
    });
    const inbox = id => page.locator(`.sidebar-account-folders [data-account-action="inbox"][data-account-id="${id}"]`);
    await inbox(accounts[1].id).click();
    const overlay = page.locator('#mailbox-transition');
    await overlay.waitFor({state:'visible'});
    assert.match(await overlay.textContent(), /personal@example\.test/);
    assert.equal(await page.locator('.list-pane').getAttribute('aria-busy'), 'true');
    await inbox(accounts[0].id).click();
    assert.match(await overlay.textContent(), /work@example\.test/);
    await overlay.waitFor({state:'hidden',timeout:15000});
    assert.equal(await page.locator('.list-pane').getAttribute('aria-busy'), null);
    assert.equal(await page.evaluate(() => activeMailAccount()?.id), accounts[0].id);
    assert.equal(await page.evaluate(() => selectedMailboxAccountId), accounts[0].id);
    assert(await page.locator('#email-list .email-item').count() > 0);
    const sent = page.locator(`.sidebar-account-folders [data-account-action="sent"][data-account-id="${accounts[0].id}"]`);
    await sent.click();
    await overlay.waitFor({state:'visible'});
    assert.match(await overlay.textContent(), /已发送/);
    const bounds = await page.evaluate(() => {
      const list = document.getElementById('email-list').getBoundingClientRect();
      const cover = document.getElementById('mailbox-transition').getBoundingClientRect();
      return {listTop:list.top, coverTop:cover.top};
    });
    assert(Math.abs(bounds.listTop - bounds.coverTop) < 2, 'only the list should transition');
    await overlay.waitFor({state:'hidden',timeout:15000});
    await inbox(accounts[0].id).click();
    await overlay.waitFor({state:'hidden',timeout:15000});
    const trash = page.locator(`.sidebar-account-folders [data-account-action="trash"][data-account-id="${accounts[0].id}"]`);
    await trash.click();
    await overlay.waitFor({state:'hidden',timeout:15000});
    await inbox(accounts[0].id).click();
    await overlay.waitFor({state:'hidden',timeout:15000});
    assert.equal(await page.locator('#email-list .email-item').count(), 12, 'Inbox rows must return after Trash');
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => applyTheme(theme),theme);
      await inbox(accounts[1].id).click();
      await overlay.waitFor({state:'visible'});
      assert.equal(await overlay.evaluate(node => getComputedStyle(node).position), 'absolute');
      await overlay.waitFor({state:'hidden',timeout:15000});
      assert.equal(await page.evaluate(() => activeMailAccount()?.id), accounts[1].id);
      await inbox(accounts[0].id).click();
      await overlay.waitFor({state:'hidden',timeout:15000});
    }
    // The compact, single-account sidebar uses onNavClick instead of the
    // per-account navigation above; it must also restore Inbox after Trash.
    await page.evaluate(() => { _systemConfig.accounts = _systemConfig.accounts.filter(account => account.id === activeMailAccount()?.id); renderSidebarAccounts(); });
    await page.locator('#folder-nav .nav-item[data-filter="status"][data-value="trash"]').click();
    await overlay.waitFor({state:'hidden',timeout:15000});
    await page.locator('#folder-nav .nav-item[data-filter="status"][data-value="inbox"]').click();
    await overlay.waitFor({state:'hidden',timeout:15000});
    assert.equal(await page.locator('#email-list .email-item').count(), 12, 'single-account Inbox must reload after Trash');
    console.log('PASS mailbox transition, rapid account switching, light/dark themes');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exit(1);});
