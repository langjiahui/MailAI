// Run against tests/workspace_preview.py; all document API responses are fixture-only.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async()=>{
  const browser = await chromium.launch({channel:'chrome'});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    const account = await page.evaluate(() => activeMailAccount()?.id);
    const email = await page.evaluate(() => allEmails.find(item => item.attachments?.length)?.id);
    assert(account && email);
    let askedScope;
    await page.route('**/api/assistant/ask-stream', async route => {
      askedScope = route.request().postDataJSON().email_ids;
      const action = {type:'fill_attachment_reply',summary:'填写当前邮件的文档附件并准备回复',
        params:{email_id:email,instruction:'填写附件回复邮件'}};
      const events = [{type:'meta',conversation_id:1},{type:'action',action},{type:'sources',sources:[]},
        {type:'delta',content:'点击开始填写。'},{type:'done'}];
      await route.fulfill({contentType:'application/x-ndjson',body:events.map(JSON.stringify).join('\n')+'\n'});
    });
    await page.route(/\/api\/emails\/\d+\/assistant-attachments$/, route => route.fulfill({json:{
      subject:'填写登记文档', items:[{index:0,name:'登记表.docx',size:1024,supported:true}]
    }}));
    let planCalls = 0;
    await page.route('**/api/assistant/document-reply/plan', route => {
      planCalls++;
      if (planCalls === 2) return route.fulfill({status:503,json:{detail:'暂时无法识别'}});
      const moved = planCalls > 2;
      return route.fulfill({json:{
        email_id:email,index:0,digest:'a'.repeat(64),plan_token:'fixture-token',name:'登记表.docx',
        fields:[{sheet:'Word 文档',cell:moved ? 'T1R2C2' : 'T1R1C2',label:'姓名',
          location_label:moved ? '表格 1 · 第 2 行第 2 列' : '表格 1 · 第 1 行第 2 列',value:''}],
        preview:'姓名 | ',note:'核对字段后生成'
      }});
    });
    let prepareCalls = 0;
    await page.route('**/api/assistant/document-reply/prepare', route => {
      prepareCalls++;
      return route.fulfill({json:{ok:true,draft_id:999,filename:'登记表_已填写.docx'}});
    });
    let draftCalls = 0;
    await page.route('**/api/drafts/999', route => {
      if (++draftCalls === 1) return route.fulfill({status:503,json:{detail:'暂时无法读取草稿'}});
      return route.fulfill({json:{
      id:999,to_addr:'sender@example.test',cc_addr:'',bcc_addr:'',subject:'Re: 填写登记文档',
      body_html:'<p>已填写，请查收。</p>',mode:'reply',reply_to_email_id:email,
      attachments:[{filename:'登记表_已填写.docx',content_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:1024,data_base64:'ZmFrZQ=='}]
      }});
    });
    await page.evaluate(({email,account}) => {
      _systemConfig.model.available = true;
      _systemConfig.model.verified = true;
      selectedEmailId = email;
      selectedEmailAccountId = account;
      assistantPinnedScope = [999]; // An older conversation must not redirect the fill request.
      document.getElementById('assistant-scope').value = 'selected';
      return askAssistant('填写附件回复邮件');
    },{email,account});
    assert.deepEqual(askedScope,[email]);
    await page.evaluate(() => document.querySelector('.assistant-action-card [data-action-confirm]').click());
    await page.locator('#assistant-document-reply').waitFor({state:'visible'});
    await page.locator('input[name="document-reply-file"]').check();
    await page.locator('[data-document-next]').click();
    await page.locator('[data-document-value="0"]').fill('张三');
    await page.locator('.document-reply-correction summary').click();
    await page.locator('.document-reply-correction textarea').fill('姓名应填写在第二行');
    await page.locator('[data-document-replan]').click();
    await page.getByText('暂时无法识别').waitFor();
    assert.equal(await page.locator('[data-document-replan]').isEnabled(), true,
      'a failed replan must allow retry');
    await page.locator('[data-document-replan]').click();
    await page.waitForFunction(() => document.querySelector('[data-document-value="0"]')?.closest('label')?.textContent?.includes('第 2 行'));
    assert.equal(await page.locator('[data-document-value="0"]').inputValue(), '',
      'a moved field must require the user to confirm its value again');
    await page.locator('[data-document-value="0"]').fill('张三');
    await page.locator('[data-document-next]').click();
    await page.getByText('回复草稿已保存，但暂时无法打开').waitFor();
    assert.equal(prepareCalls, 1);
    await page.locator('[data-document-next]').click();
    await page.locator('#compose-modal').waitFor({state:'visible'});
    assert.equal(prepareCalls, 1, 'opening a saved draft must not generate another draft');
    assert.match(await page.locator('#assistant-prepared-note').innerText(),/预览填写后的附件/);
    assert.equal(await page.locator('#btn-send-mail').innerText(),'确认发送');
    assert.equal(await page.locator('#compose-to').inputValue(),'sender@example.test');
    console.log('Document reply dialog, field review and compose confirmation passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
