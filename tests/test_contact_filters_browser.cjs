// Run only against the isolated example.test workspace preview.
const assert=require('node:assert/strict');
const browserType=require('playwright')[process.env.MAILAI_BROWSER||'chromium'];
const preview=process.env.MAILAI_PREVIEW_URL||'http://127.0.0.1:18795';
(async()=>{
  const browser=await browserType.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/mail/contacts/directory/summary',async route=>{
      const response=await route.fetch();const body=await response.json();
      await route.fulfill({response,json:{...body,pending:1}});
    });
    await page.goto(preview);await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(async()=>{
      const accountId=activeMailAccount().id;
      const post=body=>({accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      for(const name of ['项目A','客户','交付项目'])await api('/api/mail/contact-tags?name='+encodeURIComponent(name),{accountId,method:'DELETE'});
      for(const [email,name,company,department,labels] of [
        ['filter-a@example.test','陈晓','示例科技','研发部','项目组'],
        ['filter-b@example.test','李明','示例科技','产品部','项目组、负责人'],
        ['filter-c@example.test','王静','示例服务','运营部','负责人']]) {
        await api('/api/mail/contacts',post({email,name,company,group_name:email==='filter-b@example.test'?'原分组':'',profile:{department,directory_tags:labels}}));
      }
      await api('/api/mail/contact-tags',post({name:'项目A'}));
      await api('/api/mail/contact-tags',post({name:'客户'}));
      await api('/api/mail/contact-tags/members',post({name:'项目A',emails:['filter-a@example.test','filter-b@example.test']}));
      await api('/api/mail/contact-tags/members',post({name:'客户',emails:['filter-a@example.test']}));
      document.documentElement.dataset.theme='dark';await openContactCenter();
    });
    assert.equal(await page.locator('.contact-group-toolbar').isVisible(),false);
    assert.equal(await page.locator('.directory-toolbar').isVisible(),false);
    assert.equal(await page.locator('.contact-import-menu').count(),0,'import remains a single button without a split arrow');
    assert.equal(await page.locator('#contact-center .productivity-panel-entry').getAttribute('data-pending-count'),'1');
    await page.locator('.contact-import-entry').click();
    await page.locator('[data-import-pending]').waitFor();
    assert.match(await page.locator('[data-import-pending]').textContent(),/1/);
    await page.locator('[data-directory-close]').click();
    const rows=page.locator('#contact-center-list .contact-center-item');
    const initialCount=await rows.count();
    assert.equal(await rows.first().locator('.contact-row-actions button').count(),3,'rows keep only compose/edit/remove');
    const tagMenu=page.locator('[data-tag-menu]');
    await tagMenu.locator('summary').click();
    await tagMenu.locator('input[value="personal:项目A"]').check();
    await page.waitForFunction(()=>document.querySelectorAll('#contact-center-list .contact-center-item').length===2);
    await tagMenu.locator('input[value="personal:客户"]').check();
    await page.locator('[data-tag-mode]').selectOption('all');
    await page.waitForFunction(()=>document.querySelectorAll('#contact-center-list .contact-center-item').length===1);
    assert.equal(await rows.first().getAttribute('data-contact-email'),'filter-a@example.test');
    assert.match(await page.locator('[data-contact-results]').textContent(),/1 位/);
    await tagMenu.locator('summary').focus();await page.keyboard.press('Escape');
    assert.equal(await tagMenu.getAttribute('open'),null);
    await page.locator('[data-more-menu]>summary').click();
    await page.locator('#directory-department-filter').selectOption('产品部');
    await page.getByText('没有符合筛选条件的联系人',{exact:true}).waitFor();
    await page.locator('[data-more-menu] [data-filter-done]').click();
    await page.locator('[data-clear-kind="department"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#contact-center-list .contact-center-item').length===1);
    await page.locator('[data-clear-all]').click();
    await page.waitForFunction(count=>document.querySelectorAll('#contact-center-list .contact-center-item').length===count,initialCount);
    // Bulk assignment adds labels without replacing existing imported/personal labels.
    await tagMenu.locator('summary').click();
    await page.locator('[data-bulk-toggle]').click();
    await page.locator('[data-tag-contact="filter-c@example.test"]').check();
    await page.locator('[data-bulk-apply]').click();
    await page.locator('[data-member-tag]').selectOption('项目A');
    await page.locator('[data-member-add]').click();
    await page.locator('#contact-tags-dialog').waitFor({state:'hidden'});
    assert.match(await page.locator('[data-contact-email="filter-c@example.test"] .contact-labels').textContent(),/项目A/);
    assert.match(await page.locator('[data-contact-email="filter-c@example.test"] .contact-labels').textContent(),/负责人/);
    await page.locator('[data-bulk-exit]').click();
    // Rename keeps a currently active tag filter usable.
    await tagMenu.locator('summary').click();
    await tagMenu.locator('input[value="personal:项目A"]').check();
    await page.waitForFunction(()=>document.querySelectorAll('#contact-center-list .contact-center-item').length===3);
    await page.locator('[data-tag-manage]').click();
    await page.locator('[data-tag-rename="项目A"]').click();
    await page.locator('[data-new-tag]').fill('交付项目');
    await page.locator('#contact-tags-dialog [type=submit]').click();
    await page.locator('#contact-tags-dialog').waitFor({state:'hidden'});
    assert.match(await page.locator('.contact-filter-chips').textContent(),/交付项目/);
    assert.equal(await rows.count(),3);
    // Imported labels participate in filtering but aren't editable personal tags.
    await tagMenu.locator('summary').click();
    await tagMenu.locator('input[value="directory:负责人"]').check();
    await page.locator('[data-tag-mode]').selectOption('all');
    await page.waitForFunction(()=>document.querySelectorAll('#contact-center-list .contact-center-item').length===2);
    await tagMenu.locator('[data-filter-done]').click();
    await page.screenshot({path:'/tmp/mailai-contact-filters-dark.png'});
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    await page.screenshot({path:'/tmp/mailai-contact-filters-light.png'});
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-more-menu]>summary').click();
    assert(await page.locator('[data-more-menu] .contact-filter-popover').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'more filters fit a narrow viewport');
    await page.locator('[data-more-menu] [data-filter-done]').click();
    await page.screenshot({path:'/tmp/mailai-contact-filters-narrow.png'});
    // Reopening clears temporary filtering, including department and tag mode.
    await page.evaluate(async()=>{closeContactCenter();await openContactCenter();});
    assert.equal(await page.locator('.contact-filter-chips').isVisible(),false);
    assert.equal(await page.locator('#directory-department-filter').inputValue(),'');
    assert.equal(await rows.count(),initialCount);
    // Individual label editing belongs in the editor and preserves unsaved fields.
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-contact-edit="filter-b@example.test"]').click();
    await page.locator('#contact-name').fill('尚未保存的姓名');
    await page.locator('.contact-editor-tags button').click();
    await page.locator('[data-member-tag]').selectOption('客户');
    await page.locator('[data-member-add]').click();
    await page.locator('#contact-tags-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#contact-name').inputValue(),'尚未保存的姓名');
    assert.match(await page.locator('.contact-editor-tag-values').textContent(),/客户/);
    await page.locator('.contact-editor-tags button').click();
    await page.locator('[data-member-tag]').selectOption('原分组');
    await page.locator('[data-member-remove]').click();
    await page.locator('#contact-tags-dialog').waitFor({state:'hidden'});
    await page.locator('#contact-form [type=submit]').click();
    await page.locator('#contact-editor').waitFor({state:'hidden'});
    const saved=await page.evaluate(()=>api('/api/mail/contacts?q=filter-b@example.test',{accountId:contactAccountId()}));
    assert.equal(saved[0].name,'尚未保存的姓名');assert.equal(saved[0].group_name,'');
    assert(!saved[0].tags.some(t=>t.name==='原分组'),'saving the editor must not restore a removed legacy tag');
    assert.deepEqual(errors,[]);
    console.log('PASS contact filters: compact layout, imported and personal tags, any/all matching, department chips, empty recovery, bulk add, active rename, pending badge, light/dark and narrow layouts');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
