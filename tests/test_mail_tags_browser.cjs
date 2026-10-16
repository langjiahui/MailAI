const assert = require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
  const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.locator('.sidebar-account-folders [data-account-action="inbox"]').first().click();
    await page.locator('.email-item').first().waitFor();
    await page.evaluate(async()=>{const data=await api('/api/mail/tags');for(const tag of data.tags)await api(`/api/mail/tags/${tag.id}`,{method:'DELETE'});await loadData();});
    const dialog=page.locator('#mail-tags-dialog');
    await page.locator('[data-mail-tag-manage]').click();
    await dialog.waitFor({state:'visible'});
    const form=dialog.locator('[data-tag-form]');
    await form.locator('[name=name]').fill('项目 A');await form.locator('[type=submit]').click();
    await dialog.getByText('标签已保存',{exact:true}).waitFor();
    await form.locator('[name=name]').fill('客户');await form.locator('[type=submit]').click();
    await dialog.locator('[data-edit-tag]').nth(1).waitFor();
    // A rejected mutation keeps the form intact and supports an explicit retry.
    await page.route('**/api/mail/tags',async route=>{if(route.request().method()==='POST'){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'模拟保存失败'})});}else await route.continue();});
    await form.locator('[name=name]').fill('失败重试');await form.locator('[type=submit]').click();
    await dialog.getByText('模拟保存失败',{exact:true}).waitFor();
    assert.equal(await form.locator('[name=name]').inputValue(),'失败重试');
    await page.unroute('**/api/mail/tags');
    await form.locator('[type=submit]').click();await dialog.locator('[data-edit-tag]').nth(2).waitFor();
    await dialog.locator('.mail-tags-close').click();
    await page.locator('.email-item[data-id="1"]').click();
    await page.locator('[data-edit-mail-tags]').click();
    await dialog.locator('.mail-tag-choice').filter({hasText:'项目 A'}).locator('input').check();
    await dialog.locator('.mail-tag-choice').filter({hasText:'客户'}).locator('input').check();
    await dialog.locator('[data-assign-form] [type=submit]').click();
    await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelectorAll('[data-reading-mail-tags] .mail-label-chip').length===2);
    await page.locator('#mail-tag-nav [data-mail-tag="项目 A"]').click();
    assert.equal(await page.locator('.email-item').count(),1);
    await page.locator('#mail-tag-nav [data-mail-tag="客户"]').click();
    await page.locator('[data-mail-tag-mode]').selectOption('all');
    assert.equal(await page.locator('.email-item').count(),1);
    assert.match(await page.locator('#list-title').textContent(),/项目 A/);
    await page.locator('#category-nav .nav-item').first().click();
    assert.equal(await page.locator('.email-item').count(),1);
    assert.equal(await page.locator('#mail-tag-nav [aria-pressed=true]').count(),2);
    await page.locator('#btn-filter-panel').click();
    await page.locator('#btn-reset-filter').click();
    await page.locator('#btn-filter-panel').click();
    await page.waitForFunction(()=>document.querySelectorAll('.email-item').length===12);
    // Batch changes add labels without replacing a message's existing labels.
    await page.locator('.email-item').first().click();
    await page.locator('.email-item').nth(2).click({modifiers:['Shift']});
    await page.locator('[data-bulk-mail-tags]').click();
    await dialog.locator('.mail-tag-choice').filter({hasText:'失败重试'}).locator('input').check();
    await dialog.locator('[data-assign-form] [type=submit]').click();
    await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(()=>allEmails.filter(e=>e.tags.some(t=>t.name==='失败重试')).length===3);
    assert.equal(await page.evaluate(()=>allEmails.find(e=>e.id===1).tags.length),3);
    await page.locator('#bulk-cancel').click();
    // Author a rule with two fields and two targets, then apply it to historical mail.
    await page.locator('[data-mail-tag-manage]').click();
    await dialog.locator('[data-tab=rules]').click();await dialog.locator('[data-new-rule]').click();
    const rule=dialog.locator('[data-rule-form]');
    await rule.locator('[name=name]').fill('采购合同规则');
    await rule.locator('[data-field]').selectOption('subject');await rule.locator('.mail-tag-condition input').fill('采购合同');
    await rule.locator('[data-add-condition]').click();
    await rule.locator('[data-field]').nth(1).selectOption('body');await rule.locator('.mail-tag-condition input').nth(1).fill('交付');
    for(const name of ['项目 A','客户'])await rule.locator('.mail-tag-choice').filter({hasText:name}).locator('[name=tag_ids]').check();
    await rule.locator('[type=submit]').click();await dialog.locator('[data-edit-rule]').waitFor();
    await dialog.locator('[data-apply-rules]').click();
    await dialog.getByText(/已为 \d+ 封邮件添加标签/).waitFor();
    assert.equal(await page.evaluate(()=>allEmails.filter(e=>e.tags.some(t=>t.name==='客户')).length),4);
    await dialog.locator('[data-edit-rule]').click();
    assert.equal(await dialog.locator('.mail-tag-condition').count(),2);
    await dialog.locator('[data-cancel-rule]').click();
    await dialog.locator('[data-new-rule]').click();
    // Inspect both palettes and a narrow window with the actual app cascade.
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>applyTheme(theme),theme);
      for(const width of [1440,600,390]) {
        await page.setViewportSize({width,height:900});
        const metrics=await dialog.evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,rect:n.getBoundingClientRect().toJSON(),bg:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color}));
        assert(metrics.scroll<=metrics.width+1,JSON.stringify(metrics));
        assert(metrics.rect.left>=0&&metrics.rect.right<=width,JSON.stringify(metrics));
        assert.notEqual(metrics.bg,'rgba(0, 0, 0, 0)');
      }
    }
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>applyTheme('light'));
    await dialog.locator('[data-cancel-rule]').click();
    await dialog.screenshot({path:'build/mail-tags-rules-preview.png'});
    await dialog.locator('.mail-tags-close').click();
    await page.evaluate(()=>setI18nLanguage('en'));
    await page.locator('[data-mail-tag-manage]').click();
    assert.match(await dialog.locator('[data-tab=tags]').textContent(),/Manage labels/);
    await dialog.locator('[data-tab=rules]').click();
    await dialog.locator('[data-new-rule]').click();
    assert.match(await dialog.locator('[data-rule-form]').textContent(),/Match all conditions/);
    await page.setViewportSize({width:390,height:900});
    assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    await page.setViewportSize({width:1440,height:1000});
    await dialog.locator('.mail-tags-close').click();
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.locator('[data-mail-tag-manage]').click();
    await dialog.locator('.mail-tags-close').click();
    await page.locator('.sidebar-account-folders [data-account-action="inbox"]').nth(1).click();
    await page.waitForFunction(()=>allEmails.length===12 && allEmails.every(e=>!e.tags?.length));
    assert.equal(await page.locator('#mail-tag-nav [data-mail-tag]').count(),0);
    const held=[];
    await page.route('**/api/mail/tags',route=>{if(route.request().method()==='GET')held.push(route);else void route.continue();});
    const started=Date.now();
    assert.equal(await page.evaluate(()=>loadData({includeAncillary:false})),true);
    assert(Date.now()-started<2500,'A stalled label catalogue must not stall mail loading');
    for(const route of held)await route.continue();
    await page.unroute('**/api/mail/tags');
    assert.deepEqual(errors,[]);
    console.log('PASS mail labels UI: CRUD, retry, single and batch assignment, AI facets, rule editor and historical application, palettes, narrow layouts, account isolation');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
