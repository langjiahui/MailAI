// Isolated fixture only: no real Foxmail or email server access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const browserType = require('playwright')[process.env.MAILAI_BROWSER || 'chromium'];
const stamp = `${Date.now()}-${Math.random()}`;
const raw = id => Buffer.from(`From: old@example.test\r\nTo: personal@example.test\r\nSubject: 历史导入-${stamp}-${id}\r\nMessage-ID: <${stamp}-${id}@example.test>\r\nDate: Fri, 01 Jan 1993 09:30:00 +0800\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n这是需要保留的旧邮件。\r\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
(async () => {
  const browser = await browserType.launch({headless:true});
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'mailai-import-browser-'));
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors=[]; page.on('pageerror', e=>{errors.push(e.message); console.error('Browser error:',e.message);});
    await page.goto(process.env.MAILAI_FIXTURE_URL || 'http://127.0.0.1:18795/');
    await page.locator('#app-preloader').waitFor({state:'detached'});
    await page.waitForFunction(()=>Boolean(window.mailaiMailImport && _systemConfig?.accounts?.length));
    const accounts = await page.evaluate(()=>_systemConfig.accounts.map(a=>({id:a.id,user:a.user})));
    const active = await page.evaluate(()=>activeMailAccount().id);
    const target = accounts.find(a=>a.id!==active);
    await page.evaluate(()=>showSystemView('maintenance'));
    await page.locator('#btn-import-client-mail').click();
    const dialog=page.locator('#mail-import-dialog'), action=dialog.locator('[data-import-action]');
    await dialog.waitFor({state:'visible'});
    assert.equal(await action.isDisabled(),true);
    assert.match(await dialog.textContent(),/本地归档/);
    await dialog.locator('.mail-import-help summary').click();
    assert.match(await dialog.locator('.mail-import-help').textContent(),/下载完整/);
    await dialog.locator('#mail-import-account').selectOption(target.id);
    await dialog.locator('#mail-import-label').fill('Foxmail 验收-'+stamp);
    fs.mkdirSync(path.join(root,'收件箱'));
    fs.writeFileSync(path.join(root,'收件箱','原件.eml'),raw('one'));
    fs.writeFileSync(path.join(root,'收件箱','重复.eml'),raw('one'));
    fs.writeFileSync(path.join(root,'损坏.eml'),'not an email');
    fs.writeFileSync(path.join(root,'说明.txt'),'must be ignored');
    fs.writeFileSync(path.join(root,'已发送.mbox'),Buffer.concat([Buffer.from('From old@example.test Fri Jan 01 09:30:00 1993\n'),raw('two'),Buffer.from('\n')]));
    await dialog.locator('#mail-import-folder').setInputFiles(root);
    assert.match(await dialog.locator('[data-import-selected]').textContent(),/4 个邮件文件.*跳过 1 个非邮件文件/);
    await dialog.locator('#mail-import-label').fill('无效/名称');
    assert.equal(await action.isDisabled(),true);
    assert.match(await dialog.locator('[data-import-error]').textContent(),/斜杠/);
    await dialog.locator('#mail-import-label').fill('Foxmail 验收-'+stamp);
    assert.equal(await action.isEnabled(),true);
    // Slow creation verifies double clicks and account switching are locked immediately.
    let creates=0, uploads=0;
    const headers=[];
    await page.route('**/api/mail/client-imports',async route=>{
      if (route.request().method()==='POST') { creates++; headers.push(route.request().headers()['x-mailai-account']); await sleep(180); }
      await route.continue();
    });
    page.on('request',r=>{if(r.method()==='PUT'&&r.url().includes('/client-imports/')) { uploads++; headers.push(r.headers()['x-mailai-account']); }});
    await action.evaluate(n=>{n.click();n.click();});
    assert.equal(await dialog.locator('#mail-import-account').isDisabled(),true);
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 2 封邮件');
    assert.equal(creates,1); assert.equal(uploads,4); assert(headers.every(id=>id===target.id));
    assert.equal(await dialog.locator('[data-count=found]').textContent(),'4');
    assert.equal(await dialog.locator('[data-count=duplicates]').textContent(),'1');
    assert.equal(await dialog.locator('[data-count=failed]').textContent(),'1');
    assert.equal(await page.evaluate(()=>activeMailAccount().id),active,'Scanning selected account must not switch active mailbox');
    await dialog.locator('[data-import-samples] summary').click();
    assert.match(await dialog.locator('[data-import-samples]').textContent(),/收件箱/);
    await dialog.locator('[data-import-errors] summary').click();
    assert.match(await dialog.locator('[data-import-errors]').textContent(),/损坏.eml/);
    await dialog.locator('[data-import-folders] summary').click();
    assert.match(await dialog.locator('[data-import-folders]').textContent(),/收件箱.*1 封/s);
    assert.match(await dialog.locator('[data-import-folders]').textContent(),/已发送.*1 封/s);
    const reportRequest=page.waitForRequest(r=>r.url().includes('/report'));
    const firstDownload=page.waitForEvent('download');
    await dialog.locator('[data-import-report]').click();
    const reportUrl=(await reportRequest).url();
    assert(reportUrl.includes(encodeURIComponent(target.id)), 'Report download must pin selected account');
    const download=await firstDownload;
    assert.match(fs.readFileSync(await download.path(),'utf8'),/损坏.eml/);
    assert.equal(await dialog.locator('[data-import-samples] details').getAttribute('open'),'');
    assert.equal(await dialog.locator('[data-import-folders]').getAttribute('open'),'');
    await page.route('**/client-imports/*/report?*',r=>r.fulfill({status:507,contentType:'application/json',body:JSON.stringify({detail:'无法生成清单，请检查磁盘空间后重试'})}));
    await dialog.locator('[data-import-report]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-error]').textContent.includes('无法生成清单'));
    await page.unroute('**/client-imports/*/report?*');
    const retryDownload=page.waitForEvent('download');
    await dialog.locator('[data-import-report]').click(); await retryDownload;
    await page.waitForFunction(()=>document.querySelector('[data-import-error]').textContent==='');
    fs.mkdirSync('build',{recursive:true});
    await dialog.screenshot({path:'build/mail-import-preview.png'});
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='查看导入邮件');
    assert.match(await dialog.locator('[data-import-summary]').textContent(),/已新增 2 封.*1 项未能导入/);
    await action.click();
    await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(id=>activeMailAccount()?.id===id&&currentFilter.status==='local_archive',target.id);
    await page.locator('.email-item').filter({hasText:'历史导入-'+stamp}).first().waitFor();
    assert.equal(await page.locator('.email-item').filter({hasText:'历史导入-'+stamp}).count(),2,'Very old mail must be visible in archive');
    assert.equal(await page.locator('.email-item').filter({hasText:'历史导入-'+stamp}).locator('.mail-import-origin').count(),2);
    // Archived mail is readable and collectible; unsupported server actions are explicit.
    const importedRow=page.locator('.email-item').filter({hasText:'历史导入-'+stamp}).first();
    await importedRow.click({button:'right'});
    await page.locator('#mail-context-menu').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-context-action=star]').isDisabled(),true);
    assert.equal(await page.locator('[data-context-action=folders]').isDisabled(),false);
    await page.keyboard.press('Escape');
    await importedRow.click();
    await page.locator('#reading-content .meta-badges .tag').filter({hasText:'本地归档'}).waitFor();
    if (!await page.locator('[data-reading-action=favorite]').isVisible()) {
      await page.locator('.reading-more-actions > summary').click();
    }
    await page.locator('[data-reading-action=favorite]').click();
    await page.waitForFunction(()=>document.querySelector('[data-reading-action=favorite]')?.getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#reading-content .reading-risk-group').count(),0);
    // Very old archives remain visible after favorite/delete/restore actions.
    await page.evaluate(id=>openAccountMailbox(id,'favorites'),target.id);
    const favoriteRow=page.locator('.email-item').filter({hasText:'历史导入-'+stamp});
    await favoriteRow.waitFor(); assert.equal(await favoriteRow.count(),1);
    await favoriteRow.click({button:'right'});
    await page.locator('[data-context-action=trash]').click();
    await favoriteRow.waitFor({state:'hidden'});
    await page.evaluate(id=>openAccountMailbox(id,'trash'),target.id);
    const trashRow=page.locator('.email-item').filter({hasText:'历史导入-'+stamp});
    await trashRow.waitFor();
    await trashRow.click({button:'right'});
    assert.match(await page.locator('[data-context-action=cancel_trash]').textContent(),/恢复本地邮件/);
    await page.locator('[data-context-action=cancel_trash]').click();
    await trashRow.waitFor({state:'hidden'});
    await page.evaluate(id=>openAccountMailbox(id,'local_archive'),target.id);
    await page.waitForFunction(value=>allEmails.filter(e=>e.subject.includes(value)).length===2,'历史导入-'+stamp);
    // Local inbox placement must work offline and retain very old messages.
    await importedRow.click({button:'right'});
    await page.locator('[data-context-action=folders]').click();
    await page.locator('[data-context-folder="__local_inbox__"]').click();
    await page.waitForFunction(()=>!bulkOperationActive);
    await page.evaluate(id=>openAccountMailbox(id,'inbox'),target.id);
    const localInboxRow=page.locator('.email-item').filter({hasText:'历史导入-'+stamp});
    await localInboxRow.waitFor();
    assert.equal(await localInboxRow.count(),1);
    await localInboxRow.click({button:'right'});
    assert.equal(await page.locator('[data-context-action=star]').isDisabled(),true);
    await page.keyboard.press('Escape');
    await page.locator('#bulk-folder').selectOption('__local_archive__');
    await localInboxRow.waitFor({state:'hidden'});
    await page.evaluate(id=>openAccountMailbox(id,'local_archive'),target.id);
    await page.waitForFunction(value=>allEmails.filter(e=>e.subject.includes(value)).length===2,'历史导入-'+stamp);
    // Repeated export: all duplicates, with a clear explanation and disabled apply.
    await page.evaluate(()=>window.mailaiMailImport.open());
    await dialog.locator('#mail-import-files').setInputFiles({name:'same.eml',mimeType:'message/rfc822',buffer:raw('one')});
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 0 封邮件');
    assert.equal(await action.isDisabled(),true);
    assert.match(await dialog.locator('[data-import-summary]').textContent(),/无需再次导入/);
    await dialog.locator('[data-import-reset]').click(); await page.waitForFunction(()=>document.querySelector('[data-import-select]').hidden===false && document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // Interrupted upload must never silently import only part of the chosen batch.
    await dialog.locator('#mail-import-files').setInputFiles([
      {name:'first.eml',mimeType:'message/rfc822',buffer:raw('partial-one')},
      {name:'second.eml',mimeType:'message/rfc822',buffer:raw('partial-two')}
    ]);
    let thisUpload=0;
    await page.route('**/api/mail/client-imports/*/files?*',async route=>{
      if(++thisUpload===2) await route.fulfill({status:507,contentType:'application/json',body:JSON.stringify({detail:'磁盘空间不足，请重试'})});
      else await route.continue();
    });
    await action.click();
    try { await page.waitForFunction(()=>document.querySelector('[data-import-error]').textContent.includes('磁盘空间不足')); } catch(e) { console.error('Upload interruption state',thisUpload,await dialog.textContent()); throw e; }
    assert.equal(await action.isEnabled(),true);
    assert.match(await dialog.locator('[data-import-status]').textContent(),/1 \/ 2.*继续添加/);
    await page.unroute('**/api/mail/client-imports/*/files?*');
    // A committed upload with a lost response is retried safely, not counted twice.
    let lostResponse=true;
    const resumedIndices=[];
    await page.route('**/api/mail/client-imports/*/files?*',async route=>{
      resumedIndices.push(new URL(route.request().url()).searchParams.get('index'));
      if (lostResponse) { lostResponse=false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 2 封邮件');
    assert.deepEqual(resumedIndices,['1','1'],'Keep confirmed prefix; safely retry lost response');
    assert.equal(await dialog.locator('[data-count=found]').textContent(),'2');
    await page.unroute('**/api/mail/client-imports/*/files?*');
    await dialog.locator('[data-import-reset]').click(); await page.waitForFunction(()=>document.querySelector('[data-import-select]').hidden===false && document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // Reload the page after a persistent network error, then recover the saved batch.
    const resumeUploadLabel='传输断点-'+stamp;
    const resumeFiles=[{name:'saved.eml',mimeType:'message/rfc822',buffer:raw('saved')},
      {name:'remaining.eml',mimeType:'message/rfc822',buffer:raw('remaining')}];
    await dialog.locator('#mail-import-label').fill(resumeUploadLabel);
    await dialog.locator('#mail-import-files').setInputFiles(resumeFiles);
    await page.route('**/api/mail/client-imports/*/files?*',async route=>{
      if (new URL(route.request().url()).searchParams.get('index')==='1') await route.abort('failed');
      else await route.continue();
    });
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-error]').textContent.includes('文件传输中断'));
    assert.match(await dialog.locator('[data-import-status]').textContent(),/1 \/ 2/);
    assert.equal(await action.isEnabled(),true);
    await page.unroute('**/api/mail/client-imports/*/files?*');
    await page.reload();
    await page.waitForFunction(()=>Boolean(window.mailaiMailImport && _systemConfig?.accounts?.length));
    await page.evaluate(id=>window.mailaiMailImport.open(id),target.id);
    await dialog.locator('[data-import-history] summary').click();
    await dialog.locator('[data-import-job]').filter({hasText:resumeUploadLabel}).click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='继续添加');
    assert.equal(await action.isDisabled(),true);
    await dialog.locator('#mail-import-files').setInputFiles(resumeFiles);
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 2 封邮件');
    assert.equal(await dialog.locator('[data-count=found]').textContent(),'2');
    await dialog.locator('[data-import-reset]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // One bad file can be skipped without losing either healthy neighbor.
    await dialog.locator('#mail-import-files').setInputFiles([
      {name:'healthy-first.eml',mimeType:'message/rfc822',buffer:raw('skip-a')},
      {name:'empty.eml',mimeType:'message/rfc822',buffer:Buffer.alloc(0)},
      {name:'healthy-last.eml',mimeType:'message/rfc822',buffer:raw('skip-b')}
    ]);
    await action.click();
    const skip=dialog.locator('[data-import-skip]');
    await skip.waitFor({state:'visible'});
    assert.match(await dialog.locator('[data-import-error]').textContent(),/为空/);
    assert.match(await dialog.locator('[data-import-failed-file]').textContent(),/empty.eml/);
    assert.match(await dialog.locator('[data-import-retry-help]').textContent(),/重新导出.*不为 0/);
    await skip.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 2 封邮件');
    assert.equal(await dialog.locator('[data-count=failed]').textContent(),'1');
    assert.match(await dialog.locator('[data-import-skipped]').textContent(),/已单独跳过 1 个文件/);
    await dialog.locator('[data-import-errors] summary').click();
    assert.match(await dialog.locator('[data-import-errors] > div').textContent(),/empty.eml.*已单独跳过.*处理建议：.*不为 0/s);
    const skippedDownload=page.waitForEvent('download');
    await dialog.locator('[data-import-report]').click();
    const skippedCsv=fs.readFileSync(await (await skippedDownload).path(),'utf8');
    assert.match(skippedCsv,/处理建议/);
    assert.match(skippedCsv,/已跳过,empty.eml/);
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='查看导入邮件');
    assert.match(await dialog.locator('[data-import-summary]').textContent(),/已新增 2 封.*1 项未能导入/);
    await dialog.locator('[data-import-reset]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // An all-skipped batch must not offer an empty successful import.
    await dialog.locator('#mail-import-files').setInputFiles({name:'only-empty.eml',mimeType:'message/rfc822',buffer:Buffer.alloc(0)});
    await action.click(); await skip.waitFor({state:'visible'}); await skip.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 0 封邮件');
    assert.equal(await action.isDisabled(),true);
    assert.match(await dialog.locator('[data-import-summary]').textContent(),/已单独跳过 1 个文件.*另行补导/);
    await dialog.locator('[data-import-reset]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // Only corrupt files must explain re-export, never claim they already exist.
    await dialog.locator('#mail-import-files').setInputFiles(Array.from({length:40},(_,i)=>({name:`broken-${i}.eml`,mimeType:'message/rfc822',buffer:Buffer.from('broken')})));
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-summary]').textContent.includes('无法识别'));
    assert.equal(await action.isDisabled(),true);
    assert.match(await dialog.locator('[data-import-summary]').textContent(),/重新导出/);
    await dialog.locator('[data-import-errors] summary').click();
    assert.match(await dialog.locator('[data-import-issues-note]').textContent(),/40 项.*前 30 项/);
    assert.equal(await dialog.locator('[data-import-errors] > div > p').count(),30);
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.doesNotMatch(await dialog.locator('[data-import-errors]').innerText(),/[\u3400-\u9fff]/,'Import reasons and actionable advice must translate, including expanded rows');
    for(const width of [390,720,1440]) for(const mode of ['light','dark']) {
      await page.setViewportSize({width,height:800});
      await page.evaluate(mode=>applyTheme(mode),mode);
      const fit=await dialog.evaluate(n=>{const r=n.getBoundingClientRect(),f=n.querySelector('footer').getBoundingClientRect();return {left:r.left,right:r.right,footer:f.bottom,overflow:n.scrollWidth>n.clientWidth+1};});
      assert(fit.left>=0 && fit.right<=width+1 && fit.footer<=801 && !fit.overflow,JSON.stringify({width,mode,fit}));
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>{setI18nLanguage('zh-CN');applyTheme('light');});
    const fullDownload=page.waitForEvent('download');
    await dialog.locator('[data-import-report]').click();
    const csv=fs.readFileSync(await (await fullDownload).path(),'utf8');
    assert.equal(csv.trim().split(/\r?\n/).length,41);
    assert.match(csv,/broken-39.eml/);
    await dialog.locator('[data-import-reset]').click(); await page.waitForFunction(()=>document.querySelector('[data-import-select]').hidden===false && document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // Pause a real large MBOX scan, close, reopen history and continue.
    const many = Buffer.concat(Array.from({length:2500},(_,i)=>Buffer.concat([
      Buffer.from('From old@example.test Fri Jan 01 09:30:00 1993\n'),raw('resume-'+i),Buffer.from('\n')
    ])));
    const resumeLabel='可继续的导入-'+stamp;
    await dialog.locator('#mail-import-label').fill(resumeLabel);
    await dialog.locator('#mail-import-files').setInputFiles({name:'many.mbox',mimeType:'application/mbox',buffer:many});
    await action.click();
    await dialog.locator('[data-import-pause]').waitFor({state:'visible'});
    await dialog.locator('[data-import-pause]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='继续');
    assert.match(await dialog.locator('[data-import-status]').textContent(),/扫描已暂停/);
    assert.equal(await dialog.locator('[data-import-live]').isVisible(),true);
    assert.match(await dialog.locator('[data-import-live]').textContent(),/已识别.*待新增.*重复.*无法导入/);
    assert.match(await dialog.locator('[data-import-progress-note]').textContent(),/重新扫描整批文件/);
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    await page.evaluate(()=>window.mailaiMailImport.open());
    await dialog.locator('[data-import-history] summary').click();
    const historyRow=dialog.locator('[data-import-job]').filter({hasText:resumeLabel});
    await historyRow.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='继续');
    assert.equal(await dialog.locator('#mail-import-account').inputValue(),target.id);
    assert.equal(await dialog.locator('#mail-import-account').isDisabled(),true);
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 2500 封邮件',null,{timeout:60000});
    await dialog.locator('[data-import-reset]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-select]').hidden===false && document.querySelector('[data-import-action]').textContent==='扫描并去重');
    // Oversized files never transfer or block their healthy neighbors.
    const hugePath=path.join(root,'超长文件名'.repeat(20)+'.eml');
    const hugeFd=fs.openSync(hugePath,'w');fs.ftruncateSync(hugeFd,65*1024*1024);fs.closeSync(hugeFd);
    const healthyPath=path.join(root,'auto-skip-healthy.eml');fs.writeFileSync(healthyPath,raw('auto-skip'));
    await dialog.locator('[data-import-large]').uncheck();
    await dialog.locator('#mail-import-files').setInputFiles([hugePath,healthyPath]);
    const uploadsBefore=uploads;
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='导入缺少的 1 封邮件');
    assert.equal(uploads-uploadsBefore,1,'Oversized file should be skipped before any upload');
    assert.equal(await dialog.locator('[data-count=failed]').textContent(),'1');
    await dialog.locator('[data-import-errors] summary').click();
    assert.match(await dialog.locator('[data-import-errors]').textContent(),/65.*MB.*64.*MB/);
    await action.click();
    await page.waitForFunction(()=>document.querySelector('[data-import-action]').textContent==='查看导入邮件');
    await dialog.locator('[data-import-retry-files]').click();
    await page.waitForFunction(()=>document.querySelector('[data-import-selected]').textContent.includes('已选择 1 个邮件文件'));
    assert.match(await dialog.locator('[data-import-selected]').textContent(),/已选择 1 个邮件文件/);
    assert.equal(await dialog.locator('[data-import-large]').isChecked(),true);
    assert.equal(await dialog.locator('#mail-import-label').isEnabled(),true);
    await page.evaluate(()=>setI18nLanguage('en'));
    assert.match(await dialog.locator('.mail-import-large').textContent(),/Large-message mode/);
    await page.setViewportSize({width:390,height:780});
    const englishLayout=await dialog.evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,bottom:n.querySelector('footer').getBoundingClientRect().bottom}));
    assert(englishLayout.scroll<=englishLayout.client+1 && englishLayout.bottom<=780,JSON.stringify(englishLayout));
    await page.evaluate(()=>setI18nLanguage('zh-CN'));
    await page.setViewportSize({width:1440,height:1000});
    // Dark mode hover/focus and compact view must remain readable and usable.
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await dialog.locator('#mail-import-files').setInputFiles({name:'fresh.eml',mimeType:'message/rfc822',buffer:raw('fresh')});
    for (const n of [dialog.locator('[data-import-files]'),dialog.locator('[data-import-folder]'),action]) {
      await n.hover();
      const styles=await n.evaluate(n=>({color:getComputedStyle(n).color,bg:getComputedStyle(n).backgroundColor}));
      assert.notEqual(styles.color,styles.bg);
      if(n!==action) assert(Math.max(...styles.bg.match(/[\d.]+/g).slice(0,3).map(Number))<100,'Dark button hover must retain dark surface');
      await page.keyboard.press('Tab'); await n.focus(); assert.equal(await n.evaluate(n=>getComputedStyle(n).outlineStyle),'solid');
    }
    await page.setViewportSize({width:390,height:780});
    const geometry=await dialog.evaluate(n=>{const r=n.getBoundingClientRect(); const b=n.querySelector('footer').getBoundingClientRect();return {left:r.left,right:r.right,scroll:n.scrollWidth,client:n.clientWidth,footer:b.bottom};});
    assert(geometry.left>=0 && geometry.right<=391 && geometry.scroll<=geometry.client+1 && geometry.footer<=780,JSON.stringify(geometry));
    await dialog.screenshot({path:'build/mail-import-dark-mobile.png'});
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(id=>{showSystemView('account'); selectedManagedAccountId=id; renderAccountSelection();},active);
    await page.locator('#btn-account-import-mail').click();
    await dialog.waitFor({state:'visible'});
    assert.equal(await dialog.locator('#mail-import-account').inputValue(),active,'Account shortcut must use managed account, not active mailbox');
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);
    console.log('Mail import browser: directory/EML/MBOX, clear preview, account isolation, dedup, pause/history/resume, corrupt files, upload interruption, double-click lock, dark/mobile UI passed');
  } finally { fs.rmSync(root,{recursive:true,force:true}); await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
