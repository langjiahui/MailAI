// Run against the isolated workspace_preview fixture; no live mailbox is used.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();
  try{
   const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/api/ui-preferences.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
   await page.route('**/api/ui-preferences',r=>r.fulfill({json:{ok:true}}));
   await page.goto((process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795')+'/?shell=macos');
   await page.locator('#app-preloader').waitFor({state:'detached'});
   await page.locator('#email-list .email-item').first().click();
   await page.waitForFunction(()=>!!selectedEmailDetail);
   for(const theme of ['light','dark'])for(const language of ['zh-CN','en']){
    await page.evaluate(({theme,language})=>{
     applyTheme(theme);setI18nLanguage(language);
     window.originalReadingSample={...selectedEmailDetail,has_rich_body:true,has_remote_images:false,
      body_html:'<p id="current-message">当前正文 Current message</p><div class="gmail_signature" style="margin-top:24px">完整签名 Full signature</div><blockquote type="cite"><p>完整历史引用 Original quoted message</p><blockquote cite="https://example.test"><table><tr><td>嵌套引用 Nested quote</td></tr></table></blockquote></blockquote>',
      body_text:'当前正文\n-- \n完整签名\n-----Original Message-----\n完整历史引用'};
     renderReadingPane(originalReadingSample);
    },{theme,language});
    const frame=page.frameLocator('#rich-email-body iframe');
    await frame.locator('#current-message').waitFor();
    assert(await frame.locator('.gmail_signature').isVisible());
    assert(await frame.locator('blockquote').first().isVisible());
    assert(await frame.locator('blockquote table').isVisible());
    assert.equal(await frame.locator('details[data-mailai-fold],summary').count(),0);
    assert.equal(await page.locator('.body-section .body-format-actions').count(),0);
    assert(await page.locator('.body-section>.section-title').innerText().then(s=>!s.includes('HTML')));
    assert.deepEqual(await frame.locator('body').evaluate(n=>[...n.children].filter(el=>!el.hasAttribute('data-mailai-copy-image')).map(el=>el.tagName)),['P','DIV','BLOCKQUOTE']);
    // Main copy stays distinct from secondary copy, with no separate green
    // canvas inside the script-disabled HTML frame.
    const readability=await page.evaluate(()=>{
      const color=value=>{
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
        ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);
      };
      const luminance=value=>color(value).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const ratio=(a,b)=>{a=luminance(a);b=luminance(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
      const style=s=>getComputedStyle(document.querySelector(s));
      const paper=style('.body-section .email-body').backgroundColor;
      const doc=document.querySelector('#rich-email-body iframe').contentDocument;
      const rows=[['.reading-subject',paper,7],['.meta-fields',paper,7],['.meta-label',paper,4.5],
        ['.sender-contact-link small',paper,4.5],['.email-preview',style('.list-pane').backgroundColor,4.5]];
      return {paper,framePaper:doc.defaultView.getComputedStyle(doc.documentElement).backgroundColor,
        frameContrast:ratio(doc.defaultView.getComputedStyle(doc.body).color,paper),
        rows:rows.map(([s,b,min])=>({selector:s,min,contrast:ratio(style(s).color,b)}))};
    });
    assert.equal(readability.framePaper,readability.paper,JSON.stringify(readability));
    assert(readability.frameContrast>=7,JSON.stringify(readability));
    for(const row of readability.rows)assert(row.contrast>=row.min,JSON.stringify(row));
    // Switching an already mounted frame updates its paper and restores the
    // theme without replacing sender content or the frame itself.
    await page.evaluate(theme=>{
      const node=document.querySelector('#rich-email-body iframe');window.readabilityFrame=node;
      applyTheme(theme==='dark'?'light':'dark');applyTheme(theme);
    },theme);
    assert(await page.evaluate(()=>readabilityFrame===document.querySelector('#rich-email-body iframe')));
    assert.equal(await frame.locator('#current-message').innerText(),'当前正文 Current message');
    // Source-mail drawers use the same complete HTML display and no format badge.
    await page.evaluate(()=>{document.querySelector('#digest-email-body').innerHTML=renderDigestEmailDetail(originalReadingSample);mountDigestRichEmailBody(originalReadingSample);});
    await page.waitForFunction(()=>document.querySelector('#digest-rich-email-body iframe')?.contentDocument?.querySelector('.gmail_signature'));
    assert.equal(await page.locator('#digest-email-body .drawer-body-section>.section-title small').count(),0);
    assert.equal(await page.frameLocator('#digest-rich-email-body iframe').locator('details[data-mailai-fold]').count(),0);
    await page.evaluate(()=>renderReadingPane({...originalReadingSample,has_rich_body:false}));
    const plain=page.locator('.body-section .plain-email-body');
    assert((await plain.innerText()).includes('完整签名'));
    assert((await plain.innerText()).includes('完整历史引用'));
    assert.equal(await plain.locator('details,summary').count(),0);
   }
   assert.deepEqual(errors,[]);
   console.log(`PASS ${engine.name()}: complete signatures and nested quotes, original HTML order, plain-text body, no format badge in reader/drawer, light/dark and Chinese/English`);
  }finally{await browser.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
