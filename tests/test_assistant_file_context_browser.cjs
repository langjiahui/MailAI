/* Synthetic mailbox only; model and saved-chat responses are explicitly stubbed. */
const assert=require('node:assert/strict');const {chromium,webkit}=require('playwright');
(async()=>{for(const engine of [chromium,webkit]){const browser=await engine.launch();try{
const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'}),errors=[],sent=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(process.env.MAILAI_TEST_URL||'http://127.0.0.1:18795/');await page.locator('#app-preloader').waitFor({state:'hidden'});await page.evaluate(()=>{setI18nLanguage('zh-CN');return selectEmail(1)});await page.waitForFunction(()=>selectedEmailDetail?.id===1);
await page.evaluate(async()=>{const growth=await api('/api/companion/growth');for(const item of ['theme_monochrome','theme_baowu'])if(!growth.items.find(i=>i.id===item)?.owned)await api('/api/companion/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item,token:crypto.randomUUID()})});await mailaiPet.refresh();});
await page.route('**/api/assistant/ask-stream',async route=>{sent.push(route.request().postDataJSON());await route.fulfill({contentType:'application/x-ndjson',body:[{type:'meta',conversation_id:901},{type:'sources',sources:[{id:1,subject:'项目交付时间确认'}]},{type:'delta',content:'请核对项目资料【附件1】。'},{type:'done'}].map(e=>JSON.stringify(e)+'\n').join('')});});
assert.equal(await page.locator('#reading-content [data-file-analyze],[data-assistant-attachments]').count(),0,'Mail reading uses the whole-email entry');await page.locator('#btn-attachments').click();await page.locator('#attachment-center [data-assistant-file][data-email-id="1"][data-attachment-index="0"]').first().click();await page.locator('#assistant-attachment-stage').waitFor({state:'visible'});
assert.equal(await page.locator('#assistant-attachment-picker').isVisible(),false,'Single file goes directly into the conversation');
assert.equal(sent.length,0,'Attaching a file does not invoke the model');
const compact=await page.locator('.assistant-composer').evaluate(n=>({height:n.getBoundingClientRect().height,stage:document.getElementById('assistant-attachment-stage').getBoundingClientRect().height}));
assert(compact.height<=112&&compact.stage<=32,JSON.stringify(compact));
await page.locator('[data-file-context-toggle]').click();
assert(await page.locator('#assistant-file-popover').isVisible());
assert(Math.abs(await page.locator('.assistant-composer').evaluate(n=>n.getBoundingClientRect().height)-compact.height)<1,'File details must not enlarge the composer');
await page.keyboard.press('Escape');assert.equal(await page.locator('#assistant-file-popover').isVisible(),false);
assert(await page.locator('[data-file-context-toggle]').evaluate(n=>n===document.activeElement),'Escape returns focus to the file label');

const ref=await page.evaluate(()=>assistantAttachments.snapshot()[0]);assert(ref.digest&&ref.email_id===1);
await page.locator('#assistant-input').fill('总结附件');await page.locator('#assistant-send').click();await page.waitForFunction(()=>!assistantController);
assert.equal(sent.length,1);assert.equal(sent[0].attachments[0].digest,ref.digest);
assert(await page.locator('#assistant-attachment-stage').isVisible(),'File stays attached after the first answer');
await page.locator('#assistant-input').fill('具体交付时间呢？');await page.locator('#assistant-send').click();await page.waitForFunction(()=>!assistantController);
assert.equal(sent.length,2);assert.equal(sent[1].attachments[0].digest,ref.digest,'Follow-up reuses the explicit file reference');
await page.route('**/api/assistant/conversations/901',route=>route.fulfill({json:{messages:[{role:'user',content:'总结附件'},{role:'assistant',content:'请核对项目资料【附件1】。',sources:[{id:1}]}],attachments:[ref]}}));
await page.evaluate(()=>loadAssistantConversation(901));assert.equal(await page.evaluate(()=>assistantAttachments.snapshot()[0].digest),ref.digest);
await page.setViewportSize({width:390,height:844});
const mobileSingleHeight=await page.locator('.assistant-composer').evaluate(n=>n.getBoundingClientRect().height);
await page.evaluate(ref=>assistantAttachments.retain([ref,{...ref,index:1,name:'多部门项目交付说明与验收安排.xlsx'},{...ref,index:2,name:'资料归档.pdf'}],901),ref);
assert.match(await page.locator('[data-file-context-toggle]').textContent(),/3/);
await page.locator('[data-file-context-toggle]').click();
const popup=await page.locator('#assistant-file-popover').evaluate(n=>{const r=n.getBoundingClientRect(),p=document.getElementById('assistant-panel').getBoundingClientRect();return {inside:r.left>=p.left&&r.right<=p.right&&r.top>=p.top,overflow:n.scrollWidth>n.clientWidth+1,stage:document.getElementById('assistant-attachment-stage').getBoundingClientRect().height};});
assert(popup.inside&&!popup.overflow&&popup.stage<=48,JSON.stringify(popup));
assert(Math.abs(await page.locator('.assistant-composer').evaluate(n=>n.getBoundingClientRect().height)-mobileSingleHeight)<1,'Three files must occupy the same mobile input height as one file');
await page.locator('#assistant-input').click();assert.equal(await page.locator('#assistant-file-popover').isVisible(),false);
await page.evaluate(ref=>assistantAttachments.restore([ref],901),ref);await page.setViewportSize({width:1440,height:960});
let cleared=false;await page.route('**/api/assistant/conversations/901/attachments',route=>{cleared=route.request().postDataJSON().attachments.length===0;return route.fulfill({json:{ok:true}})});
await page.locator('[data-file-context-toggle]').click();await page.locator('[data-attachment-remove]').click();await page.waitForTimeout(100);assert(cleared);assert.equal(await page.evaluate(()=>assistantAttachments.snapshot().length),0);
await page.evaluate(()=>closeAssistant());await page.evaluate(()=>assistantAttachments.open(1));await page.locator('#attachment-picker-list input:not(:disabled)').first().check();await page.waitForFunction(()=>!document.querySelector('#attachment-picker-add').disabled);
assert.equal(await page.locator('#attachment-picker-preview details').getAttribute('open'),null,'Extraction detail is optional');
await page.locator('[data-file-prompt=tableQuestion]').click();assert.match(await page.locator('#attachment-picker-question').inputValue(),/表格|tables/);
for(const reward of ['', 'theme_monochrome','theme_baowu'])for(const mode of ['light','dark'])for(const width of [1440,390])for(const language of ['zh-CN','en']){
await page.setViewportSize({width,height:960});await page.evaluate(async({reward,mode,language})=>{if((document.documentElement.dataset.rewardTheme||'')!==reward){await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:reward})});await mailaiPet.refresh();}applyTheme(mode);setI18nLanguage(language);},{reward,mode,language});assert.equal(await page.evaluate(()=>document.documentElement.dataset.rewardTheme||''),reward);
const layout=await page.locator('#assistant-attachment-picker').evaluate(n=>({w:n.clientWidth,s:n.scrollWidth,h:n.clientHeight,viewport:innerHeight/Number(getComputedStyle(document.documentElement).getPropertyValue('--fz')||1)}));assert(layout.s<=layout.w+1,JSON.stringify({reward,mode,width,language,layout}));assert(layout.h<=layout.viewport,JSON.stringify(layout));if(engine===chromium&&width===1440&&language==='zh-CN'){require('node:fs').mkdirSync('build/file-conversations',{recursive:true});await page.locator('#assistant-attachment-picker').screenshot({path:`build/file-conversations/picker-${reward||'default'}-${mode}.png`});}await page.locator('#attachment-picker-add').click({trial:true});}
await page.evaluate(async()=>{await api('/api/companion/equip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:'theme',item:''})});await mailaiPet.refresh();applyTheme('light');setI18nLanguage('zh-CN');});await page.setViewportSize({width:1440,height:960});
await page.locator('#attachment-picker-add').click();await page.waitForFunction(()=>!assistantController);assert.equal(sent.length,3);
await page.locator('#assistant-new').click();assert.equal(await page.evaluate(()=>assistantAttachments.snapshot().length),0);
assert.deepEqual(errors,[]);console.log(`PASS ${engine.name()}: direct attachment, no send on selection, continuous follow-up, restored/removed context, explicit Start, 48 theme/language/width layouts`);
}finally{await browser.close()}}})().catch(e=>{console.error(e);process.exitCode=1});
