const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('app/web/static/app.js','utf8');
const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
(async()=>{
 const warnings=[];const c={atob,crypto:require('node:crypto').webcrypto,draftSession:{},composeAccountId:'one',composeAttachments:[],readFileAsBase64:file=>Promise.resolve(Buffer.alloc(file.size).toString('base64')),renderComposeAttachments(){},queueDraftSave(){},clearComposePreflight(){},toast:x=>warnings.push(x)};
 vm.createContext(c);vm.runInContext(extract('async function addComposeAttachments(','async function saveCurrentDraft('),c);
 const file={name:'a',size:20*1024*1024};await Promise.all([c.addComposeAttachments([file]),c.addComposeAttachments([file])]);assert.equal(c.composeAttachments.length,1);assert.equal(warnings.length,1);
 let release;c.composeAttachments=[];c.readFileAsBase64=()=>new Promise(r=>release=r);
 const reading=c.addComposeAttachments([{name:'old',size:1}]);c.draftSession={};c.composeAttachments=[];release('ok');await reading;assert.equal(c.composeAttachments.length,0);
 c.readFileAsBase64=()=>Promise.reject(Error('read failure'));await c.addComposeAttachments([{name:'bad',size:1}]);assert.equal(c.draftSession.attachmentBytes,0);assert.equal(c.draftSession.attachmentReads,0);
 const images={draftSession:{},composeAccountId:'one',toast(){},readFileAsBase64:()=>new Promise(r=>release=r),document:{execCommand(){throw Error('stale image inserted')}},restoreComposeSelection(){},rememberComposeSelection(){},clearComposePreflight(){},queueDraftSave(){},esc:x=>x};
 vm.createContext(images);vm.runInContext(extract('async function insertComposeImage(','function openComposePreview('),images);
 const imageRead=images.insertComposeImage({type:'image/png',size:1,name:'old.png'});images.draftSession={};release('ok');await imageRead;
 const paging={api:async path=>Array.from({length:Math.min(1000,1500-Number(path.split('offset=')[1]))},(_,i)=>({id:i+Number(path.split('offset=')[1])}))};vm.createContext(paging);vm.runInContext(extract('async function loadMailPages(','async function loadData('),paging);assert.equal((await paging.loadMailPages('/api/emails?limit=1000')).length,1500);
 let rows;const sort={specialMailbox:'sent',savedDrafts:[],sentMessages:[{id:2,status:'sent',subject:'other',sent_at:'2026-09-08'},{id:1,status:'sent',subject:'needle',sent_at:'2026-09-01',to_addr:'person@example.test',counterpart_name:'张三',counterpart_addr:'person@example.test',counterpart_count:1}],recipientEmails:value=>String(value||'').split(',').filter(Boolean),currentFilter:{search:'',sort:'date-asc',days:9999},renderEmailList:r=>rows=r,document:{getElementById:()=>({})}};vm.createContext(sort);vm.runInContext(extract('function specialMailboxRows()','// ===== 渲染邮件列表 ====='),sort);sort.renderSpecialMailbox();assert.equal(rows[0].id,1);assert.equal(rows[0].counterpart_name,'张三');sort.currentFilter.search='needle';sort.renderSpecialMailbox();assert.deepEqual(Array.from(rows,r=>r.id),[1]);
 console.log('PASS attachments session/size/failure, 1500 result paging, sent search/sort');
})();
