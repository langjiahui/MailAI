// 5,000 synthetic history rows per account; no real mailbox or original files.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium;
(async()=>{
 const browser=await engine.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let requests=0,oldMetadata=0,holdFolders=true,releaseFolders;
  const foldersHeld=new Promise(resolve=>releaseFolders=resolve);
  await page.route('**/api/mail/folders',async route=>{if(holdFolders)await foldersHeld;await route.continue();});
  await page.route('**/api/todos',route=>route.fulfill({status:503,json:{detail:'synthetic ancillary failure'}}));
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/mailbox/list')requests++;if(new URL(request.url()).pathname==='/api/emails')oldMetadata++;});
  await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/');
  await page.locator('#app-preloader').waitFor({state:'hidden',timeout:15000});
  assert(holdFolders,'First screen must not await the server folder request');
  assert.equal(await page.evaluate(()=>allEmails.length),200);
  assert.equal(await page.locator('#email-list .email-item').count(),200);
  assert.match(await page.locator('#list-count').textContent(),/10024/);
  assert.equal(oldMetadata,0,'Opening a mailbox must not retrieve the complete legacy list');
  holdFolders=false;releaseFolders();
  const accounts=await page.evaluate(()=>_systemConfig.accounts.map(row=>({id:row.id,user:row.user})));
  assert(accounts.every(row=>row.user.endsWith('@example.test')));
  const work=accounts.find(row=>row.user==='work@example.test'),personal=accounts.find(row=>row.user==='personal@example.test');
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),work.id);
  const overlay=page.locator('#mailbox-transition');await overlay.waitFor({state:'hidden'});
  assert.match(await page.locator('#list-count').textContent(),/5012/);
  assert.equal(await page.evaluate(()=>allEmails.length),200);
  await page.evaluate(async()=>{const id=allEmails[0].id;await api('/api/emails/'+id+'/read',{method:'POST'});await mailaiMailboxStore.heartbeat(true);await selectEmail(id);});
  await page.waitForFunction(()=>Boolean(selectedEmailDetail));
  const selected=await page.evaluate(()=>selectedEmailId);
  await page.locator('#email-list').evaluate(node=>node.scrollTop=1200);
  const scroll=await page.locator('#email-list').evaluate(node=>node.scrollTop);
  await page.evaluate(id=>openAccountMailbox(id,'local_archive'),work.id);
  await overlay.waitFor({state:'hidden'});assert.equal(await page.locator('#email-list .email-item').count(),1);
  const before=requests;
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),work.id);
  assert(await overlay.isHidden(),'A valid cached view must finish without a loading animation');
  await overlay.waitFor({state:'hidden'});
  assert.equal(requests,before,'Returning to an unchanged cached view reloaded metadata');
  assert.equal(await page.evaluate(()=>selectedEmailId),selected,'Cached view lost its selected message');
  assert(await page.evaluate(()=>Boolean(selectedEmailDetail)),'Cached reading snapshot was not restored');
  assert(Math.abs(await page.locator('#email-list').evaluate(node=>node.scrollTop)-scroll)<3,'Cached view lost its scroll position');
  const list=page.locator('#email-list');
  const inbox=page.locator(`.sidebar-account-folders [data-account-action="inbox"][data-account-id="${work.id}"]`);
  assert(await inbox.locator('em').isVisible(),'The inbox should show its unread badge');
  const visibleMail=()=>list.evaluate(node=>{
    const top=node.getBoundingClientRect().top;
    const row=[...node.querySelectorAll('.email-item')].find(item=>item.getBoundingClientRect().bottom>top);
    return {id:row.dataset.id,offset:row.getBoundingClientRect().top-top};
  });
  const beforeArrival=await visibleMail();
  const newSubject='New unread mail while browsing history';
  const firstInboxPage=url=>{
    if(url.pathname!=='/api/mailbox/list' || url.searchParams.get('refresh')!=='true' || url.searchParams.get('cursor'))return false;
    const filters=JSON.parse(url.searchParams.get('filters'));
    return filters.status==='inbox' && !filters.unified;
  };
  await page.route(firstInboxPage,async route=>{
    const response=await route.fetch();
    const data=await response.json();
    data.items=[{...data.items[0],id:95001,subject:newSubject,date:new Date(Date.now()+60000).toISOString(),is_read:false},...data.items.slice(0,-1)];
    await route.fulfill({response,json:data});
  },{times:1});
  await page.evaluate(()=>mailaiMailboxStore.heartbeat(true));
  const afterArrival=await visibleMail();
  assert.equal(afterArrival.id,beforeArrival.id,'New mail displaced the message being browsed');
  assert(Math.abs(afterArrival.offset-beforeArrival.offset)<3,'New mail moved the visible message');
  const requestsBeforeClick=requests;
  await inbox.click();
  await page.waitForFunction(()=>document.getElementById('email-list').scrollTop===0);
  assert.match(await list.locator('.email-item.unread').first().textContent(),/New unread mail while browsing history/);
  assert.equal(requests,requestsBeforeClick,'A saved first page should be immediate');
  await page.evaluate(()=>mailaiMailboxStore.heartbeat(true));
  // A matching historical row lies beyond the first 25 pages, not in allEmails.
  await page.evaluate(async()=>{currentFilter.mailTags=['Historical label'];await loadData();});
  assert.equal(await page.locator('#email-list .email-item').count(),1);
  assert.match(await page.locator('#email-list').textContent(),/Bulk message 00000/);
  assert.match(await page.locator('#list-count').textContent(),/1/);
  await page.evaluate(async()=>{currentFilter.mailTags=[];await loadData();});
  const tagRequests=requests;
  await page.evaluate(async()=>{currentFilter.mailTags=['Historical label'];await loadData();});
  assert.equal(requests,tagRequests,'Revisiting a cached label issued another list query');
  await page.evaluate(async()=>{currentFilter.mailTags=[];await loadData();});
  // Pagination remains bounded even when the user keeps requesting older mail.
  for(let index=0;index<6;index++){
   await page.locator('[data-mail-page="next"]').click();
   await page.waitForFunction(()=>!document.querySelector('[data-mail-page="next"]')?.disabled);
   await page.waitForFunction(()=>document.querySelectorAll('#email-list .email-item').length>=400);
  }
  const diagnostics=await page.evaluate(()=>mailaiMailboxStore.diagnostics());
  assert(diagnostics.window<=1000 && diagnostics.rows<=4000 && diagnostics.views<=12);
  assert(await page.locator('[data-mail-page="previous"]').count());
  const oldFirst=await page.evaluate(()=>allEmails[0].id);
  // New read state invalidates the version, but refresh preserves the old window.
  await page.evaluate(async()=>{await api('/api/emails/'+allEmails[0].id+'/read',{method:'POST'});await mailaiMailboxStore.heartbeat(true);});
  assert.equal(await page.evaluate(()=>allEmails[0].id),oldFirst,'Background refresh jumped to the newest page');
  await inbox.click();
  await page.waitForFunction(()=>allEmails.length===200 && !document.querySelector('[data-mail-page="previous"]'));
  assert.equal(await list.evaluate(node=>node.scrollTop),0,'Inbox click did not rewind the historical window');
  await page.evaluate(id=>mailaiMailboxStore.reveal(id),oldFirst);
  await page.locator('[data-mail-page="first"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-mail-page="first"]'));
  assert.equal(await list.evaluate(node=>node.scrollTop),0,'The anchored view must still be able to return to the beginning');
  const unifiedInbox=page.locator('[data-account-action="unified"]');
  await unifiedInbox.click();
  await overlay.waitFor({state:'hidden'});
  await list.evaluate(node=>node.scrollTop=1200);
  assert(await list.evaluate(node=>node.scrollTop)>0);
  await unifiedInbox.click();
  await page.waitForFunction(()=>document.getElementById('email-list').scrollTop===0);
  await inbox.click();
  await overlay.waitFor({state:'hidden'});
  // Coalesce the same request and discard a late response after an account switch.
  let release;const held=new Promise(resolve=>release=resolve);let blocking=true;
  await page.route('**/api/mailbox/list?*',async route=>{
   const q=JSON.parse(new URL(route.request().url()).searchParams.get('filters'));
   if(blocking && q.category==='Bulk')await held;
   await route.continue().catch(()=>{});
  });
  await page.evaluate(()=>{currentFilter.category='Bulk';window.pendingView=loadData();});
  await page.evaluate(id=>openAccountMailbox(id,'inbox'),personal.id);
  blocking=false;release();await page.evaluate(()=>window.pendingView);
  assert.equal(await page.evaluate(()=>activeMailAccount().id),personal.id);
  assert.equal(await page.evaluate(()=>selectedMailboxAccountId),personal.id);
  assert.equal(await page.evaluate(()=>currentFilter.category),'');
  // An explicit load error ends the transition and offers a concrete retry.
  await page.unroute('**/api/mailbox/list?*');
  await page.route('**/api/mailbox/list?*',route=>route.fulfill({status:503,json:{detail:'synthetic metadata failure'}}));
  await page.evaluate(async()=>{mailaiMailboxStore.invalidate();await openAccountMailbox(activeMailAccount().id,'local_archive');});
  await overlay.waitFor({state:'hidden'});
  assert(await page.locator('[data-mailbox-retry]').isVisible());
  await page.unroute('**/api/mailbox/list?*');
  await page.locator('[data-mailbox-retry]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#email-list .email-item').length===1);
  await page.evaluate(()=>{
    _systemConfig.accounts=_systemConfig.accounts.filter(account=>account.id===activeMailAccount()?.id);
    renderSidebarAccounts();
  });
  const compactInbox=page.locator('#folder-nav [data-value="inbox"]');
  await compactInbox.click();
  await overlay.waitFor({state:'hidden'});
  await list.evaluate(node=>node.scrollTop=1200);
  assert(await list.evaluate(node=>node.scrollTop)>0);
  await compactInbox.click();
  await page.waitForFunction(()=>document.getElementById('email-list').scrollTop===0);
  assert.deepEqual(errors,[]);
  console.log('PASS first-page independence, 5k history facets, cached reading position, new mail anchoring, Inbox returns to top, bounded paging and failure recovery');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
