// Uses synthetic fixture data only. Both engines run through the same flows.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium, webkit} = require('playwright');
const fs = require('node:fs');
const port = 18833, base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.env.MAILAI_FIXTURE_PYTHON || '.venv-build/bin/python', ['tests/workspace_preview.py'], {
  env:{...process.env, MAILAI_FIXTURE_PORT:String(port), MAILAI_PROGRESS_FIXTURE:'1'}, stdio:['ignore','pipe','pipe']
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
    const card=page.locator('.work-card[data-work-email]');await card.waitFor();
    assert(!requests.some(url=>url.includes('/api/work/emails/')),'Opening mail must not eagerly load the work graph');
    await card.locator('[data-work="load"]').click();
    await card.locator('[data-work="memory"]').waitFor();
    await page.route('**/api/work/emails/*',route=>route.fulfill({status:503,json:{detail:'模拟读取失败'}}),{times:1});
    await card.locator('[data-work="refresh"]').click();
    await card.locator('[data-work-content] [role="status"]').waitFor();
    await card.locator('[data-work="refresh"]').click();
    await card.locator('[data-work="memory"]').waitFor();
    assert(!requests.some(url=>url.includes('/api/assistant/ask')||url.includes('/compose/assist')),'Local work overview must not request AI');
    await card.locator('[data-work="memory"]').click();
    const dialog=page.locator('dialog.work-dialog');await dialog.waitFor();
    await dialog.locator('[name="project"]').fill('ERP 项目 <b>原文</b>');
    await dialog.locator('[name="role"]').fill('排期协调');
    await dialog.locator('[name="note"]').fill('等待实施人员名单');
    await dialog.locator('[name="style"]').fill('结论在前，简洁自然');
    await dialog.locator('[type="submit"]').click();await dialog.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.querySelector('[data-work-content]')?.textContent.includes('ERP 项目'));
    assert.equal(await card.locator('article b').textContent(),'ERP 项目 <b>原文</b>');
    assert.equal(await card.locator('article b b').count(),0,'User memory must be escaped');
    await card.locator('[data-work="reply"]').click();
    await page.locator('#compose-ai-panel').waitFor({state:'visible'});
    assert(await page.locator('#work-use-preferences').isChecked(),'Saved writing preferences apply by default and can be disabled');
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
    // Reading and editing layouts in three themes, two languages and narrow/large text.
    fs.mkdirSync('output/work-assistant',{recursive:true});
    for(const theme of ['','theme_monochrome','theme_baowu']) {
      for(const language of ['zh-CN','en']) {
        await page.evaluate(({theme,language})=>{document.documentElement.dataset.rewardTheme=theme;setI18nLanguage(language);},{theme,language});
        if(language==='en') assert(!/[\u3400-\u9fff]/.test(await card.locator('[data-work-content]>p').first().textContent()),'Work status must use the selected interface language');
        await page.setViewportSize({width:language==='en'?780:1440,height:1000});
        await card.locator('[data-work="memory"]').click();await dialog.waitFor();
        await page.evaluate(()=>Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
        const overflow=await dialog.evaluate(node=>node.scrollWidth>node.clientWidth+2);
        assert(!overflow,`${theme}/${language}: work dialog overflows`);
        await page.screenshot({path:`output/work-assistant/${process.env.MAILAI_BROWSER||'chromium'}-${theme}-${language}.png`});
        await dialog.locator('[data-close]').click();
      }
    }
    let layouts=0;
    for(const theme of ['','theme_monochrome','theme_baowu']) for(const mode of ['light','dark']) for(const language of ['zh-CN','en']) {
      await page.setViewportSize({width:1440,height:1000});
      await page.evaluate(({theme,mode,language})=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');document.documentElement.dataset.rewardTheme=theme;applyTheme(mode);setI18nLanguage(language);},{theme,mode,language});
      await card.locator('[data-work="memory"]').click();await dialog.waitFor();
      for(const [width,height,scale] of [[390,844,1],[780,844,1.3],[1440,1000,1],[1440,1000,1.3]]) {
        await page.setViewportSize({width,height});
        await page.evaluate(scale=>{document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale));},scale);
        const metrics=await dialog.evaluate(node=>({overflow:node.scrollWidth-node.clientWidth,width:node.getBoundingClientRect().width,viewport:innerWidth}));
        assert(metrics.overflow<=2 && metrics.width<=metrics.viewport,JSON.stringify({theme,mode,language,width,scale,metrics}));
        layouts++;
      }
      await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');});
      await dialog.locator('[data-close]').click();
    }
    assert.equal(layouts,48);
    assert.deepEqual(errors,[]);
    console.log('PASS work assistance UI: lazy reads, persisted escaped context, reply handoff, advisory review, stale response and theme/language layouts');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fixture.kill('SIGTERM'));
