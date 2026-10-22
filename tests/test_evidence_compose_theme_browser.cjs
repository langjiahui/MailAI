// Isolated growth fixture: palette changes must never rewrite outgoing signatures.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
  await page.route(/\/api\/emails\/\d+(?:\?.*)?$/,async route=>{
   const response=await route.fetch(),mail=await response.json();
   await route.fulfill({json:{...mail,score:5,verdict:'clean',findings:[{title:'发件域名缺少代发保护',explanation:'example.test 没有公开允许哪些服务器代发邮件（SPF），因此更难排除地址被冒用的可能。',technical_detail:'发件域 example.test 未配置 SPF',code:'DNS_SPF',weight:5}],evidence_summary:{dimension_count:1,signal_count:1,dimensions:[{name:'发件身份',count:1,weight:5,evidence:['发件域 example.test 未配置 SPF']}]},attachment_analysis:[{name:'风险线索概览 {0} <b>原文件</b>.xls',sha256:'a'.repeat(64),real_type:'OLE document (doc/xls/ppt)',has_macro:false,findings:[]}],llm_reasons:['保留模型原始分析 {0} <b>不改写</b>'],sender_profile:{sender_key:'sender@example.test',first_seen:'2026-10-10T08:53:00',message_count:57,common_hours:[8,9],typical_categories:['项目工作'],attachment_types:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']}}});
  });
  await page.goto('http://127.0.0.1:18795/?shell=macos');await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.locator('.email-item').first().click();await page.locator('.reading-subject').waitFor({state:'visible'});
  // The analysis panel is moved outside the reading pane. All of its generated
  // labels must follow language changes without remounting the message body.
  await page.evaluate(()=>{
   setI18nLanguage('zh-CN');toggleSecurityAnalysis(true);
   window.evidencePanelBefore=document.getElementById('security-analysis-panel');
   window.evidenceBodyBefore=document.querySelector('.body-section');
  });
  const auditPanel=async language=>{
   await page.evaluate(language=>setI18nLanguage(language),language);
   const result=await page.locator('#security-analysis-panel').evaluate(panel=>({
    title:panel.querySelector('h3').textContent,
    verdict:panel.querySelector('h4').textContent,
    gauge:panel.querySelector('.gauge-label').textContent,
    summary:panel.querySelector('.security-flyout-result p').textContent,
    ui:[...panel.querySelectorAll('[data-i18n],.info-grid,.evidence-dimension,.finding-copy,.section-title,.chain-final')].map(n=>n.textContent).join('\n'),
    tooltip:panel.querySelector('.finding-tech').title,
    filename:panel.querySelector('.att-analysis-name').textContent,
    unchangedReason:[...panel.querySelectorAll('.findings li')].some(n=>n.textContent==='保留模型原始分析 {0} <b>不改写</b>'),
    noMarkup:!panel.querySelector('.att-analysis-name b'),
    samePanel:panel===window.evidencePanelBefore,
    sameBody:document.querySelector('.body-section')===window.evidenceBodyBefore,
    open:!panel.classList.contains('hidden'),
   }));
   if(language==='en'){
    assert.equal(result.title,'Security result & evidence');assert.equal(result.verdict,'Clean');assert.equal(result.gauge,'Clean');
    assert(!/[\u3400-\u9fff]/.test(result.ui),JSON.stringify(result));
    assert.match(result.summary,/No obvious security risks/);
    assert(!/[\u3400-\u9fff]/.test(result.tooltip),result.tooltip);
   }else{
    assert.equal(result.title,'安全结果与证据');assert.equal(result.verdict,'正常');assert.equal(result.gauge,'正常');
    assert.match(result.ui,/风险线索概览/);assert.match(result.ui,/1 类线索 · 1 项发现/);
    assert.match(result.ui,/技术标识 DNS_SPF/);assert.match(result.ui,/发件人画像/);assert.match(result.ui,/57 封/);
    assert.match(result.summary,/暂未发现明显安全风险/);assert.match(result.tooltip,/未配置 SPF/);
    assert(!/Sender domain lacks|Sender identity|Technical identifier|Total risk score|No obvious security/.test(result.ui));
   }
   assert.equal(result.filename,'风险线索概览 {0} <b>原文件</b>.xls');
   assert(result.unchangedReason&&result.noMarkup&&result.samePanel&&result.sameBody&&result.open,JSON.stringify(result));
  };
  for(const language of ['en','zh-CN','en','zh-CN'])await auditPanel(language);
  await page.evaluate(()=>{
   document.querySelector('.security-flyout-head button').focus();
   document.querySelector('.security-analysis-grid').scrollTop=100;
   setI18nLanguage('en');
  });
  assert(await page.locator('.security-flyout-head button').evaluate(n=>n===document.activeElement),'Keep keyboard focus on the close button');
  assert.equal(await page.locator('.security-analysis-grid').evaluate(n=>n.scrollTop),100,'Keep analysis scroll position');
  await page.evaluate(()=>{toggleSecurityAnalysis(false);setI18nLanguage('zh-CN');toggleSecurityAnalysis(true)});
  assert.equal(await page.locator('#security-analysis-panel h3').textContent(),'安全结果与证据','Closed panels refresh before reopening');
  await page.evaluate(()=>toggleSecurityAnalysis(false));
  await page.evaluate(async()=>{for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh();setI18nLanguage('zh-CN');});
  async function contrast(selector){
   const values=await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>{
    const ctx=document.createElement('canvas').getContext('2d');
    const rgba=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
    const blend=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]/255+bg[i]*(1-fg[3]/255)).concat(255);
    const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const parents=[];for(let p=n;p;p=p.parentElement)parents.unshift(p);let bg=[255,255,255,255];for(const p of parents)bg=blend(rgba(getComputedStyle(p).backgroundColor),bg);
    const a=lum(rgba(getComputedStyle(n).color)),b=lum(bg);return{ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),text:n.textContent};
   }));
   assert(values.length,selector);assert(values.every(v=>v.ratio>=4.5),`${selector}: ${JSON.stringify(values)}`);
  }
  for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']){
   await page.evaluate(async({theme,mode})=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();applyTheme(mode);}, {theme,mode});
   await page.evaluate(()=>toggleSecurityAnalysis(true));
   const panel=page.locator('#security-analysis-panel');await panel.waitFor({state:'visible'});
   const surfaces=await panel.evaluate(n=>{const c=getComputedStyle(n),r=getComputedStyle(document.documentElement);return{bg:c.backgroundColor,palette:r.getPropertyValue('--desk-muted-surface').trim()};});
   assert(surfaces.bg!=='rgba(0, 0, 0, 0)');
   for(const state of ['success','warn','danger','muted']){
    await panel.locator('.security-flyout-result').evaluate((n,state)=>n.className='security-flyout-result security-'+state,state);
    await contrast('#security-analysis-panel h4,#security-analysis-panel .gauge-score,#security-analysis-panel .security-flyout-result p');
   }
   await contrast('#security-analysis-panel h3,#security-analysis-panel .finding-copy strong,#security-analysis-panel .finding-detail,#security-analysis-panel .finding-tech,#security-analysis-panel .finding-weight,#security-analysis-panel .info-label');
   await panel.locator('.security-flyout-result').evaluate(n=>n.className='security-flyout-result security-success');
   if(theme==='theme_monochrome')await panel.screenshot({path:`build/evidence-${mode}-preview.png`});
   await page.evaluate(()=>{toggleSecurityAnalysis(false);openCompose({to_addr:'recipient@example.test',subject:'主题检查',body_html:'<p>测试正文</p>'});renderComposeSignature('', '<div style="color:#33473e"><div>顺颂商祺</div><div style="width:36px;border-top:2px solid #3d8b6e"></div><div style="color:#214c3b;font-weight:700">测试姓名</div><p style="color:#60736a">开发工程师 · 产品部门</p><a href="mailto:sender@example.test" style="color:#28745a">sender@example.test</a><p style="color:#4b7565">以代码构建稳健</p></div>');});
   const body=await page.evaluate(()=>composeBodyHtml());
   const label=page.locator('#btn-compose-ai .compose-ai-label');
   await page.locator('#btn-compose-ai').hover();assert.equal(await label.evaluate(n=>getComputedStyle(n).opacity),'1');
   await contrast('#btn-compose-ai .compose-ai-label');
   await page.keyboard.press('Tab');await page.locator('#btn-compose-ai').focus();await contrast('#btn-compose-ai .compose-ai-label');
   await page.locator('#btn-compose-ai').click();await page.locator('#compose-ai-panel').waitFor({state:'visible'});
   assert.equal(await page.locator('#btn-compose-ai').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)');
   await contrast('#compose-signature-content div,#compose-signature-content p,#compose-signature-content a');
   assert.equal(await page.locator('#compose-signature-content a').getAttribute('href'),'mailto:sender@example.test');
   assert.equal(await page.evaluate(()=>composeBodyHtml()),body,'Theme CSS must preserve the original outgoing signature HTML');
   if(theme==='theme_monochrome')await page.screenshot({path:`build/compose-theme-${mode}-preview.png`});
   await page.evaluate(()=>closeCompose());
  }
  await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();});
  console.log('Evidence language round trips, original content, focus/scroll retention, risk states, help-write controls and signature payload passed in six palettes');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
