// Run only against the synthetic MAILAI_TODO_GROUP_FIXTURE fixture.
const assert = require('node:assert/strict');
const {chromium,webkit} = require('playwright');
const engine = process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium;
(async()=>{
 const browser=await engine.launch({headless:true});
 let page, original;
 try {
  page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/');
  await page.locator('#app-preloader').waitFor({state:'detached'});
  assert(await page.evaluate(()=>_systemConfig.accounts.every(row=>row.user.endsWith('@example.test'))));
  await page.evaluate(()=>openTodoCenter());
  original=await page.evaluate(()=>({accountId:todoCenterAccountId,rows:todoCenterRows.filter(row=>row.email_subject.includes('秋季出行'))}));
  const group=page.locator('.todo-group').filter({has:page.locator('h3', {hasText:'部门秋季出行安排通知'})});
  await group.waitFor();
  assert.equal(await page.locator('#todo-group-toggle').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#todo-individual-toggle').getAttribute('aria-pressed'),'false');
  assert.match(await page.locator('#todo-center-summary').innerText(),/6 项待办/);
  // Options disclose infrequent actions; Escape returns to the same control.
  await page.locator('#todo-options>summary').click();
  assert(await page.locator('#todo-show-done').isVisible());
  assert(await page.locator('#todo-extra-actions .productivity-panel-entry').isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#todo-options').getAttribute('open'),null);
  assert(await page.locator('#todo-options>summary').evaluate(node=>document.activeElement===node));
  assert(await page.locator('#todo-center').isVisible());
  assert.match(await group.locator('.todo-group-meta').innerText(),/5 项未完成/);
  assert.equal(await group.locator('.todo-group-sources button').count(),2);
  assert.equal(await group.locator('.todo-group-details').getAttribute('open'),null);
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert(await group.locator('.todo-group-details>summary').evaluate(node=>{node.click();return node.parentElement.getAnimations().length>0;}),'Expanding a group has a measured transition');
  await group.locator('.todo-group-details>summary').evaluate(node=>node.click());
  await page.waitForFunction(()=>{const node=document.querySelector('.todo-group-details');return !node.open&&node.style.overflow==='';});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#todo-individual-toggle').click();
  assert.equal(await page.locator('.todo-group').count(),0);
  assert.equal(await page.locator('#todo-list .todo-center-item:visible').count(),6);
  await page.locator('#todo-group-toggle').click();
  await group.locator('.todo-group-details>summary').click();
  assert.equal(await group.locator('.todo-center-item:visible').count(),5);
  // Source inspection is a round trip, retaining the view and expanded group.
  await page.locator('[data-todo-view="later"]').click();
  await page.setViewportSize({width:1440,height:600});
  await group.locator('.todo-center-item .todo-source').last().scrollIntoViewIfNeeded();
  const sourceScroll=await page.locator('#todo-list').evaluate(node=>node.scrollTop);
  assert(sourceScroll>0,'The source round trip covers a scrolled task list');
  await group.locator('.todo-center-item .todo-source').last().click();
  await page.locator('#todo-source-back').waitFor({state:'visible'});
  assert(!await page.locator('#todo-center').isVisible());
  await page.locator('#todo-source-back').click();
  await group.waitFor();
  assert.equal(await page.locator('#todo-center').getAttribute('data-todo-view'),'later');
  assert.notEqual(await group.locator('.todo-group-details').getAttribute('open'),null);
  assert(Math.abs(await page.locator('#todo-list').evaluate(node=>node.scrollTop)-sourceScroll)<3,'Source return keeps the previous list position');
  assert(!await page.locator('#todo-source-return').isVisible());
  await page.locator('#btn-close-todos').click();
  assert(await page.locator('#btn-todos').evaluate(node=>document.activeElement===node),'Closing a resumed workspace returns to a visible control');
  await page.locator('#btn-todos').click();
  await group.waitFor();
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('button[data-todo-view="all"]').click();
  const first=group.locator('.todo-center-item').first();
  const firstId=Number(await first.getAttribute('data-todo-id'));
  // A background refresh cannot drop a focused, unsaved title edit.
  await first.locator('textarea').fill('核对更新后的集合安排');
  await page.evaluate(()=>loadTodoCenter());
  assert.equal(await group.locator(`[data-todo-id="${firstId}"] textarea`).inputValue(),'核对更新后的集合安排');
  await group.locator('h3').click();
  await page.waitForFunction(async id=>(await api('/api/todos?include_done=true',{accountId:todoCenterAccountId})).find(row=>row.id===id)?.title==='核对更新后的集合安排',firstId);
  // The real persisted group reminder route applies once to the complete group.
  await group.locator('[data-todo-group-remind]').click();
  const dialog=page.locator('#todo-group-planner');await dialog.waitFor({state:'visible'});
  await dialog.locator('[data-group-quick="tomorrow"]').click();
  const quickTime=await dialog.locator('[data-group-time]').inputValue();
  assert(quickTime.endsWith('T09:00')&&new Date(quickTime)>new Date(),'Quick reminder means tomorrow at 9 in local time');
  const value=await page.evaluate(()=>{const date=new Date(Date.now()+2*86400000);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());return date.toISOString().slice(0,16)});
  const setTime = value=>dialog.locator('[data-group-time]').evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));},value);
  await setTime(value);
  await dialog.locator('[type=submit]').click();
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>todoCenterRows.filter(row=>row.email_subject.includes('秋季出行')).every(row=>row.remind_at));
  const snapshot=await page.evaluate(()=>todoCenterRows.filter(row=>row.email_subject.includes('秋季出行')).map(row=>({id:row.id,remind_at:row.remind_at,deadline:row.deadline})));
  assert.equal(snapshot.length,5);assert.equal(new Set(snapshot.map(row=>row.remind_at)).size,1);
  // Completed subtasks retain their IDs, while other items remain open.
  await page.emulateMedia({reducedMotion:'no-preference'});
  await group.locator(`[data-todo-toggle="${firstId}"]`).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(id=>todoCenterRows.find(row=>row.id===id)?.status==='done',firstId);
  assert.match(await group.locator('.todo-group-meta').innerText(),/4 项未完成/);
  assert.match(await group.locator('.todo-group-meta').innerText(),/共 5 项/,'Completing a task must preserve the total group size');
  assert.match(await group.locator('.todo-group-progress').getAttribute('aria-label'),/1 \/ 5/);
  assert(await page.evaluate(()=>document.activeElement.matches('.todo-complete-action')),'Keyboard completion keeps focus in the checklist');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#todo-options>summary').click();
  await page.locator('#todo-show-done').check();
  await page.locator('#todo-options>summary').click();
  assert.equal(await group.locator('.todo-center-item').count(),5);
  assert.equal(await group.locator(`[data-todo-id="${firstId}"] .todo-complete-action`).innerText(),'恢复待办');
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.match(await group.locator('.todo-group-meta').innerText(),/4 open/);
  assert.equal(await group.locator('[data-todo-group-remind]').innerText(),'Group reminder');
  assert.equal(await group.locator('h3').innerText(),'部门秋季出行安排通知');
  await group.locator('[data-todo-group-remind]').click();
  assert.match(await dialog.locator('[data-group-description]').innerText(),/4 open items/);
  // A failed save stays reviewable and can be retried, without silently closing.
  await page.route('**/api/todos/group/reminder',r=>r.fulfill({status:503,json:{detail:'fixture unavailable'}}));
  await setTime('');await dialog.locator('[type=submit]').click();
  await dialog.locator('[data-group-error]').filter({hasText:'fixture unavailable'}).waitFor();
  assert(await dialog.isVisible());
  await page.unroute('**/api/todos/group/reminder');await dialog.locator('[type=submit]').click();
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>todoCenterRows.filter(row=>row.email_subject.includes('秋季出行')).every(row=>!row.remind_at));
  await page.evaluate(()=>setI18nLanguage('zh-CN'));
  await group.locator('.todo-group-details>summary').click();
  assert.equal(await group.locator('.todo-group-details').getAttribute('open'),null);
  await page.locator('#todo-batch-toggle').click();
  assert.notEqual(await group.locator('.todo-group-details').getAttribute('open'),null,'Batch mode exposes subtasks in collapsed groups');
  assert(await page.locator('#todo-center .todo-batch-actions').isVisible());
  assert(await group.locator('.todo-select input').first().isVisible());
  assert(!await group.locator('.todo-complete-action').first().isVisible(),'Batch selection replaces completion targets');
  await page.locator('#todo-select-all').check();
  assert.equal(await page.evaluate(()=>selectedTodoIds.size),5); // 4 grouped + unrelated contract task
  await page.locator('#todo-batch-toggle').click();
  assert(!await page.locator('#todo-center .todo-batch-actions').isVisible());
  for(const palette of ['','theme_monochrome','theme_baowu']) for(const theme of ['light','dark']) {
   await page.evaluate(({palette,theme})=>{document.documentElement.dataset.rewardTheme=palette;applyTheme(theme);},{palette,theme});
   for(const width of [1440,760,390]) {
    await page.setViewportSize({width,height:1000});
    await group.locator('.todo-group-details').evaluate(node=>node.open=true);
    assert(await group.evaluate(node=>node.scrollWidth<=node.clientWidth+1),`group containment ${palette}/${theme}/${width}`);
    assert(await page.locator('.todo-center-card').evaluate(node=>{const box=node.getBoundingClientRect();return box.left>=-1&&box.right<=innerWidth+1}),`panel containment ${palette}/${theme}/${width}`);
    assert(await page.locator('.todo-center-tools').evaluate(node=>node.scrollWidth<=node.clientWidth+1),`toolbar containment ${palette}/${theme}/${width}`);
    assert(await page.locator('#todo-list').evaluate(root=>[...root.querySelectorAll('.todo-center-item')].filter(row=>row.getClientRects().length).every(row=>{
      const button=row.querySelector('.todo-complete-action').getBoundingClientRect(),title=row.querySelector('textarea').getBoundingClientRect();
      return button.width>=32&&button.width<=44&&button.right<=title.left+1;
    })),`Completion targets do not overlap titles ${palette}/${theme}/${width}`);
    if(palette==='theme_monochrome'&&width===1440&&process.env.MAILAI_TODO_UI_SCREENSHOTS)await page.screenshot({path:process.env.MAILAI_TODO_UI_SCREENSHOTS+`/todo-${engine.name()}-${theme}.png`});
   }
  }
  // English and enlarged text share the same visible actions, without clipping.
  await page.evaluate(()=>{setI18nLanguage('en');document.documentElement.style.setProperty('--fz','1.5');document.body.style.zoom='1.5';});
  assert(await page.locator('.todo-center-tools').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'English toolbar at 150% in narrow viewport');
  await page.locator('#todo-options>summary').click();
  assert(await page.locator('#todo-extra-actions').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}),'Options remain reachable at 150%');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{setI18nLanguage('zh-CN');document.documentElement.style.removeProperty('--fz');document.body.style.zoom='';});
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await group.locator('[data-todo-group-done]').click();
  await page.locator('.mailai-question [data-confirm]').click();
  await page.waitForFunction(()=>todoCenterRows.filter(row=>row.email_subject.includes('秋季出行')).every(row=>row.status==='done'));
  await page.evaluate(()=>loadTodoCenter());
  const after=await page.evaluate(()=>todoCenterRows.filter(row=>row.email_subject.includes('秋季出行')).map(row=>row.id).sort());
  assert.deepEqual(after,snapshot.map(row=>row.id).sort());
  assert.equal(await page.evaluate(()=>todoCenterRows.find(row=>row.email_id===1).status),'open');
  // Account switch must not carry over another account's completion or reminders.
  const other=await page.evaluate(()=>_systemConfig.accounts.find(row=>row.id!==todoCenterAccountId).id);
  await page.evaluate(async other=>{closeTodoCenter();await openAccountMailbox(other,'inbox');await openTodoCenter();},other);
  assert.equal(await page.evaluate(()=>todoCenterRows.filter(row=>row.email_subject.includes('秋季出行')&&row.status==='open').length),5);
  // A single large group must obey the same row budget as an ungrouped list.
  // Give this independent stress fixture a fresh page, after the theme, zoom
  // and account round trips above. Keep real pointer input in both engines;
  // accumulated WebKit page state must not decide whether this case passes.
  await page.close();
  page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/');
  await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.evaluate(()=>openTodoCenter());
  const savedRows=await page.evaluate(()=>todoCenterRows);
  await page.evaluate(()=>{
   const seed=todoCenterRows.find(row=>row.status==='open');
   todoCenterRows=Array.from({length:1000},(_,i)=>({...seed,id:50000+i,email_id:60000+i,title:'Synthetic task '+i,group_key:'mail:large-fixture|same',group_title:'Synthetic large group'}));
   todoRenderLimit=160;renderTodoCenter();
  });
  assert.equal(await page.locator('#todo-list [data-todo-id]').count(),160);
  assert.equal(await page.locator('.todo-group').count(),1);
  assert.match(await page.locator('.todo-group-meta').innerText(),/1000/);
  assert(await page.locator('.todo-group-sources button').count()<=161);
  const moreButton=await page.locator('[data-todo-render-more]').elementHandle();
  try {
   await page.locator('[data-todo-render-more]').click();
  } catch(error) {
   console.error('Large-group pointer state',await page.evaluate(()=>({
    limit:todoRenderLimit,rows:document.querySelectorAll('#todo-list [data-todo-id]').length,
    active:document.activeElement?.outerHTML.slice(0,500),
    more:document.querySelector('[data-todo-render-more]')?.outerHTML,
   })));
   throw error;
  }
  await page.waitForFunction(()=>document.querySelectorAll('#todo-list [data-todo-id]').length===320);
  assert.equal(await page.locator('#todo-list [data-todo-id]').count(),320);
  assert(await moreButton.evaluate(node=>node.isConnected && node===document.querySelector('[data-todo-render-more]')),'Paging keeps the activated button attached and focused');
  assert(await page.locator('.todo-group-sources button').count()<=321);
  await page.evaluate(rows=>{todoCenterRows=rows;todoRenderLimit=160;renderTodoCenter();},savedRows);
  assert.deepEqual(errors,[]);
  console.log('PASS grouped source notices, persisted edits/reminders, recovery, subtask/group completion, filters, language, responsive layouts and account isolation');
 } finally {
  if (original && page) {
   await page.unroute('**/api/todos/group/reminder').catch(()=>{});
   await page.evaluate(async original=>{
    for(const row of original.rows) {
     await api(`/api/todos/${row.id}/reopen`,{accountId:original.accountId,method:'POST'});
     await api(`/api/todos/${row.id}`,{accountId:original.accountId,method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:row.title,deadline:row.deadline || '',remind_at:row.remind_at || ''})});
     if(row.status==='done')await api(`/api/todos/${row.id}/done`,{accountId:original.accountId,method:'POST'});
    }
   },original).catch(()=>{});
  }
  await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1});
