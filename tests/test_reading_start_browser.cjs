// Synthetic workspace only: exercise empty-state actions without contacting AI.
const assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch();try{
   const p=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'}),errors=[];
   p.on('pageerror',e=>errors.push(e.message));
   await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({mailboxDone:true,aiDone:true,deferred:true})));
   await p.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18797/');await p.locator('#app-preloader').waitFor({state:'detached'});
   await p.locator('#email-list .email-item').first().waitFor();
   assert(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
   const snapshot=await p.evaluate(()=>api('/api/companion/growth'));
   snapshot.items=snapshot.items.map(i=>({...i,owned:i.slot==='theme'||i.owned}));let reward='';
   await p.route('**/api/companion/growth',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({...snapshot,equipped:{...snapshot.equipped,theme:reward}})}));
   await p.evaluate(()=>mailaiPet.refresh());
   const empty=p.locator('#reading-empty'),first=p.locator('#reading-start-first');
   assert(await empty.isVisible());assert(await first.isEnabled());
   for(reward of ['', 'theme_monochrome','theme_baowu']){
    await p.evaluate(()=>mailaiPet.refresh());
    for(const mode of ['light','dark'])for(const language of ['zh-CN','en']){
     await p.evaluate(({mode,language})=>{applyTheme(mode);setI18nLanguage(language);},{mode,language});
     for(const width of [1440,900,390]){
      await p.setViewportSize({width,height:800});
      await p.evaluate(()=>document.querySelector('.reading-pane').classList.add('show'));
      const result=await empty.evaluate(n=>{
       const pane=n.closest('.reading-pane'),r=pane.getBoundingClientRect(),art=n.querySelector('svg').getBoundingClientRect(),buttons=[...n.querySelectorAll('button')];
       const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
       const lum=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0)};
       const ratios=buttons.map(b=>{const s=getComputedStyle(b),a=lum(s.color),z=lum(s.backgroundColor);return (Math.max(a,z)+.05)/(Math.min(a,z)+.05)});
       return {fits:art.left>=r.left&&art.right<=r.right&&buttons.every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left&&q.right<=r.right&&q.bottom<=r.bottom}),overflow:pane.scrollWidth>pane.clientWidth+1,ratios};
      });
      assert(result.fits&&!result.overflow&&result.ratios.every(v=>v>=4.5),JSON.stringify({reward,mode,language,width,result}));
     }
    }
   }
   await p.setViewportSize({width:1440,height:960});await p.evaluate(()=>{applyTheme('light');setI18nLanguage('en');});
   assert.equal(await first.innerText(),'Read first message');
   const row=await p.locator('#email-list .email-item').first().evaluate(n=>({id:Number(n.dataset.id),account:n.dataset.accountId||''}));
   await first.focus();await p.keyboard.press('Enter');
   await p.waitForFunction(id=>selectedEmailDetail?.id===id,row.id);
   if(row.account)assert.equal(await p.evaluate(()=>selectedEmailAccountId),row.account);
   await empty.waitFor({state:'hidden'});
   await p.evaluate(()=>resetReadingPane());await empty.waitFor({state:'visible'});
   await p.locator('#reading-start-assistant').click();await p.locator('#assistant-panel').waitFor({state:'visible'});
   assert(await p.locator('#assistant-input').evaluate(n=>n===document.activeElement));
   await p.evaluate(()=>{closeAssistant();document.getElementById('email-list').replaceChildren()});await p.waitForFunction(()=>document.getElementById('reading-start-first').disabled);
   await p.evaluate(()=>renderEmailList(allEmails));await p.waitForFunction(()=>!document.getElementById('reading-start-first').disabled);
   assert.deepEqual(errors,[]);
   console.log(`PASS ${engine.name()}: reading start across 3 themes, 2 modes, 2 languages, 3 widths; first-message account, keyboard, assistant and empty queue`);
  }finally{await browser.close()}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
