// Real local routes on workspace_preview.py; synthetic mail/model only.
const assert=require('node:assert/strict'),{chromium,webkit}=require('playwright');
async function run(engine){
 const browser=await engine.launch();
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],requests=[];
  await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  p.on('pageerror',error=>errors.push(error.message));p.on('request',request=>{if(/\/api\/(assistant\/ask-stream|emails\/\d+|mail\/read)/.test(request.url()))requests.push(request.url());});
  await p.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795');await p.locator('#app-preloader').waitFor({state:'hidden'});await p.locator('#email-list .email-item').first().waitFor();
  await p.evaluate(async()=>{if(!_systemConfig.accounts.every(a=>a.user.endsWith('@example.test')))throw new Error('Isolated fixture required');await openAccountMailbox(_systemConfig.accounts[0].id,'inbox');_systemConfig.model={..._systemConfig.model,available:true,verified:true};openAssistant();askAssistant('找检索同事最近一周的闭环合同',null,[],[],false,{searchMode:true});});
  await p.waitForFunction(()=>!assistantController&&document.querySelectorAll('[data-search-loop-source]').length>3);
  const result=p.locator('.assistant-search-result').last(),rows=result.locator('.assistant-search-candidate');
  const toggle=rows.first().locator('[data-search-source-details]');
  assert.equal(await rows.first().locator('button:visible').count(),1,'Collapsed cards have one clear preview control');
  const calls=requests.length,read=await p.evaluate(()=>allEmails.map(e=>[e.id,e.is_read]));
  await toggle.focus();await p.keyboard.press('Enter');await rows.first().locator('.assistant-search-detail').waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  assert.match(await rows.first().innerText(),/闭环合同/);
  const openName=await p.evaluate(()=>mailaiText('打开邮件'));
  assert(await rows.first().getByRole('button',{name:new RegExp(openName)}).isVisible(),'Opening mail is an explicit action inside the preview');
  assert((await rows.first().locator('.assistant-search-detail p').innerText()).length>5,'An excerpt arrives with the search citations');
  await p.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert(await toggle.evaluate(n=>n===document.activeElement));
  await toggle.click();await result.locator('[data-search-loop-more]').click();
  const fourth=rows.nth(3);await fourth.locator('[data-search-source-details]').click();
  await result.locator('[data-search-loop-more]').click();assert.equal(await fourth.isVisible(),false);
  await result.locator('[data-search-loop-more]').click();assert(await fourth.locator('.assistant-search-detail').isVisible());
  await p.evaluate(()=>setI18nLanguage('en'));assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.match(await toggle.getAttribute('aria-label'),/Collapse/);
  assert.equal(requests.length,calls,'Local disclosure never fetches/opens mail or asks the model');
  assert.deepEqual(await p.evaluate(()=>allEmails.map(e=>[e.id,e.is_read])),read);
  // Old history has metadata only. Hostile markup and long text remain plain text.
  await p.evaluate(()=>{
   const node=document.createElement('div');node.className='assistant-message bot';node.innerHTML='<div class="assistant-bubble"></div>';document.getElementById('assistant-messages').append(node);
   mailaiAssistantSearch.restore(node,{id:'fixture-local-preview',status:'complete',conversation_id:assistantConversationId,account_user:'work@example.test',conditions:[],keywords:[],actions:[]},[
    {id:9001,subject:'<img src=x onerror=alert(1)>长主题'.repeat(12),from_name:'<b>合成发件人</b>',from_addr:'long-address'.repeat(12)+'@example.test',date:'2026-10-17T10:00:00',preview:'<script>alert(1)</script> 邮件片段 '.repeat(8)},
    {id:9002,subject:'Legacy history without a preview',from_addr:'old@example.test',date:'2026-10-16'}]);
  });
  const safe=p.locator('[data-search-run-id=fixture-local-preview]');await safe.locator('[data-search-source-details]').first().click();
  assert.equal(await safe.locator('img,script').count(),0);assert.match(await safe.locator('.assistant-search-source').first().innerText(),/<img/);
  await safe.locator('[data-search-source-details]').nth(1).click();assert.equal(await safe.locator('.assistant-search-detail').nth(1).locator('p').count(),0);
  for(const [width,zoom]of [[1440,1],[720,1.25],[390,1.2]]){
   await p.setViewportSize({width,height:1000});await p.evaluate(z=>{document.body.style.zoom=z;document.documentElement.style.setProperty('--fz',z);applyTheme('dark');updateAssistantPlacement();},zoom);
   const overflowing=await safe.locator('.assistant-search-result,.assistant-search-candidate,.assistant-search-detail').evaluateAll(nodes=>nodes.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>({class:n.className,scroll:n.scrollWidth,client:n.clientWidth})));
   assert.deepEqual(overflowing,[],JSON.stringify({width,zoom,overflowing}));
   const open=safe.locator('[data-search-loop-source]').first();await open.scrollIntoViewIfNeeded();
   assert(await open.evaluate(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Jump-to-latest must not cover the open-mail action');
   await p.screenshot({path:`build/candidate-details-${engine.name()}-${width}.png`});
  }
  assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: local mail details/excerpts, no read/network effects, Escape/focus, show-more/language state, legacy history and escaped long content at zoom`);
 }finally{await browser.close();}
}
(async()=>{for(const engine of [chromium,webkit].filter(e=>!process.env.MAILAI_BROWSER||e.name()===process.env.MAILAI_BROWSER))await run(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
