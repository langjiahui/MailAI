// Isolated workspace fixture: inspect maintenance without creating/restoring data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium,webkit}=require('playwright');
(async()=>{
  const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1512,height:1000},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const backups=[0,1,2,3].map((n)=>({created_at:`2026-10-0${7-n}T14:27:18`,filename:`MailAI-very-long-account-name-20261007-142713-${n}-auto.zip`,size:128000000}));
    await page.route('**/api/system/backups',r=>r.fulfill({json:backups}));
    await page.route('**/api/system/portable-backups',r=>r.fulfill({json:[]}));
    await page.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.body.dataset.petStage);
    await page.evaluate(()=>{setI18nLanguage('zh-CN');showSystemView('maintenance');});
    await page.locator('.backup-item').first().waitFor();
    fs.mkdirSync('build/maintenance-theme-preview',{recursive:true});
    async function inspect() {
      return page.locator('[data-system-panel="maintenance"]').evaluate(panel=>{
        const ctx=document.createElement('canvas').getContext('2d');
        const paint=c=>{ctx.fillStyle=c;ctx.fillRect(0,0,1,1)};
        const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
        const contrast=n=>{
          const chain=[];for(let p=n;p;p=p.parentElement)chain.unshift(p);
          ctx.clearRect(0,0,1,1);paint('#fff');chain.forEach(p=>paint(getComputedStyle(p).backgroundColor));
          const bg=lum([...ctx.getImageData(0,0,1,1).data]);
          ctx.clearRect(0,0,1,1);paint(getComputedStyle(n).color);const fg=lum([...ctx.getImageData(0,0,1,1).data]);
          return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);
        };
        const cards=[...panel.querySelectorAll('.diagnostic-card')];
        const copy=[...panel.querySelectorAll('h3,h4,.maintenance-card-copy p,.maintenance-subsection-head p,.backup-record-copy b,.backup-record-copy small,.backup-record-size,.maintenance-migration-note,.maintenance-cleanup-steps b,.maintenance-cleanup-steps small,.maintenance-badge:not(.caution),.portable-export-range>span,.older-backups>summary')].filter(n=>n.getClientRects().length);
        const buttons=[...panel.querySelectorAll('button:not(:disabled)')].filter(n=>n.getClientRects().length);
        const nodes=[...cards,...panel.querySelectorAll('.maintenance-backup-body,.maintenance-migration,.backup-record-actions,.portable-export-range')];
        return {
          images:cards.map(n=>getComputedStyle(n).backgroundImage),
          contrast:[...copy,...buttons].map(n=>({label:n.textContent.trim().slice(0,45),ratio:contrast(n)})),
          overflow:nodes.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.className),
          aligned:Math.abs(cards[0].getBoundingClientRect().top-cards[1].getBoundingClientRect().top)>1||Math.abs(cards[0].getBoundingClientRect().height-cards[1].getBoundingClientRect().height)<1
        };
      });
    }
await page.evaluate(async()=>{for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh();});
    for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
      await page.evaluate(async({theme,mode})=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();applyTheme(mode);},{theme,mode});
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.rewardTheme||''),theme);
      await page.mouse.move(10,100);
      const values=await inspect();
      assert(values.images.every(v=>v==='none'),`${theme}/${mode}: cards must use solid surfaces`);
      assert(values.contrast.every(v=>v.ratio>=4.5),JSON.stringify({theme,mode,failed:values.contrast.filter(v=>v.ratio<4.5)}));
      assert.deepEqual(values.overflow,[]);assert(values.aligned);
      for(const selector of ['#btn-import-client-mail','#btn-run-diagnostics','#btn-create-backup','.backup-record-actions button','#btn-export-portable']) {
        await page.locator(selector).first().hover();
        const hover=await inspect();
        assert(hover.contrast.every(v=>v.ratio>=4.5),JSON.stringify({theme,mode,selector,failed:hover.contrast.filter(v=>v.ratio<4.5)}));
      }
      await page.mouse.move(10,100);
      await page.screenshot({path:`build/maintenance-theme-preview/${theme||'default'}-${mode}-${process.env.MAILAI_BROWSER||'chromium'}.png`});
    }
    for(const width of [900,720,390])for(const scale of [1,1.3]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(scale=>{document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale)},scale);
      const values=await inspect();assert.deepEqual(values.overflow,[],JSON.stringify({width,scale,values}));assert(values.aligned);
    }
    await page.locator('#btn-run-diagnostics').focus();
    assert.equal(await page.locator('#btn-run-diagnostics').evaluate(n=>getComputedStyle(n).outlineStyle),'solid');
    assert.deepEqual(errors,[]);
    await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();});
    console.log('PASS maintenance: solid cards, text/button hover contrast in six palettes, responsive backups, font zoom and keyboard focus');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
