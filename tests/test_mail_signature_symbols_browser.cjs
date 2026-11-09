const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium,webkit}=require('playwright');
(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();
  try{
   const page=await browser.newPage();
   await page.setContent('<iframe sandbox="allow-same-origin"></iframe>');
   await page.evaluate(()=>{window.mdToHtml=text=>text;window.mailaiT=()=> 'Previous message details';});
   await page.addScriptTag({path:'app/web/static/mail-reading-folds.js'});
   const result=await page.evaluate(async()=>{
    const frame=document.querySelector('iframe');
    await new Promise(resolve=>{frame.onload=resolve;frame.srcdoc='<p id="normal">Normal (text) *</p><p>Signature <span style="font-family:Wingdings">&#xf028; &#xf02a; A</span><a href="mailto:sender@example.test">sender@example.test</a></p><div id="divRplyFwdMsg"><b>From:</b> prior@example.test<br><b>Subject:</b> Old mail</div><p id="quote">Complete previous body</p><blockquote>Generic quote remains visible</blockquote>';});
    const doc=frame.contentDocument;
    mailaiPrepareReadingMarkup(doc);mailaiPrepareReadingMarkup(doc);
    const header=doc.querySelector('[data-mailai-history-header]');
    const before=doc.getElementById('quote').getBoundingClientRect().height;
    return {normal:doc.getElementById('normal').textContent,signature:doc.querySelectorAll('p')[1].textContent,
     icons:[...doc.querySelectorAll('span span')].map(node=>doc.defaultView.getComputedStyle(node).fontFamily),
     headers:doc.querySelectorAll('details').length,open:header.open,stored:header.textContent,
     bodyVisible:before>0,genericVisible:doc.querySelector('blockquote').getBoundingClientRect().height>0,
     link:doc.querySelector('a').getAttribute('href')};
   });
   assert.equal(result.normal,'Normal (text) *');
   assert.match(result.signature,/☎ ✉ A/);assert(result.icons.every(font=>/Arial/.test(font)));
   assert.equal(result.headers,1);assert.equal(result.open,false);assert.match(result.stored,/prior@example.test/);
   assert(result.bodyVisible&&result.genericVisible);assert.equal(result.link,'mailto:sender@example.test');
   await page.frameLocator('iframe').locator('summary').click();
   assert(await page.frameLocator('iframe').locator('#divRplyFwdMsg').isVisible());
   const pasted=await page.evaluate(()=>{
    const doc=document.querySelector('iframe').contentDocument;
    const section=doc.createElement('section');
    section.innerHTML='<p><img width="10" height="20"><img width="18" height="14"><img width="18" height="14" alt="Logo"><img width="180" height="140"></p><blockquote><div><div style="background:#efefef"><div><b>发件人：</b> sender@example.test</div><div><b>发送时间：</b> 2026-01-01</div><div><b>收件人：</b> recipient@example.test</div><div><b>主题：</b> Prior mail</div></div></div><p id="prior-body">Previous body stays visible</p><div id="non-header"><div>From: regular example</div><div>To: regular example</div><div>Subject: regular example</div><p>Actual content prevents folding</p></div></blockquote>';
    doc.body.append(section);mailaiPrepareReadingMarkup(doc);mailaiPrepareReadingMarkup(doc);
    const visible=node=>doc.defaultView.getComputedStyle(node).display!=='none';
    return {hidden:[...section.querySelectorAll('img')].map(visible),headers:section.querySelectorAll('details').length,
     body:doc.getElementById('prior-body').getBoundingClientRect().height>0,
     nonHeader:!doc.getElementById('non-header').closest('details')};
   });
   assert.deepEqual(pasted.hidden,[false,false,true,true]);assert.equal(pasted.headers,1);assert(pasted.body&&pasted.nonHeader);
   console.log(`PASS ${engine.name()}: signature compatibility, preserved text/links, native header disclosure and visible quote body`);
  }finally{await browser.close();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
