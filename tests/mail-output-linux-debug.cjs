const {webkit}=require('playwright');
const fs=require('fs');
(async()=>{
 const browser=await webkit.launch({headless:true});
 fs.mkdirSync('build/mail-output-debug',{recursive:true});
 for(const variant of ['overscroll-auto','outer-contain']]){
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:18795');
  await page.locator('#email-list .email-item').first().click();await page.waitForFunction(()=>!!selectedEmailDetail);
  await page.route(/\/api\/emails\/\d+\/output/,async route=>{const response=await route.fetch(),output=await response.json();output.document=output.document.replace('</main>',Array.from({length:75},(_,i)=>`<p>Synthetic line ${i}</p>`).join('')+'</main>');await route.fulfill({response,json:output});});
  await page.evaluate(v=>{
   applyTheme('dark');
   const style=document.createElement('style');
   style.textContent=v==='composite'?'#mail-output-preview{transform:translateZ(0)}':v==='visible-on-load'?'#mail-output-preview{opacity:1!important}':'';
   document.head.append(style);window.mailaiMailOutput.open('print');
  },variant);
  await page.waitForFunction(()=>document.querySelector('#mail-output-preview')?.hasAttribute('data-ready'));
  const frame=page.locator('#mail-output-preview');
  await frame.evaluate((f,v)=>{
   const d=f.contentDocument;window.__wheel=[];
   document.addEventListener('wheel',e=>window.__wheel.push(['parent',e.target.tagName,e.deltaY]),{capture:true,passive:true});
   d.addEventListener('wheel',e=>window.__wheel.push(['child',e.target.tagName,e.deltaY]),{capture:true,passive:true});
   if(v==='parent-wheel')f.addEventListener('wheel',e=>{d.scrollingElement.scrollTop+=e.deltaY;e.preventDefault();},{passive:false});
   if(v==='native-scrollbar')d.documentElement.classList.remove('mail-output-scroll');
   if(v==='outer-contain')f.closest('.mail-output-content').style.overscrollBehaviorY='contain';
   if(v==='overscroll-auto'||v==='outer-contain')d.getElementById('mail-output-screen-style').textContent+='@media screen{html,body{overscroll-behavior:auto!important}}';
   if(v==='scrolling-yes')f.setAttribute('scrolling','yes');
   if(v==='inner-div'){
    const scroll=d.createElement('div');scroll.id='debug-scroll';scroll.style.cssText='height:100vh;overflow:auto';while(d.body.firstChild)scroll.append(d.body.firstChild);d.body.append(scroll);d.getElementById('mail-output-screen-style').textContent+='@media screen{html,body{height:100%;margin:0;padding:0;overflow:hidden;overscroll-behavior:auto!important}}';
   }
   if(v==='outer-viewport'){
    d.getElementById('mail-output-screen-style').textContent+='@media screen{html,body{overscroll-behavior:auto!important}}';const host=f.parentElement;host.style.cssText='display:block;overflow:auto;position:relative';f.style.height=d.documentElement.scrollHeight+'px';f.setAttribute('scrolling','no');
   }
   if(v==='unsandboxed'){f.removeAttribute('sandbox');f.srcdoc=f.srcdoc;}
  },variant);
  const box=await frame.boundingBox();await frame.hover({position:{x:box.width/2,y:160}});
  if(variant==='click-frame')await page.mouse.click(box.x+box.width/2,box.y+160);
  await page.mouse.wheel(0,480);await page.waitForTimeout(400);
  const read=()=>frame.evaluate(f=>({top:f.contentDocument.scrollingElement.scrollTop,inner:f.contentDocument.getElementById('debug-scroll')?.scrollTop,outer:f.parentElement.scrollTop,wheel:window.__wheel,focused:document.activeElement.tagName}));
  console.log(variant,'FIRST',JSON.stringify(await read()));
  await page.mouse.wheel(0,480);await page.waitForTimeout(400);console.log(variant,'SECOND',JSON.stringify(await read()));
  await page.screenshot({path:`build/mail-output-debug/${variant}.png`});
  await page.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
