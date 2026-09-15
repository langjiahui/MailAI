// Run only against tests/workspace_preview.py, never a real mailbox server.
// NODE_PATH=<playwright node_modules> node tests/prepublish_browser.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'chrome'});
  const page = await browser.newPage({viewport:{width:1440,height:1000}, reducedMotion:'reduce'});
  page.setDefaultTimeout(8000);
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const shot = name => page.screenshot({path:path.join(__dirname,'../build',`release-${name}.png`)});
  const count = n => page.waitForFunction(n => document.querySelectorAll('#email-list .email-item').length === n, n);
  const pass = text => {checks.push(text);console.log('PASS', text);};
  try {
    await page.goto('http://127.0.0.1:18795/');
    await count(24);
    const config = await page.evaluate(() => api('/api/system/config'));
    assert.ok(config.accounts.every(a => a.user.endsWith('@example.test')), 'Only the isolated fixture may be tested');
    await shot('home');
    await page.locator('#email-list .email-item').first().click();
    await page.locator('#reading-content .reading-section').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#email-list .email-item')?.dataset.readState === 'read');
    pass('统一收件箱打开邮件并更新已读');

    const folders = page.locator('.sidebar-account-folders');
    await folders.first().locator('[data-account-action="sent"]').click();
    await page.waitForSelector('#email-list .outgoing-mail');
    assert.equal(await page.locator('#email-list .unread').count(),0);
    await page.locator('#email-list .email-item').first().click();
    await page.waitForFunction(() => document.querySelector('#reading-content').textContent.includes('项目交付时间确认'));
    await folders.nth(1).locator('[data-account-action="drafts"]').click();
    await count(0);
    assert.ok(!(await page.locator('#reading-content').innerText()).includes('项目交付时间确认'));
    pass('跨账号已发送/草稿切换，阅读区清空且已发送无未读样式');

    await page.locator('[data-account-action="unified"]').click(); await count(24);
    await page.locator('#btn-filter-panel').click();
    await page.locator('label[for="filter-attachments"]').click(); await count(2);
    await page.locator('#filter-priority [data-value="低"]').click(); await count(0);
    await page.locator('#btn-reset-filter').click(); await count(24);
    pass('附件/重要程度组合筛选及无结果重置');

    await page.locator('#btn-preferences').click();
    for (const tab of ['preferences','account','maintenance','guide']) {
      await page.locator(`[data-system-tab="${tab}"]`).click();
      await page.waitForTimeout(200);
    assert.ok(await page.locator(`[data-system-panel="${tab}"]`).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1),`${tab} page horizontal overflow`);
      await shot(`settings-${tab}`);
    }
    pass('设置四个分页可用，页面没有横向溢出');
    await page.locator('#btn-close-system').click();

    await page.locator('#email-list .email-item[data-id="1"]').first().click();
    await page.locator('[data-assistant-attachments]').click();
    await page.locator('#attachment-picker-list input:not(:disabled)').first().check();
    await page.waitForFunction(() => !document.getElementById('attachment-picker-add').disabled);
    assert.ok((await page.locator('#attachment-picker-preview').innerText()).includes('项目组'));
    assert.equal(await page.locator('#attachment-picker-list input:disabled').count(),1);
    assert.equal(await page.locator('.attachment-picker-item', {hasText:'旧版资料.xls'}).locator('input').isEnabled(),true);
    await shot('attachment-preview');
    await page.locator('#attachment-picker-add').click();
    await page.locator('#assistant-attachment-stage').waitFor();
    await page.locator('#assistant-new').click();
    assert.equal(await page.locator('#assistant-attachment-stage').isVisible(),false);
    await page.locator('#assistant-close').click();
    pass('邮件附件本地提取、XLS 支持、危险旧格式禁选、加入对话及清除');

    await page.locator('#btn-compose').click();
    await page.locator('[data-contact-target="compose-to"]').click();
    await page.locator('#contact-picker-footer').waitFor();
    await shot('contact-picker');
    await page.locator('[data-contact-pick="colleague@example.test"]').click();
    await page.locator('#btn-apply-contacts').click();
    assert.ok((await page.locator('#compose-to').inputValue()).includes('colleague@example.test'));
    await page.locator('#compose-subject').fill('发布验收草稿');
    await page.locator('#compose-message').fill('您好，项目排期已确认，谢谢。');
    await page.locator('#compose-subject').press('Control+s');
    await page.waitForTimeout(400);
    pass('通讯录选择入口与草稿保存');
    let releasePreflight, seenPreflight;
    const barrier = new Promise(resolve=>{releasePreflight=resolve;});
    const requested = new Promise(resolve=>{seenPreflight=resolve;});
    const preflightRoute = async route => {
      const data = route.request().postDataJSON(); seenPreflight(); await barrier;
      await route.fulfill({contentType:'application/json',body:JSON.stringify({issues:[],recipients:{to_addr:data.to_addr,cc_addr:'',bcc_addr:''}})});
    };
    await page.route('**/api/mail/preflight',preflightRoute);
    await page.locator('#btn-send-mail').click(); await requested;
    await page.locator('#compose-to').fill('updated@example.test');
    releasePreflight();
    await page.waitForFunction(() => !document.getElementById('btn-send-mail').disabled);
    assert.equal(await page.locator('#compose-to').inputValue(),'updated@example.test','Old preflight overwrote the new recipient');
    assert.equal((await page.evaluate(() => api('/api/mail/outbox'))).length,0,'Stale preflight queued mail');
    await page.unroute('**/api/mail/preflight',preflightRoute);
    pass('延迟安全检查不能覆盖修改后的收件人或自动发送');
    // Actual local preflight + queue + cancellation, with fixture SMTP only.
    await page.locator('#compose-to').fill('colleague@example.test');
    await page.locator('#btn-send-mail').click();
    await page.locator('#compose-preflight-ack').waitFor();
    assert.equal(await page.locator('[data-preflight-send]').isDisabled(),true);
    await page.locator('#compose-preflight-ack').check();
    await page.locator('[data-preflight-send]').click();
    await page.getByRole('button',{name:'撤销发送',exact:true}).click();
    await page.waitForFunction(async () => (await api('/api/mail/outbox')).some(row=>row.status==='canceled'));
    pass('发送前检查、保存入队与撤销发送闭环');

    await page.locator('#assistant-orb').click();
    await page.locator('#assistant-input').fill(('请核对附件中的负责人、截止时间和差异。\n').repeat(16));
    const dimensions = await page.locator('#assistant-input').evaluate(el => ({h:el.clientHeight, scroll:el.scrollHeight, overflow:getComputedStyle(el).overflowY}));
    assert.ok(dimensions.h <= 130 && dimensions.scroll > dimensions.h && dimensions.overflow === 'auto');
    await page.evaluate(() => appendAssistantMessage('assistant','| 对比维度 | 邮件正文 | 附件说明 | 差异说明 |\n|---|---|---|---|\n| 参会人员 | 张三 李四 | 张三 李四 王五 | 附件多一人，需要核实名单 |\n| 时间 | 09:30 | 11:38 | 相差一小时 |'));
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.assistant-table-wrap table').count(),1);
    const send = await page.locator('#assistant-send').boundingBox();
    assert.ok(Math.abs(send.width-send.height)<2,'Send button distorted');
    await shot('assistant-table');
    await page.route('**/api/assistant/ask-stream', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'测试连接暂不可用'})}));
    await page.locator('#assistant-input').fill('请总结近期重要邮件');
    await page.locator('#assistant-send').click();
    await page.locator('#assistant-retry').waitFor();
    await page.locator('#assistant-new').click();
    assert.equal(await page.locator('#assistant-retry').isVisible(),false);
    assert.equal(await page.locator('#assistant-stop').isVisible(),false);
    assert.equal(await page.locator('#assistant-send').isDisabled(),false);
    assert.equal(await page.locator('#mail-assistant.state-thinking').count(),0);
    pass('小邮表格、长输入、发送按钮比例及失败后新建会话复位');
    for(const width of [1280,1024,760]) {
      await page.setViewportSize({width,height:900});await page.waitForTimeout(250);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),`Overflow at ${width}`);
      await shot(`responsive-${width}`);
    }
    pass('1280/1024/760 三档布局无页面横向溢出');
    assert.deepEqual(errors,[]);
    pass('浏览器无未处理 JavaScript 异常');
  } catch (error) {
    await shot('failed-step');
    console.error('UI state:', await page.locator('#compose-preflight').innerText(), await page.locator('#toast').innerText());
    throw error;
  } finally {
    fs.writeFileSync(path.join(__dirname,'../build/prepublish-browser-results.json'), JSON.stringify({checks,errors},null,2));
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
