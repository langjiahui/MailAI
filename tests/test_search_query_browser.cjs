// Run against tests/workspace_preview.py; never connects to a live mailbox.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.locator('.email-item').first().waitFor();
  const account=await page.evaluate(()=>activeMailAccount().id);
  const user=await page.evaluate(()=>activeMailAccount().user);
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  const input=page.locator('#global-search');
  async function search(text,count){
   await input.fill(text);
   await page.waitForFunction(()=>mailSearchState.phase==='done');
   assert.equal(await page.locator('#email-list .email-item').count(),count,text);
   assert(await page.locator('#search-error').isHidden(),text);
  }
  await page.locator('#email-list .email-item').first().click();
  await page.locator('#reading-content .reading-header').waitFor();
  await search('查看未读邮件',11);
  assert.match(await page.locator('[data-remove-search-token=unread]').innerText(),/未读/);
  assert.equal(await page.locator('[data-remove-search-token=text]').count(),0,'Command words are not leftover keyword restrictions');
  await search('查看本周未读且带附件的邮件',1);
  for(const key of ['unread','has_attachment','after','before'])assert(await page.locator(`[data-remove-search-token=${key}]`).isVisible());
  await search('"查看未读邮件"',0);
  assert.equal(await page.locator('[data-remove-search-token=unread]').count(),0,'Quoted text stays literal');
  await search('只看未读',11);
  await page.locator('[data-remove-search-token=unread]').click();
  await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await input.inputValue(),'');
  assert.equal(await page.locator('#email-list .email-item').count(),12);
  await search('发件人是项目同事',12);
  assert.match(await page.locator('[data-remove-search-token=sender]').innerText(),/项目同事/);
  await page.locator('#email-list .email-item').first().click();
  await page.locator('#reading-content .reading-header').waitFor();
  await search('发送人：项目同事，标题包含采购合同 最近7天 有附件',1);
  for(const key of ['sender','subject','after','before','has_attachment'])assert(await page.locator(`[data-remove-search-token=${key}]`).isVisible());
  await page.screenshot({path:`build/natural-search-${process.env.MAILAI_BROWSER||'chromium'}.png`});
  await page.locator('.search-filter-button').click();
  assert.equal(await page.locator('[data-criterion=sender]').inputValue(),'项目同事');
  assert.equal(await page.locator('[data-criterion=subject]').inputValue(),'采购合同');
  assert.equal(await page.locator('[data-criterion=query]').inputValue(),'');
  assert.equal(await page.locator('[data-criterion=mailbox]').inputValue(),'inbox');
  await page.locator('[data-close-productivity]').click();
  await page.locator('[data-remove-search-token=subject]').click();
  await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await page.locator('#email-list .email-item').count(),1);
  assert.doesNotMatch(await input.inputValue(),/(?:from|subject|after|before|has):/,'Removing a condition must keep the query readable');
  await page.locator('[data-remove-search-token=has_attachment]').click();
  await page.waitForFunction(()=>mailSearchState.phase==='done');
  assert.equal(await page.locator('#email-list .email-item').count(),12);
  await search('发件人是不存在的人 标题包含采购合同',0);
  await search('收件人是'+user,12);
  await page.evaluate(()=>openUnifiedInbox());
  await search('项目同事发来的邮件',24);
  assert.equal(await page.evaluate(()=>unifiedMailbox),true);
  // The same structured query also searches local sent records and drafts.
  await page.evaluate(id=>openAccountMailbox(id,'sent'),account);
  await search('标题包含交付',1);
  await page.locator('#email-list .email-item').first().click();
  await page.locator('.special-mail-detail').waitFor();
  assert.match(await page.locator('.special-mail-detail h1').innerText(),/项目交付/);
  const draft=await page.evaluate(()=>api('/api/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:'检索测试草稿',to_addr:'customer@example.test',body_html:'<p>草稿完整内容</p>'})}));
  try{
   await page.evaluate(id=>openAccountMailbox(id,'drafts'),account);
   await search('主题包含检索测试',1);
   await page.locator('#email-list .email-item').first().click();
   await page.locator('.special-mail-detail').waitFor();
   assert.match(await page.locator('.special-mail-detail h1').innerText(),/检索测试草稿/);
  }finally{await page.evaluate(id=>api('/api/drafts/'+id,{method:'DELETE'}),draft.id);}
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  // A canceled interpretation may not restore its tags or results.
  let started,release;
  const seen=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>release=resolve);
  await page.route('**/api/productivity/search/interpret?*',async route=>{
   if(new URL(route.request().url()).searchParams.get('q')!=='from:slow')return route.continue();
   started();await hold;await route.fulfill({json:{structured:true,criteria:{sender:'slow'},tokens:[{field:'sender',value:'slow',canonical:'from:slow'}]}}).catch(()=>{});
  });
  await input.fill('from:slow');await seen;
  await search('来自项目同事的邮件',12);release();
  await page.waitForTimeout(100);
  assert.match(await page.locator('[data-remove-search-token=sender]').innerText(),/项目同事/);
  await page.unroute('**/api/productivity/search/interpret?*');
  await input.fill('from:"未闭合');await page.waitForFunction(()=>mailSearchState.phase==='error');
  assert(await page.locator('#search-error').isVisible());
  await search('采购',12);
  // Seed synthetic exported mail through the real local import API. The old
  // inbound message has no display name; only a prior recipient header knows it.
  const token=await page.evaluate(async ()=>{
   const nonce=Date.now();
   const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   let job=await api('/api/mail/client-imports',json({label:'发件人检索回归',expected_files:3,destination:'auto',auto_import:true}));
   const messages=[
    ['收件箱/old.eml',`From: lookup@example.test\r\nTo: ${activeMailAccount().user}\r\nSubject: Historical sender lookup\r\nDate: Fri, 01 Jan 1993 09:30:00 +0800\r\nMessage-ID: <sender-old-${nonce}@example.test>\r\n\r\nHistorical message.`],
    ['已发送/history.eml',`From: ${activeMailAccount().user}\r\nTo: 顾清禾 <lookup@example.test>\r\nSubject: Earlier correspondence\r\nDate: Fri, 01 Jan 1993 10:30:00 +0800\r\nMessage-ID: <sender-names-${nonce}@example.test>\r\n\r\nReply.`],
    ['收件箱/other.eml',`From: other@example.test\r\nTo: ${activeMailAccount().user}\r\nSubject: 顾清禾的项目\r\nDate: Fri, 01 Jan 1993 11:30:00 +0800\r\nMessage-ID: <sender-other-${nonce}@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis message is from somebody else.`]
   ];
   for(let index=0;index<messages.length;index++){
    const [name,body]=messages[index];
    await api('/api/mail/client-imports/'+job.token+'/files?index='+index+'&name='+encodeURIComponent(name),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body});
   }
   await api('/api/mail/client-imports/'+job.token+'/scan',{method:'POST'});
   return job.token;
  });
  await page.waitForFunction(async token=>(await api('/api/mail/client-imports/'+token)).state==='completed',token);
  for(const query of ['发件人是顾清禾','发件人是顾清禾。','发件人是：顾清禾','查询，发件人是顾清禾的所有邮件。','发件人是“顾清禾”','from:guqinghe','来自顾清禾的全部邮件。','发件人是“顾清禾 <lookup@example.test>”']){
   await search(query,1);
   assert.match(await page.locator('#email-list .sender-name').innerText(),/顾清禾/);
  }
  await search('顾清禾',2,'A name keyword includes both sender-alias and subject matches');
  await search('发件人是“顾清禾。”',0);
  await page.evaluate(()=>api('/api/mail/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'lookup@example.test',name:'采购顾老师'})}));
  await search('采购顾老师',1);
  await search('from:caigougulaoshi',1);
  const otherAccount=await page.evaluate(id=>_systemConfig.accounts.find(row=>row.id!==id).id,account);
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),otherAccount);
  await search('发件人是采购顾老师',0,'Aliases stay within their account');
  await page.evaluate(()=>openUnifiedInbox());
  await search('发件人是顾清禾',1,'All-time unified search includes 1993 mail');
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),account);
  // Even after search handoff, product questions do not become mailbox queries.
  await page.evaluate(()=>{_systemConfig.model={..._systemConfig.model,available:true,verified:true};assistantSearchMode=true;openAssistant();});
  await page.evaluate(()=>askAssistant('你是一个什么东西？你能做什么？'));
  await page.waitForFunction(()=>!assistantController&&document.getElementById('mail-assistant').dataset.answerComplete==='true');
  const answer=await page.locator('#assistant-messages .assistant-message.bot').last().innerText();
  assert.match(answer,/我是小邮/);assert.match(answer,/找邮件/);assert.match(answer,/回复草稿/);
  assert.doesNotMatch(answer,/暂时没找到|匹配的内容/);
  assert.equal(await page.locator('.assistant-search-result').count(),0);
  assert.equal(await page.evaluate(()=>assistantSearchMode),false,'Product help exits stale search mode');
  assert.deepEqual(errors,[]);
  console.log('PASS natural variants, combined conditions, removable tags, advanced form handoff, exact identity, account scope, sent/draft opening, stale interpretation cancellation and error recovery');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
