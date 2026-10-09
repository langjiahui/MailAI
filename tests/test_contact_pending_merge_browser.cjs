// Run against an isolated tests/workspace_preview.py server only.
const assert = require('node:assert/strict');
const browserType = require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];
const base = process.env.MAILAI_PREVIEW_URL || 'http://127.0.0.1:18796';
(async () => {
  const browser = await browserType.launch({headless:true});
  let page;
  try {
    page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(async()=>{
      await openContactCenter();
      await api('/api/mail/contacts',{accountId:contactAccountId(),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'colleague@example.test',name:'已有姓名',company:'已有公司',note:'个人备注',favorite:true,group_name:'同事',profile:{department:'已有部门',address:'保留地址',custom_fields:{旧字段:'保留'}}})});
    });
    async function seed(name,uid,email='colleague@example.test') {
      await page.evaluate(async({name,uid})=>{
        const accountId=contactAccountId(),post=data=>({accountId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
        const csv=`姓名,邮箱,员工部门,工号,手机号码,办公地点\n${name},colleague@example.test,新部门,${uid},13900000000,\n冲突姓名,colleague@example.test,新部门,${uid},13900000000,\n`;
        const source=await api('/api/mail/contacts/directory/file?filename=pending.csv',{accountId,method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob([csv])});
        const plan=await api('/api/mail/contacts/directory/preview',post({token:source.token,sheets:source.sheets.map(s=>s.name)}));
        await api('/api/mail/contacts/directory/apply',post({token:plan.token,emails:[]}));
        await loadContactCenter();
        await mailaiDirectoryRefresh();
      },{name,uid});
      if(await page.locator('.contact-import-menu > summary').count())await page.locator('.contact-import-menu > summary').click();
      await page.locator('#directory-pending-button').click();
      await page.locator('.directory-pending-row').filter({hasText:uid}).click();
      await page.locator('[data-pending-email]').fill(email);
    }
    const save=page.locator('[data-resolve-pending]');
    const stamp=Date.now();
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await seed('补充姓名','F'+stamp);
    await save.click();await page.locator('.directory-pending-merge').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('[data-resolve-pending]').textContent==='确认保存到已有联系人');
    assert.equal(await page.locator('[data-pending-policy]').inputValue(),'fill');
    assert.match(await page.locator('[data-pending-differences]').textContent(),/保留已有资料/);
    await page.screenshot({path:'/tmp/mailai-pending-merge-dark.png'});
    await save.click();await page.getByText('没有待补充资料',{exact:true}).waitFor();
    let saved=await page.evaluate(async()=>(await api('/api/mail/contacts?q=colleague%40example.test',{accountId:contactAccountId()}))[0]);
    assert.equal(saved.name,'已有姓名');assert.equal(saved.profile.department,'已有部门');assert.equal(saved.profile.mobile,'13900000000');
    await page.locator('[data-directory-close]').click();
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    await seed('覆盖姓名','R'+stamp);
    await save.click();await page.locator('.directory-pending-merge').waitFor({state:'visible'});
    await page.locator('[data-pending-company]').fill('新公司');
    assert.equal(await page.locator('.directory-pending-merge').isVisible(),false);
    assert.equal(await save.textContent(),'保存并加入通讯录');
    await save.click();await page.locator('[data-pending-policy]').selectOption('replace');
    assert.match(await page.locator('[data-pending-differences]').textContent(),/新公司/);
    await page.evaluate(()=>api('/api/mail/contacts/favorite',{accountId:contactAccountId(),method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'colleague@example.test',favorite:false})}));
    await save.click();await page.getByText('资料已变化，请重新核对差异后保存',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-pending-company]').inputValue(),'新公司');
    assert.equal(await page.locator('.directory-pending-merge').isVisible(),false);
    await save.click();await page.locator('[data-pending-policy]').selectOption('replace');
    let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/api/mail/contacts/directory/pending/*',async route=>{
      if(route.request().method()==='POST')await gate;
      await route.continue();
    });
    await save.click();assert.equal(await page.locator('#pending-address').isDisabled(),true);
    assert.equal(await page.locator('[data-directory-close]').isDisabled(),true);
    release();await page.getByText('没有待补充资料',{exact:true}).waitFor();
    saved=await page.evaluate(async()=>(await api('/api/mail/contacts?q=colleague%40example.test',{accountId:contactAccountId()}))[0]);
    assert.equal(saved.name,'覆盖姓名');assert.equal(saved.company,'新公司');assert.equal(saved.profile.department,'新部门');
    assert.equal(saved.note,'个人备注');assert.equal(saved.group_name,'同事');assert.equal(saved.favorite,false);
    assert.equal(saved.profile.address,'保留地址');assert.equal(saved.profile.custom_fields.旧字段,'保留');
    await page.locator('[data-directory-close]').click();
    await seed('新联系人','N'+stamp,`new-${stamp}@example.test`);
    await save.click();await page.getByText('没有待补充资料',{exact:true}).waitFor();
    assert.match(await page.locator('[data-directory-message]').textContent(),/已保存/);
    await page.locator('[data-directory-close]').click();
    await page.unroute('**/api/mail/contacts/directory/pending/*');
    // Files with no valid email complete without creating contacts or pending records.
    await page.evaluate(()=>mailaiDirectoryImport(contactAccountId()));
    await page.locator('[data-directory-file]').setInputFiles({name:'no-email.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,邮箱,部门,工号\n无邮箱,,忽略部门,M001\n错误邮箱,invalid,忽略部门,M002\n')});
    await page.locator('[data-directory-next]').click();
    await page.locator('[data-sheet-index]').check();
    assert.equal(await page.locator('[data-update-policy]').inputValue(),'fill');
    await page.locator('[data-preview]').click();
    await page.getByText('已忽略 2 条无有效邮箱的记录，不会加入通讯录或待核对列表。',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-apply-import]').isEnabled(),true);
    await page.locator('[data-apply-import]').click();
    await page.getByText('未选择 0 人 · 待核对 0 条 · 忽略无有效邮箱 2 条',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-open-pending]').count(),0);
    const summary=await page.evaluate(()=>api('/api/mail/contacts/directory/summary',{accountId:contactAccountId()}));
    assert.equal(summary.pending,0);
    assert.deepEqual(errors,[]);
    console.log('PASS directory browser: default fill, discard missing/invalid emails, dark/light merge, concurrent edits and frozen save controls');
  } catch(error){console.error(await page?.evaluate(()=>document.querySelector('#contact-directory-dialog')?.innerText || 'Directory dialog is closed'));throw error;}
  finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
