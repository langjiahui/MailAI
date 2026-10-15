// Temporary mailbox fixture only; all update checks are mocked, no install runs.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
 const p=await browser.newPage({viewport:{width:1512,height:1000},reducedMotion:'reduce'});const errors=[];let forced=0,available=false,published='2026-10-15T00:30:00Z';
 const notes='优化设置与邮件交互。\nResponsive layouts, theme palettes and bilingual controls.';
 p.on('pageerror',e=>errors.push(e.message));
 await p.route(/\/api\/system\/update(?:\?.*)?$/,r=>{if(r.request().url().includes('force=true'))forced++;return r.fulfill({json:{current_version:'2.8.15',latest_version:available?'2.8.16':'2.8.15',device:'macos-arm64',supported:true,available,installable:false,notes,published_at:published,release_url:'https://github.com/langjiahui/MailAI/releases/tag/v2.8.15'}})});
 await p.goto('http://127.0.0.1:18795/?shell=macos');await p.locator('#app-preloader').waitFor({state:'detached'});await p.evaluate(()=>initialLoad);
 assert(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
 await p.evaluate(async()=>{for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh();showSystemView('about');});
 await p.waitForFunction(()=>document.getElementById('app-version-label').textContent==='MailAI 2.8.15');
 const out='build/about-overview-preview';fs.mkdirSync(out,{recursive:true});let checked=0;
 for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const language of ['zh-CN','en'])for(const[width,height,scale]of[[390,844,1],[720,844,1.25],[900,640,1.25],[1512,1000,1],[1920,1080,1.25],[2560,1080,1],[3440,1080,1]]){
  await p.setViewportSize({width,height});
  await p.evaluate(async({theme,mode,language,scale})=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();applyTheme(mode);setI18nLanguage(language);selectSystemTab('about');document.querySelector('.author-page').scrollTop=0;},{theme,mode,language,scale});
  const context={theme,mode,language,width,height,scale};
  const metrics=await p.locator('.author-page').evaluate(panel=>{const r=panel.getBoundingClientRect();return{overflow:panel.scrollWidth>panel.clientWidth+2,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,bad:[...panel.querySelectorAll('.about-overview,.author-hero,.app-update-card,.about-data,.author-trust-card,button,a')].filter(n=>n.getClientRects().length).filter(n=>{const b=n.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1||(!n.matches('.author-logo')&&n.scrollWidth>n.clientWidth+2)}).map(n=>n.id||n.className),cta:document.getElementById('btn-check-update').getBoundingClientRect().bottom,versionFirst:document.querySelector('.app-update-card').getBoundingClientRect().top<document.querySelector('.about-data').getBoundingClientRect().top};});
  assert(!metrics.overflow&&!metrics.pageOverflow&&!metrics.bad.length&&metrics.versionFirst,JSON.stringify({context,metrics}));
  assert(metrics.cta<=height+1,JSON.stringify({context,metrics,message:'Check updates is reachable on the first screen'}));
  assert.match(await p.locator('#app-device-label').textContent(),language==='en'?/Apple Silicon/i:/Apple 芯片/,'Resolved device must survive translation updates');
  assert.equal(await p.locator('.author-trust-card').count(),3);
  assert.equal(await p.locator('#app-update-status').getAttribute('data-update-state'),'latest');
  assert.match(await p.locator('#app-update-status').textContent(),language==='en'?/latest/i:/最新/);
  assert(await p.locator('#app-release-date-meta').isVisible());
  assert.equal(await p.locator('#app-release-date').getAttribute('datetime'),published.replace('Z','.000Z'));
  assert.match(await p.locator('#app-release-date').textContent(),language==='en'?/Oct/:/10月/);
  assert.equal(await p.locator('.author-links a').getAttribute('href'),'https://github.com/langjiahui/MailAI/issues');
  assert((await p.locator('[data-i18n="about.t3Copy"]').textContent()).includes(language==='en'?'Automatic analysis':'自动分析'));
  assert(!(await p.locator('#app-release-summary').evaluate(n=>n.open)));
  if((['','theme_monochrome'].includes(theme)&&mode==='light'&&language==='zh-CN'&&width===1512)||(theme==='theme_baowu'&&mode==='dark'&&language==='en'&&[390,2560].includes(width)))await p.screenshot({path:`${out}/${theme}-${mode}-${language}-${width}-${process.env.MAILAI_BROWSER||'chromium'}.png`});checked++;
 }
 await p.setViewportSize({width:1512,height:1000});await p.evaluate(()=>{document.body.style.zoom=1;document.documentElement.style.setProperty('--fz',1);document.querySelector('.author-page').scrollTop=0;});
 await p.locator('#app-release-summary>summary').focus();await p.keyboard.press('Enter');await p.waitForFunction(()=>document.getElementById('app-release-summary').open);
 assert.equal(await p.locator('#app-release-summary-notes').textContent(),notes);
 await p.locator('#btn-check-update').click();await p.waitForFunction(()=>!document.getElementById('btn-check-update').disabled);
 assert.equal(forced,1);assert(await p.locator('#app-release-summary').evaluate(n=>n.open),'Refreshing version info preserves an expanded release note');
 published='invalid-date';available=true;await p.locator('#btn-check-update').click();await p.locator('#update-dialog').waitFor({state:'visible'});assert.match(await p.locator('#update-dialog-title').textContent(),/2.8.15.*2.8.16/);await p.keyboard.press('Escape');
 assert.equal(forced,2);assert(!await p.locator('#app-release-date-meta').isVisible());assert.equal(await p.locator('#app-update-status').getAttribute('data-update-state'),'available');assert(!await p.locator('#btn-check-update').isDisabled());
 await p.locator('#btn-share-app').click();await p.locator('#share-app-dialog').waitFor({state:'visible'});await p.keyboard.press('Escape');
 await p.locator('[data-about-target="guide"]').click();assert.equal(await p.locator('#system-tabs [aria-current="page"]').getAttribute('data-system-tab'),'guide');
 await p.evaluate(()=>selectSystemTab('about'));
 for(const result of [
  {current_version:'2.8.15',latest_version:'2.8.15',device:'macos-arm64',development:true,supported:false,available:false},
  {current_version:'2.8.15',latest_version:'2.8.16',device:'linux-arm64',supported:false,available:false,published_at:'invalid-date'},
 ]) {
  await p.evaluate(result=>renderAppVersion(result),result);
  assert.equal(await p.locator('#app-update-status').getAttribute('data-update-state'),'neutral');
  assert(!await p.locator('#app-release-date-meta').isVisible());
  assert(!await p.locator('#app-release-summary').isVisible());
  assert(!/latest|最新/.test(await p.locator('#app-update-status').textContent()));
 }
 assert.deepEqual(errors,[]);console.log(`PASS ${checked} About layouts across six palettes, two languages, 390–3440px and 125%; device label, release disclosure, update dialog, share and help actions (${process.env.MAILAI_BROWSER||'chromium'}).`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
