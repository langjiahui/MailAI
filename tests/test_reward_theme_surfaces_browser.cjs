/* Run after test_reward_themes_browser.cjs on the same isolated fixture. */
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage);
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    async function inspect(selector) {
      const values=await page.locator(selector).first().evaluate(node=>{
        const style=getComputedStyle(node),root=getComputedStyle(document.documentElement);
        const rgb=name=>{const n=document.createElement('span');n.style.color=root.getPropertyValue(`--reward-${name}`);document.body.append(n);const value=getComputedStyle(n).color;n.remove();return value;};
        return {background:style.backgroundColor,color:style.color,surface:rgb('surface'),soft:rgb('soft'),ink:rgb('ink')};
      });
      assert([values.surface,values.soft].includes(values.background),`${selector}: ${JSON.stringify(values)}`);
      assert.equal(values.color,values.ink,`${selector} text must use theme ink`);
    }
    for(const theme of ['theme_monochrome','theme_baowu']) {
      await page.evaluate(async theme=>{
        await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});
        await mailaiPet.refresh();
      },theme);
      for(const mode of ['light','dark']) {
        await page.evaluate(mode=>applyTheme(mode),mode);
        const brand=await page.evaluate(()=>{
          const mark=document.querySelector('.reward-brand-mark'),root=getComputedStyle(document.documentElement);
          return {visible:getComputedStyle(mark).display,original:getComputedStyle(document.querySelector('.logo img')).display,
            color:getComputedStyle(mark.querySelector('.reward-brand-shield')).fill,
            accent:root.getPropertyValue('--reward-accent').trim(),favicon:document.querySelector('link[rel="icon"]').href};
        });
        assert.equal(brand.visible,'block');assert.equal(brand.original,'none');
        assert(await page.locator('#assistant-orb').evaluate(n=>parseFloat(getComputedStyle(n).borderRadius)>0),'Theme must preserve the pet button shape');
        assert(brand.favicon.startsWith('data:image/svg+xml,'));
        assert(decodeURIComponent(brand.favicon).includes(`fill="${brand.accent}"`));
        await page.evaluate(()=>openCompose());
        await page.locator('#compose-modal').waitFor({state:'visible'});
        await inspect('.compose-card');
        await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-compose.png`});
        await page.evaluate(()=>closeCompose());
        await page.evaluate(()=>openContactCenter());
        await inspect('.contact-center-card');
        await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-contacts.png`});
        await page.evaluate(()=>closeContactCenter());
        await page.evaluate(()=>openAttachmentCenter());
        await inspect('#attachment-center .attachment-center-card');
        await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-attachments.png`});
        await page.evaluate(()=>closeAttachmentCenter());
        await page.evaluate(()=>openAssistant());
        await inspect('#assistant-panel');
        assert.equal(await page.locator('#assistant-send svg path').evaluate(n=>getComputedStyle(n).stroke),await page.locator('#assistant-send').evaluate(n=>getComputedStyle(n).color),'Send glyph must contrast with its themed button');
        await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-assistant.png`});
        await page.evaluate(()=>{closeAssistant();showSystemView('guide')});
        await inspect('#system-view');
        await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-help.png`});
        await page.evaluate(()=>hideSystemView(true));
        for(const panel of ['account','ai','remote','maintenance','about']) {
          await page.evaluate(panel=>showSystemView(panel),panel);
          await page.locator(`[data-system-panel="${panel}"]`).waitFor({state:'visible'});
          await inspect('#system-view');
          if(panel==='about')await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-about.png`});
        }
        await page.evaluate(()=>{hideSystemView(true);showDashboard()});
        await inspect('#dashboard-view');
        await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-dashboard.png`});
        await page.evaluate(()=>{hideDashboard();showRulesView()});
        await inspect('#rules-view');
        await page.evaluate(()=>hideRulesView(true));
      }
    }
    // The script-disabled mail frame receives palette updates while mounted.
    await page.evaluate(()=>{
      const frame=document.createElement('iframe');frame.id='reward-mail-fixture';
      frame.setAttribute('sandbox','allow-same-origin');document.body.append(frame);
      frame.srcdoc=richEmailDocument('<div style="background:#fff!important;color:#222!important"><p>Theme email</p><a href="https://example.test">Link</a><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></div>');
      richEmailFrames.add(frame);
    });
    await page.waitForFunction(()=>document.querySelector('#reward-mail-fixture').contentDocument?.body?.querySelector('p'));
    for(const theme of ['theme_monochrome','theme_baowu']) {
      await page.evaluate(async theme=>{
        await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();
      },theme);
      await page.evaluate(()=>{applyTheme('dark');syncRichEmailFrameTheme()});
      const mail=await page.evaluate(()=>{
        const frame=document.querySelector('#reward-mail-fixture'),doc=frame.contentDocument;
        return {paper:doc.querySelector('div').style.backgroundColor,text:doc.querySelector('div').style.color,
          image:doc.querySelector('img').getAttribute('src'),palette:getComputedStyle(document.documentElement).getPropertyValue('--reward-soft').trim()};
      });
      const rgb=mail.palette.slice(1).match(/../g).map(value=>parseInt(value,16));
      assert.equal(mail.paper,`rgb(${rgb.join(', ')})`);assert(mail.image.startsWith('data:image/svg+xml'));
    }
    await page.evaluate(async()=>{
      await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();
    });
    assert.equal(await page.locator('.logo img').evaluate(n=>getComputedStyle(n).display),'block');
    assert.equal(await page.locator('.reward-brand-mark').evaluate(n=>getComputedStyle(n).display),'none');
    assert(!(await page.locator('link[rel="icon"]').getAttribute('href')).startsWith('data:'));
    assert.equal(await page.evaluate(()=>document.querySelector('#reward-mail-fixture').contentDocument.getElementById('mailai-reward-theme')),null);
    await page.evaluate(()=>{
      const frame=document.querySelector('#reward-mail-fixture');richEmailFrames.delete(frame);frame.remove();
    });
    assert.deepEqual(errors,[]);
    console.log('Both themes/light-dark: vector logo, favicon, composer, contacts, attachments, assistant, help, live HTML mail and full reset passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
