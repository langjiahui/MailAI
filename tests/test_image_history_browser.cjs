const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.waitForSelector('#email-list .email-item');
    const accounts=await page.evaluate(()=>api('/api/system/config'));
    assert.ok(accounts.accounts.every(a=>a.user.endsWith('@example.test')));
    await page.locator('#assistant-orb').click();
    const data=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=2400;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#eaf3ee';ctx.fillRect(0,0,800,2400);
      ctx.fillStyle='#245c49';ctx.font='32px sans-serif';ctx.fillText('项目安排 / History preview',30,70);
      return api('/api/assistant/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'请看这张图片',images:[{data_url:canvas.toDataURL()}]})});
    });
    await page.evaluate(id=>loadAssistantConversation(id),data.conversation_id);
    const thumb=page.locator('.assistant-sent-images img');
    await thumb.scrollIntoViewIfNeeded();
    await thumb.evaluate(img=>img.decode());
    assert.ok((await thumb.getAttribute('src')).includes('thumbnail=true'));
    assert.ok((await thumb.getAttribute('src')).includes('mailai_account='));
    assert.equal(await page.locator('.assistant-message.user').innerText(),'请看这张图片');
    await thumb.click();
    await page.locator('#assistant-image-zoom img').evaluate(img=>img.decode());
    assert.equal(await page.locator('#assistant-image-zoom img').evaluate(img=>img.naturalHeight),2400);
    await page.locator('#assistant-image-size').click();
    assert.ok(await page.locator('#assistant-image-zoom').evaluate(n=>n.classList.contains('original-size')));
    await page.screenshot({path:'build/image-history-preview.png'});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('#assistant-image-zoom img').hasAttribute('src'));
    assert.equal(await page.locator('#assistant-image-zoom img').getAttribute('src'),null);
    await page.reload();await page.waitForSelector('#email-list .email-item');
    await page.locator('#assistant-orb').click();
    await page.evaluate(id=>loadAssistantConversation(id),data.conversation_id);
    await page.locator('.assistant-sent-images img').scrollIntoViewIfNeeded();
    await page.locator('.assistant-sent-images img').evaluate(img=>img.decode());
    await page.screenshot({path:'build/image-history-restored.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS: persisted image after reload, clean prompt, lazy account-bound thumbnail, original preview, zoom and Escape cleanup');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
