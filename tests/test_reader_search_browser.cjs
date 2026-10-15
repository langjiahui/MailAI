// Isolated fixture only: physical scrollbar alignment and stale search cancellation.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();
  try{
   const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:18795/?shell=macos');
   await page.locator('#app-preloader').waitFor({state:'detached'});
   await page.locator('#email-list .email-item').first().click();
   await page.locator('#reading-content .reading-header').waitFor();
   await page.evaluate(()=>{const filler=document.createElement('div');filler.style.height='3600px';filler.textContent='长邮件布局回归 / Long message';document.querySelector('#reading-content').append(filler);});
   for(const width of [1280,1440,1512,1920]){
    await page.setViewportSize({width,height:900});
    for(const theme of ['light','dark']) for(const zoom of [.9,1,1.1,1.3]){
     await page.evaluate(({theme,zoom})=>{applyTheme(theme);document.body.style.zoom=zoom;document.documentElement.style.setProperty('--fz',zoom);}, {theme,zoom});
     for(const fraction of [0,.5,1]){
      const m=await page.evaluate(fraction=>{
       const pane=document.querySelector('.reading-pane');pane.scrollTop=(pane.scrollHeight-pane.clientHeight)*fraction;showScrollIndicator(pane);
       const indicator=scrollIndicators.get(pane),p=pane.getBoundingClientRect(),r=indicator.getBoundingClientRect(),t=indicator.firstElementChild.getBoundingClientRect();
       return {gap:p.right-r.right,top:r.top-p.top,bottom:p.bottom-r.bottom,width:r.width,thumbTop:t.top,thumbBottom:t.bottom,trackTop:r.top,trackBottom:r.bottom};
      },fraction);
      const detail=JSON.stringify({engine:engine.name(),width,theme,zoom,fraction,m});
      assert(Math.abs(m.gap-4)<1,detail);assert(Math.abs(m.width-5)<.2,detail);
      assert(Math.abs(m.top-13)<1&&Math.abs(m.bottom-13)<1,detail);
      assert(m.thumbTop>=m.trackTop-1&&m.thumbBottom<=m.trackBottom+1,detail);
      if(fraction===1)assert(Math.abs(m.thumbBottom-m.trackBottom)<2,detail);
     }
    }
   }
   for(const language of ['zh','en']) for(const palette of ['', 'theme_monochrome','theme_baowu']){
    await page.evaluate(({language,palette})=>{
     setI18nLanguage(language);
     if(palette)document.documentElement.dataset.rewardTheme=palette;else delete document.documentElement.dataset.rewardTheme;
     document.dispatchEvent(new Event('mailai:reward-themechange'));
     document.body.style.zoom=.9;document.documentElement.style.setProperty('--fz','.9');
    },{language,palette});
    const gap=await page.evaluate(()=>{
     const pane=document.querySelector('.reading-pane');showScrollIndicator(pane);
     return pane.getBoundingClientRect().right-scrollIndicators.get(pane).getBoundingClientRect().right;
    });
    assert(Math.abs(gap-4)<1,`${engine.name()}/${language}/${palette}: scrollbar gap ${gap}`);
   }
   await page.waitForFunction(()=>!scrollIndicators.get(document.querySelector('.reading-pane')).classList.contains('is-visible'));
   await page.evaluate(()=>{document.body.style.zoom=1;document.documentElement.style.setProperty('--fz','1');});
   // Exercise the real api() and fetch AbortController without real slow requests.
   await page.evaluate(()=>{
    const real=window.fetch;window.searchSignals=[];
    window.fetch=(url,opts)=>{
     if(String(url).includes('/api/emails/search')||String(url).includes('/api/system/mail/unified-inbox?days=9999&q=')){
      searchSignals.push(opts.signal);
      if(new URL(url,location.href).searchParams.get('q')==='old-query')return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
     }
     return real(url,opts);
    };
   });
   await page.locator('#global-search').fill('old-query');
   await page.waitForFunction(()=>searchSignals.length===1);
   await page.locator('#global-search').fill('采购');
   await page.waitForFunction(()=>searchSignals[0].aborted&&mailSearchState.phase==='done');
   assert(await page.locator('#search-error').isHidden());
   assert(await page.locator('#email-list .email-item').count()>0);
   // Leaving the search scope must also release its in-flight request.
   await page.locator('#global-search').fill('old-query');
   await page.waitForFunction(()=>searchSignals.length===3);
   await page.evaluate(()=>advanceMailSearchRevision());
   assert(await page.evaluate(()=>searchSignals.at(-1).aborted));
   await page.locator('#global-search').fill('');
   assert.deepEqual(errors,[]);
   await page.screenshot({path:`build/reader-search-${engine.name()}.png`});
   console.log(`PASS ${engine.name()}: 1280–1920px, 90–130% zoom, light/dark, Chinese/English and theme palettes, scrollbar edges/travel/idle, replaced and abandoned search cancellation`);
  }finally{await browser.close();}
 }
})().catch(e=>{console.error(e);process.exit(1);});
