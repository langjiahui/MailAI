// Isolated workspace_preview.py only. No live mailbox/model or outgoing mail.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
async function run(type){
 const browser=await type.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],sent=[];
  await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/mail/send')sent.push(request.url());});
  await page.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795');
  await page.locator('#app-preloader').waitFor({state:'hidden'});
  await page.locator('#email-list .email-item').first().waitFor();
  assert((await page.evaluate(()=>api('/api/system/config'))).accounts.every(account=>account.user.endsWith('@example.test')));
  const palette=page.locator('#productivity-dialog'),input=page.locator('#productivity-command-query'),launcher=page.locator('#btn-command-palette');
  const closed=()=>palette.waitFor({state:'hidden'});
  async function open(){await page.keyboard.press('Control+k');await input.waitFor();assert(await input.evaluate(node=>node===document.activeElement));}
  const active=()=>input.evaluate(node=>document.getElementById(node.getAttribute('aria-activedescendant'))?.dataset.commandId);
  const global=page.locator('#global-search');
  await global.fill('采购合同');await page.waitForFunction(()=>mailSearchState.phase==='done');
  await global.evaluate(node=>node.setSelectionRange(1,3));
  await open();assert.equal(await launcher.getAttribute('aria-expanded'),'true');
  await input.fill('待办');
  await input.evaluate(node=>{node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
  assert(await palette.isVisible(),'IME confirmation must not execute a command even if the platform omits isComposing');
  assert.equal(await page.locator('#todo-center').isVisible(),false);
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await input.fill('');
  assert.equal(await palette.locator('.command-copy small').filter({hasText:await page.evaluate(()=>activeMailAccount().user)}).count(),0,'Mailbox context is shown once above the command list');
  await input.fill('搜索');assert(await palette.locator('[data-command-id=focus-search] mark').count()>0);
  await input.fill('');
  await page.keyboard.press('ArrowDown');assert.equal(await active(),'compose');
  await page.keyboard.press('ArrowUp');assert.equal(await active(),'focus-search');
  await input.fill('DAIBAN');assert.equal(await active(),'todos','Commands match case-insensitive aliases');
  await page.keyboard.press('Escape');await closed();
  await page.waitForFunction(()=>{const n=document.getElementById('global-search');return n===document.activeElement&&n.selectionStart===1&&n.selectionEnd===3;});
  assert.equal(await global.inputValue(),'采购合同');
  await launcher.click();await input.fill('daiban');await input.press('Enter');
  await page.locator('#todo-center').waitFor();await closed();
  await page.locator('#btn-close-todos').click();
  // Reusing the productivity dialog must not let its old close event invalidate
  // the new advanced-search or template panel.
  await open();await input.fill('advanced');await input.press('Enter');
  await page.locator('#productivity-dialog[data-panel=advanced-search]').waitFor();
  assert(await page.locator('#productivity-search-form').isVisible());
  await page.keyboard.press('Escape');await closed();
  await open();await input.fill('template');await input.press('Enter');
  await page.locator('#productivity-template-name').waitFor();
  await page.locator('#productivity-template-name').fill('Fixture unsaved template');
  await page.keyboard.press('Control+k');
  assert.equal(await page.locator('#productivity-template-name').inputValue(),'Fixture unsaved template');
  assert.equal(await input.count(),0,'A template editor is not replaced by the palette');
  await page.keyboard.press('Escape');await closed();
  await page.evaluate(async()=>{await mailaiProductivity.templates();document.getElementById('productivity-dialog').close();await mailaiProductivity.templates();});
  assert(await page.locator('[data-productivity-action=save-template]').evaluate(node=>typeof node.onclick==='function'),'A queued close event cannot invalidate the next panel');
  assert(await page.locator('#productivity-template-name').evaluate(node=>node===document.activeElement));
  await page.keyboard.press('Escape');await closed();
  await open();await input.fill('采购合同命令入口验证');
  assert.equal(await active(),'search-query');
  const scope=await page.evaluate(()=>currentMailboxScopeLabel());
  assert.match(await page.locator('[data-command-id=search-query]').innerText(),new RegExp(scope));
  await input.press('Enter');await closed();await page.waitForFunction(()=>document.getElementById('global-search').value==='采购合同命令入口验证'&&mailSearchState.phase==='done');
  assert.equal(await global.inputValue(),'采购合同命令入口验证');
  assert.equal(await page.evaluate(()=>currentMailboxScopeLabel()),scope,'Search preserves the current mailbox scope');
  // A failed switch rolls back through the existing mailbox navigation path.
  const original=await page.evaluate(()=>activeMailAccount().id);
  const other=await page.evaluate(id=>_systemConfig.accounts.find(account=>account.id!==id),original);
  let release,signal,attempts=0;const started=new Promise(resolve=>signal=resolve);
  await page.route('**/api/system/mail/preferred',async route=>{
   attempts++;const pending=new Promise(resolve=>release=resolve);signal();await pending;
   await route.fulfill({status:503,json:{detail:'fixture switch unavailable'}});
  });
  await open();await input.fill(other.user.toUpperCase());assert.equal(await active(),'account:'+other.id);
  await input.press('Enter');await started;
  assert.equal(await launcher.getAttribute('aria-busy'),'true');
  await page.keyboard.press('Control+k');assert.equal(await launcher.getAttribute('aria-busy'),'true');
  assert.equal(await palette.isVisible(),false);assert.equal(attempts,1);
  release();await page.waitForFunction(()=>!document.getElementById('btn-command-palette').hasAttribute('aria-busy'));
  assert.equal(await page.evaluate(()=>activeMailAccount().id),original);
  assert.match(await page.locator('#toast').innerText(),/fixture switch unavailable/);
  await page.unroute('**/api/system/mail/preferred');
  await open();await input.fill(other.user);await input.press('Enter');await closed();
  await page.waitForFunction(id=>activeMailAccount()?.id===id&&selectedMailboxAccountId===id&&!document.getElementById('btn-command-palette').hasAttribute('aria-busy'),other.id);
  // Special characters stay text, and IME confirmation never executes a row.
  await open();await input.fill('<img src=x onerror=alert(1)>');
  assert.equal(await palette.locator('img').count(),0);
  await input.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
  assert(await palette.isVisible());
  await page.evaluate(()=>setI18nLanguage('en'));
  assert.equal(await input.inputValue(),'<img src=x onerror=alert(1)>');
  assert.match(await page.locator('[data-command-id=search-query]').innerText(),/Search mail/);
  await input.fill('ＳＥＡＲＣＨ');assert.equal(await active(),'focus-search');
  assert.match(await page.locator('[data-command-id=focus-search] mark').innerText(),/Search/i);
  await page.evaluate(()=>setI18nLanguage(I18N_DEFAULT_LANG));
  for(const [width,theme,scale]of [[1440,'light',1],[390,'dark',1.2]]){
   await page.setViewportSize({width,height:800});
   await page.evaluate(({theme,scale})=>{applyTheme(theme);document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',String(scale));},{theme,scale});
   await input.fill('');
   assert(await palette.evaluate(node=>{const r=node.getBoundingClientRect();return node.scrollWidth<=node.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}));
   await page.screenshot({path:`build/command-palette-${type.name()}-${width}.png`});
  }
  await page.keyboard.press('Escape');await closed();
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>{document.body.style.zoom=1;document.documentElement.style.setProperty('--fz','1');});
  // Existing non-native modal and compose text are preserved by the shortcut.
  await page.evaluate(()=>openAttachmentCenter());await page.locator('#attachment-center').waitFor();
  await page.keyboard.press('Control+k');assert.equal(await palette.isVisible(),false);
  await page.locator('#btn-close-attachments').click();
  await page.evaluate(()=>{window.fixtureQuestion=mailaiAsk({title:'Fixture confirmation',message:'Keep this open'});});
  await page.locator('dialog.mailai-question').waitFor();await page.keyboard.press('Control+k');
  assert.equal(await palette.isVisible(),false);await page.keyboard.press('Escape');
  await page.locator('dialog.mailai-question').waitFor({state:'detached'});
  await page.evaluate(()=>openCompose());await page.locator('#compose-subject').fill('Fixture draft must remain');
  await page.keyboard.press('Control+k');assert.equal(await palette.isVisible(),false);
  assert.equal(await page.locator('#compose-subject').inputValue(),'Fixture draft must remain');
  await page.locator('#btn-close-compose').click();
  await page.locator('#compose-modal').waitFor({state:'hidden'});

  // Item 2: unified workbench shortcuts, contextual quick-action bar, fast triage & shortcut sheet.
  await page.evaluate(async()=>await openAccountMailbox(_systemConfig.accounts[0].id,'inbox'));
  await page.waitForFunction(()=>activeMailAccount()?.id===_systemConfig.accounts[0].id&&allEmails.length>=2);
  await page.locator('#email-list .email-item').first().waitFor();
  const secondId=Number(await page.locator('#email-list .email-item').nth(1).getAttribute('data-id'));
  await page.locator('#email-list .email-item').first().click();
  await page.waitForFunction(()=>Boolean(selectedEmailDetail&&selectedEmailDetail.id));
  const openedId=await page.evaluate(()=>Number(selectedEmailDetail.id));
  const openedSubject=await page.evaluate(()=>String(selectedEmailDetail.subject||'').trim());
  await page.evaluate(async id=>{
   await api(`/api/productivity/workflow/${id}`,{accountId:_systemConfig.accounts[0].id,method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'unhandled',at:'',followup_at:''})});
   const row=allEmails.find(r=>Number(r.id)===id); if(row) row.handle_state='unhandled';
   if(selectedEmailDetail&&Number(selectedEmailDetail.id)===id) selectedEmailDetail.handle_state='unhandled';
  },openedId);

  // Contextual mail bar + searchable contextual commands appear inside Cmd/Ctrl+K while preserving index 0/1 ordering.
  await open();
  assert.equal(await active(),'focus-search');
  await page.keyboard.press('ArrowDown');assert.equal(await active(),'compose');
  await page.locator('#productivity-command-mail').waitFor();
  assert.match(await page.locator('#productivity-command-mail .command-mail-meta strong').innerText(),new RegExp(openedSubject.slice(0,8).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(await page.locator('#productivity-command-mail [data-command-pill]').count(),5);
  await page.screenshot({path:`build/command-palette-context-${type.name()}.png`});
  await input.fill('yichuli');
  assert.equal(await active(),'mail-done-next','Contextual fast-triage commands are searchable by pinyin/alias');

  // Contrast check on new palette mail-bar, keys, recent badges and shortcut cheat-sheet across 6 palettes.
  await input.fill('');
  for(const [theme,mode,width,scale] of [['','light',1440,1],['theme_monochrome','dark',1440,1],['theme_baowu','dark',390,1.2]]){
   await page.setViewportSize({width,height:800});
   await page.evaluate(({theme,mode,scale})=>{applyTheme(mode);if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',String(scale));},{theme,mode,scale});
   const failures=await palette.evaluate(root=>{
    const ctx=document.createElement('canvas').getContext('2d');
    const paint=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);};
    const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    return [...root.querySelectorAll('.command-mail-meta strong,.command-mail-pill,.command-key,.command-hints')].filter(n=>n.getClientRects().length&&n.textContent.trim()).map(n=>{
     const a=[];for(let x=n;x;x=x.parentElement)a.unshift(x);
     ctx.clearRect(0,0,1,1);paint('#fff');a.forEach(x=>paint(getComputedStyle(x).backgroundColor));const bg=lum([...ctx.getImageData(0,0,1,1).data]);
     ctx.clearRect(0,0,1,1);paint(getComputedStyle(n).color);const fg=lum([...ctx.getImageData(0,0,1,1).data]);
     return {text:n.textContent.trim(),ratio:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)};
    }).filter(n=>n.ratio<4.5);
   });
   assert.deepEqual(failures,[],JSON.stringify({theme,mode,width,failures}));
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>{applyTheme('light');delete document.documentElement.dataset.rewardTheme;document.body.style.zoom=1;document.documentElement.style.setProperty('--fz','1');});
  await page.keyboard.press('Escape');await closed();

  // Single-key workflow triage (`e`), Shift+E (mark done + advance), undo via palette, read toggle (`u`), task (`t`), shortcut sheet (`?`), and input guard.
  await page.locator('#productivity-command-mail').waitFor({state:'hidden'});
  await page.keyboard.press('e');
  await page.waitForFunction(id=>allEmails.find(r=>Number(r.id)===id)?.handle_state==='done',openedId);
  await open();await input.fill('undo');assert.equal(await active(),'mail-undo-workflow');
  await input.press('Enter');await closed();
  await page.waitForFunction(id=>allEmails.find(r=>Number(r.id)===id)?.handle_state==='unhandled',openedId);

  await page.keyboard.press('Shift+E');
  await page.waitForFunction(([prev,next])=>allEmails.find(r=>Number(r.id)===prev)?.handle_state==='done'&&Number(selectedEmailDetail?.id)===next,[openedId,secondId]);

  const wasRead=await page.evaluate(id=>Boolean(allEmails.find(r=>Number(r.id)===id)?.is_read),secondId);
  await page.keyboard.press('u');
  await page.waitForFunction(([id,expected])=>Boolean(allEmails.find(r=>Number(r.id)===id)?.is_read)===expected,[secondId,!wasRead]);

  await page.keyboard.press('t');
  await page.locator('#task-planner').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#task-planner').waitFor({state:'hidden'});

  await page.keyboard.press('?');
  await page.locator('#productivity-dialog[data-panel=shortcuts]').waitFor();
  assert.equal(await page.locator('#productivity-dialog[data-panel=shortcuts] .shortcut-row').count()>=10,true);
  await page.screenshot({path:`build/command-palette-shortcuts-${type.name()}.png`});
  await page.locator('#productivity-dialog[data-panel=shortcuts] [data-productivity-action="open-palette"]').click();
  await input.waitFor();
  await input.fill('genjin');assert.equal(await active(),'followups');
  await input.press('Enter');await closed();
  await page.locator('#todo-center[data-todo-view="followups"]').waitFor();
  // While todo center is open, single-key shortcuts must not leak through.
  await page.keyboard.press('c');
  assert.equal(await page.locator('#compose-modal').isVisible(),false);
  await page.locator('#btn-close-todos').click();
  await page.locator('#todo-center').waitFor({state:'hidden'});

  assert.deepEqual(sent,[]);assert.deepEqual(errors,[]);
  console.log(`PASS ${type.name()}: command discovery, keyboard/IME/focus, current-scope search, account switch/failure, shared dialog handoff, modal/draft guards, fast triage flow, shortcut sheet, i18n and narrow zoom`);
 }finally{await browser.close();}
}
(async()=>{for(const type of [chromium,webkit].filter(type=>!process.env.MAILAI_BROWSER||type.name()===process.env.MAILAI_BROWSER))await run(type);})().catch(error=>{console.error(error);process.exitCode=1;});
