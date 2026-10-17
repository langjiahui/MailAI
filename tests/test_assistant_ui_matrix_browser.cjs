// Release audit: synthetic content only; themes are rendered locally, no mail/model actions.
const assert=require('node:assert/strict'),{chromium,webkit}=require('playwright');
async function run(engine){
 const browser=await engine.launch();let checked=0;
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
  p.on('pageerror',error=>errors.push(error.message));
  await p.addInitScript(()=>localStorage.setItem('mailai.onboarding.v2',JSON.stringify({deferred:true,mailboxDone:true,aiDone:true})));
  await p.goto(process.env.MAILAI_FIXTURE_URL||'http://127.0.0.1:18795');await p.locator('#app-preloader').waitFor({state:'hidden'});await p.locator('.email-item').first().waitFor();
  assert(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))));
  await p.locator('.email-item').first().click();await p.waitForFunction(()=>!!selectedEmailDetail);
  await p.evaluate(()=>{
   openAssistant();const node=document.createElement('div');node.className='assistant-message bot';node.innerHTML='<div class="assistant-bubble"></div>';document.getElementById('assistant-messages').append(node);
   mailaiAssistantSearch.restore(node,{id:'ui-release-audit',conversation_id:assistantConversationId,status:'complete',account_user:'audit@example.test',conditions:[{field:'sender',value:'合成同事'}],keywords:['合同'],actions:[]},[{id:9001,subject:'合成采购合同及交付安排 / Synthetic contract and delivery schedule '.repeat(4),from_name:'合成同事',from_addr:'client@example.test',date:'2026-10-17T12:30:00',preview:'合成邮件片段：请核对采购合同和项目交付日期。'.repeat(5)}]);
  });
  async function frame(language,theme,mode,width,height,zoom){
   await p.setViewportSize({width,height});
   await p.evaluate(({language,theme,mode,zoom})=>{setI18nLanguage(language);applyTheme(mode);if(theme)document.documentElement.dataset.rewardTheme=theme;else delete document.documentElement.dataset.rewardTheme;document.body.style.zoom=zoom;document.documentElement.style.setProperty('--fz',zoom);updateAssistantPlacement();},{language,theme,mode,zoom});
   await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  async function contrast(root,selector,context){
   const failures=await root.evaluate((root,selector)=>{
    const ctx=document.createElement('canvas').getContext('2d');
    const paint=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);};
    const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    return [...root.querySelectorAll(selector)].filter(n=>n.getClientRects().length&&n.textContent.trim()).map(n=>{
     const ancestors=[];for(let a=n;a;a=a.parentElement)ancestors.unshift(a);
     ctx.clearRect(0,0,1,1);paint('#fff');ancestors.forEach(a=>paint(getComputedStyle(a).backgroundColor));const bg=luminance([...ctx.getImageData(0,0,1,1).data]);
     ctx.clearRect(0,0,1,1);paint(getComputedStyle(n).color);const fg=luminance([...ctx.getImageData(0,0,1,1).data]);
     return {text:n.textContent.trim().slice(0,35),ratio:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)};
    }).filter(n=>n.ratio<4.5);
   },selector);
   assert.deepEqual(failures,[],JSON.stringify({context,failures}));
  }
  const card=p.locator('[data-search-run-id=ui-release-audit] .assistant-search-candidate');
  for(const language of ['zh-CN','en'])for(const theme of ['','theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const [width,height,zoom]of [[1440,1000,1],[900,640,1.25],[390,800,1.2]]){
   const context={surface:'candidate',language,theme,mode,width,height,zoom};await frame(language,theme,mode,width,height,zoom);
   const toggle=card.locator('[data-search-source-details]');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
   assert(await card.evaluate(n=>[n,...n.querySelectorAll('button,dl,dd,p')].every(x=>x.scrollWidth<=x.clientWidth+1)),JSON.stringify(context));
   await contrast(card,'b,small,dt,dd,p strong,.assistant-search-open-mail',context);
   const open=card.locator('[data-search-loop-source]');await open.scrollIntoViewIfNeeded();
   assert(await open.evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),JSON.stringify(context));
   assert(await p.locator('#assistant-jump-latest').evaluate(n=>{if(n.hidden)return true;const r=n.getBoundingClientRect(),a=n.parentElement.getBoundingClientRect();return r.top>=a.top-1&&r.bottom<=a.bottom+1;}),'Jump control fits its own space: '+JSON.stringify(context));
   checked++;
  }
  await p.evaluate(()=>closeAssistant());await p.locator('#assistant-panel').waitFor({state:'hidden'});
  for(const language of ['zh-CN','en']){
   await frame(language,'','light',1440,1000,1);await p.evaluate(()=>mailaiProductivity.palette());const palette=p.locator('#productivity-dialog');await palette.waitFor();
   const input=p.locator('#productivity-command-query');await input.fill(language==='en'?'SEARCH':'搜索');
   for(const theme of ['','theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const [width,height,zoom]of [[1440,1000,1],[900,640,1.25],[390,800,1.2]]){
    const context={surface:'commands',language,theme,mode,width,height,zoom};await frame(language,theme,mode,width,height,zoom);
    assert(await palette.evaluate(n=>{const r=n.getBoundingClientRect();return n.scrollWidth<=n.clientWidth+1&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;}),JSON.stringify(context));
    assert(await input.evaluate(n=>n===document.activeElement));await contrast(palette,'[data-account-label],.command-group,.command-copy strong,.command-copy small,mark,.command-hints',context);checked++;
   }
   await p.keyboard.press('Escape');await palette.waitFor({state:'hidden'});
  }
  // A text search from the palette remains usable when the toolbar is compact.
  await p.evaluate(()=>mailaiProductivity.palette());await p.locator('#productivity-command-query').fill('合成检索测试');await p.locator('#productivity-command-query').press('Enter');
  await p.waitForFunction(()=>document.getElementById('global-search').value==='合成检索测试'&&mailSearchState.phase==='done');
  assert(await p.locator('#global-search').evaluate(n=>n===document.activeElement&&n.getClientRects().length>0),'Compact search must retain a visible editing field');
  assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: ${checked} candidate/command layouts, 6 palettes, 2 languages, compact/zoom, 4.5:1 text contrast, action reachability and compact search`);
 }finally{await browser.close();}
}
(async()=>{for(const engine of [chromium,webkit].filter(e=>!process.env.MAILAI_BROWSER||e.name()===process.env.MAILAI_BROWSER))await run(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
