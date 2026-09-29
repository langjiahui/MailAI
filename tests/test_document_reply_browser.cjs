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
    await page.route(/\/api\/emails\/\d+\/assistant-attachments$/, route => route.fulfill({json:{
      subject:'填写登记文档', items:[{index:0,name:'登记表.docx',size:1024,supported:true}]
    }}));
    await page.route('**/api/assistant/document-reply/plan', route => route.fulfill({json:{
      email_id:email,index:0,digest:'a'.repeat(64),plan_token:'fixture-token',name:'登记表.docx',
      fields:[{sheet:'Word 文档',cell:'T1R1C2',label:'姓名',location_label:'表格 1 · 第 1 行第 2 列',value:''}],
      preview:'姓名 | ',note:'核对字段后生成'
    }}));
    await page.route('**/api/assistant/document-reply/prepare', route => route.fulfill({json:{ok:true,draft_id:999,filename:'登记表_已填写.docx'}}));
    await page.route('**/api/drafts/999', route => route.fulfill({json:{
      id:999,to_addr:'sender@example.test',cc_addr:'',bcc_addr:'',subject:'Re: 填写登记文档',
      body_html:'<p>已填写，请查收。</p>',mode:'reply',reply_to_email_id:email,
      attachments:[{filename:'登记表_已填写.docx',content_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:1024,data_base64:'ZmFrZQ=='}]
    }}));
    await page.evaluate(({email,account}) => window.startAssistantDocumentReply(email,account,'填写附件并回复'),{email,account});
    await page.locator('input[name="document-reply-file"]').check();
    await page.locator('[data-document-next]').click();
    await page.locator('[data-document-value="0"]').fill('张三');
    await page.locator('[data-document-next]').click();
    await page.locator('#compose-modal').waitFor({state:'visible'});
    assert.match(await page.locator('#assistant-prepared-note').innerText(),/预览填写后的附件/);
    assert.equal(await page.locator('#btn-send-mail').innerText(),'确认发送');
    assert.equal(await page.locator('#compose-to').inputValue(),'sender@example.test');
    console.log('Document reply dialog, field review and compose confirmation passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
