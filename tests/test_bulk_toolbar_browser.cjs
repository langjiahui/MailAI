// Real cascade + resizable pane; isolated workspace fixture with no live mail.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
  const browser=await (process.env.MAILAI_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
    await page.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
    await page.goto((process.env.MAILAI_TEST_URL||'http://127.0.0.1:18795')+'/?shell=macos');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.locator('.sidebar-account-folders [data-account-action="inbox"]').first().click();
    await page.locator('.email-item').first().click();
    await page.locator('.email-item').nth(2).click({modifiers:['Shift']});
    await page.locator('#bulk-toolbar').waitFor({state:'visible'});
    const toolbar=page.locator('#bulk-toolbar');
    const read=toolbar.getByRole('button',{name:'标记为已读',exact:true});
    const unread=toolbar.getByRole('button',{name:'标记为未读',exact:true});
    const tooltip=button=>button.evaluate(node=>{
      const css=getComputedStyle(node,'::after');
      return {content:css.content,visibility:css.visibility};
    });
    assert.notEqual(await read.locator('svg path').getAttribute('d'),await unread.locator('svg path').getAttribute('d'));
    assert.equal(await unread.locator('svg circle').count(),1);
    assert.match(await page.locator('#bulk-count').textContent(),/3/);
    assert.notEqual(await page.locator('.reading-selection-sheet[data-depth="0"]').evaluate(n=>getComputedStyle(n).boxShadow),'none','Selection preview retains its paper depth');
    assert.equal(await page.locator('.reading-selection-sheet:visible').count(),3,'Selected messages retain their layered preview');
    assert.equal(await page.locator('.email-item.bulk-selected .mail-sender-avatar').first().evaluate(n=>getComputedStyle(n,'::after').content),'"✓"','Selected rows have an explicit check');
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
        const move=bar.querySelector('#bulk-folder'),moveStyle=getComputedStyle(move);
        ctx.font=`${moveStyle.fontWeight} ${moveStyle.fontSize} ${moveStyle.fontFamily}`;
        const moveTextSpace=move.clientWidth-parseFloat(moveStyle.paddingLeft)-parseFloat(moveStyle.paddingRight);
        const moveTextWidth=ctx.measureText(move.selectedOptions[0].textContent.trim()).width;
        return {theme:document.documentElement.dataset.rewardTheme||'',mode:document.documentElement.dataset.theme,image:getComputedStyle(bar).backgroundImage,overflow:bar.scrollWidth>bar.clientWidth,
          overlapsList:rect.bottom>list.top+1,moveTextSpace,moveTextWidth,
          controls:nodes.map(n=>{const css=getComputedStyle(n),r=n.getBoundingClientRect(),b=lum(blend(rgba(css.backgroundColor),bg)),a=lum(rgba(css.color));
            return {id:n.id||n.dataset.bulkAction,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),
              inside:r.left>=rect.left-1&&r.right<=rect.right+1&&r.top>=rect.top-1&&r.bottom<=rect.bottom+1,
              image:css.backgroundImage,stroke:n.querySelector('svg')?getComputedStyle(n.querySelector('svg')).stroke:css.color,color:css.color};})};
      });
      assert.equal(value.theme,expectedTheme,`${label}: theme must remain equipped`);
      assert.equal(value.mode,expectedMode);
      assert.equal(value.image,'none',`${label}: no accent gradient`);
      assert(!value.overflow&&!value.overlapsList,`${label}: ${JSON.stringify(value)}`);
      assert(value.moveTextSpace>=value.moveTextWidth,`${label}: the Move to label needs ${value.moveTextWidth}px but has ${value.moveTextSpace}px`);
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
      for(const width of [240,320,329,440,560,700]) {
        await page.locator('.list-pane').evaluate((n,width)=>{n.style.setProperty('width',width+'px','important');n.style.setProperty('flex','0 0 '+width+'px','important');n.style.setProperty('min-width','0','important');},width);
        await page.mouse.move(20,950);await check(`${theme}/${mode}/${width}/rest`);
        for(const target of ['[data-bulk-action="read"]','[data-bulk-action="unread"]','[data-bulk-action="trash"]','[data-bulk-mail-tags]','#bulk-folder','#bulk-cancel']) {
          await toolbar.locator(target).hover();await check(`${theme}/${mode}/${width}/${target}/hover`);
        }
        if(width===329) {
          assert(await read.locator('span').isVisible());
          assert(await unread.locator('span').isVisible());
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
    await page.mouse.move(20,950);
    assert.equal((await tooltip(unread)).visibility,'hidden');
    await read.hover();
    assert.deepEqual(await tooltip(read),{content:'"标记为已读"',visibility:'visible'});
    await page.mouse.move(20,950);
    await read.focus();
    await page.keyboard.press('Tab');
    if (!await unread.evaluate(node=>document.activeElement===node)) {
      // macOS WebKit may reserve plain Tab for fields and select menus.
      await read.focus();
      await page.keyboard.press('Alt+Tab');
    }
    assert(await unread.evaluate(node=>node.matches(':focus-visible')));
    assert.deepEqual(await tooltip(unread),{content:'"标记为未读"',visibility:'visible'});
    await page.evaluate(()=>setI18nLanguage('en'));
    const unreadEnglish=toolbar.getByRole('button',{name:'Mark as unread',exact:true});
    assert.deepEqual(await tooltip(unreadEnglish),{content:'"Mark as unread"',visibility:'visible'});
    for(const width of [240,320,329,350,370,560,639,640,700]) {
      await page.locator('.list-pane').evaluate((n,width)=>{
        n.style.setProperty('width',width+'px','important');
        n.style.setProperty('flex','0 0 '+width+'px','important');
      },width);
      await check(`English / ${width} / keyboard focus`);
      if(width===329 || width===350) assert(await unreadEnglish.locator('span').isHidden());
      if(width===370) assert(await unreadEnglish.locator('span').isVisible());
    }
    await page.locator('.list-pane').evaluate(n=>{
      for(const property of ['width','flex','min-width']) n.style.removeProperty(property);
    });
    for(const lang of ['zh-CN','en']) {
      await page.evaluate(lang=>setI18nLanguage(lang),lang);
      for(const width of [320,390]) {
        await page.setViewportSize({width,height:1000});
        assert(await page.locator('#reading-pane').isHidden(),'The selection preview must leave the narrow window available for batch actions');
        const unreadButton=toolbar.locator('[data-bulk-action="unread"]');
        await unreadButton.hover();
        assert.deepEqual(await tooltip(unreadButton),{content:lang==='en'?'"Mark as unread"':'"标记为未读"',visibility:'visible'});
        await check(`${lang} / ${width}px window`);
      }
    }
    await page.setViewportSize({width:1600,height:1000});
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.locator('#bulk-cancel').click();
    assert(!await toolbar.isVisible());
    assert(await page.locator('.list-header').isVisible());
    assert.equal(await page.evaluate(()=>selectedMailIds.size),0);
    const inboxIds=await page.locator('#email-list .email-item').evaluateAll(nodes=>nodes.slice(0,2).map(node=>node.dataset.id));
    for(const [button,state] of [[unread,'unread'],[read,'read']]) {
      await page.evaluate(()=>resetReadingPane());
      for(const id of inboxIds) await page.locator(`#email-list .email-item[data-id="${id}"]`).click({modifiers:['Meta']});
      assert.equal(await page.evaluate(()=>selectedMailIds.size),2);
      await button.click();
      await page.waitForFunction(({ids,state})=>!bulkOperationActive && ids.every(id=>
        document.querySelector(`#email-list .email-item[data-id="${id}"]`)?.dataset.readState===state),{ids:inboxIds,state});
    }
    await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();});
    const accountId=await page.evaluate(()=>activeMailAccount()?.id);
    const seeded=await page.request.post(new URL(`/fixture/sent-selection/${accountId}`,page.url()).href);
    assert(seeded.ok());
    const rows=await seeded.json();
    await page.locator(`.sidebar-account-folders [data-account-action="sent"][data-account-id="${accountId}"]`).click();
    const row=id=>page.locator(`#email-list .email-item[data-id="${id}"]`);
    const queued=page.locator('#email-list .email-item').filter({hasText:rows.queued});
    await queued.waitFor();
    await row(rows.local).focus();
    await page.keyboard.press('Control+a');
    assert.equal(await row(rows.local).getAttribute('aria-selected'),'true');
    assert.equal(await queued.getAttribute('aria-selected'),'false');
    await page.keyboard.press('Escape');
    await row(rows.local).click();
    await page.waitForFunction(id=>String(selectedEmailId)===String(id),rows.local);
    await row(rows.server).click({modifiers:['Shift']});
    assert.equal(await row(rows.local).getAttribute('aria-selected'),'true');
    assert.equal(await row(rows.server).getAttribute('aria-selected'),'true');
    assert.equal(await queued.getAttribute('aria-selected'),'false');
    await page.keyboard.press('Escape');
    await row(rows.server).click({modifiers:['Meta']});
    assert.equal(await row(rows.local).getAttribute('aria-selected'),'true');
    const stack=page.locator('.reading-selection-stack');
    const top=stack.locator('.reading-selection-sheet[data-depth="0"]');
    await top.getByText('Server sent preview body',{exact:true}).waitFor();
    assert.match(await top.locator('.reading-selection-sheet-head b').textContent(),/发给 fixture-recipient@example\.test/);
    assert.equal(await stack.locator('.reading-selection-sheet:visible').count(),2);
    assert(!(await page.locator('#reading-content').isVisible()));
    await page.evaluate(()=>setI18nLanguage('en'));
    await top.getByText('To fixture-recipient@example.test',{exact:true}).waitFor();
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await row(rows.local).click({modifiers:['Meta']});
    await stack.waitFor({state:'detached'});
    await row(rows.local).click({modifiers:['Meta']});
    await top.getByText('Local sent preview body',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await stack.waitFor({state:'detached'});
    await page.frameLocator('#reading-content iframe.rich-email-frame').getByText('Local sent preview body',{exact:true}).waitFor();
    await row(rows.local).click();
    await row(rows.server).click({modifiers:['Meta']});
    await row(rows.missing).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.email-item.bulk-selected').count(),3);
    assert.deepEqual(await toolbar.locator('[data-bulk-action]:visible').evaluateAll(nodes=>nodes.map(n=>n.dataset.bulkAction)),['trash']);
    await row(rows.server).click({button:'right'});
    await page.locator('#mail-context-menu [data-context-action="select-all"]').waitFor();
    assert.equal(await page.locator('#mail-context-menu [data-context-action="read"]').count(),0);
    await page.keyboard.press('Escape');
    const deleted=page.waitForResponse(response=>response.url().endsWith('/api/mail/sent/bulk-trash'));
    await toolbar.locator('[data-bulk-action="trash"]').click();
    const result=await (await deleted).json();
    assert.equal(result.completed,2);
    assert.deepEqual(result.failed.map(item=>item.id),[rows.missing]);
    await row(rows.local).waitFor({state:'detached'});
    await row(rows.server).waitFor({state:'detached'});
    await stack.waitFor({state:'detached'});
    assert.equal(await row(rows.missing).getAttribute('aria-selected'),'true');
    await queued.waitFor();
    await page.waitForFunction(()=>!bulkOperationActive);
    await page.keyboard.press('Control+z');
    await row(rows.local).waitFor();
    await row(rows.server).waitFor();
    await page.evaluate(token=>api(`/api/mail/outbox/${token}/cancel`,{method:'POST'}),rows.token);
    console.log('Batch toolbar: six palettes, six pane widths, localized tooltips, hover, busy, focus, read/unread and cancel passed');
    console.log('Sent bulk actions: mixed selection, stacked preview, reader restoration, queued exclusion, partial failure and undo passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
