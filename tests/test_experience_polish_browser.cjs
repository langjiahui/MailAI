// Isolated fixture only. No remote mail mutation or native notifications.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch();try{
 const p=await browser.newPage({viewport:{width:1512,height:950},reducedMotion:'reduce'});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:18795');await p.locator('.email-item').first().waitFor();await p.locator('#app-preloader').waitFor({state:'hidden'});
 assert(await p.evaluate(()=>activeMailAccount().user.endsWith('@example.test')));
 // Failed remote COPY can be paused without claiming remote success.
 let paused=false;const writes=[];
 await p.route('**/api/mail/action-sync**',async r=>{
  const u=new URL(r.request().url());
  if(r.request().method()==='POST'){writes.push(u.pathname);paused=u.pathname.endsWith('/pause');return r.fulfill({json:{ok:true}})}
  const row={id:999,subject:'同步结果待核对',pending_action:'trash_copying',pending_error:'副本结果未知',pending_attempts:9,paused};
  const rows=!paused||u.searchParams.has('include_paused')?[row]:[];
  return r.fulfill({json:{rows,total:rows.length,paused_count:paused?1:0}});
 });
 await p.evaluate(()=>openTaskCenter());await p.locator('[data-action-sync-pause]').click();await p.locator('.mailai-question [data-confirm]').click();
 await p.locator('[data-sync-paused-toggle]').waitFor();assert.equal(await p.locator('[data-action-sync-pause]').count(),0);
 await p.locator('[data-sync-paused-toggle]').click();await p.locator('[data-action-sync-retry]').waitFor();assert.match(await p.locator('#task-center-list').innerText(),/服务器端是否删除尚未确认/);
 await p.locator('[data-action-sync-retry]').click();await p.locator('[data-action-sync-pause]').waitFor();assert.deepEqual(writes,['/api/mail/action-sync/999/pause','/api/mail/action-sync/999/retry']);await p.evaluate(()=>closeTaskCenter());
 // Attachments retain preview/download behavior in a dense, aligned list.
 await p.locator('#btn-attachments').click();await p.locator('.attachment-open').first().waitFor();await p.locator('button[data-file-view=list]').click();
 await p.evaluate(()=>{const base=attachmentItems[0];attachmentItems=Array.from({length:148},(_,i)=>({...base,name:i%2?'交付安排.csv':'很长的跨部门项目交付时间安排与审批记录文件名称.csv'}));renderAttachmentCenter()});
 for(const width of [1512,850,560,390]){
  await p.setViewportSize({width,height:900});await p.evaluate(()=>document.documentElement.dataset.theme='dark');
  const ok=await p.locator('#attachment-grid').evaluate(g=>[...g.querySelectorAll('.attachment-card')].every(c=>{const r=c.getBoundingClientRect();return [...c.querySelectorAll('.attachment-file-icon,b,.attachment-download-action,.attachment-risk')].filter(n=>n.getClientRects().length).every(n=>{const b=n.getBoundingClientRect();return b.bottom<=r.bottom+1&&b.right<=r.right+1&&b.left>=r.left-1})}));assert(ok,'list containment '+width);
 }
 await p.setViewportSize({width:1512,height:950});await p.evaluate(()=>document.documentElement.dataset.theme='light');await p.screenshot({path:'build/experience-attachments.png'});
 await p.locator('#attachment-grid').evaluate(g=>g.scrollTop=600);
 // Row height varies by density; measure after bringing the chosen file into view.
 await p.locator('.attachment-open').nth(9).scrollIntoViewIfNeeded();const top=await p.locator('#attachment-grid').evaluate(g=>g.scrollTop);
 await p.locator('.attachment-open').nth(9).click();await p.locator('.file-preview').waitFor({state:'visible'});await p.locator('.file-preview button[aria-label="关闭预览"]').click();assert(Math.abs(await p.locator('#attachment-grid').evaluate(g=>g.scrollTop)-top)<100);
 await p.locator('#btn-close-attachments').click();
 // Same panel for reminders, and date views keep task scope explicit.
 await p.evaluate(async()=>{await openTodoCenter();const base=todoCenterRows[0];const day=localDateKey();todoCenterRows=[{...base,id:101,title:'今天的工作',status:'open',deadline:day,remind_at:''},{...base,id:102,title:'逾期工作',status:'open',deadline:'2000-01-01',remind_at:''},{...base,id:103,title:'未安排工作',status:'open',deadline:'',remind_at:''}];renderTodoCenter()});
 await p.locator('button[data-todo-view=overdue]').click();assert.equal(await p.locator('#todo-list [data-todo-id]').count(),1);assert.equal(await p.locator('.todo-title-input').inputValue(),'逾期工作');
 await p.locator('#btn-task-notices').click();assert(await p.locator('#todo-center #task-notices').isVisible());assert(!await p.locator('#todo-list').isVisible());
 await p.locator('button[data-todo-view=today]').click();await p.waitForTimeout(100);assert.equal(await p.locator('.todo-title-input').inputValue(),'今天的工作','closing reminder records must retain chosen filter');
 assert(!await p.locator('.todo-select').first().isVisible());await p.locator('#todo-batch-toggle').click();await p.locator('#todo-select-all').check();assert.deepEqual(await p.evaluate(()=>[...selectedTodoIds]),[101]);
 await p.locator('button[data-todo-view=overdue]').click();assert.deepEqual(await p.evaluate(()=>[...selectedTodoIds]),[]);await p.locator('#todo-select-all').check();assert.deepEqual(await p.evaluate(()=>[...selectedTodoIds]),[102]);await p.locator('#todo-batch-toggle').click();
 await p.locator('button[data-todo-view=all]').click();assert(await p.locator('#todo-list').isVisible());assert(!await p.locator('#task-notices').isVisible());await p.screenshot({path:'build/experience-tasks.png'});
 for(const width of [760,390]) {await p.setViewportSize({width,height:900});await p.evaluate(()=>document.documentElement.dataset.theme='dark');await p.waitForTimeout(80);await p.screenshot({path:'build/experience-tasks-'+width+'.png'});assert(await p.locator('#todo-list').evaluate(g=>[...g.querySelectorAll('.todo-center-item')].every(c=>{const r=c.getBoundingClientRect();return [...c.querySelectorAll('.todo-title-input,.todo-time-meta,.todo-plan-actions')].every(n=>{const b=n.getBoundingClientRect();return b.right<=r.right+1&&b.bottom<=r.bottom+1&&b.left>=r.left-1})})),'task containment '+width);}
 await p.screenshot({path:'build/experience-tasks-narrow.png'});
 await p.locator('button[data-todo-view=later]').click();await p.locator('[data-todo-empty-all]').click();assert.equal(await p.locator('#todo-list [data-todo-id]').count(),3);
 await p.setViewportSize({width:1280,height:800});await p.evaluate(()=>{document.documentElement.style.setProperty('--fz','1.5');document.body.style.zoom='1.5';const base=todoCenterRows[0];todoCenterRows=Array.from({length:60},(_,i)=>({...base,id:1000+i,title:'较长任务：跨部门评审材料的准备、核对与反馈安排'}));renderTodoCenter()});
 assert(await p.locator('#todo-list').evaluate(n=>n.scrollHeight>n.clientHeight),'long list must scroll');
 await p.locator('.todo-complete-action').last().scrollIntoViewIfNeeded();assert(await p.locator('.todo-complete-action').last().evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}));
 assert(await p.locator('.todo-center-card').evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1}),'zoomed panel within viewport');
 await p.screenshot({path:'build/experience-tasks-enlarged.png'});await p.evaluate(()=>{document.documentElement.style.removeProperty('--fz');document.body.style.zoom='' });
 await p.evaluate(()=>{document.documentElement.dataset.theme='light';closeTodoCenter()});
 // Real button nodes move into more; primary labels remain visible.
 await p.locator('.email-item').first().click();await p.locator('.prioritized-actions').waitFor();
 await p.locator('#reading-pane').evaluate(n=>{n.style.width='540px';n.style.maxWidth='540px'}).catch(()=>{});
 await p.setViewportSize({width:1050,height:900});await p.waitForTimeout(150);
 await p.locator('.reading-more-actions>summary').click();assert(await p.locator('.reading-overflow-actions [data-reading-action=summary]').isVisible());
 await p.screenshot({path:'build/experience-reading.png'});
 assert.deepEqual(errors,[]);console.log('PASS failure pause/resume, dense attachments, reminder workspace, date filters and responsive reading actions');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
