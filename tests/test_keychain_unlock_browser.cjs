// Run only against tests/workspace_preview.py; all authorization responses mocked.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
  for(const type of [chromium,webkit]) {
    const browser=await type.launch({headless:true});
    let page;
    try {
      page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
      let unlocked=false,target='',explicit=0;const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/system/config',async route=>{
        const response=await route.fetch(),data=await response.json();
        assert(data.accounts.every(a=>a.user.endsWith('@example.test')),'Isolated fixture required');
        target=data.accounts[1].id;
        data.accounts[1].credential_available=unlocked;
        data.accounts[1].credential_authorization_required=!unlocked;
        await route.fulfill({json:data});
      });
      await page.route('**/api/system/mail/preferred',async route=>{
        const request=route.request().postDataJSON();
        explicit++;assert.equal(request.account_id,target);unlocked=true;
        await route.fulfill({json:{ok:true,account_id:target,user:'personal@example.test'}});
      });
      await page.goto('http://127.0.0.1:18795/');await page.locator('#app-preloader').waitFor({state:'detached'});
      await page.evaluate(()=>{setI18nLanguage('zh-CN');showSystemView('account');});
      await page.locator(`.saved-account[data-account-id="${target}"]`).click();
      assert.equal(await page.locator('#btn-manage-mail').textContent(),'解锁凭据');
      assert.match(await page.locator('#selected-account-help').textContent(),/共用保险库/);
      assert.equal(explicit,0,'Startup, status, and settings selection do not authorize other mailboxes');
      await page.evaluate(async()=>{await loadSystemConfig();await loadSystemConfig();});
      assert.equal(explicit,0);
      await page.locator('#btn-manage-mail').click();
      await page.waitForFunction(()=>document.querySelector('#btn-manage-mail').textContent.includes('更新登录信息'));
      assert.equal(explicit,1,'One explicit unlock; config refresh must not cascade prompts');
      assert.equal(await page.locator('#mail-add-panel').isVisible(),false,'No password entry is required when a saved credential can be unlocked');
      await page.evaluate(async()=>{await loadSystemConfig();await loadSystemConfig();});assert.equal(explicit,1);
      // Unlock from the mailbox sidebar also works without opening a login form.
      unlocked=false;
      await page.evaluate(async()=>{browsingAccountId='';await loadSystemConfig();hideSystemView(true);});
      await page.locator(`.sidebar-account-head[data-account-id="${target}"]`).click();
      await page.waitForFunction(target=>activeMailAccount()?.id===target,target);
      assert.equal(explicit,2);
      assert.deepEqual(errors,[]);
      console.log(`${type.name()}: pending credential UI, passive status, explicit per-mailbox unlock and sidebar selection passed`);
    }finally{await page?.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
