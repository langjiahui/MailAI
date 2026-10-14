// Isolated growth fixture: palette changes must never rewrite outgoing signatures.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
  await page.route(/\/api\/emails\/\d+(?:\?.*)?$/,async route=>{
   const response=await route.fetch(),mail=await response.json();
   await route.fulfill({json:{...mail,score:5,verdict:'clean',findings:[{title:'发件域名缺少代发保护',explanation:'发件域名未发布 SPF 记录，请结合上下文核对身份。',code:'DNS_SPF',weight:5}],sender_profile:{sender_key:'sender@example.test',first_seen:'2026-10-10T08:53:00',message_count:57,common_hours:[8,9],typical_categories:[],attachment_types:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']}}});
  });
  await page.goto('http://127.0.0.1:18795/?shell=macos');await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.locator('.email-item').first().click();await page.locator('.reading-subject').waitFor({state:'visible'});
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
  console.log('Evidence risk states, help-write hover/focus/active and signature display/payload passed in six palettes');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
