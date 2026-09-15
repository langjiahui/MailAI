// Isolated fixture only: never use a real mailbox or model.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.waitForSelector('#email-list .email-item');
    assert.ok((await page.evaluate(()=>api('/api/system/config'))).accounts.every(a=>a.user.endsWith('@example.test')));
    await page.locator('#email-list .email-item').first().click();
    await page.locator('#assistant-orb').click();
    await page.locator('.assistant-welcome').waitFor();
    assert.equal(await page.locator('#assistant-quick button').count(),4);
    await page.screenshot({path:path.join(__dirname,'../build/composer-welcome.png')});
    let sentQuestion;
    await page.route('**/api/assistant/ask-stream',async route=>{
      sentQuestion=route.request().postDataJSON().question;
      await route.fulfill({contentType:'application/x-ndjson',body:[
        {type:'meta',conversation_id:17},{type:'sources',sources:[]},
        {type:'delta',content:'这周有两项需要关注：\n\n1. 确认采购合同的交付日期。\n2. 周五前反馈项目排期。\n\n可以先确认交期，再安排项目评审。'},
        {type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
    });
    await page.locator('[data-assistant-question="总结最近的重要邮件"]').click();
    await page.waitForFunction(()=>!document.getElementById('assistant-send').disabled);
    assert.equal(sentQuestion,'总结最近的重要邮件','Send the question, not the icon/card description');
    assert.equal(await page.locator('#assistant-quick').count(),0);
    assert.equal(await page.locator('.assistant-welcome').count(),0);
    await page.locator('#assistant-close').click();await page.locator('#assistant-orb').click();
    await page.waitForFunction(()=>document.getElementById('assistant-panel').classList.contains('layout-stable'));
    assert.equal(await page.locator('#assistant-quick').count(),0,'Reopening an existing chat must not restore examples');
    await page.evaluate(()=>{document.getElementById('assistant-scope').value='selected';updateAssistantScopeControl();});
    const card=page.locator('.assistant-composer');
    assert.equal(await card.locator('#assistant-scope-picker').count(),1);
    assert.equal(await card.locator('#assistant-add-image').count(),1);
    await page.screenshot({path:path.join(__dirname,'../build/composer-conversation.png')});
    await page.locator('#assistant-scope-picker summary').click();
    await page.locator('[data-assistant-scope="account"]').click();
    assert.equal(await page.locator('#assistant-scope-clear').isVisible(),false);
    await page.locator('#assistant-input').fill('请继续帮我核对项目安排。'.repeat(150));
    for(const width of [1440,1024,760,390]){
      await page.setViewportSize({width,height:1000});
      await page.waitForTimeout(250);
      const metrics=await page.locator('#assistant-send').boundingBox();
      assert.ok(Math.abs(metrics.width-metrics.height)<1);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.ok(await page.locator('#assistant-input').evaluate(n=>n.scrollHeight>n.clientHeight));
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#assistant-input').fill('');
    await page.locator('#assistant-new').click();
    assert.equal(await page.locator('#assistant-quick button').count(),4);
    await page.route('**/api/assistant/conversations/17',route=>route.fulfill({json:{messages:[{role:'user',content:'之前的问题'},{role:'assistant',content:'之前的回复'}]}}));
    await page.evaluate(()=>loadAssistantConversation(17));
    assert.equal(await page.locator('#assistant-quick').count(),0,'History replaces the welcome');
    await page.locator('[data-secretary-view="briefing"]').click();
    assert.equal(await card.isVisible(),false);
    await page.locator('[data-secretary-view="chat"]').click();
    assert.ok(await card.isVisible());
    assert.deepEqual(errors,[]);
    console.log('PASS: welcome-only prompts, exact quick question, reopen/history/new chat, integrated scope, long input, four widths, briefing isolation, no JS errors');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
