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
  assert.deepEqual(sent,[]);assert.deepEqual(errors,[]);
  console.log(`PASS ${type.name()}: command discovery, keyboard/IME/focus, current-scope search, account switch/failure, shared dialog handoff, modal/draft guards, i18n and narrow zoom`);
 }finally{await browser.close();}
}
(async()=>{for(const type of [chromium,webkit].filter(type=>!process.env.MAILAI_BROWSER||type.name()===process.env.MAILAI_BROWSER))await run(type);})().catch(error=>{console.error(error);process.exitCode=1;});
