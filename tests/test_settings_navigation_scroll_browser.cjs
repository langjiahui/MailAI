// Isolated workspace_preview.py with MAILAI_REWARD_MOTION_FIXTURE=1 only.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1512,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:18795/?shell=macos');await page.locator('#app-preloader').waitFor({state:'detached'});
 await page.evaluate(()=>initialLoad);
 assert(await page.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
 await page.evaluate(async()=>{for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh();showSystemView('maintenance');});
 const out='build/settings-navigation-preview';fs.mkdirSync(out,{recursive:true});let checked=0;
 for(const theme of ['', 'theme_monochrome','theme_baowu']) for(const mode of ['light','dark']) for(const language of ['zh-CN','en']) for(const width of [390,1512,2560]){
  await page.setViewportSize({width,height:1000});
  await page.evaluate(async({theme,mode,language})=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();applyTheme(mode);setI18nLanguage(language);selectSystemTab('maintenance');window.dispatchEvent(new Event('blur'));},{theme,mode,language});
  const state=await page.evaluate(()=>{
   const panel=document.querySelector('[data-system-panel="maintenance"]'),nav=document.getElementById('system-tabs');
   return{bad:[...nav.querySelectorAll('button')].filter(n=>getComputedStyle(n).borderTopWidth!=='0px'||getComputedStyle(n).boxShadow!=='none').map(n=>n.dataset.systemTab),active:nav.querySelector('[aria-current="page"]').dataset.systemTab,indicator:getComputedStyle(nav.querySelector('.active'),'::after').content,overflow:document.documentElement.scrollWidth>innerWidth+1,nativeWidth:getComputedStyle(panel).scrollbarWidth,gutter:panel.offsetWidth-panel.clientWidth,color:getComputedStyle(panel).scrollbarColor,thumb:getComputedStyle(panel,'::-webkit-scrollbar-thumb').backgroundColor};
  });
  assert.deepEqual(state.bad,[],JSON.stringify({theme,mode,language,width,state}));assert.equal(state.active,'maintenance');assert.equal(state.indicator,'none');assert(!state.overflow);
  // A transparent computed color can still paint a gray native WKWebView thumb.
  assert.equal(state.nativeWidth,'none',JSON.stringify({theme,mode,language,width,state}));
  assert.equal(state.gutter,0,'Idle removes the native scrollbar itself');
  // Keep theme colors transparent as well for older engines.
  if(state.color)assert.equal(state.color,'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  if(state.thumb)assert.equal(state.thumb,'rgba(0, 0, 0, 0)');
  if((theme==='theme_monochrome'&&mode==='light'&&language==='zh-CN'&&width===1512)||(theme==='theme_baowu'&&mode==='dark'&&language==='en'&&[390,2560].includes(width)))await page.screenshot({path:`${out}/${theme}-${mode}-${language}-${width}-${process.env.MAILAI_BROWSER||'chromium'}.png`});checked++;
 }
 await page.setViewportSize({width:1512,height:760});await page.evaluate(()=>{selectSystemTab('maintenance');setI18nLanguage('zh-CN');window.dispatchEvent(new Event('blur'));});
 const panel=page.locator('[data-system-panel="maintenance"]');await panel.evaluate(n=>{n.scrollTop=0});await page.waitForFunction(()=>!document.querySelector('[data-system-panel="maintenance"]').classList.contains('scrollbar-visible'));
 const contentGeometry=()=>panel.evaluate(n=>{const r=n.firstElementChild.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}});
 const geometryBefore=await contentGeometry(),bounds=await panel.boundingBox();
 await page.mouse.move(bounds.x+100,bounds.y+100);await page.mouse.wheel(0,420);
 await page.waitForFunction(()=>{const n=document.querySelector('[data-system-panel="maintenance"]');return n.scrollTop>0&&n.classList.contains('scrollbar-visible')});
 assert.equal(await panel.evaluate(n=>getComputedStyle(n).scrollbarWidth),'thin');
 const geometryActive=await contentGeometry();
 assert(Math.abs(geometryActive.width-geometryBefore.width)<=1,'Revealing the native scrollbar must preserve content width');
 await page.waitForFunction(()=>!document.querySelector('[data-system-panel="maintenance"]').classList.contains('scrollbar-visible'));
 assert.equal(await panel.evaluate(n=>getComputedStyle(n).scrollbarWidth),'none');
 assert.equal(await panel.evaluate(n=>n.offsetWidth-n.clientWidth),0);
 assert(Math.abs((await contentGeometry()).width-geometryBefore.width)<=1,'Hiding the native scrollbar must preserve content width');
 // A stationary pointer at the right edge must not hold the thumb open forever.
 await page.mouse.move(bounds.x+bounds.width-3,bounds.y+120);
 await page.waitForFunction(()=>document.querySelector('[data-system-panel="maintenance"]').classList.contains('scrollbar-visible'));
 await page.waitForFunction(()=>!document.querySelector('[data-system-panel="maintenance"]').classList.contains('scrollbar-visible'));
 // Preserve the thumb while dragging; cancellation and blur always release it.
 await panel.evaluate(n=>{const r=n.getBoundingClientRect();n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:r.right-3,clientY:r.top+100}));});
 // Wait past the idle deadline to verify a held thumb remains available.
 await page.waitForTimeout(1100);
 assert(await panel.evaluate(n=>n.classList.contains('scrollbar-visible')));
 await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel')));
 await page.waitForFunction(()=>!document.querySelector('[data-system-panel="maintenance"]').classList.contains('scrollbar-visible'));
 // Recover even when native scrollbar chrome consumes pointerup.
 await panel.evaluate(n=>{const r=n.getBoundingClientRect();n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,clientX:r.right-3,clientY:r.top+100}));n.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,buttons:0,clientX:r.left+80,clientY:r.top+100}));});
 await page.waitForFunction(()=>!document.querySelector('[data-system-panel="maintenance"]').classList.contains('scrollbar-visible'));
 await panel.evaluate(n=>n.dispatchEvent(new Event('scroll')));assert(await panel.evaluate(n=>n.classList.contains('scrollbar-visible')));
 await page.locator('[data-system-tab="preferences"]').click();assert(!await panel.evaluate(n=>n.classList.contains('scrollbar-visible')));
 await page.locator('[data-system-tab="preferences"]').focus();await page.keyboard.press('End');
 assert.equal(await page.locator('#system-tabs [aria-current="page"]').getAttribute('data-system-tab'),'about');
 assert.equal(await page.locator('#system-tabs .active').evaluate(n=>getComputedStyle(n).outlineStyle),'solid','Keyboard focus remains visible');
 assert.deepEqual(errors,[]);console.log(`PASS ${checked} navigation/scroll palettes and bilingual widths; real wheel, idle at edge, stable gutter, drag cancellation, tab cleanup and keyboard focus (${process.env.MAILAI_BROWSER||'chromium'}).`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
