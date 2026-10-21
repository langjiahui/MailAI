// Isolated workspace fixture. Change only the rendered palette, never real account settings.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const {partition}=require('./helpers/ci-shard.cjs');
const cases=partition(require('./helpers/home-dialog-cases.cjs'));
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 const errors=[];let checked=0;
 try{
  const p=await browser.newPage({viewport:{width:1512,height:1000},reducedMotion:'reduce'});
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/api/ui-preferences.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
  await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  await p.goto('http://127.0.0.1:18795/?shell=macos');await p.locator('#app-preloader').waitFor({state:'detached'});await p.evaluate(()=>initialLoad);
  for(const[name,selector,open,close]of cases){
   await p.evaluate('('+open.toString()+')()');await p.locator(selector).waitFor({state:'visible'});
   for(const theme of['','theme_monochrome','theme_baowu'])for(const mode of['light','dark']){
    const failures=await p.locator(selector).evaluate((root,{theme,mode})=>{
     if(theme)document.documentElement.dataset.rewardTheme=theme;else document.documentElement.removeAttribute('data-reward-theme');
     applyTheme(mode);
     const ctx=document.createElement('canvas').getContext('2d');
     const paint=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1)};
     const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
     return [...root.querySelectorAll('header h2,header h3,header small,header p,.form-hint,.productivity-hint,.file-preview-note,button:not(:disabled)')]
      .filter(n=>n.getClientRects().length&&n.textContent.trim()&&!n.closest('fieldset:disabled'))
      .map(n=>{
       const chain=[];for(let a=n;a;a=a.parentElement)chain.unshift(a);
       ctx.clearRect(0,0,1,1);paint('#fff');
       chain.forEach(a=>{
        paint(getComputedStyle(a).backgroundColor);
        // The contact selector paints its active background with a moving pseudo-element.
        if(a.id==='contact-center-filters'&&n.closest('[data-contact-filter]')?.classList.contains('active'))paint(getComputedStyle(a,'::before').backgroundColor);
       });
       const bg=luminance([...ctx.getImageData(0,0,1,1).data]);
       ctx.clearRect(0,0,1,1);paint(getComputedStyle(n).color);const fg=luminance([...ctx.getImageData(0,0,1,1).data]);
       return{selector:n.id||n.className,text:n.textContent.trim().slice(0,50),ratio:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05),minimum:n.classList.contains('contact-star')?3:4.5};
      }).filter(n=>n.ratio<n.minimum);
    },{theme,mode});
    assert.deepEqual(failures,[],JSON.stringify({name,theme,mode,failures}));checked++;
   }
   await p.evaluate('('+close.toString()+')()');
  }
  assert.deepEqual(errors,[]);console.log(`PASS ${checked} dialog/palette combinations: rendered titles, key hints and enabled buttons reach 4.5:1, star controls reach 3:1 (${process.env.MAILAI_BROWSER||'chromium'}).`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
