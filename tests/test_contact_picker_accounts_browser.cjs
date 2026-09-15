// Only tests/workspace_preview.py: temporary accounts, no real mail sent.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const waitContacts=()=>page.waitForFunction(()=>document.querySelectorAll('.contact-center-item').length>0);
  try{
    await page.goto('http://127.0.0.1:18795/');await page.waitForFunction(()=>_systemConfig?.accounts?.length===2);
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
    await page.locator('#contact-name').fill('甲方更新');
    await page.locator('#contact-form [type="submit"]').click();
    await page.waitForFunction(()=>document.getElementById('contact-editor').classList.contains('hidden'));
    const names=await page.evaluate(async({a,b})=>Promise.all([a,b].map(accountId=>api('/api/mail/contacts?q=colleague',{accountId}))),{a,b});
    assert.equal(names[0][0].name,'甲方更新');assert.equal(names[1][0].name,'乙方联系人');
    console.log('PASS 浏览账号与发件账号不同时，编辑联系人仍写入其所属账号');
    await page.locator('#btn-close-contacts').click();
    await page.evaluate(()=>openContactCenter('compose-cc'));await waitContacts();
    await page.locator('#group-create').click();await page.locator('#group-dialog-name').fill('乙方分组');
    await page.locator('#group-dialog-form [type="submit"]').click();
    await page.waitForFunction(()=>document.getElementById('contact-group-filter').value==='乙方分组');
    const groups=await page.evaluate(async({a,b})=>Promise.all([a,b].map(accountId=>api('/api/mail/contact-groups',{accountId}))),{a,b});
    assert.ok(!groups[0].some(g=>g.name==='乙方分组'));assert.ok(groups[1].some(g=>g.name==='乙方分组'));
    await page.locator('#group-add-members').click();
    await page.locator('#group-members-list input[value="colleague@example.test"]').check();
    await page.locator('#group-members-save').click();
    await page.waitForFunction(()=>!document.getElementById('group-members-dialog').open);
    const member=await page.evaluate(b=>api('/api/mail/contacts?q=colleague',{accountId:b}),b);
    assert.equal(member[0].group_name,'乙方分组');
    console.log('PASS 分组创建、候选成员读取与添加均绑定发件账号');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
