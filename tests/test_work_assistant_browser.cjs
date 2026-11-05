// Uses synthetic fixture data only. Both engines run through the same flows.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium, webkit} = require('playwright');
const fs = require('node:fs');
const port = Number(process.env.MAILAI_WORK_FIXTURE_PORT || 18833), base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.env.MAILAI_FIXTURE_PYTHON || '.venv-build/bin/python', ['tests/workspace_preview.py'], {
  env:{...process.env, MAILAI_FIXTURE_PORT:String(port), MAILAI_PROGRESS_FIXTURE:'1', MAILAI_MEMORY_FIXTURE:'1'}, stdio:['ignore','pipe','pipe']
});
let log=''; fixture.stdout.on('data',chunk=>log+=chunk); fixture.stderr.on('data',chunk=>log+=chunk);
(async () => {
  let ready=false;
  for(let n=0;n<150;n++) {
    if(fixture.exitCode!==null) throw new Error(log);
    try { ready=(await fetch(base+'/api/health')).ok; } catch (_) {}
    if(ready) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(ready,log);
  const engine=process.env.MAILAI_BROWSER==='webkit'?webkit:chromium;
  const browser=await engine.launch();
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const requests=[],writes=[];page.on('request',request=>{requests.push(request.url());if(request.method()==='POST')writes.push(request.url());});
    await page.goto(base);await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('.email-item').first().click();
    await page.waitForFunction(()=>selectedEmailDetail?.id && document.querySelector('.reading-header'));
    assert.equal(await page.locator('#reading-content .work-card,[data-work-toggle],[data-reading-action="work"]').count(),0,'Reading has no duplicated work surface');
    assert(!requests.some(url=>url.includes('/api/work/')||url.includes('/api/assistant/ask')),'Reading does not load memory or call AI');
    const firstId=await page.evaluate(()=>Number(selectedEmailDetail.id));
    await page.locator('[data-reading-action="ask"]').click();
    const panel=page.locator('#assistant-panel');await panel.waitFor({state:'visible'});
    const guide=panel.locator('.assistant-welcome .assistant-quick');
    assert.equal(await guide.locator('[data-assistant-question]').count(),2,'Offer conversational starters, not a tool dashboard');
    assert.equal(await guide.locator('[data-work-action]').count(),0);
    assert.equal(await page.locator('#assistant-scope-label').textContent(),await page.evaluate(()=>selectedEmailDetail.subject));
    assert(!requests.some(url=>url.includes('/api/work/')||url.includes('/api/assistant/ask')),'Opening XiaoYou is lazy');
    await page.evaluate(()=>{_systemConfig.model.available=true;_systemConfig.model.verified=true;});
    let guidedRequest;
    await page.route('**/api/assistant/ask-stream',route=>{
      guidedRequest=route.request().postDataJSON();
      return route.fulfill({contentType:'application/x-ndjson',body:[
        {type:'sources',sources:[{id:firstId,subject:'原邮件',from_addr:'colleague@example.test'}]},
        {type:'delta',content:'我们先核对需要确认的排期。你现在倾向于怎样回应？'},
        {type:'done'}].map(event=>JSON.stringify(event)+'\n').join('')});
    });
    await guide.locator('[data-assistant-question]').last().click();
    await page.waitForFunction(()=>document.querySelectorAll('.assistant-message.user').length===1&&!assistantController);
    assert.deepEqual(guidedRequest.email_ids,[firstId]);assert.match(guidedRequest.question,/先聊聊/);
    assert.match(await panel.locator('.assistant-message.bot').last().textContent(),/怎样回应/);
    assert.equal(await page.locator('.assistant-action-card').count(),0,'Discussion does not prematurely propose execution');
    await page.unroute('**/api/assistant/ask-stream');
    const chat=async text=>{
      const count=await panel.locator('.assistant-message.user').count();
      await page.locator('#assistant-input').fill(text);await page.locator('#assistant-send').click();
      await page.waitForFunction(n=>document.querySelectorAll('.assistant-message.user').length>n&&!assistantController,count);
    };
    const memoryCard=()=>panel.locator('.work-memory-confirm').last();
    const prefs=()=>page.evaluate(()=>api('/api/work/preferences',{accountId:activeMailAccount()?.id}));
    const context=()=>page.evaluate(id=>api(`/api/work/emails/${id}`,{accountId:activeMailAccount()?.id}),firstId);
    await chat('我负责排期协调，帮我记住');
    assert.equal((await context()).context.length,0,'Statements remain unpersisted until confirmation');
    await memoryCard().locator('[data-action-dismiss]').click();
    assert.equal((await context()).context.length,0,'Cancellation preserves existing records');
    await chat('我负责排期协调，帮我记住');
    await memoryCard().locator('[data-action-confirm]').click();
    await memoryCard().locator('.assistant-action-result').waitFor();
    assert((await context()).context.some(row=>row.note.includes('我负责排期协调')));
    assert.equal((await prefs()).style,'','Matter facts are not personal writing preferences');
    await chat('以后回信简短一点');
    assert.equal((await prefs()).style,'');
    await page.route('**/api/assistant/actions/execute',route=>route.fulfill({status:503,json:{detail:'模拟保存失败'}}),{times:1});
    await memoryCard().locator('[data-action-confirm]').click();
    await memoryCard().locator('[data-memory-error]').filter({hasText:'模拟保存失败'}).waitFor();
    assert(!await memoryCard().locator('[data-action-confirm]').isDisabled(),'Failed saves can be retried without losing the proposal');
    await memoryCard().locator('[data-action-confirm]').click();await memoryCard().locator('.assistant-action-result').waitFor();
    assert.match((await prefs()).style,/以后回信简短一点/);
    await chat('记住我长期负责采购协调，不负责审批');
    await memoryCard().locator('[data-action-confirm]').click();await memoryCard().locator('.assistant-action-result').waitFor();
    assert(!/采购协调/.test((await prefs()).style),'Personal role facts stay separate from writing instructions');
    await chat('记住我平时希望小邮沟通时一次只问一个问题');
    // Keep the last statement unconfirmed, then review it through settings analysis.
    await memoryCard().locator('[data-action-dismiss]').click();
    await page.locator('#assistant-close').click();
    const openSettings=async()=>{
      if(!await page.locator('#system-view').isVisible())await page.locator('#btn-preferences').click();
      if(!await page.locator('#work-style-settings').isVisible())await page.locator('[data-system-tab="xiaoyou"]').click();
      await page.locator('#work-style-settings').click();await page.locator('#work-preferences-dialog').waitFor();
      await page.waitForFunction(()=>!document.querySelector('#work-preferences-dialog [name="style"]').disabled);
    };
    await openSettings();
    const dialog=page.locator('#work-preferences-dialog'), style=dialog.locator('[name="style"]');
    assert.equal(await dialog.locator('[name="project"],[name="role"],[name="note"]').count(),0,'Personal settings do not combine matter-specific fields');
    assert.match(await style.inputValue(),/以后回信简短一点/);
    await style.fill('结论在前，简洁自然 <b>原文</b>');
    await page.route('**/api/work/preferences',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{detail:'模拟偏好保存失败'}}):route.continue(),{times:1});
    await dialog.locator('[type="submit"]').click();await dialog.locator('[data-status]').filter({hasText:'模拟偏好保存失败'}).waitFor();
    assert.equal(await style.inputValue(),'结论在前，简洁自然 <b>原文</b>');
    await dialog.locator('[type="submit"]').click();await dialog.locator('[data-status]').filter({hasText:'已保存'}).waitFor();
    assert.equal((await prefs()).style,'结论在前，简洁自然 <b>原文</b>');
    assert.equal(await dialog.locator('textarea b').count(),0);
    await page.route('**/api/work/memory/analyze',route=>route.fulfill({status:503,json:{detail:'模拟分析失败'}}),{times:1});
    await dialog.locator('[data-analyze]').click();await dialog.locator('[data-status]').filter({hasText:'模拟分析失败'}).waitFor();
    await dialog.locator('[data-analyze]').click();
    await dialog.locator('.work-memory-item').filter({hasText:'沟通时一次只问一个问题'}).waitFor();
    const candidate=dialog.locator('.work-memory-item').filter({hasText:'沟通时一次只问一个问题'});
    await candidate.locator('summary').click();assert.match(await candidate.locator('blockquote').textContent(),/我平时希望小邮/);
    await candidate.locator('[data-memory-action="adopt"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-memory-list]').textContent.includes('还没有待确认'));
    await dialog.locator('[data-memory-status="adopted"]').click();
    const adopted=dialog.locator('.work-memory-item').filter({hasText:'沟通时一次只问一个问题'});await adopted.waitFor();
    await adopted.locator('[data-memory-action="edit"]').click();
    assert(await style.isDisabled(),'Editing a memory protects unrelated preference drafts');
    assert(await dialog.locator('[data-memory-status="pending"]').isDisabled(),'Changing views cannot discard a memory edit');
    await adopted.locator('[data-memory-editor] textarea').fill('沟通时先说结论，每次最多追问一点');
    await adopted.locator('[data-memory-action="save"]').click();
    const changed=dialog.locator('.work-memory-item').filter({hasText:'沟通时先说结论，每次最多追问一点'});await changed.waitFor();
    assert.equal((await prefs()).style,'结论在前，简洁自然 <b>原文</b>','Communication memory does not alter mail writing defaults');
    await changed.locator('[data-memory-action="dismiss"]').click();await changed.waitFor({state:'detached'});
    assert(await dialog.locator('.work-memory-item').filter({hasText:'长期负责采购协调'}).isVisible());
    await dialog.locator('[data-work="clear"]').click();await dialog.locator('[type="submit"]').click();
    await dialog.locator('[data-status]').filter({hasText:'已保存'}).waitFor();assert.equal((await prefs()).style,'');
    assert((await context()).context.some(row=>row.note.includes('我负责排期协调')),'Clearing writing preferences preserves matter context');
    await dialog.locator('[data-close]').click();
    const useMemory=page.locator('[data-memory-enabled]'),autoMemory=page.locator('[data-memory-auto]');
    await page.waitForFunction(()=>!document.querySelector('[data-memory-enabled]').disabled);
    assert(await useMemory.isChecked());assert(!await autoMemory.isChecked(),'Background analysis starts disabled');
    await page.locator('[data-memory-summary]').filter({hasText:'长期负责采购协调'}).waitFor();
    assert.match(await page.locator('[data-memory-summary]').textContent(),/长期负责采购协调/);
    await useMemory.uncheck();
    await page.waitForFunction(()=>document.querySelector('[data-memory-auto]').disabled&&!document.querySelector('[data-memory-enabled]').disabled);
    const disabledAnalysis=await page.evaluate(()=>api('/api/work/memory/analyze',{accountId:activeMailAccount()?.id,method:'POST'}));
    assert.equal(disabledAnalysis.analyzed,0);
    await useMemory.check();await page.waitForFunction(()=>!document.querySelector('[data-memory-auto]').disabled);
    await autoMemory.check();await page.waitForFunction(()=>!document.querySelector('[data-memory-enabled]').disabled);
    assert((await page.evaluate(()=>api('/api/work/memory/settings',{accountId:activeMailAccount()?.id}))).auto_analyze);
    await page.locator('[data-memory-clear]').click();assert(await page.locator('[data-memory-clear-confirm]').isVisible());
    await page.locator('[data-memory-clear-no]').click();assert.match(await page.locator('[data-memory-summary]').textContent(),/采购协调/);
    await page.locator('[data-memory-clear]').click();await page.locator('[data-memory-clear-yes]').click();
    await page.locator('[data-memory-control-status]').filter({hasText:'已清除'}).waitFor();
    assert(!(await page.locator('[data-memory-summary]').textContent()).includes('采购协调'));
    assert((await context()).context.some(row=>row.note.includes('我负责排期协调')),'Clearing account memory preserves matter context');
    if(await page.locator('#system-view').isVisible())await page.locator('#btn-close-system').click();
    await page.evaluate(async()=>{await composeFromEmail('reply');toggleComposeAiPanel(true);});
    await page.locator('#compose-ai-panel').waitFor({state:'visible'});
    assert(await page.locator('#work-use-preferences').isChecked());
    const editor=page.locator('#compose-message');
    await page.evaluate(()=>{composeMessageElement().innerText='收到，详见附件。';composeAttachments=[];});
    await page.route('**/api/work/review',async route=>{
      const payload=route.request().postDataJSON();assert(payload.body.includes('详见附件'));
      await route.fulfill({json:{items:[{kind:'attachment',question:'',note:'正文提及附件，目前没有添加附件。'}],model_used:true,limited:true}});
    });
    await page.locator('[data-work="review"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-work-review]').textContent.includes('没有添加附件'));
    assert.match(await page.locator('[data-work-review]').textContent(),/只核对了部分内容/);
    assert.equal(await page.evaluate(()=>composeMessageElement().innerText),'收到，详见附件。','Review must not change the draft');
    await page.evaluate(()=>{composeAttachments=[{filename:'排期.xlsx',size:10}];renderComposeAttachments();});
    await page.waitForFunction(()=>document.querySelector('[data-work-review]').textContent.includes('已修改'));
    // A late model response cannot be applied to an edited draft.
    await page.unroute('**/api/work/review');
    let respond, intercepted;
    const readyReview = new Promise(resolve=>{intercepted=resolve;});
    await page.route('**/api/work/review',route=>new Promise(resolve=>{assert.deepEqual(route.request().postDataJSON().attachment_names,['排期.xlsx']);respond=async()=>{await route.fulfill({json:{items:[],model_used:true}});resolve();};intercepted();}));
    await page.locator('[data-work="review"]').click();
    await readyReview;
    await page.evaluate(()=>composeMessageElement().innerText='新正文');
    await respond();
    await page.waitForFunction(()=>document.querySelector('[data-work-review]').textContent.includes('已修改'));
    await page.evaluate(()=>hideCompose());
    await page.evaluate(()=>window.mailaiPrepareFollowup(1,activeMailAccount()?.id));
    await page.locator('#compose-ai-panel').waitFor({state:'visible'});
    assert.match(await page.locator('#compose-ai-instruction').inputValue(),/跟进/);
    const expectedMessage = await page.evaluate(async()=> (await api('/api/mail/sent/1',{accountId:activeMailAccount()?.id})).message_id);
    assert.equal(await page.evaluate(()=>composeContext.in_reply_to),expectedMessage);
    assert(!writes.some(url=>url.endsWith('/api/mail/send')||url.endsWith('/api/mail/outbox')),'Assistance must not submit a send');
    await page.evaluate(()=>hideCompose());
    // Settings memory stays readable across themes, languages, windows and 200% text.
    fs.mkdirSync('output/work-assistant',{recursive:true});
    let layouts=0;
    for(const theme of ['','theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const language of ['zh-CN','en']){
      await page.setViewportSize({width:1440,height:1000});
      await page.evaluate(({theme,mode,language})=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');document.documentElement.dataset.rewardTheme=theme;applyTheme(mode);setI18nLanguage(language);},{theme,mode,language});
      await openSettings();
      if(language==='en')assert.equal(await dialog.locator('h2').textContent(),'XiaoYou memory');
      for(const [width,height,scale]of[[390,844,1],[390,844,2],[780,844,1.3],[780,844,2],[1440,1000,1],[1440,1000,1.3],[1440,1000,2]]){
        await page.setViewportSize({width,height});await page.evaluate(scale=>{document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale));},scale);
        const bounds=await dialog.evaluate(n=>({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,width:n.getBoundingClientRect().width,vw:innerWidth,vh:innerHeight,overflow:n.scrollWidth-n.clientWidth}));
        assert(bounds.top>=-1&&bounds.bottom<=bounds.vh+1&&bounds.width<=bounds.vw&&bounds.overflow<=2,JSON.stringify({theme,mode,language,width,scale,bounds}));layouts++;
      }
      await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');});
      if(mode==='light')await page.screenshot({path:`output/work-assistant/memory-${process.env.MAILAI_BROWSER||'chromium'}-${theme}-${language}.png`});
      await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
    }
    assert.equal(layouts,84);
    assert(!writes.some(url=>url.endsWith('/api/mail/send')||url.endsWith('/api/mail/outbox')),'Conversation and memory never send mail');
    assert.deepEqual(errors,[]);
    console.log('PASS conversational XiaoYou: clean reader, scoped discussion, confirmed matter/personal memory, learning evidence, settings edit/stop-use, review, failure retry and 84 layouts');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fixture.kill('SIGTERM'));
