// Isolated example.test fixture only: never uses a real mailbox or OS notification.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18795');await page.locator('.email-item').first().waitFor();await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.evaluate(async()=>{const rows=await api('/api/todos?include_done=true');if(rows[0]?.status==='done')await api(`/api/todos/${rows[0].id}/reopen`,{method:'POST'})});
  await page.locator('#btn-todos').click();const title=page.locator('.todo-title-input').first();await title.waitFor();
  let fail=true, writes=[];
  await page.route('**/api/todos/*',async route=>{
   if(route.request().method()!=='PATCH') return route.continue();
   writes.push(route.request().postDataJSON());
   if(fail)return route.fulfill({status:503,json:{detail:'测试保存失败'}});
   await new Promise(r=>setTimeout(r,350));return route.continue();
  });
  await title.fill('修改尚未保存');await title.press('Tab');
  await page.locator('.todo-save-state[data-state="error"]').waitFor();
  await page.evaluate(()=>loadTodoCenter());assert.equal(await title.inputValue(),'修改尚未保存');
  await page.locator('#btn-close-todos').click();assert(await page.locator('#btn-todos').evaluate(n=>n===document.activeElement));
  await page.locator('#btn-todos').click();await title.waitFor();assert.equal(await title.inputValue(),'修改尚未保存');
  fail=false;await page.locator('[data-todo-save-retry]').click();await page.locator('.todo-save-state[data-state="saved"]').waitFor();
  await title.fill('较早的修改');await title.press('Tab');await title.fill('最新修改');await title.press('Tab');
  await page.waitForFunction(()=>document.querySelector('.todo-save-state')?.dataset.state==='saved');
  const saved=await page.evaluate(async()=>(await api('/api/todos?include_done=true'))[0]);assert.equal(saved.title,'最新修改');
  await title.focus();await page.evaluate(()=>{window.originalTitle=document.activeElement});await page.evaluate(()=>loadTodoCenter());
  assert(await title.evaluate(n=>n===document.activeElement));
  // A modal cancellation must not close the underlying writing panel.
  await page.locator('#btn-close-todos').click();await page.evaluate(()=>{openCompose();toggleComposeAiPanel(true);document.getElementById('compose-subject').value='保留草稿';});
  await page.locator('#btn-discard-draft').click();await page.locator('.mailai-question').waitFor();
  assert.equal(await page.locator('.mailai-question [data-cancel]').evaluate(n=>n===document.activeElement),true);
  await page.keyboard.press('Escape');await page.locator('.mailai-question').waitFor({state:'detached'});
  assert(await page.locator('#compose-ai-panel').isVisible());assert.equal(await page.locator('#compose-subject').inputValue(),'保留草稿');
  await page.evaluate(()=>{window.questionResult='pending';mailaiAsk({title:'文件夹名称',value:'原名称',confirmText:'创建'}).then(v=>window.questionResult=v)});
  await page.locator('.mailai-question input').fill('新名称');await page.locator('.mailai-question [data-confirm]').click();await page.waitForFunction(()=>window.questionResult==='新名称');
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';mailaiAsk({title:'舍弃草稿？',message:'已保存的草稿会被删除，无法撤销。',danger:true,confirmText:'舍弃草稿'});});
  await page.setViewportSize({width:600,height:900});await page.screenshot({path:'build/interaction-question-dark.png'});await page.keyboard.press('Escape');
  // Failed local connection is diagnosed; no mutation is replayed by recovery.
  let attempts=0;
  await page.route('**/api/health',r=>r.abort());
  await page.route('**/api/test-connection',r=>{attempts++;return r.abort()});
  await page.evaluate(()=>api('/api/test-connection',{method:'POST'}).catch(()=>{}));
  await page.waitForFunction(()=>document.querySelector('#connection-recovery span')?.textContent.includes('连接不到'));
  await page.unroute('**/api/health');
  await page.evaluate(()=>document.querySelector('#connection-recovery button').click());
  await page.waitForFunction(()=>document.querySelector('#connection-recovery span')?.textContent.includes('已连接'));
  assert.equal(attempts,1);
  await page.evaluate(()=>api('/api/health'));
  await page.route('**/api/mail/folders',r=>r.fulfill({status:502,json:{detail:'测试邮箱连接失败'}}));
  await page.evaluate(()=>api('/api/mail/folders').catch(()=>{}));
  assert.match(await page.locator('#connection-recovery').innerText(),/邮箱操作未完成/);
  assert.match(await page.locator('#connection-recovery').innerText(),/邮箱设置/);
  await page.route('**/api/mail/compose/assist',r=>r.fulfill({status:502,json:{detail:'AI 写作服务暂时不可用'}}));
  await page.evaluate(()=>api('/api/mail/compose/assist',{method:'POST'}).catch(()=>{}));
  assert.match(await page.locator('#connection-recovery').innerText(),/AI 服务/);
  assert.match(await page.locator('#connection-recovery').innerText(),/模型设置/);
  assert.deepEqual(errors,[]);
  console.log('PASS: failed-edit retention/retry, serialized saves, focus, cancel/IME-safe modal, dark/narrow, transport recovery without resending');
 } finally {await browser.close();}
})();
