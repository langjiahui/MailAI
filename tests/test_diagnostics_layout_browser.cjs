// Isolated UI fixture only; diagnostic streams never reach real mail/model services.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
const checks=['db','isolation','disk','backup','vault','imap','smtp','model','init'].map(id=>({id,name:id,status:'queued',probe:['imap','smtp','model'].includes(id)?'live':'local'}));
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1512,height:949},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(checks=>{
      const originalFetch=window.fetch;
      window.diagnosticRequests=0;
      window.fetch=(url,options)=>{
        if(!String(url).includes('/api/system/diagnostics/stream'))return originalFetch(url,options);
        window.diagnosticRequests++;
        const encoder=new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({start(controller){
          window.sendDiagnosticEvent=event=>controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'));
          window.closeDiagnosticStream=()=>controller.close();
          sendDiagnosticEvent({type:'plan',checks});
        }}),{headers:{'Content-Type':'application/x-ndjson'}}));
      };
    },checks);
    await page.goto('http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>{setI18nLanguage('zh-CN');applyTheme('light');showSystemView('maintenance');});
    const start=async()=>{
      if(await page.locator('#diagnostics-drawer').evaluate(n=>n.open)) await page.locator('#btn-rerun-diagnostics').click();
      else await page.locator('#btn-run-diagnostics').click();
      await page.waitForFunction(()=>document.querySelector('#diagnostic-results').getAttribute('aria-busy')==='true');
      await page.waitForFunction(()=>typeof window.sendDiagnosticEvent==='function');
    };
    const send=event=>page.evaluate(event=>sendDiagnosticEvent(event),event);
    const finish=async rows=>{
      await send({type:'done',data:{ok:!rows.some(r=>r.status==='fail'),checks:rows}});
      await page.evaluate(()=>closeDiagnosticStream());
      await page.waitForFunction(()=>document.querySelector('#diagnostic-results').getAttribute('aria-busy')==='false');
    };
    const passed=checks.map(row=>({...row,status:'pass',detail:row.id==='init'?'已完成 · 9/9':'结构与索引校验通过',duration_ms:300}));
    const originalCardHeight=await page.locator('.maintenance-diagnostics').evaluate(n=>n.getBoundingClientRect().height);
    await start();
    assert.equal(await page.locator('#diagnostic-results .diagnostic-item:visible').count(),0,'Queued checks must not fill the page');
    await send({type:'check',check:{...checks[0],status:'running',detail:'正在检查'}});
    await page.locator('[data-diagnostic-pending] [data-check-id=db]:visible').waitFor();
    await page.evaluate(()=>window.mailaiRunDiagnostics());
    assert.equal(await page.evaluate(()=>diagnosticRequests),1,'Do not start duplicate probes');
    await send({type:'check',check:passed[0]});
    await page.waitForFunction(()=>document.querySelector('[data-diagnostic-progress]').value===1);
    assert.equal(await page.locator('.diagnostic-passed').evaluate(n=>n.open),false);
    assert.equal(await page.locator('#btn-rerun-diagnostics').isEnabled(),false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#diagnostics-drawer').evaluate(n=>n.open),false);
    assert(await page.locator('[data-system-panel=maintenance]').isVisible(),'Escape must leave settings open');
    await finish(passed);
    assert.equal(await page.locator('.maintenance-diagnostics').evaluate(n=>n.getBoundingClientRect().height),originalCardHeight,'Results must not expand the maintenance card');
    await page.locator('#btn-view-diagnostics').click();
    assert.equal(await page.evaluate(()=>diagnosticRequests),1,'Viewing retained results must not start another probe');
    assert.equal(await page.locator('.diagnostic-overall').getAttribute('data-state'),'pass');
    assert.equal(await page.locator('.diagnostic-passed [data-check-id]').count(),9);
    assert.equal(await page.locator('#diagnostic-results .diagnostic-item:visible').count(),0);
    const elapsed=await page.locator('[data-diagnostic-summary]').textContent();
    fs.mkdirSync('build',{recursive:true});
    await page.locator('.diagnostic-passed summary').click();
    await page.waitForFunction(()=>document.querySelector('[data-diagnostic-toggle]').textContent==='收起详情');
    await page.screenshot({path:'build/diagnostics-drawer-light.png'});
    await page.locator('.diagnostic-passed summary').click();
    for(const language of ['en','zh-CN']) for(const theme of ['light','dark']) for(const width of [900,1512]) for(const scale of [1,1.3]){
      await page.setViewportSize({width,height:949});
      await page.evaluate(({language,theme,scale})=>{setI18nLanguage(language);applyTheme(theme);document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);},{language,theme,scale});
      const layout=await page.locator('#diagnostics-drawer').evaluate(drawer=>{
        const box=drawer.getBoundingClientRect(),card=document.querySelector('.maintenance-diagnostics').getBoundingClientRect(),importCard=document.querySelector('.client-import-card').getBoundingClientRect();
        const close=document.querySelector('#btn-close-diagnostics').getBoundingClientRect(),footer=document.querySelector('.diagnostics-drawer-footer').getBoundingClientRect();
        return {contained:box.x>=0&&box.right<=innerWidth+1&&box.top>=0&&box.bottom<=innerHeight+1,closeVisible:close.top>=box.top&&close.bottom<=box.bottom,footerVisible:footer.bottom<=box.bottom,aligned:Math.abs(card.top-importCard.top)>1||Math.abs(card.height-importCard.height)<1,overflow:[...drawer.querySelectorAll('h3,.diagnostic-overall-copy,.diagnostic-passed summary')].some(n=>n.scrollWidth>n.clientWidth+1)};
      });
      assert(layout.contained&&layout.closeVisible&&layout.footerVisible&&layout.aligned&&!layout.overflow,JSON.stringify({language,theme,width,scale,layout}));
      for(let step=0;step<8;step++){
        await page.keyboard.press('Tab');
        assert(await page.evaluate(()=>document.activeElement===document.body||document.querySelector('#diagnostics-drawer').contains(document.activeElement)),'Settings behind the modal must never receive keyboard focus');
      }
      await page.locator('.diagnostic-passed summary').focus();await page.keyboard.press('Enter');
      assert.equal(await page.locator('.diagnostic-passed').evaluate(n=>n.open),true);
      const body=await page.locator('#diagnostic-results').evaluate(n=>({height:n.clientHeight,scroll:n.scrollHeight,width:n.clientWidth,scrollWidth:n.scrollWidth,overflow:getComputedStyle(n).overflowY}));
      assert(body.height>0&&body.scroll>=body.height&&body.scrollWidth<=body.width+1&&body.overflow==='auto','The drawer should own vertical scrolling without horizontal overflow');
      await page.locator('.diagnostic-passed summary').click();
    }
    assert.equal(await page.locator('[data-diagnostic-summary]').textContent(),elapsed,'Language switching must not change the recorded duration');
    await page.setViewportSize({width:1512,height:949});
    await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement.id==='btn-view-diagnostics');
    await page.evaluate(()=>applyTheme('light'));
    await page.screenshot({path:'build/maintenance-aligned-light.png'});
    await page.evaluate(()=>applyTheme('dark'));
    await start();
    const mixed=passed.map(row=>row.id==='model'?{...row,status:'fail',issue:'authentication',detail:'模型认证失败，请核对授权码或 API Key'}:row.id==='backup'?{...row,status:'warning',detail:'尚无近期自动备份；软件运行时会定期尝试，空间不足时请手动备份'}:row);
    await finish(mixed);
    assert.equal(await page.locator('.diagnostic-overall').getAttribute('data-state'),'fail');
    assert.equal(await page.locator('[data-check-id=init] small').textContent(),'已完成 · 9/9');
    assert.equal(await page.locator('[data-diagnostic-attention] .diagnostic-item').first().getAttribute('data-check-id'),'model');
    assert.equal(await page.locator('[data-diagnostic-attention] .diagnostic-item:visible').count(),2);
    await page.locator('[data-check-id=model] .diagnostic-help summary').click();
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.equal(await page.locator('[data-check-id=model] .diagnostic-help').evaluate(n=>n.open),true);
    assert.equal(await page.locator('[data-check-id=init] small').textContent(),'Completed · 9/9');
    assert(!/[\u3400-\u9fff]/.test(await page.locator('#diagnostic-results').innerText()));
    assert.equal(await page.locator('#btn-run-diagnostics').textContent(),'Start check','Finishing a check must retain the translatable button label');
    assert(!/[\u3400-\u9fff]/.test(await page.locator('.maintenance-grid').innerText()),'Maintenance copy should update when switching languages');
    await page.screenshot({path:'build/diagnostics-attention-dark.png'});
    await page.evaluate(()=>document.querySelector('#backup-list').insertAdjacentHTML('beforeend',renderBackupItem({created_at:'invalid',filename:'用户备份.zip',size:1024},0)));
    for(const language of ['zh-CN','en']){
      await page.evaluate(language=>setI18nLanguage(language),language);
      const labels=await page.locator('.backup-record-actions').innerText();
      const aria=await page.locator('.backup-record-actions button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')).join(' '));
      assert.equal(/[\u3400-\u9fff]/.test(labels+aria),language==='zh-CN','Backup labels and accessible names must follow the current language');
      assert.equal(await page.locator('.backup-record-copy small').textContent(),'用户备份.zip','User filenames must remain intact');
    }
    await page.locator('[data-check-id=model] [data-diagnostic-target=ai]').click();
    assert.equal(await page.locator('#diagnostics-drawer').evaluate(n=>n.open),false);
    await page.waitForFunction(()=>document.activeElement.id==='model-base-url');
    assert(await page.locator('[data-system-panel=ai]').isVisible(),'Advice should open the model settings');
    await page.evaluate(()=>showSystemView('maintenance'));
    await start();
    await send({type:'check',check:passed[0]});
    await page.evaluate(()=>closeDiagnosticStream());
    await page.waitForFunction(()=>document.querySelector('#diagnostic-results').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('.diagnostic-overall').getAttribute('data-state'),'interrupted');
    assert.equal(await page.locator('.diagnostic-passed [data-check-id]').count(),1);
    assert.equal(await page.locator('[data-diagnostic-attention] .interrupted').count(),8);
    assert.match(await page.locator('[data-diagnostic-summary]').textContent(),/1\/9/);
    assert.equal(await page.locator('#btn-run-diagnostics').isEnabled(),true);
    await start();await finish(passed);
    assert.equal(await page.locator('.diagnostic-attention').isVisible(),false,'A fresh run must clear old errors');
    await page.mouse.click(40,200);
    assert.equal(await page.locator('#diagnostics-drawer').evaluate(n=>n.open),false,'Clicking the backdrop should close the drawer');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    assert.deepEqual(errors,[]);
    console.log('PASS diagnostics drawer: live progress, folded passes, prioritized issues, drawer scrolling, retry, interruption, language switching and responsive themes');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
