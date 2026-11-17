const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium,webkit} = require('playwright');
(async()=>{
  const engine=process.env.MAILAI_BROWSER==='webkit'?'webkit':'chromium';
  const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  fs.mkdirSync('build/mail-output',{recursive:true});
  try {
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795');
    assert.equal(await page.locator('#mail-output-preview').count(),0,'Opening the app must not create an unused mail output frame');
    await page.locator('#email-list .email-item').first().click();
    await page.waitForFunction(()=>!!selectedEmailDetail);
    await page.route(/\/api\/emails\/\d+\/output/,async route=>{
      const response=await route.fetch();
      const output=await response.json();
      const paragraphs=Array.from({length:75},(_,index)=>`第 ${index+1} 段：请协助确认本次采购合同的交付时间。`);
      output.document=output.document.replace('</main>',paragraphs.map(text=>`<p>${text}</p>`).join('')+'</main>');
      await route.fulfill({response,json:output});
    },{times:1});
    await page.locator('.reading-more-actions > summary').click();
    const entries=page.locator('.reading-secondary-actions [data-mail-output]');
    assert.deepEqual(await entries.locator('span').allTextContents(),['打印邮件','分享邮件']);
    assert.equal(await entries.locator('svg').count(),2);
    assert.deepEqual(await entries.locator('svg').evaluateAll(icons=>icons.map(icon=>icon.getBoundingClientRect().width)),[16,16]);
    for(const palette of ['theme_monochrome','theme_baowu','']) for(const mode of ['light','dark']) {
      const hoverColor=await page.evaluate(({palette,mode})=>{
        if(palette)document.documentElement.dataset.rewardTheme=palette;
        else delete document.documentElement.dataset.rewardTheme;
        applyTheme(mode);
        const probe=document.createElement('span');
        probe.style.backgroundColor='var(--desk-hover)';
        document.body.append(probe);
        const color=getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      },{palette,mode});
      const actions=page.locator('.reading-more-panel button:not([data-reading-action="delete-current"]):enabled');
      for(const action of await actions.all()){
        await action.hover();
        assert.equal(await action.evaluate(button=>getComputedStyle(button).backgroundColor),
          hoverColor,`${mode} ${palette}: ${(await action.innerText()).trim()}`);
      }
      const remove=page.locator('[data-reading-action="delete-current"]');
      await remove.hover();
      assert.notEqual(await remove.evaluate(button=>getComputedStyle(button).backgroundColor),hoverColor,
        'Delete keeps its danger feedback');
    }
    await page.locator('[data-mail-output="print"]').click();
    const dialog=page.locator('#mail-output-dialog');
    await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
    await page.waitForFunction(()=>!document.querySelector('[data-output-print]').disabled);
    assert.equal(await dialog.locator('input[value="eml"]').isDisabled(),true,'Missing originals must not produce a reconstructed EML');
    assert.equal(await dialog.locator('#mail-output-format').isVisible(),false);
    assert.deepEqual(await dialog.locator('footer button:visible').allTextContents(),['打印']);
    const initial=await page.evaluate(()=>({
      id:selectedEmailDetail.id, account:selectedEmailAccountId||selectedEmailDetail._account_id||activeMailAccount().id,
      document:document.querySelector('#mail-output-preview').srcdoc,
      text:document.querySelector('#mail-output-preview').contentDocument.body.innerText,
      filename:document.querySelector('#mail-output-subject').textContent
    }));
    const previewStyle=()=>page.locator('#mail-output-preview').evaluate(frame=>{
      const doc=frame.contentDocument;
      const root=frame.contentWindow.getComputedStyle(doc.documentElement);
      return {
        background:root.backgroundColor,
        edgeBehavior:root.overscrollBehaviorY,
        bodyEdgeBehavior:frame.contentWindow.getComputedStyle(doc.body).overscrollBehaviorY,
        frameBorder:getComputedStyle(frame).borderTopWidth,
        panel:getComputedStyle(frame.closest('dialog')).backgroundColor,
        header:getComputedStyle(frame.closest('dialog').querySelector('header')).backgroundColor,
        note:frame.contentWindow.getComputedStyle(doc.querySelector('.mail-output-note')).display,
      };
    });
    const darkPreview=await previewStyle();
    assert.equal(darkPreview.background,darkPreview.panel);
    assert.equal(darkPreview.edgeBehavior,'auto');
    assert.equal(darkPreview.bodyEdgeBehavior,'auto');
    assert.equal(await dialog.locator('.mail-output-content').evaluate(el=>getComputedStyle(el).overscrollBehaviorY),'contain');
    assert.equal(darkPreview.frameBorder,'0px');
    assert.equal(darkPreview.header,darkPreview.panel);
    assert.equal(darkPreview.note,'none');
    const frame=page.locator('#mail-output-preview');
    const checkPreviewScroll=async label=>{
      await page.waitForFunction(()=>document.querySelector('#mail-output-preview')?.hasAttribute('data-ready'));
      const state=()=>frame.evaluate(el=>{
        const doc=el.contentDocument,root=doc.scrollingElement,view=el.contentWindow;
        return {top:root.scrollTop,visible:el.parentElement.querySelector('.mail-output-scrollbar').classList.contains('output-scrollbar-visible'),
          hidden:view.getComputedStyle(root).scrollbarWidth==='none'||view.getComputedStyle(root,'::-webkit-scrollbar').display==='none',
          width:doc.body.getBoundingClientRect().width};
      });
      await page.waitForFunction(()=>!document.querySelector('#mail-output-preview-host .mail-output-scrollbar').classList.contains('output-scrollbar-visible'));
      await frame.evaluate(el=>{el.contentDocument.scrollingElement.scrollTop=0;});
      const before=await state(),box=await frame.boundingBox();
      assert.ok(before.hidden,label+': idle native scrollbar is removed');
      // Locator.hover waits for the rendered hit target and stable geometry;
      // the load callback's data-ready flag alone does not commit WebKit's
      // scrolling tree before raw mouse input in the Linux headless renderer.
      await frame.hover({position:{x:box.width/2,y:Math.min(160,box.height/2)}});
      await page.mouse.wheel(0,480);
      try {
        await page.waitForFunction(()=>document.querySelector('#mail-output-preview').contentDocument.scrollingElement.scrollTop>0);
      } catch(error) {
        console.error(label,await frame.evaluate(el=>{
          const doc=el.contentDocument,root=doc.scrollingElement,view=el.contentWindow;
          return {ready:doc.readyState,frame:el.getBoundingClientRect().toJSON(),top:root.scrollTop,
            height:root.scrollHeight,viewport:root.clientHeight,bodyZoom:getComputedStyle(document.body).zoom,
            visibility:getComputedStyle(el).visibility,opacity:getComputedStyle(el).opacity,
            overflow:view.getComputedStyle(root).overflowY,overscroll:view.getComputedStyle(root).overscrollBehaviorY};
        }));
        await page.screenshot({path:`build/mail-output/scroll-failure-${engine}.png`});
        throw error;
      }
      await page.waitForFunction(()=>document.querySelector('#mail-output-preview-host .mail-output-scrollbar').classList.contains('output-scrollbar-visible'));
      const active=await state();
      assert.ok(active.visible,label+': wheel reveals the scrollbar');
      assert.ok(Math.abs(active.width-before.width)<=1,label+': showing the scrollbar keeps the text width stable');
      await page.waitForFunction(()=>!document.querySelector('#mail-output-preview-host .mail-output-scrollbar').classList.contains('output-scrollbar-visible'));
      const idle=await state();
      assert.ok(idle.hidden,label+': scrollbar hides after inactivity');
      assert.ok(Math.abs(idle.width-before.width)<=1,label+': hiding the scrollbar keeps the text width stable');
      await page.mouse.wheel(0,-240);
      await page.waitForFunction(top=>document.querySelector('#mail-output-preview').contentDocument.scrollingElement.scrollTop<top,idle.top);
      const start=await state();
      const thumb=page.locator('#mail-output-preview-host .mail-output-scrollbar i');
      const thumbBox=await thumb.boundingBox();
      await page.mouse.move(thumbBox.x+thumbBox.width/2,thumbBox.y+thumbBox.height/2);
      await page.mouse.down();
      await page.mouse.move(thumbBox.x+thumbBox.width/2,thumbBox.y+thumbBox.height/2+70,{steps:5});
      await page.waitForFunction(top=>document.querySelector('#mail-output-preview').contentDocument.scrollingElement.scrollTop>top,start.top);
      await page.waitForTimeout(1000);
      assert.ok((await state()).visible,label+': holding the thumb keeps it visible');
      await page.mouse.up();
      await page.waitForFunction(()=>!document.querySelector('#mail-output-preview-host .mail-output-scrollbar').classList.contains('output-scrollbar-visible'));

    };
    await checkPreviewScroll('Print');
    assert.ok(await frame.evaluate(el=>el.clientWidth>=innerWidth*.9 && el.clientHeight>=innerHeight*.8));
    const printButton=dialog.locator('[data-output-print]');
    const printPosition=await printButton.boundingBox();
    const scrollPosition=await frame.evaluate(el=>{
      const scroller=el.contentDocument.scrollingElement;
      scroller.scrollTop=scroller.scrollHeight;
      return scroller.scrollTop;
    });
    assert.ok(scrollPosition>0,'The expanded preview must still scroll long emails');
    assert.deepEqual(await printButton.boundingBox(),printPosition,'The print action stays in place while reading');
    await frame.evaluate(el=>{el.contentDocument.scrollingElement.scrollTop=0;});
    for(const mode of ['light','dark']) {
      await page.evaluate(mode=>{
        document.documentElement.dataset.rewardTheme='theme_monochrome';
        applyTheme(mode);
      },mode);
      const monochrome=await previewStyle();
      assert.equal(monochrome.background,monochrome.panel);
    }
    await page.evaluate(()=>{
      delete document.documentElement.dataset.rewardTheme;
      document.dispatchEvent(new CustomEvent('mailai:reward-themechange'));
    });
    await page.emulateMedia({media:'print'});
    const printStyle=await previewStyle();
    assert.equal(printStyle.background,'rgb(255, 255, 255)');
    assert.equal(printStyle.edgeBehavior,'auto');
    await page.emulateMedia({media:'screen'});
    await page.screenshot({path:`build/mail-output/browser-${engine}-dark-print.png`});
    assert.ok(initial.text.includes('请协助确认'));
    assert.ok(!initial.text.includes('AI 助手'));
    await page.evaluate(()=>{
      const frame = document.querySelector('#mail-output-preview').contentWindow;
      frame.print = () => { window.__printedPreview = frame.document.body.innerText; };
    });
    await dialog.locator('[data-output-print]').click();
    await page.waitForFunction(()=>window.__printedPreview?.includes('请协助确认'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('#mail-output-dialog').open);
    await page.waitForFunction(()=>document.activeElement.matches('.reading-more-actions > summary'));

    const raw='From: sender@example.test\r\nSubject: Original mail\r\n\r\nComplete original body';
    const headers=[];
    await page.route(/\/api\/emails\/\d+\/original/,async route=>{
      headers.push(route.request().headers()['x-mailai-account']);
      await route.fulfill({contentType:'message/rfc822',body:raw});
    });
    await page.evaluate(data=>{
      window.__outputData={...data,has_raw:true,notes:[],native_pdf:true,native_share:true,token:'fixture-token',text:data.text};
      window.__outputCalls=[];
      window.pywebview={api:{
        prepare_mail_output:async(id,account)=>{window.__outputCalls.push(['prepare',id,account]);return window.__outputData;},
        mail_output_pdf:async(token)=>{window.__outputCalls.push(['pdf',token]);return {ok:true,data:btoa('%PDF-1.4\nfixture')};},
        print_mail_output:async token=>{window.__outputCalls.push(['print',token]);return {ok:true};},
        save_mail_output:async(token,kind)=>{window.__outputCalls.push(['save',token,kind]);return {ok:true};},
        share_mail_output:async(token,kind)=>{window.__outputCalls.push(['share',token,kind]);return {ok:true};},
        release_mail_output:async token=>{window.__outputCalls.push(['release',token]);return {ok:true};}
      }};
    },initial);
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>{applyTheme(theme);window.mailaiMailOutput.open('share');},theme);
      await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
      assert.equal(await dialog.locator('input[type=file]').count(),0);
      await checkPreviewScroll('Share PDF '+theme);
      assert.ok(await frame.evaluate(el=>el.clientHeight>=innerHeight*.7));
      await dialog.locator('[data-output-save]').click();
      await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
      await dialog.locator('[data-output-share]').click();
      await page.waitForFunction(()=>document.querySelector('#mail-output-status').textContent.includes('系统分享'));
      await dialog.locator('input[value="pdf"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(()=>document.activeElement.value==='text');
      assert.equal(await dialog.locator('[data-output-print]').isVisible(),false);
      assert.match(await dialog.locator('#mail-output-text-preview').innerText(),/请协助确认/);
      assert.ok(await dialog.locator('#mail-output-text-preview').evaluate(el=>el.clientHeight>=innerHeight*.7));
      const textPreview=dialog.locator('#mail-output-text-preview');
      await textPreview.hover();
      await page.mouse.wheel(0,360);
      await page.waitForFunction(()=>document.querySelector('#mail-output-text-preview').scrollTop>0);
      await page.waitForFunction(()=>!document.querySelector('#mail-output-text-host .mail-output-scrollbar').classList.contains('output-scrollbar-visible'));
      assert.ok(await textPreview.evaluate(el=>getComputedStyle(el).scrollbarWidth==='none'||getComputedStyle(el,'::-webkit-scrollbar').display==='none'));
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(()=>document.activeElement.value==='eml');
      await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
      await checkPreviewScroll('Share EML '+theme);
      await dialog.locator('[data-output-save]').click();
      await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
      await page.screenshot({path:`build/mail-output/browser-${engine}-${theme}.png`});
      assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await dialog.locator('[data-output-close]').click();
      await page.waitForFunction(()=>!document.querySelector('#mail-output-dialog').open);
    }
    assert.deepEqual(headers,[],'Desktop file actions should reuse the prepared message token');
    const calls=await page.evaluate(()=>window.__outputCalls);
    for(const name of ['prepare','share','save','release']) assert.ok(calls.some(call=>call[0]===name));
    assert.ok(calls.some(call=>call[0]==='save'&&call[2]==='eml'));

    // A completed native preparation after dismissal must release its token and
    // must not reopen a dialog or replace another message's preview.
    await page.evaluate(()=>{
      window.pywebview.api.prepare_mail_output=()=>new Promise(resolve=>window.__finishOutput=resolve);
      window.mailaiMailOutput.open('share');
    });
    await dialog.locator('[data-output-close]').click();
    await page.waitForFunction(()=>!document.querySelector('#mail-output-dialog').open);
    await page.evaluate(()=>window.__finishOutput({...window.__outputData,token:'late-token'}));
    await page.waitForFunction(()=>window.__outputCalls.some(call=>call[0]==='release'&&call[1]==='late-token'));
    assert.equal(await dialog.isVisible(),false);
    assert.equal(await page.locator('#mail-output-preview').count(),0,'Dismissal must remove the mail document frame');

    // File sharing stays in the explicit click handler. Cancellation is normal.
    await page.evaluate(()=>{
      window.pywebview.api.prepare_mail_output=async()=>({...window.__outputData,native_share:false});
      Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
      Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.__sharedFile=data.files[0].name;throw new DOMException('Canceled','AbortError');}});
      window.mailaiMailOutput.open('share');
    });
    await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
    await page.waitForFunction(()=>!document.querySelector('[data-output-share]').disabled);
    await dialog.locator('[data-output-share]').click();
    await page.waitForFunction(()=>document.querySelector('#mail-output-status').textContent.includes('已取消'));
    assert.ok((await page.evaluate(()=>window.__sharedFile)).endsWith('.pdf'));
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.equal(await dialog.locator('h2').innerText(),'Share email');
    assert.equal(await dialog.locator('[data-output-save]').innerText(),'Save as PDF');
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.setViewportSize({width:375,height:812});
    await page.screenshot({path:`build/mail-output/browser-${engine}-narrow.png`});
    assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
    assert.ok(await frame.evaluate(el=>el.getBoundingClientRect().height>=innerHeight*.6));
    for(const language of ['zh-CN','en']) for(const theme of ['','theme_monochrome','theme_baowu']) {
      await page.evaluate(({language,theme})=>{
        setI18nLanguage(language);document.body.style.zoom='1.25';document.documentElement.style.setProperty('--fz','1.25');
        if(theme)document.documentElement.dataset.rewardTheme=theme;else document.documentElement.removeAttribute('data-reward-theme');
      },{language,theme});
      for(const mode of ['light','dark']) {
        await page.evaluate(mode=>applyTheme(mode),mode);
        const metrics=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:el.scrollWidth>el.clientWidth+2};});
        assert.ok(metrics.left>=-1&&metrics.right<=376&&metrics.top>=-1&&metrics.bottom<=813&&!metrics.overflow,JSON.stringify({language,theme,mode,metrics}));
      }
    }
    await checkPreviewScroll('Share narrow at 125%');
    await page.setViewportSize({width:640,height:320});
    assert.ok(await frame.evaluate(el=>el.getBoundingClientRect().height>=90));
    const landscapeActions=await dialog.locator('footer').boundingBox();
    assert.ok(landscapeActions.y+landscapeActions.height<=320);
    await page.setViewportSize({width:375,height:812});
    await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');setI18nLanguage('zh-CN');document.documentElement.removeAttribute('data-reward-theme');});
    const pdfRequests=[];
    await page.route(/\/api\/emails\/\d+\/pdf/,async route=>{
      pdfRequests.push(route.request());
      await route.fulfill({contentType:'application/pdf',body:'%PDF-1.4\ncurrent mail'});
    });
    await page.evaluate(()=>{
      delete window.pywebview;
      delete navigator.canShare;
      delete navigator.share;
      Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
      // Reopen in the same task, before the queued native dialog close event.
      document.querySelector('[data-output-close]').click();
      window.mailaiMailOutput.open('share');
    });
    await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
    assert.deepEqual(await dialog.locator('footer button:visible').allTextContents(),['另存为 PDF']);
    assert.equal(pdfRequests.length,0,'Do not render a download before it is requested');
    const result=page.waitForEvent('download');
    await dialog.locator('[data-output-save]').click();
    const download=await result;
    assert.equal(download.suggestedFilename(),initial.filename+'.pdf');
    assert.equal(fs.readFileSync(await download.path(),'utf8'),'%PDF-1.4\ncurrent mail');
    assert.equal(pdfRequests.length,1);
    assert.equal(pdfRequests[0].headers()['x-mailai-account'],initial.account);
    assert.equal(new URL(pdfRequests[0].url()).pathname,`/api/emails/${initial.id}/pdf`);
    await dialog.locator('[data-output-close]').click();
    await page.evaluate(()=>{window.pywebview={api:{release_mail_output:async()=>({ok:true})}};});

    // Outgoing records and incoming mail may have the same numeric ID. The
    // rendered action must carry its source instead of using stale selection.
    const outgoingAccount=await page.evaluate(()=>activeMailAccount().id);
    for(const remote of [false,true]) {
      await page.evaluate(async remote=>{
        window.pywebview.api.prepare_mail_output=async(id,account,language,source)=>{
          window.__sentOutputRef={id,account,source};return window.__outputData;
        };
        specialMailbox='sent';
        await selectSpecialMessage(remote?-99:42,{id:remote?-99:42,remote_email_id:remote?99:null,
          _remote:remote,status:'sent',subject:'Synthetic sent output',to_addr:'reader@example.test',
          body_html:'<p>Outgoing message body</p>',attachments:[]});
      },remote);
      await page.locator('.special-mail-actions [data-mail-output="share"]').click();
      await page.waitForFunction(()=>!document.querySelector('#mail-output-format').disabled);
      const reference=await page.evaluate(()=>window.__sentOutputRef);
      assert.equal(reference.id,remote?99:42);
      assert.equal(reference.source,remote?'email':'sent');
      assert.equal(reference.account,outgoingAccount);
      await dialog.locator('[data-output-close]').click();
    }

    if(engine==='chromium') {
      const output=await browser.newPage();
      await output.setContent(initial.document);
      await output.pdf({path:'build/mail-output/browser-output.pdf',format:'A4',printBackground:true});
      await output.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS '+engine+' single-mail preview, PDF/save/share/print, original identity, cancellation, late close, light/dark/narrow');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
