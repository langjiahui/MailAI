// Run only against tests/workspace_preview.py. No real SMTP or mailbox writes.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true, channel:'chrome'});
  const page = await browser.newPage({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method()==='POST' && r.url().endsWith('/api/drafts')) writes.push(r.postDataJSON()); });
  page.on('dialog', dialog => dialog.accept());
  const pass = name => console.log('PASS', name);
  const open = () => page.evaluate(() => openCompose());
  const closed = () => page.waitForFunction(() => !document.body.classList.contains('compose-open'));
  const list = accountId => page.evaluate(accountId => api('/api/drafts',{accountId}),accountId);
  try {
    await page.goto('http://127.0.0.1:18795/');
    await page.waitForFunction(() => _systemConfig?.accounts?.length === 2);
    const accounts = await page.evaluate(() => _systemConfig.accounts);
    assert.ok(accounts.every(a => a.user.endsWith('@example.test')),'Isolated fixture required');
    const a = await page.evaluate(() => activeMailAccount().id), b = accounts.find(x=>x.id!==a).id;
    const baseline = (await list(a)).length;
    await open();
    await page.evaluate(()=>renderComposeSignature('', '<p>默认签名</p>'));
    await page.locator('#compose-to').focus(); await page.locator('#compose-subject').focus();
    await page.locator('#btn-close-compose').click(); await closed();
    assert.equal(writes.length,0);
    assert.equal((await list(a)).length,baseline);
    pass('空白打开、切换焦点、关闭，不创建签名空草稿');

    await open();
    await page.locator('#compose-subject').fill('草稿体验验证');
    await page.locator('#compose-message').fill('快速关闭之前的最新内容');
    await page.locator('#btn-close-compose').click(); await closed();
    let saved=(await list(a)).find(x=>x.subject==='草稿体验验证');
    assert.ok(saved.body_html.includes('最新内容'));
    assert.equal(writes.length,1);
    await page.evaluate(({saved,a})=>openCompose({...saved,account_id:a}),{saved,a});
    await page.locator('#compose-subject').focus();
    await page.locator('#btn-close-compose').click(); await closed();
    assert.equal(writes.length,1,'Unchanged draft must not be written again');
    pass('快速关闭立即保存；重开未编辑不重复写入');

    await page.evaluate(({saved,a})=>openCompose({...saved,account_id:a}),{saved,a});
    await page.locator('#compose-message').fill('保存失败仍然保留的内容');
    const fail = route => route.fulfill({status:500,contentType:'application/json',body:'{"detail":"测试磁盘写入失败"}'});
    await page.route('**/api/drafts',async route=>route.request().method()==='POST'?fail(route):route.continue());
    await page.locator('#btn-close-compose').click();
    await page.waitForFunction(()=>document.getElementById('draft-state').dataset.state==='error');
    assert.ok(await page.locator('#compose-modal').isVisible());
    assert.equal(await page.locator('#compose-message').innerText(),'保存失败仍然保留的内容');
    await page.waitForTimeout(3200); // Capture the persistent status, not the transient toast.
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>applyTheme(theme),theme);
      await page.waitForTimeout(350);
      await page.screenshot({path:path.join(__dirname,`../build/draft-experience-${theme}.png`)});
    }
    await page.unroute('**/api/drafts');
    await page.locator('#draft-state').click();
    await page.waitForFunction(()=>document.getElementById('draft-state').dataset.state==='saved');
    pass('保存失败保留编辑器，明暗主题错误提示及点击重试');

    let release, seen;
    const barrier=new Promise(r=>release=r), requested=new Promise(r=>seen=r);
    await page.route('**/api/drafts',async route=>{
      if(route.request().method()==='POST'){seen();await barrier;}
      await route.continue();
    });
    await page.locator('#compose-message').fill('较旧的内容');
    const pending=page.evaluate(()=>saveCurrentDraft());
    await requested;
    await page.locator('#compose-message').fill('保存期间又输入的新内容');
    release();await pending;
    assert.notEqual(await page.locator('#draft-state').getAttribute('data-state'),'saved');
    await page.unroute('**/api/drafts');
    await page.locator('#btn-save-draft').click();await closed();
    saved=(await list(a)).find(x=>x.id===saved.id);
    assert.ok(saved.body_html.includes('保存期间又输入的新内容'));
    pass('旧保存完成不能宣称新内容已保存；存草稿并关闭保留最新编辑');

    await page.evaluate(({saved,a})=>openCompose({...saved,account_id:a}),{saved,a});
    await page.route('**/api/mail/send-capability',route=>route.fulfill({status:500,contentType:'application/json',body:'{"detail":"测试账号切换失败"}'}));
    await page.selectOption('#compose-from',b);
    await page.waitForFunction(()=>!draftSession.switching);
    assert.equal(await page.evaluate(()=>composeAccountId),a);
    assert.ok((await list(a)).some(x=>x.id===saved.id));
    assert.ok((await page.locator('#compose-message').innerText()).includes('保存期间又输入的新内容'));
    await page.unroute('**/api/mail/send-capability');
    pass('账号切换失败回退原账号，内容和原草稿保留');
    await page.selectOption('#compose-from',b);
    await page.waitForFunction(b=>composeAccountId===b && !draftSession.switching,b);
    assert.equal((await list(a)).some(x=>x.id===saved.id),false,'Old-account draft must be removed after transfer');
    const moved=(await list(b)).find(x=>x.subject==='草稿体验验证');
    assert.ok(moved.body_html.includes('保存期间又输入的新内容'));
    await page.locator('#btn-close-compose').click();await closed();
    pass('切换发件账号先保存新草稿，再移除旧副本');

    await open();
    await page.locator('#compose-message').fill('需要保留的独立新邮件');
    await page.route('**/api/mail/compose/assist',async route=>{
      await new Promise(r=>setTimeout(r,500));
      await route.fulfill({contentType:'application/json',body:JSON.stringify({content:'旧邮件的AI草稿',basis:['旧邮件']})});
    });
    const ai=page.evaluate(()=>aiCompose('draft',document.getElementById('btn-ai-generate')));
    await page.locator('#btn-close-compose').click();await closed();
    await open(); await ai;
    assert.equal(await page.evaluate(()=>composeAiSuggestion),'');
    assert.ok(await page.locator('#btn-ai-generate').isEnabled());
    pass('旧邮件AI结果不会出现在新邮件中，生成按钮恢复可用');
    await page.locator('#btn-close-compose').click(); await closed();

    await open(); await page.locator('#compose-message').fill('舍弃验证');
    await page.evaluate(()=>saveCurrentDraft());
    const discarded=await page.evaluate(()=>({id:currentDraftId,accountId:composeAccountId}));
    await page.locator('#btn-discard-draft').click();await closed();
    assert.equal((await list(discarded.accountId)).some(x=>x.id===discarded.id),false);
    pass('舍弃确认后删除同一草稿，不被自动保存重新创建');

    await open();
    const count=writes.length;
    await page.locator('#compose-message').fill('停顿保存');
    await page.waitForFunction(()=>document.getElementById('draft-state').dataset.state==='saved');
    assert.equal(writes.length,count+1);
    await page.locator('#compose-to').focus();await page.locator('#compose-subject').focus();
    assert.equal(writes.length,count+1,'Focus/blur alone must not save');
    const continuous=writes.length;
    for(let i=0;i<21;i++) {
      await page.locator('#compose-message').fill('连续输入 '+i);
      await page.waitForTimeout(800);
    }
    assert.ok(writes.length>continuous,'Continuous typing must trigger the 15s maximum interval');
    assert.equal(await page.evaluate(()=>window.mailaiPrepareExit()),true);
    await closed();
    const last=(await list(a)).find(row=>row.body_html.includes('连续输入 20'));
    assert.ok(last,'Native exit hook must flush the last keystroke');
    pass('停顿保存、无变化不写入、连续输入保底保存、退出保存最后编辑');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
