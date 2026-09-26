// Use only tests/workspace_preview.py: synthetic files, no real mailbox.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const p=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:18795');await p.locator('.email-item').first().waitFor();await p.locator('#app-preloader').waitFor({state:'hidden'});
 await p.locator('#btn-attachments').click();await p.locator('.attachment-open').first().waitFor();await p.locator('[data-file-view=cards]').click();
 await p.locator('.attachment-open').first().click();await p.locator('.file-preview').waitFor({state:'visible'});
 await p.locator('.file-preview button[aria-label="关闭预览"]').click();
 const [download]=await Promise.all([p.waitForEvent('download'),p.locator('.attachment-download-action').first().click()]);
 assert.equal(download.suggestedFilename(),'交付安排.csv');assert(!await p.locator('.file-preview').isVisible());
 await p.evaluate(()=>{
  const base=attachmentItems[0];attachmentItems=[
   {name:'天气与旅行指南.pdf',content_type:'application/pdf'},
   {name:'季度采购预算.xlsx',content_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
   {name:'产品界面设计参考.png',content_type:'image/png'},
   {name:'项目实施方案与交付说明.docx',content_type:'application/msword'},
   {name:'本季度全部项目资料与评审归档.zip',content_type:'application/zip'},
   {name:'2026年跨部门项目合作安排及风险评估附件资料（第三次修订与最终审批意见）.pdf',content_type:'application/pdf',score:45,verdict:'suspicious'},
  ].map((x,i)=>({...base,size:126800+i*11533,subject:'项目资料与交付时间确认',date:'2026-09-26T10:30:00',...x}));renderAttachmentCenter();
 });
 await p.screenshot({path:'build/attachment-library-light.png'});
 assert.equal(await p.locator('.attachment-file-icon svg').count(),6);
 await p.locator('[data-attachment-type="pdf"]').click(); // Handler reloads the isolated server's filtered results.
 await p.locator('[data-attachment-type="pdf"][aria-pressed="true"]').waitFor();
 await p.waitForFunction(()=>attachmentCenterState==='ready');
 await p.evaluate(()=>{attachmentTypeFilter='all';attachmentCenterState='ready';attachmentItems=[{email_id:1,index:0,name:'一份名称很长的附件文件用于检查小窗口下是否出现横向溢出.pdf',content_type:'application/pdf',size:12456,date:'2026-09-26T10:30:00',subject:'项目参考资料',from_addr:'colleague@example.test',score:45,verdict:'suspicious'}];renderAttachmentCenter();document.documentElement.dataset.theme='dark';});
 await p.setViewportSize({width:560,height:800});await p.screenshot({path:'build/attachment-library-dark.png'});
 await p.setViewportSize({width:390,height:844});
 assert(await p.locator('.attachment-risk').isVisible(),'Risk label stays visible in a small window');
 assert(await p.locator('.attachment-card').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
 assert(await p.locator('#attachment-center .attachment-center-card').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
 // Regression: long lists previously compressed each grid row to just its padding.
 await p.evaluate(()=>{const base=attachmentItems[0];attachmentItems=Array.from({length:148},(_,i)=>({...base,email_id:i+1,name:i%3?'天气与旅行.pdf':'2026年跨部门项目合作安排及风险评估附件资料（第三次修订与最终审批意见）.pdf'}));renderAttachmentCenter();});
 for (const [width,height,scale,theme] of [[1512,875,1,'light'],[1100,760,1.2,'light'],[560,800,1,'dark'],[390,844,1.2,'dark']]) {
  await p.setViewportSize({width,height});
  await p.evaluate(({scale,theme})=>{document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale));document.documentElement.dataset.theme=theme;},{scale,theme});
  const layout=await p.locator('#attachment-grid').evaluate(grid=>{
   const cards=[...grid.querySelectorAll('.attachment-card')];
   return {scrolls:grid.scrollHeight>grid.clientHeight, contained:cards.every(card=>{
    const r=card.getBoundingClientRect();return [...card.querySelectorAll('.attachment-file-icon,.attachment-card-main,.attachment-download-action,.attachment-risk')].every(n=>{const c=n.getBoundingClientRect();return c.bottom<=r.bottom+1 && c.right<=r.right+1 && c.top>=r.top-1;});
   }), ordered:cards.every((card,i)=>{const r=card.getBoundingClientRect();const next=cards[i+2]?.getBoundingClientRect();return !next||r.bottom<=next.top+1;})};
  });
  assert(layout.scrolls,`148 files must scroll at ${width}px`);
  assert(layout.contained,`Card content must stay within its row at ${width}px / ${scale}`);
  assert(layout.ordered,`Rows must not overlap at ${width}px`);
  if(width===1512){await p.waitForTimeout(300);await p.screenshot({path:'build/attachment-density-fixed.png'});}
  await p.locator('#attachment-grid').evaluate(n=>n.scrollTop=n.scrollHeight);
  await p.locator('.attachment-download-action').last().click({trial:true});
  await p.locator('#attachment-grid').evaluate(n=>n.scrollTop=0);
 }
 // Compact rows must scale the SVG, not only its wrapper; keep actions reachable.
 await p.locator('[data-file-view=list]').click();
 for (const [width,scale,theme] of [[1512,1,'light'],[1512,1,'dark'],[900,1.3,'dark'],[390,1.2,'light']]) {
  await p.setViewportSize({width,height:900});
  await p.evaluate(({scale,theme})=>{document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',String(scale));applyTheme(theme);},{scale,theme});
  await p.waitForTimeout(400);
  const sizes=await p.locator('.attachment-card').first().evaluate(card=>{
   const r=card.getBoundingClientRect(), svg=card.querySelector('.attachment-file-icon svg').getBoundingClientRect(), icon=card.querySelector('.attachment-file-icon').getBoundingClientRect();
   return {row:r.height, svg:svg.height, icon:icon.height, contained:svg.top>=r.top&&svg.bottom<=r.bottom, overflow:card.scrollWidth>card.clientWidth+1};
  });
  assert(sizes.svg<=30*scale+1 && sizes.svg<=sizes.icon+1 && sizes.contained,'compact SVG must fit its small wrapper and row');
  assert(!sizes.overflow,'compact rows must not overflow');
  if(width===1512){assert(sizes.row<=50,'compact rows should stay close to 48px');await p.screenshot({path:`build/attachment-compact-${theme}.png`});}
  await p.locator('.attachment-download-action').first().click({trial:true});
 }
 assert.deepEqual(errors,[]);console.log('PASS attachment preview/download separation, file types, filters, dark/narrow layout, visible risk, 148-file scrolling and no overlap with enlarged text');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
