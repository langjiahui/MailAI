// Run against tests/workspace_preview.py with Playwright available. Uses fixture data only.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({headless:true,channel:'chrome'});const p=await b.newPage({viewport:{width:1440,height:1000}});const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});try{
await p.goto('http://127.0.0.1:18795');await p.locator('#email-list .email-item').first().waitFor();
assert.ok(await p.evaluate(()=>_systemConfig.accounts.every(a=>a.user.endsWith('@example.test'))), 'Run only against workspace_preview.py');
await p.evaluate(()=>{_systemConfig.accounts=_systemConfig.accounts.slice(0,1);renderSidebarAccounts();});
await p.locator('#folder-nav [data-value="favorites"]').waitFor({state:'visible'});
const response=p.waitForResponse(r=>r.url().includes('status=favorites'));
await p.locator('#folder-nav [data-value="favorites"]').dispatchEvent('click');await response;
await p.locator('#folder-nav [data-value="inbox"]').dispatchEvent('click');
await p.evaluate(()=>{document.querySelectorAll('.modal').forEach(e=>e.classList.add('hidden'));document.getElementById('settings-view')?.classList.add('hidden');document.querySelector('.layout').classList.remove('hidden');});
for(const theme of ['light','dark']){
await p.waitForTimeout(300);await p.evaluate(t=>{applyTheme(t);specialMailbox='';currentServerFolder='';currentFilter.status='inbox';currentFilter.search='';currentFilter.attachments=false;currentFilter.unread=false;currentFilter.days=9999;const base={status:'inbox',date:new Date().toISOString(),direction:'incoming',subject:'Test',from_addr:'test@example.test',verdict:'clean',score:0};allEmails=[{...base,id:9001,is_read:0,attachments:[{name:'a.txt'}]},{...base,id:9002,is_read:1,attachments:[]},{...base,id:9003,is_read:0,attachments:[]},{...base,id:9004,is_read:0,direction:'outgoing',attachments:[]}];searchResults=null;applyFilters();},theme);
if(await p.locator('#workspace-filters').evaluate(e=>e.classList.contains('hidden')))await p.locator('#btn-filter-panel').dispatchEvent('click');await p.locator('#filter-unread').evaluate(e=>{if(!e.checked)e.click()});assert.equal(await p.locator('#email-list .email-item').count(),2);await p.locator('#filter-attachments').evaluate(e=>{if(!e.checked)e.click()});assert.equal(await p.locator('#email-list .email-item').count(),1);await p.locator('#filter-attachments').evaluate(e=>{if(e.checked)e.click()});
await p.evaluate(()=>setLocalEmailReadState(9001,activeMailAccount()?.id||'',true));assert.equal(await p.locator('#email-list .email-item').count(),1);
await p.locator('[data-remove-filter="unread"]').dispatchEvent('click');assert.equal(await p.locator('#filter-unread').isChecked(),false);assert.equal(await p.locator('#email-list .email-item').count(),4);
}assert.deepEqual(errors,[]);console.log('PASS single-account favorites navigation; light/dark unread filtering, attachments combination, mark-read removal and chip reset');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
