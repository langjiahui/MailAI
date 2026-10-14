// Real cascade + resizable pane; isolated workspace fixture with no live mail.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
  const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
    await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
    await page.goto('http://127.0.0.1:18795/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('.sidebar-account-folders [data-account-action="inbox"]').first().click();
    await page.locator('.email-item').first().click();
    await page.locator('.email-item').nth(2).click({modifiers:['Shift']});
    await page.locator('#bulk-toolbar').waitFor({state:'visible'});
    const toolbar=page.locator('#bulk-toolbar');
    assert.match(await page.locator('#bulk-count').textContent(),/3/);
    await page.evaluate(async()=>{
      for(const item of ['theme_monochrome','theme_baowu'])await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});
      await mailaiPet.refresh();
    });
    let expectedTheme='',expectedMode='light';
    async function check(label) {
      const value=await toolbar.evaluate(bar=>{
        const ctx=document.createElement('canvas').getContext('2d');
        const rgba=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
        const blend=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]/255+bg[i]*(1-fg[3]/255)).concat(255);
        const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
        const rect=bar.getBoundingClientRect(),bg=rgba(getComputedStyle(bar).backgroundColor);
        const nodes=[bar.querySelector('#bulk-count'),...bar.querySelectorAll('button,select')].filter(n=>getComputedStyle(n).display!=='none');
        const list=bar.parentElement.querySelector('#email-list').getBoundingClientRect();
        return {theme:document.documentElement.dataset.rewardTheme||'',mode:document.documentElement.dataset.theme,image:getComputedStyle(bar).backgroundImage,overflow:bar.scrollWidth>bar.clientWidth,
          overlapsList:rect.bottom>list.top+1,
          controls:nodes.map(n=>{const css=getComputedStyle(n),r=n.getBoundingClientRect(),b=lum(blend(rgba(css.backgroundColor),bg)),a=lum(rgba(css.color));
            return {id:n.id||n.dataset.bulkAction,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),
              inside:r.left>=rect.left-1&&r.right<=rect.right+1&&r.top>=rect.top-1&&r.bottom<=rect.bottom+1,
              image:css.backgroundImage,stroke:n.querySelector('svg')?getComputedStyle(n.querySelector('svg')).stroke:css.color,color:css.color};})};
      });
      assert.equal(value.theme,expectedTheme,`${label}: theme must remain equipped`);
      assert.equal(value.mode,expectedMode);
      assert.equal(value.image,'none',`${label}: no accent gradient`);
      assert(!value.overflow&&!value.overlapsList,`${label}: ${JSON.stringify(value)}`);
      for(const c of value.controls){assert(c.inside,`${label}: clipped ${c.id}`);assert(c.ratio>=4.5,`${label}: low contrast ${JSON.stringify(c)}`);assert(!c.image.includes('gradient'),`${label}: gradient ${c.id}`);assert.equal(c.stroke,c.color);}
    }
    for(const theme of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark']) {
      expectedTheme=theme;expectedMode=mode;
      await page.evaluate(async({theme,mode})=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:theme})});await mailaiPet.refresh();applyTheme(mode);setI18nLanguage('zh-CN');},{theme,mode});
      // Refreshing the equipped theme can replace list rows. Query and read in
      // one page evaluation so WebKit never measures a detached locator node.
      await page.waitForFunction(()=>document.querySelectorAll('.email-item.bulk-selected').length===3);
      const selected=await page.evaluate(()=>{const n=document.querySelector('.email-item.bulk-selected');return {bg:getComputedStyle(n).backgroundColor,list:getComputedStyle(n.parentElement).backgroundColor,image:getComputedStyle(n).backgroundImage};});
      assert.equal(selected.image,'none','Selection must use a quiet surface');
      assert.notEqual(selected.bg,selected.list,'Selected messages remain visible');
      for(const width of [240,320,440,560,700]) {
        await page.locator('.list-pane').evaluate((n,width)=>{n.style.setProperty('width',width+'px','important');n.style.setProperty('flex','0 0 '+width+'px','important');n.style.setProperty('min-width','0','important');},width);
        await page.mouse.move(20,950);await check(`${theme}/${mode}/${width}/rest`);
        for(const target of ['[data-bulk-action="read"]','[data-bulk-action="trash"]','#bulk-folder','#bulk-cancel']) {
          await toolbar.locator(target).hover();await check(`${theme}/${mode}/${width}/${target}/hover`);
        }
        if(theme==='theme_monochrome'&&mode==='dark'&&width===440) {
          await page.mouse.move(20,950);await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:'build/bulk-toolbar-dark-preview.png'});
          await toolbar.screenshot({path:'build/bulk-toolbar-detail.png'});
        }
        await page.evaluate(()=>setBulkOperationState(true,'正在移动到“较长的目标文件夹名称” · 100/300',300));
        await check(`${theme}/${mode}/${width}/busy`);
        assert.equal(await toolbar.getAttribute('aria-busy'),'true');
        for(const control of await toolbar.locator('button,select').all())assert(await control.isDisabled());
        await page.evaluate(()=>setBulkOperationState(false));
      }
      await page.locator('#bulk-folder').focus();
      assert.equal(await page.locator('#bulk-folder').evaluate(n=>getComputedStyle(n).outlineStyle),'solid');
    }
    await page.locator('#bulk-cancel').click();
    assert(!await toolbar.isVisible());
    assert(await page.locator('.list-header').isVisible());
    assert.equal(await page.evaluate(()=>selectedMailIds.size),0);
    await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();});
    console.log('Batch toolbar: six palettes, five pane widths, hover, busy, focus and cancel passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
