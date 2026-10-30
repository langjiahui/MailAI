const assert=require('node:assert/strict');
// Audit each task view, rather than only the collection overview, across the
// actual workspace palette cascade and font-scaled layout.
async function auditSpaceThemes(page,dialog) {
 const failures=[];let checked=0;
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const language of ['zh-CN','en'])for(const mode of ['light','dark'])for(const reward of ['','theme_monochrome','theme_baowu']) {
  await page.evaluate(({language,mode,reward})=>{setI18nLanguage(language);applyTheme(mode);document.documentElement.dataset.rewardTheme=reward;},{language,mode,reward});
  for(const [width,height,scale]of [[1440,1000,1],[390,844,1.35]]) {
   await page.setViewportSize({width,height});
   await page.evaluate(scale=>{document.documentElement.style.setProperty('--fz',scale);document.body.style.zoom=String(scale);},scale);
   for(const tab of ['today','shop','wardrobe','journey','gifts','themes','history']) {
    await dialog.locator(`[data-pet-tab="${tab}"]`).click();
    const issues=await dialog.evaluate(d=>{
     const problems=[],rgb=s=>{const c=(s.match(/[\d.]+/g)||[]).map(Number);return s.startsWith('color(srgb')?c.map((v,i)=>i<3?v*255:v):c;},blend=(a,b)=>{const alpha=a[3]??1;return a.slice(0,3).map((v,i)=>v*alpha+b[i]*(1-alpha));};
     const luminance=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
     const background=n=>{const chain=[];for(let a=n;a instanceof Element;a=a.parentElement)chain.unshift(a);return chain.reduce((color,a)=>blend(rgb(getComputedStyle(a).backgroundColor),color),[255,255,255]);};
     const contrast=n=>{const bg=background(n),fg=blend(rgb(getComputedStyle(n).color),bg);const values=[luminance(fg),luminance(bg)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);};
     const body=d.querySelector('.pet-journal-body'),main=d.querySelector('.pet-center-main');
     if(body.scrollHeight>body.clientHeight+1)problems.push('Outer dialog body scrolls');
     for(const [name,n]of [['dialog',d],['body',body],['main',main]])if(n.scrollWidth>n.clientWidth+1)problems.push(name+' has horizontal overflow');
     const close=d.querySelector('[data-pet-close]').getBoundingClientRect();if(close.top<0||close.right>innerWidth+1||close.bottom>innerHeight+1)problems.push('Close is outside the viewport');
     for(const n of d.querySelectorAll('.pet-tabs button,.pet-hero h3,.pet-center-summary b,.pet-page-heading h3,.pet-series-actions button,.pet-shelf-pages button,.pet-shop-item>button,.pet-theme-card>button')) {
      const css=getComputedStyle(n);if(!n.getClientRects().length||css.visibility==='hidden'||n.disabled||n.closest('[hidden]'))continue;
      if(n.scrollWidth>n.clientWidth+1)problems.push('Clipped text: '+n.textContent.trim());
      const ratio=contrast(n),large=parseFloat(css.fontSize)>=24||parseFloat(css.fontSize)>=18.66&&parseInt(css.fontWeight)>=700;
      if(ratio<(large?3:4.5)-.05)problems.push('Low text contrast '+ratio.toFixed(2)+': '+n.textContent.trim());
     }
     return problems;
    });
    if(language==='en'&&/[\u3400-\u9fff]/.test(await dialog.textContent()))issues.push('Chinese in English interface');
    if(issues.length)failures.push({language,mode,reward,width,scale,tab,issues});
    checked++;
   }
  }
 }
 await page.evaluate(()=>{document.documentElement.style.setProperty('--fz','1');document.body.style.zoom='1';setI18nLanguage('zh-CN');applyTheme('light');document.documentElement.dataset.rewardTheme='';});
 await page.setViewportSize({width:1280,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});
 if(failures.length)console.error(JSON.stringify(failures,null,2));
 assert.deepEqual(failures,[], 'Companion views must keep translated controls readable and reachable');
 console.log(`PASS ${page.context().browser().browserType().name()}: ${checked} localized view/palette/size/scale cases with text contrast and bounded layout`);
}
module.exports={auditSpaceThemes};
