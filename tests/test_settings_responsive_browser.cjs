// Start workspace_preview.py with MAILAI_REWARD_MOTION_FIXTURE=1 for temporary theme credits.
// Isolated fixture only; never opens a real mailbox or changes credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium, webkit} = require('playwright');
(async () => {
  const engine = process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true});
  const errors = [];
  const tabs = ['preferences','account','ai','remote','maintenance','guide','about'];
  try {
    const page = await browser.newPage({viewport:{width:1512,height:1000},reducedMotion:'reduce'});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage);
    await page.evaluate(async()=>{
      for (const item of ['theme_monochrome','theme_baowu']) await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});
      await mailaiPet.refresh();
    });
    for(const tab of tabs) await page.evaluate(tab=>showSystemView(tab),tab);
    const out = 'build/settings-preview'; fs.mkdirSync(out,{recursive:true});
    let cases = 0;
    for(const theme of ['', 'theme_monochrome', 'theme_baowu']) {
      await page.evaluate(async theme=>{
        await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();
      },theme);
      for(const mode of ['light','dark']) for(const language of ['zh-CN','en']) {
        await page.evaluate(({mode,language})=>{applyTheme(mode);setI18nLanguage(language);document.getElementById("interface-language").value=language;syncPreferenceChoices();},{mode,language});
        for(const [width,scale] of [[390,1],[720,1.25],[900,1],[1200,1.25],[1512,1],[1920,1.25],[2560,1],[3440,1]]) {
          await page.setViewportSize({width,height:1000});
          await page.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);},scale);
          for(const tab of tabs) {
            await page.evaluate(tab=>{selectSystemTab(tab);document.querySelector(`[data-system-panel="${tab}"]`).scrollTop=0;},tab);
            const context = {theme,mode,language,width,scale,tab};
            const geometry = await page.locator(`[data-system-panel="${tab}"]`).evaluate(panel=>{
              const bounds = panel.getBoundingClientRect();
              const selectors = '.preference-card,.account-directory,.account-detail,.connection-card,.diagnostic-card,.remote-setup-guide,.help-topic,.help-toolbar,.author-trust-card,.app-update-card';
              const cards = [...panel.querySelectorAll(selectors)].filter(n=>n.getClientRects().length);
              const escaped = cards.filter(n=>{const r=n.getBoundingClientRect();return r.left<bounds.left-2 || r.right>bounds.right+2 || n.scrollWidth>n.clientWidth+2;}).map(n=>({class:n.className,scroll:n.scrollWidth,client:n.clientWidth,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right}));
              const close=document.querySelector('#btn-close-system').getBoundingClientRect();
              return {overflow:panel.scrollWidth>panel.clientWidth+2,escaped,bounds:{left:bounds.left,right:bounds.right},close:{top:close.top,bottom:close.bottom,right:close.right},pageOverflow:document.documentElement.scrollWidth>innerWidth+1};
            });
            assert(!geometry.overflow && !geometry.pageOverflow && !geometry.escaped.length,JSON.stringify({context,geometry}));
            assert(geometry.close.top>=0 && geometry.close.bottom<=1000 && geometry.close.right<=width+1,JSON.stringify({context,geometry}));
            assert.equal(await page.locator('#system-tabs [aria-current="page"]').getAttribute('data-system-tab'),tab);
            const navVisible=await page.locator('#system-tabs [aria-current="page"]').evaluate(button=>{
              const nav=button.parentElement.getBoundingClientRect(),r=button.getBoundingClientRect();
              return r.left>=nav.left-2 && r.right<=nav.right+2;
            });
            assert(navVisible,JSON.stringify({context,message:'Selected category must remain visible in the horizontal navigation'}));
            if((width===1512 && mode==='light' && language==='zh-CN' && theme==='') || (width===2560 && mode==='dark' && language==='en' && theme==='theme_baowu') || (width===390 && mode==='dark' && language==='en' && theme==='theme_monochrome')) {
              await page.screenshot({path:`${out}/${tab}-${theme||'default'}-${mode}-${language}-${width}-${process.env.MAILAI_BROWSER||'chromium'}.png`});
            }
            if(width===1512) {
              const failures=await page.locator(`[data-system-panel="${tab}"]`).evaluate(root=>{
                const ctx=document.createElement('canvas').getContext('2d');
                const paint=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);};
                const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
                return [...root.querySelectorAll('h3,h4,legend,small,.form-hint,.preference-note,.settings-page-intro p,.author-trust-card p,.author-boundary p,button:not(:disabled)')]
                  .filter(n=>n.getClientRects().length && n.textContent.trim() && !n.closest('fieldset:disabled'))
                  .map(n=>{
                    const chain=[];for(let parent=n;parent;parent=parent.parentElement)chain.unshift(parent);
                    ctx.clearRect(0,0,1,1);paint('#fff');chain.forEach(parent=>paint(getComputedStyle(parent).backgroundColor));
                    const bg=luminance([...ctx.getImageData(0,0,1,1).data]);
                    ctx.clearRect(0,0,1,1);paint(getComputedStyle(n).color);const fg=luminance([...ctx.getImageData(0,0,1,1).data]);
                    return {text:n.textContent.trim().slice(0,60),ratio:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)};
                  }).filter(n=>n.ratio<4.5);
              });
              assert.deepEqual(failures,[],JSON.stringify({context,failures}));
            }
            cases++;
          }
        }
      }
    }
    // Real preference interactions still work after the controls are regrouped.
    await page.setViewportSize({width:1512,height:1000});
    await page.evaluate(()=>{document.body.style.zoom='1';document.documentElement.style.setProperty('--fz','1');setI18nLanguage('en');showSystemView('preferences');});
    await page.locator('input[name="workspace-density-choice"][value="compact"]').check();
    assert.equal(await page.locator('#workspace-density').inputValue(),'compact');
    await page.locator('input[name="interface-language-choice"][value="zh-CN"]').check();
    await page.locator('input[name="interface-language-choice"][value="en"]').check();
    assert.equal(await page.locator('[data-i18n="settings.syncTitle"]').textContent(),'Sync and folders');
    assert.equal(await page.locator('[data-i18n="settings.companionTitle"]').textContent(),'Companion and personalization');
    const folders=page.locator('#show-server-folders');const original=await folders.isChecked();
    await folders.setChecked(!original);await folders.setChecked(original);
    // Off/on switches must retain distinct, contrasting tracks and thumbs.
    const paint = await folders.evaluate(input=>{
      const track=input.nextElementSibling,thumb=getComputedStyle(track,'::after');
      return {track:getComputedStyle(track).backgroundColor,thumb:thumb.backgroundColor};
    });
    assert.notEqual(paint.track,paint.thumb);
    await page.reload();await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>showSystemView('preferences'));
    assert.equal(await page.locator('#workspace-density').inputValue(),'compact');
    assert.equal(await page.locator('#show-server-folders').isChecked(),original);
    await page.locator('input[name="workspace-density-choice"][value="comfortable"]').check();
    // Keyboard navigation keeps the selected category reachable and marked.
    await page.locator('[data-system-tab="preferences"]').focus();await page.keyboard.press('End');
    assert.equal(await page.locator('#system-tabs [aria-current="page"]').getAttribute('data-system-tab'),'about');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#system-tabs [aria-current="page"]').getAttribute('data-system-tab'),'preferences');
    await page.evaluate(async()=>{setI18nLanguage('zh-CN');applyTheme('light');await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});});
    assert.deepEqual(errors,[]);
    console.log(`Settings: ${cases} layouts across 7 tabs, 6 palettes, 2 languages and 390–3440px; saved preferences and keyboard navigation passed (${process.env.MAILAI_BROWSER||'chromium'}).`);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
