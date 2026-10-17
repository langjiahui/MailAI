/* Isolated fixture only: MAILAI_TAG_FIXTURE=1 MAILAI_FIXTURE_PORT=18806. */
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
  await page.goto('http://127.0.0.1:18806/?shell=macos');await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  await page.locator('.sidebar-account-folders [data-account-action=inbox]').first().click();
  await page.waitForFunction(()=>allEmails.length===325);
  const dialog=page.locator('#mail-tags-dialog');
  const labels=await page.evaluate(async()=>{
   const current=await api('/api/mail/tags');for(const t of current.tags)await api(`/api/mail/tags/${t.id}`,{method:'DELETE'});
   const items=[];
   for(const name of ['项目 <A> & "客户"','项目 B','并发添加',...Array.from({length:12},(_,i)=>`标签 ${i+1}`),'很长的标签名称'.repeat(10)])items.push(await api('/api/mail/tags',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}));
   await api('/api/mail/tags/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[1],tag_ids:[items[0].id]})});await loadData();return items;
  });
  await page.locator('.email-item[data-id="1"]').click();await page.locator('[data-edit-mail-tags]').click();
  // Fresh snapshot and concurrent additive change must survive the picker save.
  await page.evaluate(async tag=>{await api('/api/mail/tags/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[1],tag_ids:[tag]})});},labels[2].id);
  await dialog.locator('.mail-tag-choice').filter({hasText:'项目 B'}).locator('input').check();
  await dialog.locator('[data-assign-form] [type=submit]').click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>selectedEmailDetail?.tags.length===3);
  assert.equal(await page.evaluate(()=>selectedEmailDetail.tags.some(t=>t.name==='并发添加')),true);
  // Search hides options without removing their selected state.
  await page.locator('[data-edit-mail-tags]').click();
  await dialog.locator('[data-picker-search]').fill('不存在');
  assert.equal(await dialog.locator('[data-label-option]:visible').count(),0);
  await dialog.locator('[data-picker-search]').fill('项目 B');
  assert.equal(await dialog.locator('[data-label-option]:visible').count(),1);
  await dialog.locator('.mail-tag-choice:visible input').uncheck();
  await page.keyboard.press('Escape');await dialog.locator('[data-keep-editing]').waitFor();
  await dialog.locator('[data-keep-editing]').click();
  assert.equal(await dialog.locator('[data-picker-search]').inputValue(),'项目 B');
  await dialog.locator('[data-assign-form] [type=submit]').click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>selectedEmailDetail?.tags.length===2);
  // Multi-message batching, a failed middle request and retry only the remainder.
  await page.evaluate(()=>{selectedMailIds=new Set(allEmails.map(e=>e.id));mailSelectionExplicit=true;syncBulkSelectionVisuals();});
  await page.locator('[data-bulk-mail-tags]').click();
  await dialog.locator('[data-picker-search]').fill('项目 B');
  await dialog.locator('.mail-tag-choice:visible input').check();
  const batches=[];let fail=true;
  await page.route('**/api/mail/tags/members',async route=>{
   const data=route.request().postDataJSON();batches.push(data.ids);
   if(fail&&batches.length===2){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'模拟第二批失败'})});return;}
   await route.continue();
  });
  await dialog.locator('[data-assign-form] [type=submit]').click();
  try{await dialog.getByText(/剩余 100 封未完成/).waitFor();}catch(error){console.error('BATCH DEBUG',batches.map(b=>b.length),errors,await dialog.textContent());throw error;}
  assert.deepEqual(batches.map(b=>b.length),[100,100,100,25]);
  assert.equal(await page.evaluate(()=>selectedMailIds.size),100);
  fail=false;
  await dialog.locator('[data-assign-form] [type=submit]').click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual(batches.at(-1),batches[1]);
  await page.unroute('**/api/mail/tags/members');
  await page.waitForFunction(()=>allEmails.every(e=>e.tags.some(t=>t.name==='项目 B')));
  await page.locator('#bulk-cancel').click();
  // A committed change with a failed catalogue refresh is reported as saved.
  await page.locator('.email-item[data-id="1"]').click();await page.locator('[data-edit-mail-tags]').click();
  await dialog.locator('[data-picker-search]').fill('并发添加');
  await dialog.locator('.mail-tag-choice:visible input').uncheck();
  await page.route('**/api/mail/tags',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'refresh failed'})}));
  await dialog.locator('[data-assign-form] [type=submit]').click();await dialog.waitFor({state:'hidden'});
  await page.getByText('已保存，但列表刷新失败；请刷新列表查看最新标签',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>selectedEmailDetail.tags.some(t=>t.name==='并发添加')),false);
  await page.unroute('**/api/mail/tags');
  // Rule preview has no side effects; changing conditions invalidates stale output.
  await page.locator('[data-mail-tag-manage]').click();await dialog.locator('[data-tab=rules]').click();await dialog.locator('[data-new-rule]').click();
  await dialog.locator('[data-rule-form] [name=name]').fill('预览规则');
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.equal(await dialog.locator('[data-rule-form] [name=name]').inputValue(),'预览规则');
  assert.match(await dialog.locator('[data-rule-form]').textContent(),/Test matching/);
  assert.match(await dialog.locator('[data-field] option').first().textContent(),/From|Sender/);
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  assert.match(await dialog.locator('[data-field] option').first().textContent(),/发件人/);await dialog.locator('[data-field]').selectOption('subject');
  await dialog.locator('.mail-tag-condition input').fill('采购合同');await dialog.locator('[data-preview-rule]').click();
  await dialog.getByText(/已有 109 封邮件满足条件/).waitFor();
  assert.equal(await page.evaluate(async()=> (await api('/api/mail/tags')).rules.length),0);
  await dialog.locator('.mail-tag-condition input').fill('没有任何邮件');
  assert.equal(await dialog.locator('[data-rule-preview]').textContent(),'');
  await dialog.locator('[data-tab=tags]').click();await dialog.locator('[data-keep-editing]').waitFor();
  await dialog.locator('[data-keep-editing]').click();assert.equal(await dialog.locator('[data-rule-form] [name=name]').inputValue(),'预览规则');
  await dialog.locator('[data-cancel-rule]').click();await dialog.locator('[data-discard]').click();
  await dialog.locator('[data-tab=tags]').click();
  await dialog.locator('.mail-tags-close').click();
  // Long labels, translated copy, dark mode and desktop zoom retain controls.
  for(const language of ['zh-CN','en'])for(const theme of ['light','dark']){
   await page.evaluate(({language,theme})=>{setI18nLanguage(language);applyTheme(theme);},{language,theme});
   await page.locator('[data-mail-tag-manage]').click();
   await dialog.waitFor({state:'visible'});
   for(const width of [1440,600,390]){
    await page.setViewportSize({width,height:700});
    const metrics=await dialog.evaluate(n=>({scroll:n.scrollWidth,width:n.clientWidth,rect:n.getBoundingClientRect().toJSON(),header:n.querySelector('header').getBoundingClientRect().toJSON()}));
    assert(metrics.scroll<=metrics.width+1,JSON.stringify(metrics));assert(metrics.rect.right<=width+1&&metrics.rect.bottom<=700,JSON.stringify(metrics));
    await dialog.locator('.mail-tags-body').evaluate(n=>n.scrollTop=n.scrollHeight);
    assert(await dialog.locator('.mail-tags-close').isVisible());
   }
   await page.setViewportSize({width:1440,height:1000});
   await page.evaluate(()=>{document.body.style.zoom='1.3';document.documentElement.style.setProperty('--fz','1.3');});
   assert(await dialog.evaluate(n=>n.getBoundingClientRect().right<=innerWidth+1));
   await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');});
   await dialog.locator('.mail-tags-close').click();
  }
  await page.evaluate(()=>{setI18nLanguage('zh-CN');applyTheme('light');});
  await page.locator('[data-mail-tag-manage]').click();await dialog.screenshot({path:'build/mail-tags-polish-light.png'});
  await page.evaluate(()=>applyTheme('dark'));await dialog.screenshot({path:'build/mail-tags-polish-dark.png'});
  await dialog.locator('.mail-tags-close').click();
  // Unified inbox edits target the message owner, even when both accounts have id=1.
  const accounts=await page.evaluate(async()=>{
    const owner=activeMailAccount().id,other=_systemConfig.accounts.find(a=>a.id!==owner).id;
    const previous=await api('/api/mail/tags',{accountId:other});for(const t of previous.tags)await api(`/api/mail/tags/${t.id}`,{method:'DELETE',accountId:other});
    const tag=await api('/api/mail/tags',{accountId:other,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'另一个邮箱专属'})});
    return {owner,other,tag};
  });
  await page.locator('[data-account-action=unified]').click();
  await page.waitForFunction(()=>unifiedMailbox && allEmails.length===650);
  await page.evaluate(async id=>selectEmail(1,{accountId:id}),accounts.other);
  await page.locator('[data-edit-mail-tags]').click();
  await dialog.locator('[name=tag_ids]').check();await dialog.locator('[data-assign-form] [type=submit]').click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>selectedEmailDetail?.tags.some(t=>t.name==='另一个邮箱专属'));
  assert.equal(await page.evaluate(()=>activeMailAccount().id),accounts.owner);
  const scoped=await page.evaluate(async({owner,other})=>({
    a:(await api('/api/mail/tags/snapshot',{accountId:owner,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[1]})})).items[0].tags,
    b:(await api('/api/mail/tags/snapshot',{accountId:other,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[1]})})).items[0].tags,
  }),accounts);
  assert(!scoped.a.some(t=>t.name==='另一个邮箱专属'));assert(scoped.b.some(t=>t.name==='另一个邮箱专属'));
  // A delayed picker request cannot reopen for a different message/account.
  let held,release;const ready=new Promise(resolve=>release=resolve);
  await page.route('**/api/mail/tags',route=>{held=route;release();});
  await page.locator('[data-edit-mail-tags]').click();await ready;
  await page.evaluate(()=>resetReadingPane());await held.continue();await page.unroute('**/api/mail/tags');
  assert.equal(await dialog.isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS labels edge UI: 325-message batches and partial retry, concurrent changes, refresh failures, preview, dirty forms, searched selection, i18n, long names, themes, stale requests');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
