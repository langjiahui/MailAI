// Only tests/workspace_preview.py: temporary accounts, no real mail sent.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const waitContacts=()=>page.waitForFunction(()=>document.querySelectorAll('.contact-center-item').length>0);
  try{
    await page.goto(process.env.MAILAI_PREVIEW_URL||'http://127.0.0.1:18795/');await page.locator('#app-preloader').waitFor({state:'detached'});await page.waitForFunction(()=>_systemConfig?.accounts?.length===2);
    const accounts=await page.evaluate(()=>_systemConfig.accounts);assert.ok(accounts.every(a=>a.user.endsWith('@example.test')));
    const a=await page.evaluate(()=>activeMailAccount().id),b=accounts.find(x=>x.id!==a).id;
    await page.evaluate(async({a,b})=>{
      for(const [accountId,name] of [[a,'甲方联系人'],[b,'乙方联系人']]) await api('/api/mail/contacts',{accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'colleague@example.test',name})});
      await api('/api/mail/contacts',{accountId:b,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'second@example.test',name:'第二位'})});
      await openCompose({account_id:b,to_addr:'colleague@example.test, 未完成输入'});
      await openContactCenter('compose-to');
    },{a,b});await waitContacts();
    assert.ok((await page.locator('#contact-center-description').innerText()).includes(accounts.find(x=>x.id===b).user));
    assert.ok((await page.locator('#contact-center-list').innerText()).includes('乙方联系人'));
    assert.ok(!(await page.locator('#contact-center-list').innerText()).includes('甲方联系人'));
    await page.locator('[data-contact-pick="colleague@example.test"]').click();
    await page.locator('[data-contact-pick="second@example.test"]').click();
    await page.locator('#contact-center-search').fill('colleague');
    await page.waitForFunction(()=>contactCenterItems.length===1 && contactCenterItems[0].email==='colleague@example.test');
    await page.locator('#btn-apply-contacts').click();
    let recipients=await page.locator('#compose-to').inputValue();
    assert.ok(!recipients.includes('colleague@example.test'));
    assert.ok(recipients.includes('第二位 <second@example.test>') && recipients.includes('未完成输入'));
    console.log('PASS 发件账号通讯录一致、跨搜索保留姓名、取消勾选移除、未完成手输保留');
    await page.evaluate(()=>openContactCenter('compose-to'));await waitContacts();
    await page.locator('[data-contact-pick="second@example.test"]').click();
    assert.ok(await page.locator('#btn-apply-contacts').isEnabled());
    await page.locator('#btn-apply-contacts').click();
    assert.equal(await page.locator('#compose-to').inputValue(),'未完成输入');
    console.log('PASS 全部取消可以应用，不残留实际收件人');

    // A's address book remains A's even when a B compose window is open.
    await page.evaluate(()=>openContactCenter());await waitContacts();
    assert.ok((await page.locator('#contact-center-list').innerText()).includes('甲方联系人'));
    await page.locator('[data-contact-edit="colleague@example.test"]').click();
    // An editor must not be clipped by the compact contact list underneath it.
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      for (const selector of ['#contact-editor-title','#contact-form button[type="submit"]']) {
        assert.ok(await page.locator(selector).evaluate(el=>{
          const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return r.top>=0 && r.bottom<=innerHeight && (hit===el || el.contains(hit));
        }),`${selector} must be visible and reachable at ${width}px`);
      }
    }
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#contact-name').fill('甲方更新');
    await page.locator('#contact-form [type="submit"]').click();
    await page.waitForFunction(()=>document.getElementById('contact-editor').classList.contains('hidden'));
    const names=await page.evaluate(async({a,b})=>Promise.all([a,b].map(accountId=>api('/api/mail/contacts?q=colleague',{accountId}))),{a,b});
    assert.equal(names[0][0].name,'甲方更新');assert.equal(names[1][0].name,'乙方联系人');
    console.log('PASS 浏览账号与发件账号不同时，编辑联系人仍写入其所属账号');
    await page.locator('#btn-close-contacts').click();
    await page.evaluate(()=>openContactCenter('compose-cc'));await waitContacts();
    await page.locator('[data-tag-menu]>summary').click();await page.locator('[data-tag-manage]').click();
    await page.locator('[data-new-tag]').fill('乙方标签');
    await page.locator('#contact-tags-dialog [type="submit"]').click();
    await page.locator('#contact-tags-dialog').waitFor({state:'hidden'});
    const tags=await page.evaluate(async({a,b})=>Promise.all([a,b].map(accountId=>api('/api/mail/contact-tags',{accountId}))),{a,b});
    assert.ok(!tags[0].tags.some(t=>t.name==='乙方标签'));assert.ok(tags[1].tags.some(t=>t.name==='乙方标签'));
    await page.evaluate(async b=>{closeContactCenter();await openAccountMailbox(b,'inbox');await openContactCenter();},b);
    await page.locator('[data-tag-menu]>summary').click();
    await page.locator('[data-bulk-toggle]').click();
    await page.locator('[data-tag-contact="colleague@example.test"]').check();
    await page.locator('[data-bulk-apply]').click();
    await page.locator('[data-member-tag]').selectOption('乙方标签');
    await page.locator('[data-member-add]').click();
    await page.locator('#contact-tags-dialog').waitFor({state:'hidden'});
    const member=await page.evaluate(b=>api('/api/mail/contacts?q=colleague',{accountId:b}),b);
    assert.ok(member[0].tags.some(t=>t.id==='personal:乙方标签'));
    console.log('PASS 标签创建绑定发件账号、批量标记绑定当前通讯录账号');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
