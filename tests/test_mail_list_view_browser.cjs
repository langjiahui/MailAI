// Run against workspace_preview.py, never a real mailbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium, webkit} = require('playwright');
(async () => {
  const engine = process.env.MAILAI_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.goto(process.env.MAILAI_TEST_URL || 'http://127.0.0.1:18797/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.locator('.sidebar-account-folders [data-account-action="inbox"]').first().click();
    await page.locator('.email-item').first().waitFor();
    const setView=async value=>{
      await page.evaluate(()=>showSystemView('preferences'));
      await page.locator(`input[name="mail-list-view-choice"][value="${value}"]`).check();
      await page.locator('#btn-close-system').click();
    };
    await setView('cards');
    assert.equal(await page.locator('.mail-table-header').count(),0);
    assert.equal(await page.locator('.mail-sender-avatar').count(),12);
    const identity=await page.evaluate(()=>({a:mailSenderAvatar('项目同事','SENDER@example.test'),b:mailSenderAvatar('项目同事','sender@example.test'),safe:mailSenderAvatar('<img onerror=alert(1)>','safe@example.test')}));
    assert.equal(identity.a,identity.b,'Sender identity colors ignore address case');
    assert(!identity.safe.includes('<img'),'Avatar labels never become email-provided markup');
    const dateCases=await page.evaluate(()=>{
      const now=new Date(2026,0,1,10,0);setI18nLanguage('zh-CN');
      return [mailCardDate(new Date(2026,0,1,9,5).toISOString(),now),mailCardDate(new Date(2025,11,31,23,58).toISOString(),now),mailCardDate(new Date(2024,9,20,9,0).toISOString(),now),mailCardDate('invalid',now)];
    });
    assert.equal(dateCases[0].text,'09:05');assert.equal(dateCases[1].text,'23:58','Yesterday is calculated across local year boundaries');
    assert.match(dateCases[2].text,/2024/);assert.equal(dateCases[3].text,'—');assert(dateCases[0].title.includes('2026'));
    assert.equal(await page.locator('.email-item[data-id="1"] .email-meta .mail-list-attachment').count(),1);
    assert.equal(await page.locator('.email-item[data-id="1"] .email-tags .tag-attachment').count(),0);
    // Keep the equipped theme in the client snapshot too: language changes and
    // scheduled refreshes must exercise the same theme instead of clearing it.
    await page.evaluate(async()=>{await api('/api/companion/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});await mailaiPet.refresh();});
    const themeSnapshot=await page.evaluate(()=>api('/api/companion/growth'));
    themeSnapshot.items=themeSnapshot.items.map(item=>({...item,owned:item.slot==='theme'||item.owned}));
    let simulatedReward='';
    await page.route('**/api/companion/growth',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...themeSnapshot,equipped:{...themeSnapshot.equipped,theme:simulatedReward}})}));
    for(const reward of ['', 'theme_monochrome','theme_baowu'])for(const language of ['zh-CN','en'])for(const mode of ['light','dark'])for(const width of [1440,900,390]) {
      simulatedReward=reward;await page.evaluate(()=>mailaiPet.refresh());
      await page.setViewportSize({width,height:1000});await page.evaluate(({mode,language,reward})=>{applyTheme(mode);setI18nLanguage(language);reward?document.documentElement.dataset.rewardTheme=reward:delete document.documentElement.dataset.rewardTheme;},{mode,language,reward});
      for(const density of ['comfortable','compact']) {
        await page.evaluate(density=>document.body.dataset.density=density,density);
        const shape=await page.locator('#email-list').evaluate(list=>({overflow:list.scrollWidth>list.clientWidth+1,overlaps:[...list.querySelectorAll('.email-item')].some(row=>{
          const avatar=row.querySelector('.mail-sender-avatar').getBoundingClientRect(),sender=row.querySelector('.email-sender').getBoundingClientRect(),subject=row.querySelector('.email-subject').getBoundingClientRect();
          return avatar.right>sender.left-5||avatar.right>subject.left-5;
        })}));
        assert(!shape.overflow&&!shape.overlaps,JSON.stringify({reward,language,mode,width,density,shape}));
        assert(await page.locator('.email-item[data-id="1"] .mail-list-attachment').isVisible(),'Compact rows still show attachments');
        const tones=await page.locator('#email-list').evaluate((list,{reward})=>{
          const ctx=document.createElement('canvas').getContext('2d');
          const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
          const over=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]/255+bg[i]*(1-fg[3]/255)).concat(255);
          const lum=c=>c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
          const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
          const sample=document.createElement('span');list.append(sample);
          const token=name=>{sample.style.color=`var(--${name})`;return rgba(getComputedStyle(sample).color);};
          if(reward==='theme_monochrome')for(const name of ['canvas','surface','soft','line','ink','muted','hover','selected','accent','on-accent']){
            const channels=token('reward-'+name).slice(0,3);
            if(new Set(channels).size!==1)throw Error('Monochrome UI tokens must be neutral: '+name+' '+channels);
          }
          if(reward==='theme_monochrome'){
            const dark=document.documentElement.dataset.theme==='dark';
            if(token('reward-accent')[0]!== (dark?255:0)||token('reward-on-accent')[0]!== (dark?0:255))throw Error('Monochrome primary actions need true black and white');
          }
          const paper=rgba(getComputedStyle(list).backgroundColor),selected=token('desk-selected');
          const backgrounds=['.list-pane','.list-header','#email-list','.group-header','.list-footer'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor);
          if(new Set(backgrounds).size!==1)throw Error('The mail column must have a continuous surface: '+JSON.stringify(backgrounds));
          const footer=list.closest('.list-pane').querySelector('.list-footer'),footerStyle=getComputedStyle(footer);
          const footerHeight=footer.getBoundingClientRect().height/(parseFloat(getComputedStyle(document.body).zoom)||1);
          if(!matchMedia('(pointer:coarse)').matches&&footerHeight>34)throw Error('Desktop history strip must stay compact: '+footerHeight);
          const footerBounds=footer.getBoundingClientRect();
          if([...footer.querySelectorAll('.fetch-actions>button,.fetch-hint')].filter(n=>n.getClientRects().length).some(n=>{const r=n.getBoundingClientRect();return r.top<footerBounds.top-1||r.bottom>footerBounds.bottom+1;}))throw Error('History controls must fit inside the status strip');
          const separator=getComputedStyle(list.querySelector('.email-group'));
          if(parseFloat(separator.borderBottomWidth)!==0)throw Error('Date groups must use spacing instead of divider lines');
          for(const selector of ['.topbar','.layout>.sidebar','.layout>.list-pane']){
            const style=getComputedStyle(document.querySelector(selector));
            if(style.display==='none'||style.visibility==='hidden')continue;
            if(style.boxShadow!=='none'||['Top','Right','Bottom','Left'].some(side=>parseFloat(style['border'+side+'Width'])>0))throw Error('Workspace regions must stay free of permanent rules: '+JSON.stringify({selector,width:innerWidth,mode:document.documentElement.dataset.theme,reward:document.documentElement.dataset.rewardTheme,shadow:style.boxShadow,borders:style.border}));
          }
          const results=[];
          for(const selector of ['.sender-name','.email-subject','.email-preview','.email-date','.group-title','.group-count','.mail-list-attachment']){
            const n=list.querySelector(selector),style=getComputedStyle(n);if(!n.getClientRects().length)continue;
            results.push({selector,ratio:Math.min(contrast(rgba(style.color),paper),contrast(rgba(style.color),selected))});
          }
          const avatar=list.querySelector('.mail-sender-avatar').cloneNode(true);list.append(avatar);
          const avatarBackgrounds=[];
          for(let tone=0;tone<6;tone++){
            avatar.dataset.avatarTone=String(tone);const style=getComputedStyle(avatar),fg=rgba(style.color),bg=over(rgba(style.backgroundColor),paper);
            results.push({selector:'avatar '+tone,ratio:contrast(fg,bg)});avatarBackgrounds.push(bg.join(','));
            const chroma=Math.max(...bg.slice(0,3))-Math.min(...bg.slice(0,3));
            if(reward==='theme_monochrome' && chroma!==0)throw Error('Monochrome avatars must remain neutral: '+JSON.stringify({tone,fg,bg}));
            if(reward==='theme_baowu' && [0,1,3].includes(tone) && !(fg[2]>fg[0]&&bg[2]>bg[0]))throw Error('Baowu identity marks must retain their main blue palette');
            if(reward!=='theme_monochrome' && [2,4].includes(tone) && !(bg[0]>bg[2]))throw Error('Warm accent avatars remain available in every theme');
          }
          avatar.remove();
          const host=document.createElement('div');host.innerHTML=renderEmailItem({...allEmails[0],score:90,verdict:'phishing',is_read:1});list.append(host);
          for(const n of [list.querySelector('.risk-badge.warn'),host.querySelector('.risk-badge.danger'),host.querySelector('.risk-alert-dot')]){
            const style=getComputedStyle(n),bg=over(rgba(style.backgroundColor),paper);
            results.push({selector:n.className,ratio:contrast(rgba(style.color),bg)});
          }
          const unread=list.querySelector('.unread .sender-name'),read=list.querySelector('.email-item:not(.unread) .sender-name');
          const readWeight=parseFloat(getComputedStyle(host.querySelector('.sender-name')).fontWeight),unreadWeight=unread?parseFloat(getComputedStyle(unread).fontWeight):0;
          host.remove();sample.remove();
          return {results,avatarTones:new Set(avatarBackgrounds).size,readWeight,unreadWeight};
        },{reward});
        assert(tones.results.every(item=>item.ratio>=4.5),JSON.stringify({reward,mode,language,width,density,tones}));
        assert.equal(tones.avatarTones,6,'Identity tones remain distinct within the chosen palette');
        if(tones.readWeight)assert(tones.unreadWeight>tones.readWeight,'Unread type remains stronger in every palette');
        if(width===1440&&language==='zh-CN'&&density==='comfortable') {
          const row=page.locator('#email-list .email-item').nth(2);
          await row.hover();
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          const hover=await row.evaluate(n=>({bg:getComputedStyle(n).backgroundColor,hover:n.matches(':hover'),class:n.className}));
          assert(hover.bg!=='rgba(0, 0, 0, 0)',JSON.stringify({reward,mode,hover}));
          await row.focus();await page.keyboard.press('ArrowDown');
          assert(await page.locator('#email-list .email-item:focus-visible').evaluate(n=>{const s=getComputedStyle(n);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2;}),'Keyboard focus remains visible');
        }
      }
    }
    await page.unroute('**/api/companion/growth');await page.evaluate(()=>mailaiPet.refresh());
    await page.setViewportSize({width:390,height:1000});
    const crowded=await page.evaluate(()=>{
      const list=document.getElementById('email-list'),host=document.createElement('div');
      host.innerHTML=renderEmailItem({...allEmails[0],from_name:'A very long sender name that must remain readable',counterpart_name:'',counterpart_addr:'',date:'2024-10-20T09:05:00',score:90,verdict:'phishing',is_favorite:1,is_starred:1,pending_action:'trash',attachments:[{name:'report.pdf'}]});
      list.append(host);
      const row=host.querySelector('.email-item'),bounds=row.getBoundingClientRect();
      const result={dateVisible:host.querySelector('.email-date').getBoundingClientRect().right<=bounds.right-5,riskVisible:host.querySelector('.risk-badge.danger').getBoundingClientRect().right<=bounds.right-5,senderWidth:host.querySelector('.sender-name').clientWidth};
      host.remove();return result;
    });
    assert(crowded.dateVisible&&crowded.riskVisible&&crowded.senderWidth>0,JSON.stringify(crowded));
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.body.dataset.density='comfortable';delete document.documentElement.dataset.rewardTheme;applyTheme('light');setI18nLanguage('zh-CN');});
    await page.locator('.email-item').first().focus();await page.keyboard.press('ArrowDown');
    assert(await page.locator('.email-item').nth(1).evaluate(n=>n===document.activeElement),'Avatar layout preserves keyboard navigation');
    await page.keyboard.press(' ');assert(await page.locator('.email-item.bulk-selected').count()>0);await page.locator('#bulk-cancel').click();
    await page.locator('.email-item[data-id="1"]').click();
    await page.locator('#reading-content:not(.hidden)').waitFor();
    const selected = await page.evaluate(()=>selectedEmailId);
    await page.locator('#email-list .selection-glass-plate:not([hidden])').waitFor();
    const highlight=await page.locator('#email-list .selection-glass-plate').evaluate(n=>{const s=getComputedStyle(n);return {shadow:s.boxShadow,border:parseFloat(s.borderTopWidth),image:s.backgroundImage};});
    assert.deepEqual(highlight,{shadow:'none',border:0,image:'none'},'Mail selection must be a flat fill without a raised card frame');
    await setView('table');
    assert.equal(await page.evaluate(()=>selectedEmailId),selected,'View switches retain the open message');
    assert.equal(await page.locator('.mail-table-item').count(),12);
    assert.match(await page.locator('.mail-table-recipient').first().textContent(),/@example.test/);
    assert.equal(await page.locator('.mail-table-heading').count(),4);
    assert.equal(await page.locator('.mail-table-state,.mail-table-attachment,.table-warning').count(),0);
    await page.locator('[data-table-date-sort]').click();
    assert.equal(await page.locator('#list-sort').inputValue(),'date-asc');
    await page.locator('[data-table-date-sort]').click();
    assert.equal(await page.locator('#list-sort').inputValue(),'date-desc');
    await page.locator('.mail-table-item').first().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.mail-table-item').nth(1).evaluate(n=>n===document.activeElement),true);
    await page.keyboard.press(' ');
    assert.equal(await page.locator('.mail-table-item.bulk-selected').count(),2);
    await page.locator('#bulk-cancel').click();
    const beforeWidth=await page.locator('.mail-table-heading').nth(0).evaluate(n=>n.getBoundingClientRect().width);
    const handle=page.locator('[data-mail-column="0"]');
    assert.equal(await handle.getAttribute('aria-label'),'调整列宽 · 发件人');
    assert.match(await handle.getAttribute('title'),/拖动调整列宽/);
    const box=await handle.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+24,box.y+box.height/2,{steps:5}); await page.mouse.up();
    const afterWidth=await page.locator('.mail-table-heading').nth(0).evaluate(n=>n.getBoundingClientRect().width);
    assert(afterWidth>beforeWidth+15,'Dragging grows sender and shrinks recipient without horizontal overflow');
    await handle.focus(); await page.keyboard.press('ArrowLeft');
    const columns=await page.evaluate(()=>localStorage.getItem('mailai-mail-table-columns'));
    assert(columns,'Column sizes are persisted');
    await page.reload();
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.locator('.mail-table-header').waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('mailai-mail-table-columns')),columns);
    assert.equal(await page.evaluate(()=>document.body.dataset.mailListView),'table');
    await page.locator('[data-mail-column="0"]').dblclick();
    await page.locator('[data-resizer="list"]').dblclick();
    // Pane resizing schedules a column fit through ResizeObserver and rAF.
    // Wait for its resulting geometry, including on a busy CI renderer.
    await page.waitForFunction(()=>{
      const widths=[...document.querySelectorAll('.mail-table-heading')].map(n=>n.getBoundingClientRect().width);
      return widths.length===4&&widths[2]>widths[0]&&widths[2]>widths[1];
    });
    const defaults=await page.locator('.mail-table-heading').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
    assert(defaults[2]>defaults[0]&&defaults[2]>defaults[1],`The subject gets most of the default column space: ${JSON.stringify(defaults)}`);
    fs.mkdirSync('output/mail-list-view',{recursive:true});
    for (const theme of ['', 'theme_monochrome','theme_baowu']) for (const scale of [1,1.25]) for (const mode of ['light','dark']) for (const language of ['zh-CN','en']) for (const width of [1440,1024,900,768,390]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(({mode,language,theme,scale})=>{applyTheme(mode);setI18nLanguage(language);theme?document.documentElement.dataset.rewardTheme=theme:delete document.documentElement.dataset.rewardTheme;document.body.style.zoom=scale;document.documentElement.style.setProperty('--fz',scale);},{mode,language,theme,scale});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const geometry=await page.evaluate(()=>{
        const header=document.querySelector('.mail-table-header'),row=document.querySelector('.mail-table-item');
        const h=[...header.children].map(n=>n.getBoundingClientRect().left),r=[...row.children].slice(0,4).map(n=>n.getBoundingClientRect().left);
        const list=document.querySelector('.list-pane').getBoundingClientRect(),read=document.querySelector('.reading-pane').getBoundingClientRect();
        const clippedHeadings=[...header.querySelectorAll('.mail-table-heading > span,.mail-table-heading button > span:first-child')].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.textContent);
        return {overflowing:[...document.querySelectorAll(".topbar,.global-actions,.nav-action,.reading-pane,.assistant-panel")].filter(n=>n.getClientRects().length&&n.getBoundingClientRect().right>innerWidth+1).map(n=>({id:n.id,cls:n.className,right:n.getBoundingClientRect().right})),clippedHeadings,aligned:h.every((x,i)=>Math.abs(x-r[i])<2),overflow:document.documentElement.scrollWidth>innerWidth+1,listRight:list.right,readingLeft:read.left,listOverflow:document.querySelector('#email-list').scrollWidth>document.querySelector('#email-list').clientWidth+1};
      });
      assert(geometry.aligned&&!geometry.overflow&&!geometry.listOverflow&&!geometry.clippedHeadings.length,JSON.stringify({width,mode,language,theme,scale,geometry}));
      if(width>820)assert(geometry.readingLeft>=geometry.listRight-1,JSON.stringify(geometry));
      if(!theme&&scale===1&&[1440,900].includes(width)&&language==='zh-CN')await page.screenshot({path:`output/mail-list-view/${mode}-${width}-${process.env.MAILAI_BROWSER||'chromium'}.png`});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>{setI18nLanguage('zh-CN');applyTheme('light');delete document.documentElement.dataset.rewardTheme;document.body.style.zoom=1;document.documentElement.style.setProperty('--fz',1);showSystemView('preferences');});
    await page.locator('.mail-list-view-settings').screenshot({path:`output/mail-list-view/settings-${process.env.MAILAI_BROWSER||'chromium'}.png`});
    await page.locator('#btn-close-system').click();
    await setView('cards');
    assert.equal(await page.locator('.mail-table-header').count(),0);
    assert(await page.locator('.email-subject').count()>0);
    assert.deepEqual(errors,[]);
    console.log('PASS mail views: sender identity, safe avatars, concise dates, compact attachments, 72 card layouts with theme contrast, settings, shared selection/reading, sorting, keyboard, reload and 120 table layouts');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
