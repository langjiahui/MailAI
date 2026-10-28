// Synthetic routes only. No real IMAP mailbox or large attachment is accessed.
const assert=require('node:assert/strict');
const browserType=require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];
(async()=>{
 const browser=await browserType.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:980},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.MAILAI_FIXTURE_URL || 'http://127.0.0.1:18795/');
  await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.waitForFunction(()=>Boolean(window.mailaiMailRecovery && _systemConfig?.accounts?.length));
  const accounts=await page.evaluate(()=>_systemConfig.accounts.map(row=>({id:row.id,user:row.user})));
  const active=await page.evaluate(()=>activeMailAccount().id),target=accounts.find(row=>row.id!==active);
  let items=[{folder:'INBOX',uid:80,size:53*1024**2,error:'邮件 80 超过 50 MB，已暂停自动下载'}];
  let task={},sync={running:false,error:'邮箱连接中断，请稍后重试同步'};
  const calls=[];
  await page.route('**/api/mail/sync-issues**',async route=>{
   const request=route.request(),pathname=new URL(request.url()).pathname;
   calls.push({pathname,account:request.headers()['x-mailai-account'],method:request.method(),body:request.postDataJSON()});
   let response={items,total:items.length,task,sync};
   if(pathname.endsWith('/inspect'))response={...items[0],subject:'<img src=x onerror=alert(1)> 合成大邮件',sender:'Sender <sender@example.test>',date:'Thu, 22 Oct 2026'};
   if(pathname.endsWith('/retry')){task={running:true,received:1024**2,size:53*1024**2,uid:80,folder:'INBOX'};response={ok:true,running:true};}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
  });
  await page.route('**/api/poll',async route=>{calls.push({pathname:'/api/poll',account:route.request().headers()['x-mailai-account']});await route.fulfill({contentType:'application/json',body:'{"ok":true}'});});
  await page.evaluate(id=>{const account=_systemConfig.accounts.find(row=>row.id===id);account.sync_error='synthetic sync failure';account.sync_status='failed';renderSidebarAccounts();},target.id);
  await page.locator(`.account-sync-state[data-account-recovery="${target.id}"]`).click();
  const dialog=page.locator('#mail-recovery-dialog');await dialog.waitFor({state:'visible'});
  assert.equal(await dialog.locator('[data-recovery-account]').inputValue(),target.id);
  assert.match(await dialog.locator('[data-recovery-sync]').textContent(),/同步失败/);
  // Temporary disconnections recover automatically; expired credentials get an
  // explicit account repair action instead of the same generic failure label.
  for (const [kind,label] of [['connection','自动重连中'],['credentials','需要重新登录']]) {
   await page.evaluate(({id,kind})=>{const account=_systemConfig.accounts.find(row=>row.id===id);account.sync_issue_kind=kind;renderSidebarAccounts();},{id:target.id,kind});
   assert.equal(await page.locator(`.account-sync-state[data-account-recovery="${target.id}"]`).textContent(),label);
   sync.issue_kind=kind;
   await dialog.locator('[data-recovery-refresh]').click();
   await page.waitForFunction(kind=>kind==='credentials' ? document.querySelector('[data-recovery-manage]').textContent==='重新连接邮箱' : document.querySelector('[data-recovery-sync]').textContent.includes('正在重新连接'),kind);
  }
  sync.issue_kind='unknown';
  await dialog.locator('[data-recovery-refresh]').click();
  await dialog.locator('[data-recovery-inspect="0"]').click();
  await page.waitForFunction(()=>document.querySelector('.mail-recovery-item h3')?.textContent.includes('合成大邮件'));
  assert.equal(await dialog.locator('.mail-recovery-item img').count(),0,'Untrusted message titles must remain text');
  await page.waitForFunction(()=>!document.querySelector('[data-recovery-retry="0"]')?.disabled);
  await dialog.locator('[data-recovery-retry="0"]').evaluate(node=>{node.click();node.click();});
  await dialog.locator('[data-recovery-task] progress').waitFor({state:'visible'});
  assert.equal(calls.filter(row=>row.pathname.endsWith('/retry')).length,1,'Double clicks cannot start a second task');
  assert.equal(await dialog.locator('[data-recovery-retry="0"]').isDisabled(),true);
  assert(calls.every(row=>row.account===target.id),'Every recovery request pins the selected account');
  assert.deepEqual(calls.find(row=>row.pathname.endsWith('/retry')).body,{folder:'INBOX',uid:80});
  await dialog.locator('[data-recovery-close]').last().click();
  await dialog.waitFor({state:'hidden'});
  const count=calls.length;await page.waitForTimeout(2800);assert.equal(calls.length,count,'Closed recovery dialogs must stop polling');
  task={running:false,email_id:1};items=[];sync={running:false,error:''};
  await page.evaluate(id=>window.mailaiMailRecovery.open(id),target.id);
  await dialog.locator('[data-recovery-open]').waitFor({state:'visible'});
  assert.match(await dialog.locator('[data-recovery-task]').textContent(),/问题记录已移除/);
  assert(!/同步失败|正在重新连接/.test(await dialog.locator('[data-recovery-sync]').textContent()),'A successful sync must clear the cached error');
  task={running:false,error:'补下载未完成，请检查邮箱连接后重试；问题记录已保留'};
  items=[{folder:'INBOX',uid:81,size:257*1024**2,error:'超过自动下载限制'}];
  await dialog.locator('[data-recovery-refresh]').click();
  await page.waitForFunction(()=>document.querySelector('[data-recovery-task]')?.textContent.includes('问题记录已保留'));
  assert.equal(await dialog.locator('[data-recovery-retry="0"]').isDisabled(),true);
  assert.match(await dialog.locator('.mail-recovery-item').textContent(),/超过 256 MB.*较小副本/);
  for(const language of ['zh-CN','en'])for(const width of [390,1440])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:780});
   await page.evaluate(({language,theme})=>{setI18nLanguage(language);applyTheme(theme);},{language,theme});
   const fit=await dialog.evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,bottom:node.querySelector('footer').getBoundingClientRect().bottom}));
   assert(fit.scroll<=fit.client+1 && fit.bottom<=781,JSON.stringify({language,width,theme,fit}));
   if(language==='en')assert.equal(await dialog.locator('h2').textContent(),'Sync and problem mail');
  }
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  await dialog.locator('[data-recovery-poll]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-recovery-poll]').disabled);
  assert.equal(calls.find(row=>row.pathname==='/api/poll').account,target.id);
  await dialog.screenshot({path:'build/mail-recovery-mobile.png'});
  await dialog.locator('[data-recovery-manage]').click();
  await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>selectedManagedAccountId),target.id);
  await page.evaluate(()=>showSystemView('maintenance'));
  await page.locator('[data-system-panel=maintenance] [data-account-recovery]').click();
  await dialog.waitFor({state:'visible'});
  assert.equal(await dialog.locator('[data-recovery-account]').inputValue(),active);
  assert.deepEqual(errors,[]);
  console.log('Sync recovery UI: clickable warnings, account pinning, safe metadata, retry locking, persistent task entry, no hidden polling, oversized guidance, English/dark/mobile and management closure passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
