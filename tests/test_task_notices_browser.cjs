// Run only against tests/workspace_preview.py: no real notifications or mail.
const {chromium}=require('playwright'); const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const p=await browser.newPage({viewport:{width:1440,height:1000}});
 await p.route('**/api/task-notices/test',route=>route.fulfill({json:{ok:true,message:'已提交测试通知；请检查系统设置。'}}));
 await p.goto('http://127.0.0.1:18795');await p.locator('.email-item').first().waitFor();await p.locator('#app-preloader').waitFor({state:'hidden'});
 await p.evaluate(async()=>{const rows=await api('/api/todos?include_done=true');if(rows[0]?.status==='done')await api(`/api/todos/${rows[0].id}/reopen`,{method:'POST'});await openTodoCenter();await openTaskPlanner({todoId:todoCenterRows[0].id})});
 await p.locator('[data-plan-time="later"]').click();await p.locator('#plan-save').click();await p.locator('#task-planner').waitFor({state:'hidden'});
 await p.route('**/api/task-notices',r=>r.fulfill({status:503,json:{detail:'测试读取失败'}}));
 await p.locator('#btn-task-notices').click();await p.waitForFunction(()=>document.getElementById('notice-records').textContent.includes('暂时无法读取'));
 await p.unroute('**/api/task-notices');await p.locator('#notice-refresh').click();const row=p.locator('.notice-record').first();await row.waitFor();assert.match(await row.innerText(),/等待提醒/);
 await row.locator('[data-notice-action="later"]').focus();
 await row.evaluate(n=>{window.noticeNode=n;window.noticeFocus=document.activeElement});
 await p.evaluate(()=>document.getElementById('notice-refresh').click());await p.waitForTimeout(350);
 assert(await row.evaluate(n=>n===window.noticeNode));assert(await p.evaluate(()=>document.activeElement===window.noticeFocus));
 await row.locator('[data-notice-action="tomorrow"]').click();await p.waitForTimeout(500);
 const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);const date=tomorrow.getFullYear()+'-'+String(tomorrow.getMonth()+1).padStart(2,'0')+'-'+String(tomorrow.getDate()).padStart(2,'0');
 assert.match(await row.innerText(),new RegExp(date+' 09:00'));
 if(await p.locator('#notice-test').isEnabled()){await p.locator('#notice-test').click();await p.waitForFunction(()=>document.getElementById('notice-capability').textContent.includes('已提交测试'));assert.match(await p.locator('#notice-capability').innerText(),/已提交测试/);}
 await p.evaluate(()=>document.documentElement.dataset.theme='dark');await p.setViewportSize({width:600,height:900});await p.screenshot({path:'build/task-notices-dark.png'});
 await row.locator('[data-notice-action="open"]').click();await p.locator('#task-planner').waitFor({state:'visible'});assert(await p.locator('#plan-remind').inputValue());await p.locator('#task-planner [data-plan-close]').first().click();
 await p.evaluate(()=>mailaiOpenTaskReminder({}));await row.waitFor();await row.locator('[data-notice-action="done"]').click();await p.locator('.notice-empty').waitFor();
 await p.locator('#notice-show-done').check();await p.locator('#notice-refresh').click();await p.waitForTimeout(300);
 await p.locator('.notice-state[data-state="done"]').waitFor();
 // Completion clears the reminder, but the record remains inspectable.
 const reminder=await p.evaluate(async()=>{const tasks=await api('/api/todos?include_done=true');return tasks[0]});assert.equal(reminder.status,'done');assert(!reminder.remind_at);
 await p.keyboard.press('Escape');assert(!await p.locator('#task-notices').isVisible());
 console.log('Reminder UI passed: save, shortcuts, record, native entry, complete, dark/narrow, dismissal; system test mocked');
}finally{await browser.close()}})();
