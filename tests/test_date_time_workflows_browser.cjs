// Run against tests/workspace_preview.py. No live mailbox or mail sending.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
  for(const type of [chromium,webkit]) {
    const browser=await type.launch({headless:true});
    try {
      const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://127.0.0.1:18795/');await page.locator('#app-preloader').waitFor({state:'detached'});
      const accounts=await page.evaluate(()=>_systemConfig.accounts);
      assert(accounts.length===2 && accounts.every(a=>a.user.endsWith('@example.test')),'Isolated fixture required');
      const future=await page.evaluate(()=>{const d=new Date();d.setDate(d.getDate()+3);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
      async function pick(id,value) {
        await page.locator(`#${id} + .datetime-trigger`).click();
        const panel=page.locator('.datetime-panel:visible');
        await panel.locator('.datetime-navigation select').last().selectOption(value.slice(0,4));
        await panel.locator('.datetime-navigation select').first().selectOption(String(Number(value.slice(5,7))-1));
        await panel.locator(`[data-date="${value.slice(0,10)}"]`).click();
        if(value.includes('T')){await panel.locator('.datetime-hour').fill(value.slice(11,13));await panel.locator('.datetime-minute').fill(value.slice(14,16));}
        const colors=await panel.locator('.datetime-apply').evaluate(n=>{const s=getComputedStyle(n);return {fg:s.color,bg:s.backgroundColor};});
        assert.notEqual(colors.fg,colors.bg,`${id} selected action must be visible`);
        await panel.locator('.datetime-apply').click();assert.equal(await page.locator(`#${id}`).inputValue(),value);
      }
      await page.evaluate(()=>setI18nLanguage('zh-CN'));
      for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
        await page.evaluate(()=>openCompose());await page.locator('#productivity-schedule-button').click();
        await page.locator('#send-arrangement-mode').selectOption('scheduled');
        await page.evaluate(({theme,mode})=>{applyTheme(mode);if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;},{theme,mode});
        await pick('productivity-send-at',`${future}T09:15`);
        await page.locator('[data-productivity-action="save-send-arrangement"]').click();
        assert.equal(await page.locator('#compose-send-at').inputValue(),`${future}T09:15`);
        await page.evaluate(()=>closeCompose());
        await page.evaluate(async()=>{const rows=await api('/api/todos?include_done=true');if(rows[0].status==='done')await api(`/api/todos/${rows[0].id}/reopen`,{method:'POST'});await openTaskPlanner({todoId:rows[0].id});});
        await page.evaluate(({theme,mode})=>{applyTheme(mode);if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;},{theme,mode});
        await pick('plan-deadline',future);await pick('plan-remind',`${future}T10:30`);
        if(type===chromium && theme==='theme_baowu') {
          await page.locator('#plan-remind + .datetime-trigger').click();
          await page.screenshot({path:`/tmp/mailai-task-picker-${mode}.png`});await page.keyboard.press('Escape');
        }
        await page.locator('#plan-save').click();await page.locator('#task-planner').waitFor({state:'hidden'});
        const row=await page.evaluate(async()=>{const rows=await api('/api/todos?include_done=true');return rows[0];});
        assert.equal(row.deadline,future);assert.match(row.remind_at,new RegExp(`${future}T10:30`));
      }
      await page.evaluate(()=>mailaiProductivity.openSearch());
      await page.locator('[data-criterion="after"] + .datetime-trigger').waitFor();
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('input[type="date"],input[type="datetime-local"],input[type="time"]')].filter(n=>!n.hidden && !n.classList.contains('hidden') && !n.classList.contains('datetime-source')).length),0,'Every user-facing date/time field is enhanced');
      await page.keyboard.press('Escape');await page.evaluate(()=>showSystemView('maintenance'));
      await page.locator('#btn-create-backup').click();await page.locator('#backup-list [data-restore-backup]').first().waitFor();
      await page.locator('#backup-list [data-restore-backup]').first().click();
      await pick('restore-start','2026-01-01');await pick('restore-end','2026-12-31');
      await page.locator('#restore-submit').click();await page.locator('#backup-restore-dialog').waitFor({state:'hidden'});
      assert.deepEqual(errors,[]);
      console.log(`${type.name()}: real send-arrangement, task persistence, backup/range restore, all palettes and dynamic search dates passed`);
    } finally {await browser.close();}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
