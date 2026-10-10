/* Fresh isolated growth fixture; no real mailbox/model/network services. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async()=>{
  const browser = await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>!!document.body.dataset.petStage);
    await page.emulateMedia({reducedMotion:'reduce'});
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
          const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});
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
          assert.equal(colors.bg,{theme_monochrome:{light:'rgb(241, 242, 244)',dark:'rgb(17, 18, 22)'},theme_baowu:{light:'rgb(237, 243, 249)',dark:'rgb(12, 24, 38)'}}[theme][mode]);
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
            assert.equal(panel.bg,panels.expected[['.sidebar','.list-pane'].includes(panel.selector)?'soft':'surface'],JSON.stringify({theme,mode,panel}));
            assert(panel.contrast>=4.5,JSON.stringify({theme,mode,panel}));
          }
          assert(panels.selected>=4.5,`${theme}/${mode} selected row contrast`);
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
    assert.deepEqual(errors,[]);
    console.log('Reward themes: purchases/retry, persistence, light/dark, both pet routes, palette priority, contrast, reset, mobile, i18n and client-wide sharing passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
