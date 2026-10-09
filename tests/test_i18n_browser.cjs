// Run against the isolated example.test workspace fixture; never a live mailbox.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
const preview=process.env.MAILAI_TEST_URL||'http://127.0.0.1:18795/';
const han=/[\u3400-\u9fff]/;
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.request.post(new URL('/api/ui-preferences',preview).href,{data:{key:'mailai-language',value:'en'}});
    await page.goto(preview);await page.locator('#app-preloader').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>currentI18nLanguage()),'en','English must apply on startup from persisted preferences');
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--mailai-copy-signature')), '"Signature"');
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    const audit=async selector=>{
      await page.waitForTimeout(80);
      const leaks=await page.locator(selector).evaluate(root=>[root,...root.querySelectorAll('*')].flatMap(n=>{
        if(!n.getClientRects().length&&!(n.tagName==='OPTION'&&n.closest('select')?.getClientRects().length))return[];
        if(n.closest('[contenteditable=true],textarea'))return[];
        const result=[];
        for(const c of n.childNodes)if(c.nodeType===3&&/[\u3400-\u9fff]/.test(c.textContent))result.push(n.tagName+': '+c.textContent);
        for(const a of ['title','placeholder','aria-label','alt','data-tooltip','data-placeholder'])if(/[\u3400-\u9fff]/.test(n.getAttribute(a)||''))result.push(a+': '+n.getAttribute(a));
        return result;
      }));
      assert.deepEqual(leaks,[],`Untranslated interface in ${selector}`);
    };
    await page.locator('#btn-filter-panel').click();await audit('.mail-filter-group');
    assert.equal(await page.locator('#productivity-workflow-filter').inputValue(),'all');
    await page.locator('#filter-priority [data-value="高"]').click();
    assert.equal(await page.evaluate(()=>currentFilter.priority),'高','Translated filter labels must keep the backend enum value');
    await page.locator('#btn-reset-filter').click();
    await page.locator('[data-account-action="local_archive"]').first().click();
    await audit('#email-list');await audit('.mail-filter-group');
    assert.equal(await page.locator('#list-title').textContent(), 'Local archive', 'Dynamic mailbox title must not revert to its static startup label');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.waitForTimeout(80);
    assert.equal(await page.locator('#list-title').textContent(), '本地归档');
    await page.evaluate(()=>setI18nLanguage('en'));await page.waitForTimeout(80);
    assert.equal(await page.locator('#list-title').textContent(), 'Local archive');
    assert(!han.test(await page.locator('#search-scope').textContent()));
    assert(!han.test(await page.locator('.facet-scope-label').first().textContent()));
    if(process.env.MAILAI_SCREENSHOT_DIR){fs.mkdirSync(process.env.MAILAI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.MAILAI_SCREENSHOT_DIR+'/i18n-archive-dark.png'});}
    await page.evaluate(()=>window.mailaiProductivity.openSearch());await audit('#productivity-dialog');
    const input=page.locator('[data-criterion=query]'),state=page.locator('[data-criterion=state]');
    await input.fill('采购合同 {0} <b>保留输入</b>');await state.selectOption('reply');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.waitForTimeout(80);
    assert.equal(await page.locator('#productivity-title').textContent(),'高级搜索');
    assert.equal(await state.locator('option:checked').textContent(),'待回复');
    await page.evaluate(()=>setI18nLanguage('en'));await audit('#productivity-dialog');
    assert.equal(await input.inputValue(),'采购合同 {0} <b>保留输入</b>');assert.equal(await state.inputValue(),'reply');
    assert.equal(await page.locator('#productivity-title').textContent(),'Advanced search');
    if(process.env.MAILAI_SCREENSHOT_DIR)await page.locator('#productivity-dialog').screenshot({path:process.env.MAILAI_SCREENSHOT_DIR+'/i18n-search-dark.png'});
    await page.evaluate(()=>document.querySelector('#productivity-dialog').close());
    // Secondary dialogs are easy to miss during a main-page translation audit.
    await page.evaluate(()=>openContactCenter());
    await page.locator('#contact-center .productivity-panel-entry').first().click();await audit('#contact-directory-dialog');
    await page.evaluate(()=>document.querySelector('#contact-directory-dialog').close());await page.locator('#btn-close-contacts').click();
    await page.evaluate(()=>openAttachmentCenter());
    await page.locator('#attachment-center .productivity-panel-entry').first().click();await audit('#productivity-dialog');
    await page.evaluate(()=>document.querySelector('#productivity-dialog').close());await page.locator('#btn-close-attachments').click();
    await page.evaluate(()=>openTodoCenter());
    await page.locator('#todo-center .productivity-panel-entry').first().click();await audit('#productivity-dialog');
    await page.evaluate(()=>document.querySelector('#productivity-dialog').close());
    await page.locator('#btn-task-notices').click();await page.locator('#notice-capability').filter({hasText:/\S/}).waitFor();await audit('#task-notices');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.evaluate(()=>setI18nLanguage('en'));await audit('#task-notices');
    await page.locator('[data-notice-close]').click();await page.locator('#btn-close-todos').click();
    await page.evaluate(()=>openTaskCenter());await audit('#task-center');await page.locator('#close-task-center').click();
    await page.evaluate(()=>openAssistant());await audit('#assistant-panel');
    await page.evaluate(()=>closeAssistant());
    await page.evaluate(()=>showDashboard());await page.waitForFunction(()=>_dashboardData!==null);
    await page.evaluate(()=>renderDashboard({total:12,operations:{pending_review:2},action_policy:{mode:'review'}}));
    await audit('#dashboard-view');
    const dashboardTitle=await page.locator('#dashboard-status-title').textContent();
    assert.notEqual(dashboardTitle,'Assessing…','The loaded dashboard status must replace its initial label');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.waitForTimeout(80);
    assert.match(await page.locator('#dashboard-status-title').textContent(), /2/);
    await page.evaluate(()=>setI18nLanguage('en'));await audit('#dashboard-view');
    assert.equal(await page.locator('#dashboard-status-title').textContent(), dashboardTitle);
    await page.evaluate(()=>hideDashboard());
    await page.evaluate(()=>showRulesView());await page.locator('.rule-weight').first().waitFor({state:'attached'});
    await page.locator('#btn-toggle-advanced-rules').click();await audit('#rules-view');
    await page.locator('.rule-weight').first().fill('42');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.waitForTimeout(80);
    assert.equal(await page.locator('.rule-weight').first().inputValue(),'42');
    await page.evaluate(()=>setI18nLanguage('en'));await audit('#rules-view');
    assert.equal(await page.locator('.rule-weight').first().inputValue(),'42','Keep unsaved rule edits across language changes');
    await page.evaluate(()=>hideRulesView());
    for(const tab of ['preferences','account','ai','maintenance','guide','about','remote']){await page.evaluate(tab=>showSystemView(tab),tab);await audit('#system-view');}
    await page.evaluate(()=>{hideSystemView(true);openCompose();});await audit('#compose-modal');
    await page.locator('#compose-subject').fill('未启用 {0}');await page.locator('#compose-message').fill('正文保留：邮箱账号不存在');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));await page.evaluate(()=>setI18nLanguage('en'));await audit('#compose-modal');
    assert.equal(await page.locator('#compose-subject').inputValue(),'未启用 {0}');assert.equal(await page.locator('#compose-message').textContent(),'正文保留：邮箱账号不存在');
    assert.equal(await page.locator('#compose-ai-tone').inputValue(),'正式','Translation must preserve compose protocol values');
    await page.evaluate(()=>toast('邮箱账号不存在','error'));assert.equal(await page.locator('.toast-message').textContent(),'Email account does not exist');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));assert.equal(await page.locator('.toast-message').textContent(),'邮箱账号不存在');
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--mailai-copy-signature')), '"签名"');
    await page.evaluate(()=>setI18nLanguage('en'));assert.equal(await page.locator('.toast-message').textContent(),'Email account does not exist');
    const formatted=await page.evaluate(()=>{
      const name='联系人 {0} <img src=x onerror=alert(1)>';
      return {text:mailaiTemplate`删除“${name}”？联系人和邮件都会保留。`,label:mailaiCopySource('Ask Xiaoyou'),system:mailaiSystemMessage('发送失败: SMTP connection refused')};
    });
    assert.equal(formatted.text,'Delete “联系人 {0} <img src=x onerror=alert(1)>”? Contacts and emails will remain.');
    assert.equal(formatted.label,'问小邮');assert.equal(formatted.system,'Sending failed: SMTP connection refused');
    // Dynamic UI leaves translate without destroying inputs or adjacent handlers.
    await page.evaluate(()=>{
      const host=document.createElement('div');host.id='i18n-regression-host';
      host.innerHTML='<button><span data-i18n="ui.44ce7ae909bb">搜索</span><i aria-hidden="true">+</i></button><input value="用户数据">';
      document.body.append(host);window.i18nClicks=0;host.querySelector('button').onclick=()=>window.i18nClicks++;
    });await audit('#i18n-regression-host');await page.locator('#i18n-regression-host button').dispatchEvent('click');
    assert.equal(await page.evaluate(()=>window.i18nClicks),1);assert.equal(await page.locator('#i18n-regression-host input').inputValue(),'用户数据');
    await page.evaluate(()=>{const label=document.createElement('span');label.id='i18n-stale-state';document.body.append(label);mailaiBindUI(label,'textContent',()=>mailaiText('正在搜索…'));label.textContent='由新渲染器接管';setI18nLanguage('zh-CN');});
    assert.equal(await page.locator('#i18n-stale-state').textContent(),'由新渲染器接管','Language changes must not replay stale bindings');
    assert.deepEqual(errors,[]);
    console.log('i18n browser checks passed: startup, filters, archive title/empty state, advanced search, secondary dialogs, reminders, dashboard, rules, settings, composer, service errors and language switching');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
