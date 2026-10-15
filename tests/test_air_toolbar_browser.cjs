// Uses workspace_preview only. Never accesses live mail or changes OS settings.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const fs=require('node:fs');
(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();
  try{
   const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:18795/?shell=macos');
   await page.locator('#app-preloader').waitFor({state:'detached'});
   await page.evaluate(()=>{localStorage.setItem('mailai-onboarding-seen','1');document.getElementById('onboarding-overlay')?.classList.add('hidden');});
   const snapshots=[];
   for(const language of ['zh-CN','en']){
    await page.evaluate(language=>setI18nLanguage(language),language);
    for(const width of [900,1100,1280,1366,1440,1470,1512,1618,1920]){
     await page.setViewportSize({width,height:900});
     for(const scale of [.9,1,1.1,1.3]){
      await page.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);},scale);
      await page.waitForTimeout(60);
      const geometry=await page.evaluate(()=>{
       const box=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
       const h=document.querySelector('.topbar'),s=getComputedStyle(h),z=parseFloat(getComputedStyle(document.body).zoom)||1;
       return {header:box(h),search:box(document.querySelector('.global-search')),actions:box(document.querySelector('.global-actions')),
        overflow:document.documentElement.scrollWidth>innerWidth+1,usable:(h.getBoundingClientRect().width/z)-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),
        buttons:[...h.querySelectorAll('.global-actions .nav-action')].filter(n=>n.getClientRects().length).map(n=>({id:n.id,...box(n)})),
        labels:['btn-compose','btn-contacts','btn-attachments','btn-todos','btn-security-menu'].map(id=>{const n=document.querySelector('#'+id+'>span');return {id,...box(n),display:getComputedStyle(n).display,clip:getComputedStyle(n).clipPath};})};
      });
      const detail=JSON.stringify({engine:engine.name(),language,width,scale,geometry});
      assert(!geometry.overflow,detail);assert(geometry.search.width>=90,detail);assert(geometry.search.right<=geometry.actions.left+1,detail);
      assert(Math.abs(geometry.header.height-52)<1,detail);
      for(const button of geometry.buttons)assert(button.left>=0&&button.right<=width+1&&button.bottom<=53,detail);
      for(let n=1;n<geometry.buttons.length;n++)assert(geometry.buttons[n-1].right<=geometry.buttons[n].left+1,detail);
      if(geometry.usable>900)assert(geometry.labels.every(l=>l.width>10&&l.display!=='none'&&l.clip==='none'),detail);
      if(geometry.usable<=900&&geometry.usable>720){
       assert(geometry.labels[0].width>10,detail);
       assert(geometry.labels.slice(1).every(l=>l.width<=1.5),detail);
      }
      if(geometry.usable<=720)assert(geometry.labels.every(l=>l.width<=1.5),detail);
      snapshots.push({language,width,scale,usable:geometry.usable,labels:geometry.labels.map(l=>l.width>10)});
     }
    }
   }
   // The reported Air width keeps every work label, including larger text.
   await page.setViewportSize({width:1618,height:866});
   for(const theme of ['light','dark']) for(const palette of ['', 'theme_monochrome','theme_baowu']){
    await page.evaluate(({theme,palette})=>{applyTheme(theme);setI18nLanguage('zh-CN');document.body.style.zoom='1.3';document.documentElement.style.setProperty('--fz','1.3');if(palette)document.documentElement.dataset.rewardTheme=palette;else delete document.documentElement.dataset.rewardTheme;}, {theme,palette});
    assert((await page.locator('#btn-compose>span').boundingBox()).width>10);
    assert((await page.locator('#btn-contacts>span').boundingBox()).width>10);
   }
   await page.evaluate(()=>{applyTheme('light');setI18nLanguage('zh-CN');delete document.documentElement.dataset.rewardTheme;document.body.style.zoom='1.1';document.documentElement.style.setProperty('--fz','1.1');document.getElementById('onboarding-overlay')?.classList.add('hidden');});
   await page.locator('#email-list .email-item').first().click();
   await page.locator('#reading-content .reading-header').waitFor();
   await page.screenshot({path:`build/air-toolbar-${engine.name()}.png`});
   // Essential interactions remain reachable with labels restored.
   await page.locator('#btn-compose').click();await page.locator('#compose-modal').waitFor({state:'visible'});
   await page.locator('#btn-close-compose').click();
   await page.locator('#btn-security-menu').click();await page.locator('#security-menu-popover').waitFor({state:'visible'});
   await page.keyboard.press('Escape');
   assert.deepEqual(errors,[]);
   fs.writeFileSync(`build/air-toolbar-${engine.name()}.json`,JSON.stringify(snapshots,null,2));
   console.log(`PASS ${engine.name()}: Air 1280–1618px label retention, 900–1920px no overlap, 90–130% scaling, Chinese/English, six palettes and command interactions`);
  }finally{await browser.close();}
 }
})().catch(e=>{console.error(e);process.exit(1);});
