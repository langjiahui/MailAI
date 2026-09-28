// Isolated workspace fixture only; all chat platform requests are mocked.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async()=>{
 const browser=await chromium.launch();
 try {
  for(const shell of ['macos','windows']) for(const theme of ['light','dark']) {
   const page=await browser.newPage({viewport:{width:1280,height:900}});
   const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   let bound=false, enabled=false, aiEnabled=false, selected=[], saveFail=false, polls=0, readFail=true;
   const accounts=[{id:'fixture-a',user:'a@example.test'},{id:'fixture-b',user:'b@example.test'}];
   await page.route('**/api/system/remote-control**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const isWX=path.includes('/weixin');
    if(isWX && route.request().method()==='GET' && readFail) {readFail=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'offline'})});return;}
    if(route.request().method()==='POST') assert.match(route.request().headers()['content-type'],/application\/json/);
    let data;
    if(path.endsWith('/login')) data={login_id:'fixtureQR',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',message:'请用微信扫一扫'};
    else if(path.endsWith('/poll')) {
     polls++;bound=true;data={status:'confirmed',message:'本人已绑定，请选择邮箱并启用',config:{enabled:false,bot_id:'bot-fixture',secret_saved:true,keychain_available:true,account_ids:[],accounts}};
    } else if(path.endsWith('/cancel')) data={ok:true};
    else {
     if(route.request().method()==='POST' && !path.endsWith('/reconnect')) {
      if(saveFail) {saveFail=false;await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({detail:'模拟保存失败，请重试'})});return;}
      const payload=route.request().postDataJSON();enabled=payload.enabled;selected=payload.account_ids;aiEnabled=!!payload.ai_enabled;
     }
     data={ai_enabled:isWX?aiEnabled:false,ai_available:true,enabled:isWX?enabled:false,account_ids:isWX?selected:[],accounts,keychain_available:true,
      secret_saved:isWX?bound:false,bot_id:isWX&&bound?'bot-fixture':'',connection:{phase:enabled?'connected':'disabled',message:enabled?'已连接 · 仅接受本人指令':'未启用'}};
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   });
   await page.goto('http://127.0.0.1:18795/?shell='+shell);
   await page.locator('#app-preloader').waitFor({state:'hidden'});
   await page.evaluate(theme=>{applyTheme(theme);showSystemView('remote');},theme);
   await page.locator('#weixin-retry').waitFor({state:'visible'});
   await page.locator('#weixin-retry').click();
   await page.locator('#weixin-login:not([disabled])').waitFor();
   assert.equal(await page.locator('#weixin-enabled').isDisabled(),true);
   assert.equal(await page.locator('.remote-dingtalk-details').getAttribute('open'),null);
   await page.locator('#weixin-account-options input').first().check();
   await page.locator('#weixin-ai-enabled').check();
   await page.locator('#weixin-login').click();
   await page.locator('#weixin-qr-panel').waitFor({state:'visible'});
   await page.locator('#weixin-qr-panel').waitFor({state:'hidden'});
   assert.equal(polls,1);
   assert.equal(await page.locator('#weixin-ai-enabled').isChecked(),true,'QR must retain AI choice');
   assert.equal(await page.locator('#weixin-account-options input').first().isChecked(),true,'QR confirmation must preserve chosen accounts');
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.fixtureCopied=text}}));
   await page.locator('[data-remote-copy="最新邮件"]').click();
   assert.equal(await page.evaluate(()=>window.fixtureCopied),'最新邮件');
   for(const command of ['有什么新邮件？','今天有什么重要的？','今天下午两点之后的邮件','更多新邮件','梳理重要邮件','看看今天待办','查看第一项待办','查看原邮件','返回待办','查看第一封的附件','把第二个附件发给我','预览第一个附件']) {
    if(await page.locator('[data-remote-copy="'+command+'"]').count()) {
     const button=page.locator('[data-remote-copy="'+command+'"]').first();
     await button.evaluate(el=>{const details=el.closest('details');if(details) details.open=true;});
     await button.click();
     assert.equal(await page.evaluate(()=>window.fixtureCopied),command);
    } else assert.fail('Missing discoverable phone command: '+command);
   }
   assert.match(await page.locator('#weixin-identity').textContent(),/已绑定/);
   await page.locator('#weixin-account-options input').first().check();
   await page.locator('#weixin-enabled').check();
   saveFail=true;
   await page.locator('#weixin-save').click();
   await page.getByText('模拟保存失败，请重试',{exact:true}).waitFor();
   assert.equal(await page.locator('#weixin-enabled').isChecked(),true,'retain unsaved state on failure');
   await page.locator('#weixin-save').click();
   await page.locator('#weixin-login[disabled]').waitFor();
   assert.deepEqual(selected,['fixture-a']);assert(enabled);
   await page.locator('#weixin-account-options input').nth(1).check();
   await page.locator('#weixin-disable').click();
   await page.locator('#weixin-login:not([disabled])').waitFor();assert(!enabled);
   assert.deepEqual(selected,['fixture-a'],'closing connection must retain saved permissions, not apply unsaved edits');
   await page.locator('.remote-dingtalk-details summary').click();
   await page.locator('#remote-client-id').fill('my-app');
   await page.locator('#remote-client-secret').fill('fixture-secret');
   await page.locator('#remote-show-secret').click();
   assert.equal(await page.locator('#remote-client-secret').getAttribute('type'),'text');
   await page.locator('#remote-show-secret').click();
   assert.equal(await page.locator('#remote-client-secret').getAttribute('type'),'password');
   await page.waitForTimeout(5200);
   assert.equal(await page.locator('#remote-client-secret').inputValue(),'fixture-secret','polling must preserve unsaved credentials');
   for(const width of [900,1280,1512,2048]) {
    await page.setViewportSize({width,height:900});
    const overflow=await page.locator('[data-system-panel="remote"]').evaluate(el=>el.scrollWidth>el.clientWidth+2);
    assert(!overflow,shell+' '+theme+' '+width+' overflow');
    const layout=await page.evaluate(()=>{
     const box=selector=>document.querySelector(selector).getBoundingClientRect();
     const panel=box('[data-system-panel="remote"]'),grid=box('.remote-settings-grid'),left=box('.remote-channel-stack'),right=box('.remote-setup-guide');
     return {panel:panel.width,grid:grid.width,left:left.width,right:right.width,leftY:left.y,rightY:right.y,
      commandColumns:getComputedStyle(document.querySelector('.remote-command-examples')).gridTemplateColumns.split(' ').length};
    });
    assert(layout.grid>layout.panel*.9,shell+' '+theme+' '+width+' should use panel width');
    if(width>=1512) {
     assert(Math.abs(layout.leftY-layout.rightY)<3,shell+' '+theme+' '+width+' two-column alignment');
     assert(layout.left>500 && layout.right>600,shell+' '+theme+' '+width+' readable columns');
    } else {
     assert(layout.rightY>layout.leftY,shell+' '+theme+' '+width+' stacked columns');
    }
    if(width===2048) assert.equal(layout.commandColumns,2,shell+' '+theme+' wide commands');
   }
   assert.deepEqual(errors,[]);
   await page.locator('[data-system-panel="remote"]').evaluate(el=>el.scrollTop=0);
   await page.screenshot({path:'/tmp/mailai-remote-'+shell+'-'+theme+'.png',fullPage:true});
   await page.close();
  }
  console.log('PASS Mac/Windows light/dark settings, QR pairing, error recovery, scope saving and unsaved-field preservation');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
