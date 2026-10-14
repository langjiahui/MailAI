// Use an isolated workspace_preview.py fixture; no mailbox operations are sent.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/');
  await page.locator('#app-preloader').waitFor({state:'detached'});
  await page.locator('.email-item').first().click();
  await page.locator('.reading-subject').waitFor({state:'visible'});
  await page.evaluate(()=>openCorrespondence());
  await page.locator('.correspondence-item.current').waitFor();
await page.evaluate(async()=>{for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh();});
  for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
   await page.evaluate(async({theme,mode})=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();applyTheme(mode);},{theme,mode});
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.rewardTheme||''),theme);
   const current=page.locator('.correspondence-item.current');
   const row=page.locator('.correspondence-item:not(.current)').first();
   async function check(target) {
    const ratios=await target.evaluate(row=>{
     const ctx=document.createElement('canvas').getContext('2d');
     const rgb=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
     const lum=c=>rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
     const bg=lum(getComputedStyle(row).backgroundColor);
     return [...row.querySelectorAll('strong,.correspondence-meta small,time,.correspondence-copy>p')].map(n=>{
      const fg=lum(getComputedStyle(n).color);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
     });
    });
    assert(ratios.length>=4);assert(ratios.every(n=>n>=4.5),`${theme}/${mode}: ${ratios}`);
   }
   await page.mouse.move(10,500);await check(current);await check(row);
   await current.hover();await check(current);
   await row.hover();await check(row);
   await row.locator('input[type=checkbox]').check({force:true});await check(row);
   await row.locator('input[type=checkbox]').uncheck({force:true});
   if(theme==='theme_monochrome'&&mode==='dark')await page.screenshot({path:'/tmp/mailai-correspondence-fixed.png'});
  }
  await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();});
    console.log('Correspondence current, hover and selected text contrast passed in all six palettes');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
