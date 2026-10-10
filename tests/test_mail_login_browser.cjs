// Run against tests/workspace_preview.py; all auth/login writes are mocked.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.platform === 'darwin' ? {channel:'chrome'} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}}), errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/ui-preferences.js', route => route.fulfill({contentType:'text/javascript',body:'/* isolated test preferences */'}));
    await page.addInitScript(() => localStorage.setItem('mailai.onboarding.v2', JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
    let clients = {}, delayStart = false, releaseStart, holdDiscovery = false, releaseDiscovery, releaseUpdate;
    await page.route('**/api/oauth/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const data = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      calls.push({path,data});
      if (path === '/api/oauth/clients') {
        if (data) clients[data.provider] = {client_id:data.client_id};
        return route.fulfill({json:data ? {ok:true} : clients});
      }
      if (path === '/api/oauth/start') {
        if (delayStart) await new Promise(resolve => releaseStart = resolve);
        return route.fulfill({json:{state:'fixture-' + data.provider, url:'https://accounts.google.com/fixture-only'}});
      }
      if (path === '/api/oauth/status') return route.fulfill({json:{status:'ready'}});
      if (path === '/api/oauth/complete') return route.fulfill({json:{ok:true,smtp_warning:'fixture: receiving works; sending requires repair'}});
      return route.fulfill({json:{ok:true}});
    });
    await page.route('**/api/system/mail/account/update', async route => {
      calls.push({path:'/api/system/mail/account/update',data:route.request().postDataJSON()});
      await new Promise(resolve => releaseUpdate = resolve);
      await route.fulfill({status:400,json:{detail:'fixture: keep editor open'}});
    });
    await page.route('**/api/system/mail/discover?**', async route => {
      if (holdDiscovery) {
        await new Promise(resolve => releaseDiscovery = resolve);
        return route.fulfill({json:{imap_host:'imap.stale.test',imap_port:993,smtp_host:'smtp.stale.test',smtp_port:465,smtp_ssl:true,smtp_starttls:false,detected:false}});
      }
      return route.continue();
    });
    await page.goto(process.env.MAILAI_PREVIEW_URL || 'http://127.0.0.1:18795');
    await page.waitForFunction(() => !!window.mailaiMailLogin && !!_systemConfig);
    await page.locator('#app-preloader').waitFor({state:'hidden'});
    await page.evaluate(() => {
      window.pywebview = {api:{open_external_url:async () => ({ok:true})}};
      mailOnboarding.connected = () => {};
      showSystemView('account');
    });
    await page.locator('#btn-add-mail').click();
    const dialog = page.locator('#mail-login-dialog');
    assert.equal(await dialog.locator('[data-login-provider]').count(), 6);
    assert.equal(await page.getByText('使用 Google / Microsoft 官方登录',{exact:true}).count(),0);
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.waitForTimeout(300);
      await page.screenshot({path:`/tmp/mailai-login-picker-${theme}.png`});
    }
    await page.locator('#mail-login-address').fill('fixture@qq.com');
    assert.equal(await dialog.locator('[data-login-provider="qq"]').getAttribute('data-recommended'),'true');
    await dialog.locator('[data-login-provider="qq"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.loginProvider),'google');
    await page.locator('#mail-login-address').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id),'mail-password','recognized email should lead directly to the password field');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('#mail-host').inputValue(), 'imap.qq.com');
    await page.locator('#mail-user').fill('wrong@gmail.com');
    assert.equal(await page.locator('#mail-user').evaluate(node => node.checkValidity()), false);
    assert.equal(await page.locator('#mail-login-address-error').isVisible(),true);
    assert.equal(await page.locator('#mail-user').getAttribute('aria-invalid'),'true');
    await page.locator('#mail-user').fill('fixture@qq.com');
    assert.equal(await page.locator('.mail-login-guide-actions>a').isVisible(),true,'code acquisition must be visible without expanding help');
    await page.locator('#mail-password').fill('fixture-only-code');
    await page.locator('.mail-login-password-toggle').click();
    assert.equal(await page.locator('#mail-password').getAttribute('type'),'text');
    assert.equal(await page.locator('.mail-login-password-toggle').getAttribute('aria-pressed'),'true');
    await page.locator('.mail-login-password-toggle').click();
    assert.equal(await page.locator('#mail-password').getAttribute('type'),'password');
    await page.locator('.mail-login-credential-guide summary').click();
    assert.match(await page.locator('.mail-login-credential-guide').textContent(), /扫码仅用于登录网页/);
    await page.screenshot({path:'/tmp/mailai-login-qq-dark.png'});
    await page.locator('.mail-login-credential-heading button').click();
    await dialog.locator('[data-login-provider="other"]').click();
    assert.equal(await page.locator('#mail-user').inputValue(),'fixture@qq.com','changing provider keeps the typed email address');
    assert.equal(await page.locator('#mail-password').inputValue(),'','credentials must not follow a provider switch');
    assert.equal(await page.locator('#mail-user').evaluate(node => node.validity.customError), false);
    holdDiscovery = true;
    await page.locator('#mail-user').fill('person@unlisted.test');
    await page.waitForFunction(() => document.getElementById('mail-user').value === 'person@unlisted.test');
    // Wait for the debounced request to enter the route before changing providers.
    for (let i=0; i<30 && !releaseDiscovery; i++) await new Promise(resolve => setTimeout(resolve,20));
    assert.ok(releaseDiscovery);
    await page.locator('.mail-login-credential-heading button').click();
    await dialog.locator('[data-login-provider="exmail"]').click();
    releaseDiscovery(); holdDiscovery = false;
    await page.locator('#mail-user').fill('person@company.test');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#mail-host').inputValue(), 'imap.exmail.qq.com');
    assert.equal(await page.locator('#mail-smtp-host').inputValue(), 'smtp.exmail.qq.com');
    // A delayed discovery response must preserve manually entered server details.
    await page.locator('.mail-login-credential-heading button').click();
    await dialog.locator('[data-login-provider="other"]').click();
    holdDiscovery = true; releaseDiscovery = undefined;
    await page.locator('#mail-user').fill('manual@custom.test');
    for (let i=0; i<30 && !releaseDiscovery; i++) await new Promise(resolve => setTimeout(resolve,20));
    assert.ok(releaseDiscovery);
    await page.locator('.mail-advanced summary').click();
    await page.locator('#mail-host').fill('imap.chosen.test');
    await page.locator('#mail-smtp-host').fill('smtp.chosen.test');
    releaseDiscovery(); holdDiscovery = false;
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#mail-host').inputValue(),'imap.chosen.test');
    assert.equal(await page.locator('#mail-smtp-host').inputValue(),'smtp.chosen.test');
    // Updating a saved account must keep the original account ID and receiving host.
    await page.evaluate(() => openMailAddPanel({id:'existing-exmail',user:'person@company.test',host:'imap.exmail.qq.com'}));
    assert.equal(await page.locator('#mail-user').getAttribute('readonly'), '');
    await page.locator('#mail-password').fill('fixture-code');
    await page.evaluate(() => { document.getElementById('mail-smtp-host').value = ''; });
    await page.locator('#btn-connect-mail').click();
    assert.equal(await page.locator('.mail-advanced').getAttribute('open'),'','invalid hidden server fields must reveal advanced settings');
    assert.equal(calls.some(call => call.path === '/api/system/mail/account/update'),false);
    await page.locator('#mail-smtp-host').fill('smtp.exmail.qq.com');
    await page.locator('#btn-connect-mail').click();
    for (let i=0; i<30 && !releaseUpdate; i++) await new Promise(resolve => setTimeout(resolve,20));
    assert.ok(releaseUpdate);
    assert.equal(await page.locator('#mail-password').isDisabled(),true);
    assert.equal(await page.locator('#btn-cancel-add-mail').isDisabled(),true);
    assert.equal(await page.locator('.account-directory .saved-account').first().isDisabled(),true);
    releaseUpdate();
    await page.locator('.mail-login-credential-error').getByText('fixture: keep editor open',{exact:true}).waitFor();
    assert.equal(await page.locator('#mail-password').isEnabled(),true,'failed connection restores the form');
    assert.equal(await page.locator('#mail-password').inputValue(),'fixture-code','failure preserves entered credentials for retry');
    const update = calls.find(call => call.path === '/api/system/mail/account/update');
    assert.equal(update.data.account_id,'existing-exmail'); assert.equal(update.data.host,'imap.exmail.qq.com');
    assert.equal(update.data.smtp_host,'smtp.exmail.qq.com');
    await page.locator('#btn-cancel-add-mail').click();
    await page.locator('#btn-add-mail').click();
    await dialog.locator('[data-login-provider="google"]').click();
    await page.locator('#mail-login-capability').getByText('官方授权暂未配置，请联系应用维护者或企业管理员。',{exact:true}).waitFor();
    assert.equal(await page.locator('#mail-login-authorize').isDisabled(),true);
    assert.equal(await page.locator('#mail-login-client').isVisible(),false);
    assert.equal(calls.some(call => call.path === '/api/oauth/start'),false);
    await page.locator('#mail-login-email').fill('typed@gmail.com');
    await dialog.locator('[data-login-back]').click();
    assert.equal(await page.locator('#mail-login-address').inputValue(),'typed@gmail.com');
    await page.locator('#mail-login-address').press('Enter');
    assert.equal(await page.locator('#mail-login-email').inputValue(),'typed@gmail.com');
    await dialog.locator('.mail-login-admin summary').click();
    await page.locator('#mail-login-client').fill('fixture-google-client');
    await page.locator('#mail-login-secret').fill('fixture-secret');
    await page.locator('#mail-login-admin-form button').click();
    await page.getByText('接入配置已保存，可以开始官方授权。',{exact:true}).waitFor();
    assert.equal(await page.locator('#mail-login-secret').inputValue(),'');
    await dialog.locator('.mail-login-admin summary').click();
    await page.locator('#mail-login-email').fill('fixture@gmail.com');
    await page.screenshot({path:'/tmp/mailai-login-google-dark.png'});
    await page.locator('#mail-login-authorize').click();
    assert.equal(await page.locator('#mail-login-email').getAttribute('readonly'),'');
    await dialog.waitFor({state:'hidden'});
    assert.equal(calls.filter(call => call.path === '/api/oauth/complete').length,1);
    assert.equal(calls.filter(call => call.path === '/api/oauth/clients' && call.data).length,1,'ordinary authorization must not rewrite client settings');
    assert.ok(!calls.some(call => call.path === '/api/oauth/cancel' && call.data.state === 'fixture-google'),'completed authorization must not be canceled');
    await page.getByText('fixture: receiving works; sending requires repair',{exact:true}).waitFor();
    // Cancel without closing while the start request is pending; its late response must be discarded.
    delayStart = true; releaseStart = undefined;
    await page.evaluate(() => mailaiMailLogin.open());
    await dialog.locator('[data-login-provider="google"]').click();
    await page.locator('#mail-login-email').fill('cancel@gmail.com');
    await page.locator('#mail-login-authorize').click();
    for (let i=0; i<30 && !releaseStart; i++) await new Promise(resolve => setTimeout(resolve,20));
    assert.ok(releaseStart);
    await page.locator('#mail-login-cancel-auth').click();
    assert.equal(await page.locator('#mail-login-authorize').isEnabled(),true);
    assert.equal(await page.locator('#mail-login-email').inputValue(),'cancel@gmail.com');
    releaseStart(); delayStart = false; releaseStart = undefined;
    await page.waitForTimeout(150);
    assert.equal(calls.filter(call => call.path === '/api/oauth/complete').length,1);
    assert.equal(await page.locator('#mail-login-browser-link').isVisible(),false);
    await dialog.locator('.mail-login-close').click();
    // Cancel a pending start and reopen another provider before its response arrives.
    clients.microsoft = {client_id:'fixture-microsoft-client'}; delayStart = true;
    await page.evaluate(() => mailaiMailLogin.open());
    await dialog.locator('[data-login-provider="google"]').click();
    await page.locator('#mail-login-email').fill('fixture@gmail.com');
    await page.locator('#mail-login-authorize').click();
    for (let i=0; i<30 && !releaseStart; i++) await new Promise(resolve => setTimeout(resolve,20));
    assert.ok(releaseStart);
    await dialog.locator('.mail-login-close').click();
    await page.evaluate(() => mailaiMailLogin.open());
    await dialog.locator('[data-login-provider="microsoft"]').click();
    releaseStart(); delayStart = false;
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#mail-login-title').textContent(),'Microsoft / Outlook');
    assert.ok(calls.some(call => call.path === '/api/oauth/cancel' && call.data.state === 'fixture-google'));
    assert.equal(await page.locator('#mail-login-browser-link').isVisible(),false);
    // Reauthorization uses the official flow and freezes the saved email address.
    await dialog.locator('.mail-login-close').click();
    await page.evaluate(() => openMailAddPanel({id:'oauth-saved',user:'saved@company.test',host:'outlook.office365.com',auth_type:'oauth2'}));
    assert.equal(await page.locator('#mail-login-email').inputValue(),'saved@company.test');
    assert.equal(await page.locator('#mail-login-email').getAttribute('readonly'),'');
    await dialog.locator('.mail-login-close').click();
    // First use shares the provider chooser while keeping Skip and saved accounts usable.
    await page.evaluate(() => document.getElementById('onboarding-overlay').classList.remove('hidden'));
    assert.equal(await page.locator('#onboarding-user').isVisible(),false);
    await page.locator('#mail-login-onboarding').click();
    await page.locator('#mail-login-address').fill('first@126.com');
    await dialog.locator('[data-login-provider="netease"]').click();
    assert.equal(await page.locator('#onboarding-user').isVisible(),true);
    assert.equal(await page.locator('#onboarding-user').inputValue(),'first@126.com');
    await page.locator('#onboarding-user').fill('fixture@126.com');
    await page.waitForFunction(() => document.getElementById('onboarding-host').value === 'imap.126.com');
    await page.evaluate(() => mailaiMailLogin.open());
    await page.setViewportSize({width:390,height:760});
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth),true);
    assert.equal(await dialog.locator('.mail-login-foot').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight),true,'footer stays visible while provider choices scroll');
    await page.waitForTimeout(300);
    await page.screenshot({path:'/tmp/mailai-login-picker-mobile.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS provider routing, explicit enterprise profile, stale discovery, account update identity, configured OAuth, automatic completion, cancellation isolation, reauthorization, first use and responsive layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
