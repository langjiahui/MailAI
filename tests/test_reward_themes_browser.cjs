/* Fresh isolated growth fixture; no real mailbox/model/network services. */
const assert = require('node:assert/strict');
const {chromium,webkit} = require('playwright');
(async()=>{
  const browser = await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>!!document.body.dataset.petStage);
    await page.emulateMedia({reducedMotion:'reduce'});
    const snapshot=()=>page.evaluate(()=>['body','.topbar','.sidebar','.list-pane','.reading-pane','.global-search'].map(selector=>{
      const css=getComputedStyle(document.querySelector(selector));
      return {selector,background:css.backgroundColor,color:css.color,shadow:css.boxShadow,blur:css.backdropFilter || css.webkitBackdropFilter};
    }));
    const defaults={};
    for(const mode of ['light','dark']) {
      await page.evaluate(mode=>applyTheme(mode),mode);
      defaults[mode]=await snapshot();
    }
    await page.evaluate(async()=>{
      setI18nLanguage('zh-CN');applyTheme('light');
      await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});
      await window.mailaiPet.refresh();showSystemView('preferences');
    });
    await page.locator('#companion-theme-settings').click();
    const dialog=page.locator('#companion-growth-dialog');
    await dialog.locator('[data-pet-buy="theme_monochrome"]').waitFor({state:'visible'});
    assert.match(await dialog.locator('[data-pet-buy="theme_monochrome"]').textContent(),/300/);
    assert.match(await dialog.locator('[data-pet-buy="theme_baowu"]').textContent(),/480/);
    const before=await page.evaluate(()=>api('/api/companion/growth'));
    await dialog.locator('[data-pet-buy="theme_monochrome"]').click();
    await page.waitForFunction(()=>document.documentElement.dataset.rewardTheme === 'theme_monochrome');
    const mono=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(mono.stamps,before.stamps-300);assert.equal(mono.xp,before.xp);
    assert.match(await page.locator('#companion-theme-summary').textContent(),/黑白简约/);
    await page.keyboard.press('Escape');await page.evaluate(()=>hideSystemView(true));
    await page.screenshot({path:'/tmp/mailai-theme-monochrome-light.png'});
    await page.evaluate(()=>window.mailaiPet.openThemes());
    // Lost response after a real theme purchase; reload/retry charges only once.
    let token;
    await page.route('**/api/companion/purchase',async route=>{
      token=route.request().postDataJSON().token;
      const response=await route.fetch();assert.equal(response.status(),200);
      await route.fulfill({status:503,contentType:'application/json',body:'{"detail":"fixture theme response lost"}'});
    });
    await dialog.locator('[data-pet-buy="theme_baowu"]').click();
    await dialog.locator('[data-pet-reconcile]').waitFor({state:'visible'});
    const committed=await page.evaluate(()=>api('/api/companion/growth'));
    assert.equal(committed.stamps,mono.stamps-480);
    await page.unroute('**/api/companion/purchase');
    await page.reload();await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.documentElement.dataset.rewardTheme === 'theme_baowu');
    await page.evaluate(()=>window.mailaiPet.openThemes());
    const retries=[];page.on('request',request=>{if(request.url().endsWith('/api/companion/purchase'))retries.push(request.postDataJSON().token);});
    await dialog.locator('[data-pet-reconcile]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-pet-reconcile]'));
    assert.equal(retries[0],token);
    assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).stamps,committed.stamps);
    // Both styles and both brightness modes share the redeemed workspace skin.
    await page.emulateMedia({reducedMotion:'reduce'});
    const contrast=await page.evaluate(()=>{
      window.rewardThemeContrast=(foreground,background)=>{
        const lum=color=>{
          // Computed color-mix values may use color(srgb ...), not rgb bytes.
          const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
          const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,1,1);
          const rgb=[...context.getImageData(0,0,1,1).data].slice(0,3).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});
          return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
        };
        const a=lum(foreground),b=lum(background);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      };return true;
    });assert(contrast);
    for(const theme of ['theme_monochrome','theme_baowu']) {
      if(await dialog.locator(`[data-pet-equip="${theme}"]`).isEnabled())await dialog.locator(`[data-pet-equip="${theme}"]`).click();
      await page.waitForFunction(expected=>document.documentElement.dataset.rewardTheme===expected,theme);
      for(const style of ['nature','ranger']) {
        if(await dialog.locator(`[data-pet-style="${style}"]`).isEnabled())await dialog.locator(`[data-pet-style="${style}"]`).click();
        await page.waitForFunction(expected=>document.body.dataset.petStyle===expected,style);
        for(const mode of ['light','dark']) {
          await page.evaluate(mode=>applyTheme(mode),mode);
          const colors=await page.evaluate(()=>{
            const body=getComputedStyle(document.body),button=getComputedStyle(document.querySelector('#btn-compose'));
            return {bg:body.backgroundColor,button:rewardThemeContrast(button.color,button.backgroundColor),text:rewardThemeContrast(body.color,body.backgroundColor),pet:getComputedStyle(document.querySelector('.pet-hero .growth-body')).fill};
          });
          assert.equal(colors.bg,mode==='light'?'rgb(255, 255, 255)':theme==='theme_monochrome'?'rgb(23, 23, 23)':'rgb(22, 24, 26)');
          assert(colors.button>=4.5 && colors.text>=4.5,JSON.stringify({theme,style,mode,colors}));
          assert.equal(colors.pet,theme === 'theme_monochrome' ? 'rgb(208, 210, 214)' : 'rgb(149, 198, 231)');
          await page.keyboard.press('Escape');
          await page.evaluate(()=>hideSystemView(true));
          const owner=await page.evaluate(()=>activeMailAccount().id);
          await page.locator(`.email-item[data-account-id="${owner}"]`).first().click();
          await page.waitForFunction(expected=>document.documentElement.dataset.rewardTheme===expected,theme);
          const panels=await page.evaluate(()=>{
            const root=getComputedStyle(document.documentElement);
            const color=value=>{const n=document.createElement('span');n.style.color=value;document.body.append(n);const c=getComputedStyle(n).color;n.remove();return c;};
            const expected={surface:color(root.getPropertyValue('--reward-surface')),soft:color(root.getPropertyValue('--reward-soft')),selected:color(root.getPropertyValue('--reward-selected'))};
            return {expected,rows:['.sidebar','.list-pane','.reading-pane','.topbar','.global-search'].map(selector=>{
              const c=getComputedStyle(document.querySelector(selector));return {selector,bg:c.backgroundColor,contrast:rewardThemeContrast(c.color,c.backgroundColor)};
            }),selected:rewardThemeContrast(getComputedStyle(document.querySelector('.email-item.selected .email-subject')).color,expected.selected)};
          });
          for(const panel of panels.rows) {
            assert.equal(panel.bg,panels.expected[['.sidebar','.list-pane','.global-search'].includes(panel.selector)?'soft':'surface'],JSON.stringify({theme,mode,panel}));
            assert(panel.contrast>=4.5,JSON.stringify({theme,mode,panel}));
          }
          assert(panels.selected>=4.5,`${theme}/${mode} selected row contrast`);
          await page.waitForFunction(()=>document.querySelector('#email-list .selection-glass-plate:not([hidden])'));
          const material=await page.evaluate(()=>['.topbar','#email-list .selection-glass-plate','#assistant-panel'].map(selector=>{
            const css=getComputedStyle(document.querySelector(selector));
            return {selector,blur:css.backdropFilter || css.webkitBackdropFilter,background:css.backgroundColor,shadow:css.boxShadow};
          }));
          assert(material.every(item=>!item.blur || item.blur==='none'),JSON.stringify({theme,mode,material}));
          assert.equal(material[1].background,panels.expected.selected,'Selected fill must be opaque');
          assert.equal(material[1].shadow,'none','Selection must remain flat and quiet');
          await page.emulateMedia({contrast:'more'});
          await page.waitForFunction(()=>getComputedStyle(document.querySelector('#email-list .selection-glass-plate')).boxShadow.includes('inset'));
          const edgeContrast=await page.evaluate(()=>{
            const css=getComputedStyle(document.querySelector('#email-list .selection-glass-plate'));
            return rewardThemeContrast(css.borderLeftColor,css.backgroundColor);
          });
          assert(edgeContrast>=3,'Increased contrast must restore a clear selection boundary');
          await page.emulateMedia({contrast:'no-preference'});
          await page.waitForFunction(()=>getComputedStyle(document.querySelector('#email-list .selection-glass-plate')).boxShadow==='none');
          const hover=page.locator('.email-item:not(.selected)').first();await hover.hover();
          const hovered=await hover.evaluate(n=>getComputedStyle(n).backgroundColor);
          assert.notEqual(hovered,panels.expected.surface,'Hover must remain visible on the pure canvas');
          assert.notEqual(hovered,panels.expected.selected,'Hover must differ from selection');
          await page.keyboard.press('Tab');await page.locator('#btn-compose').focus();
          assert.equal(await page.locator('#btn-compose').evaluate(n=>getComputedStyle(n).outlineStyle),'solid');
          for(const selector of ['#btn-compose','.reading-actions button.reading-primary-action']) {
            const button=page.locator(selector).first();await button.hover();
            assert(await button.evaluate(node=>{const css=getComputedStyle(node),label=node.querySelector('.reading-action-label,span[data-i18n]');return rewardThemeContrast(getComputedStyle(label || node).color,css.backgroundColor)>=4.5}),`${theme}/${mode}/${selector}: hover contrast`);
          }
          await page.mouse.move(1400,50);
          await page.locator('#global-search').focus();
          const focusedSearch=await page.locator('.global-search').evaluate(node=>{const css=getComputedStyle(node);return {background:css.backgroundColor,shadow:css.boxShadow};});
          assert.equal(focusedSearch.background,panels.expected.surface,'Focused search must rise above the quiet field');
          assert.notEqual(focusedSearch.shadow,'none','Search focus must remain visible');
          await page.locator('#global-search').evaluate(node=>node.blur());
          if(style==='ranger')await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-reading.png`});
          await page.evaluate(()=>showSystemView('preferences'));
          const settings=await page.locator('.preference-card').first().evaluate(n=>{const c=getComputedStyle(n);return {bg:c.backgroundColor,contrast:rewardThemeContrast(c.color,c.backgroundColor)};});
          assert.equal(settings.bg,panels.expected.surface);assert(settings.contrast>=4.5);
          if(style==='ranger')await page.screenshot({path:`/tmp/mailai-${theme}-${mode}-settings.png`});
          await page.evaluate(()=>window.mailaiPet.openThemes());
        }
      }
    }
    await page.evaluate(()=>applyTheme('light'));
    await dialog.locator('.pet-journal-body').evaluate(node=>node.scrollTop=0);
    await page.screenshot({path:'/tmp/mailai-theme-baowu-shop.png'});
    await page.keyboard.press('Escape');
    await page.screenshot({path:'/tmp/mailai-theme-baowu-light.png'});
    await page.evaluate(()=>applyTheme('dark'));
    await page.screenshot({path:'/tmp/mailai-theme-baowu-dark.png'});
    await page.evaluate(()=>window.mailaiPet.openThemes());
    // Individual pet palettes take priority; skin does not replace gear or XP.
    await dialog.locator('[data-pet-buy="sky"]').click();
    await page.waitForFunction(()=>document.body.dataset.petPalette === 'sky');
    assert.equal(await dialog.locator('.pet-hero .growth-body').evaluate(node=>getComputedStyle(node).fill),'rgb(178, 215, 237)');
    const balance=(await page.evaluate(()=>api('/api/companion/growth'))).stamps;
    await dialog.locator('.pet-themes-title [data-pet-slot="theme"]').click();
    await page.waitForFunction(()=>!document.documentElement.dataset.rewardTheme);
    await dialog.locator('[data-pet-equip="theme_baowu"]').click();
    await page.waitForFunction(()=>document.documentElement.dataset.rewardTheme === 'theme_baowu');
    assert.equal((await page.evaluate(()=>api('/api/companion/growth'))).stamps,balance);
    await page.evaluate(()=>setI18nLanguage('en'));
    assert(!/[\u3400-\u9fff]/.test(await dialog.textContent()));
    await page.setViewportSize({width:390,height:844});
    assert(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    assert(await dialog.locator('.pet-journal-body').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await page.screenshot({path:'/tmp/mailai-theme-baowu-mobile.png'});
    await page.keyboard.press('Escape');
    await page.evaluate(async()=>{
      const config=await api('/api/system/config'),other=config.accounts.find(account=>!account.active);
      await activateMailAccount(other.id,{quiet:true});
    });
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.rewardTheme),'theme_baowu');
    await page.evaluate(()=>window.mailaiPet.openThemes());
    assert(await dialog.locator('[data-pet-slot="theme"][data-pet-equip="theme_monochrome"]').isEnabled());
    await page.evaluate(async()=>{
      const config=await api('/api/system/config'),work=config.accounts.find(account=>account.user==='work@example.test');
      await activateMailAccount(work.id,{quiet:true});
    });
    await page.waitForFunction(()=>document.documentElement.dataset.rewardTheme === 'theme_baowu');
    await page.evaluate(async()=>{
      await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});
      await mailaiPet.refresh();hideSystemView(true);
    });
    await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:960});await page.mouse.move(1400,50);
    for(const mode of ['light','dark']) {
      await page.evaluate(mode=>applyTheme(mode),mode);
      assert.deepEqual(await snapshot(),defaults[mode],`Default ${mode} theme must fully restore its materials`);
    }
    assert.deepEqual(errors,[]);
    console.log('Reward themes: purchases/retry, persistence, light/dark, both pet routes, palette priority, contrast, reset, mobile, i18n and client-wide sharing passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
