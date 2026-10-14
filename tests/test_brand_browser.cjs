// Real shared brand geometry, measured startup handoff and static theme cascade.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'../app/web/static');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*src=[^>]*>[\s\S]*?<\/script>/g,'');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const handoff=app.slice(app.indexOf('function hideAppPreloader('),app.indexOf('// ===== 三栏宽度拖拽与本地记忆 ====='));
(async()=>{
 const browser=await(process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 try {
  for(const shell of ['macos','windows','browser'])for(const mode of ['light','dark']){
   const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(mode=>localStorage.setItem('mailai.preferences.theme.v1',mode),mode);
   await page.route('http://mailai.test/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
    const file=path.join(root,url.pathname.replace('/static/',''));
    return fs.existsSync(file)?route.fulfill({path:file}):route.abort();
   });
   await page.goto(`http://mailai.test/?shell=${shell}`);
   for(const name of ['i18n.js','i18n-catalog.js','i18n-runtime.js','macos-window.js','windows-window.js','companion.js','brand.js'])await page.addScriptTag({path:path.join(root,name)});
   const entrance=page.locator('.brand-entrance');
   assert.equal(await entrance.locator('path').count(),4);
   assert(await page.locator('.topbar .brand-mark').isVisible(),`${shell}: native header shows new mark`);
   const start=await entrance.evaluate(n=>n.getAnimations({subtree:true}).filter(a=>a.animationName?.startsWith('brand-')).map(a=>({name:a.animationName,iterations:a.effect.getTiming().iterations})));
   assert.equal(start.length,4);assert(start.every(a=>a.iterations===1),'Entrance runs once');
   await entrance.evaluate(async n=>{await Promise.all(n.getAnimations({subtree:true}).map(a=>a.finished));});
   for(const theme of ['', 'theme_monochrome','theme_baowu']){
    await page.evaluate(theme=>{if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;document.dispatchEvent(new Event('mailai:reward-themechange'));},theme);
    const brand=await page.locator('.topbar .brand-mark').evaluate(n=>{
     const style=getComputedStyle(document.documentElement);
     const rgb=value=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=value;c.fillRect(0,0,1,1);return[...c.getImageData(0,0,1,1).data].slice(0,3);};
     const lum=value=>rgb(value).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
     const front=getComputedStyle(n.querySelector('.brand-front')).fill,back=getComputedStyle(n.querySelector('.brand-back')).fill;
     const surface=style.getPropertyValue('--workspace-chrome').trim()||getComputedStyle(document.body).backgroundColor;
     const a=lum(front),b=lum(surface);
     return {front,back,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),paths:[...n.querySelectorAll('path')].map(p=>p.getAttribute('d'))};
    });
    assert(brand.ratio>=3,`${shell}/${mode}/${theme}: ${JSON.stringify(brand)}`);
    assert.notEqual(brand.front,brand.back,'Paper layers stay distinct');
    assert.deepEqual(await entrance.locator('path').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d'))),brand.paths);
    const icon=decodeURIComponent(await page.locator('link[rel="icon"]').getAttribute('href'));
    assert(icon.startsWith('data:image/svg+xml,'));assert(!icon.includes('var(--'),'Favicon must resolve palette variables');
    for(const d of brand.paths)assert(icon.includes(d),'Favicon shares fold geometry');
   }
   await page.evaluate(()=>{delete document.documentElement.dataset.rewardTheme;document.dispatchEvent(new Event('mailai:reward-themechange'));});
   if(shell==='macos')await page.screenshot({path:`build/brand-startup-${mode}.png`});
   await page.addScriptTag({content:handoff});
   await page.evaluate(()=>{document.getElementById('onboarding-overlay').classList.add('hidden');document.getElementById('app-preloader').dataset.introUntil='0';hideAppPreloader();});
   const docking=await entrance.evaluate(n=>n.getAnimations().find(a=>a.effect.getTiming().duration===1100)?.effect.getKeyframes());
   assert(docking?.some(k=>k.transform.includes('scale(')),'Folded mark docks into header');
   await page.locator('#app-preloader').waitFor({state:'detached'});
   assert(await page.locator('.topbar .brand-mark').isVisible());
   assert.deepEqual(errors,[]);
   await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await page.route('http://mailai.test/**',route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});const f=path.join(root,u.pathname.replace('/static/',''));return fs.existsSync(f)?route.fulfill({path:f}):route.abort();});
  await page.goto('http://mailai.test/');await page.addScriptTag({path:path.join(root,'brand.js')});
  assert.equal(await page.locator('.brand-entrance').evaluate(n=>n.getAnimations({subtree:true}).length),0,'Reduced motion does not fold or travel');
  const bounds=await page.locator('.brand-entrance').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390);
  await page.close();
  console.log('Folded M: three shells, six palettes, finite entrance, docking, favicon and reduced-motion mobile passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
