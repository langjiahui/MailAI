const {chromium}=require('playwright');
const fs=require('fs'), path=require('path'), assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  await page.route('http://mailai.test/**', route=>{
   const file=path.join(__dirname,'../app/web/static',new URL(route.request().url()).pathname);
   if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
   return route.fulfill({body:'',status:200});
  });
  const html=fs.readFileSync(path.join(__dirname,'../app/web/static/index.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/href="\/static\//g,'href="/');
  await page.goto('http://mailai.test/'); await page.setContent(html);
  await page.evaluate(()=>{document.querySelector('#app-preloader').remove();document.querySelector('#compose-modal').classList.remove('hidden');document.body.classList.add('compose-open');});
  await page.addScriptTag({path:path.join(__dirname,'../app/web/static/companion.js')});
  assert.equal(await page.locator('#btn-compose-ai .mail-companion').count(),1);
  await page.locator('#btn-compose-ai').hover();
  assert.ok(await page.locator('#btn-compose-ai').evaluate(el=>el.style.getPropertyValue('--look-x')));
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#btn-compose-ai .mail-companion').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const width of [1920,1440,1280,1024,390]) {
   await page.setViewportSize({width,height:1000});
   await page.evaluate(()=>document.querySelector('#compose-ai-panel').classList.add('hidden'));
   await page.waitForTimeout(350);
   const before=await page.locator('.compose-card').boundingBox();
   const editor=await page.locator('#compose-body').boundingBox();
   await page.evaluate(()=>document.querySelector('#compose-ai-panel').classList.remove('hidden'));
   await page.waitForTimeout(350);
   const after=await page.locator('.compose-card').boundingBox(), panel=await page.locator('#compose-ai-panel').boundingBox();
   assert.equal(Math.round(after.width),Math.round(before.width));
   assert.equal(Math.round((await page.locator('#compose-body').boundingBox()).width),Math.round(editor.width));
   assert.ok(panel.x>=0&&panel.x+panel.width<=width+1);
   if(width>=1200){assert.ok(after.x<before.x);assert.ok(after.x>=0);assert.ok(after.x+after.width<=panel.x);}
   if(width===1024){assert.ok(panel.x<=after.x&&panel.y<=after.y);assert.ok(panel.x+panel.width>=after.x+after.width&&panel.y+panel.height>=after.y+after.height);}
   if(width===1440)await page.screenshot({path:path.join(__dirname,'../build/compose-sidecar.png')});
  }
  console.log('PASS assistant outside compose, stable editor width, left shift, non-overlap and mobile bounds');
 } finally {await browser.close();}
})();
