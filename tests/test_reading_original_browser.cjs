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
