/* Standalone owner tool: protocol identifiers and signed user content never change with language. */
const itemNames = __ITEM_NAMES__;
const copy = {
  title:['小邮礼物发放','XiaoYou gift studio'],
  intro:['选好礼物，生成领取券，再把礼物送出去。','Choose gifts, create a voucher, and send it to someone.'],
  steps:['发放步骤','Gift issuing steps'],step1:['01 选择礼物','01 Choose gifts'],step2:['02 生成领取券','02 Create voucher'],step3:['03 复制或导出','03 Copy or export'],
  name:['礼包名称','Gift name'],defaultName:['小邮见面礼','A gift from XiaoYou'],who:['发给谁','Who is it for?'],
  personal:['专属赠礼 · 指定客户端','Personal gift · One client'],campaign:['活动礼包 · 多人领取','Campaign bundle · Multiple clients'],
  deadline:['领取期限','Claim window'],unlimited:['不限期','No deadline'],days7:['7 天','7 days'],days30:['30 天','30 days'],days90:['90 天','90 days'],
  recipient:['客户端领取编号','Client recipient code'],recipientHint:['用户在「养成手账 → 领取礼物 → 我的领取编号」中复制给你。','Ask the recipient to copy their code from Growth journal → Gifts → My recipient code.'],
  recipientPlaceholder:['粘贴完整的 XY-… 编号','Paste the complete XY-… code'],recipientInvalid:['请粘贴以 XY- 开头的完整客户端领取编号。','Paste the complete client recipient code, starting with XY-.'],
  pick:['挑选礼物','Choose gifts'],count:['{0} / 8 件','{0} / 8 selected'],itemsHint:['永久装扮与主题，免费领取，无成长等级门槛。','Permanent outfits and themes. Free to claim at any growth level.'],
  retryHint:['生成结果待核对。重试会找回同一张领取券，不会再生成一张。','The result needs checking. Retrying retrieves the same voucher without creating another.'],restart:['重新填写','Start a new gift'],
  issue:['生成领取券','Create voucher'],issuing:['正在生成…','Creating…'],retry:['核对并重试','Check and retry'],
  review:['待发放的礼物','Gift to create'],emptySelection:['选中的礼物会显示在这里','Selected gifts appear here'],
  personalHint:['指定客户端领取，转发给其他客户端无效。','Only the specified client can claim this gift.'],campaignHint:['每个客户端领取一次，可以发给多人。','Each client can claim once. You can share it with multiple people.'],
  noDeadline:['领取不限期。','No claim deadline.'],withinDays:['须在 {0} 天内领取。','Claim within {0} days.'],
  ready:['领取券已准备好','Your voucher is ready'],recovered:['已找回原领取券','Original voucher recovered'],personalShort:['专属赠礼','Personal gift'],campaignShort:['活动礼包 · 每个客户端一次','Campaign bundle · Once per client'],
  expires:['领取截止：{0}','Claim by: {0}'],copy:['复制领取券','Copy voucher'],copied:['已复制','Copied'],export:['导出文件','Export file'],voucher:['领取券','Gift voucher'],
  viewCode:['查看完整领取券','View full voucher'],sendHint:['将领取券或文件发给用户，在养成手账 → 领取礼物中使用。','Send the voucher or file to the recipient. They can claim it in Growth journal → Gifts.'],
  copyDone:['已复制，可发送给用户。','Copied. You can send it to the recipient.'],copyFallback:['请复制已选中的完整领取券。','Copy the selected voucher in full.'],
  history:['最近发放的礼物','Recent gifts'],historyHint:['最近 20 条，可找回原券','Last 20 gifts · Recover original vouchers'],refresh:['刷新','Refresh'],reading:['正在读取…','Loading…'],
  recover:['找回原券','Recover voucher'],historyEmpty:['还没有发放记录。','No gifts issued yet.'],expired:['已过领取期限','Claim window ended'],
  historyFailed:['记录暂时无法读取，可以点击刷新重试。','Could not load records. Select Refresh to try again.'],
  timeout:['等待超时，请重试核对原券。','The request timed out. Retry to check the original voucher.'],
  network:['连接中断，请重试核对原券。','Connection interrupted. Retry to check the original voucher.'],
  invalid:['请核对领取编号、礼物名称，并选择 1 到 8 件礼物。','Check the recipient code and gift name, and select 1 to 8 gifts.'],
  saveFailed:['发放记录保存失败，请检查文件权限后重试。','Could not save the issuing record. Check file permissions and retry.']
};
const el = id => document.getElementById(id), form = el('issuer-form'), boxes = [...document.querySelectorAll('.items input')];
const setDisabled = (node,value) => { if(node.disabled!==!!value)node.disabled=!!value; };
let language = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
try { const saved = localStorage.getItem('mailai-gift-issuer-language'); if (['zh-CN','en'].includes(saved)) language = saved; } catch (_) {}
const t = (key,...args) => (copy[key]?.[language==='en'?1:0] || key).replace(/\{(\d+)\}/g,(_,index)=>String(args[index]??''));
const itemLabel = id => itemNames[id]?.[language==='en'?1:0] || id;
const dateLabel = seconds => new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'short'}).format(new Date(seconds*1000));
let downloadUrl = '', busy = false, pending = null, currentPacket = null, entries = [], historyRevision = 0;
let recovered = false;
let errorKey = '', errorLiteral = '', copyStatus = '', recipientError = false, historyStatus = '';
const stashKey = 'mailai-gift-issuer-pending:'+location.pathname;
function data() {
  return {title:el('title').value.trim(),items:boxes.filter(n=>n.checked).map(n=>n.value),recipient:el('kind').value==='campaign'?'*':el('recipient').value.trim(),days:Number(el('days').value)};
}
function stash(value) {
  pending = value;
  try { value ? sessionStorage.setItem(stashKey,JSON.stringify(value)) : sessionStorage.removeItem(stashKey); } catch (_) {}
}
function draw() {
  const selected = boxes.filter(n=>n.checked), exclusive = el('kind').value==='exclusive';
  el('count').textContent = t('count',selected.length);
  boxes.forEach(n=>setDisabled(n,busy||!!pending||selected.length>=8&&!n.checked));
  for (const node of form.querySelectorAll('input:not([type=checkbox]),select')) setDisabled(node,busy||!!pending);
  el('recipient-label').hidden=!exclusive; el('recipient').required=exclusive;
  el('recipient').setAttribute('aria-invalid',String(recipientError)); el('recipient-error').textContent=recipientError?t('recipientInvalid'):'';
  el('selection').dataset.empty=t('emptySelection');
  el('selection').replaceChildren(...selected.map(node=>{const chip=document.createElement('span');chip.textContent=itemLabel(node.value);return chip;}));
  el('meta').textContent=t(exclusive?'personalHint':'campaignHint')+' '+(el('days').value==='0'?t('noDeadline'):t('withinDays',el('days').value));
  const valid=selected.length>0&&el('title').value.trim()&&(!exclusive||el('recipient').value.trim());
  setDisabled(el('issue'),busy||!pending&&!valid);
  const caption=t(busy?'issuing':pending?'retry':'issue'); if(el('issue').textContent!==caption)el('issue').textContent=caption;
  el('retry').hidden=!pending||busy; setDisabled(el('restart'),busy);
  el('form-card').setAttribute('aria-busy',String(busy)); el('error').textContent=errorKey?t(errorKey):errorLiteral;
  el('history-status').textContent=historyStatus?t(historyStatus):'';
}
function show(packet, fromHistory = false) {
  currentPacket=packet; copyStatus=''; recovered=fromHistory;
  if(downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl=URL.createObjectURL(new Blob([packet.code+'\n'],{type:'text/plain'}));
  el('download').href=downloadUrl; el('download').download='MailAI-gift-'+packet.id+'.mailaigift';
  renderPacket(); el('result').hidden=false;
  if(!fromHistory)document.querySelectorAll('.steps>span').forEach((n,i)=>n.classList.toggle('current',i===2));
}
function renderPacket() {
  if(!currentPacket)return;
  const packet=currentPacket;
  el('result-title').textContent=t(recovered?'recovered':'ready');
  el('code').value=packet.code;
  el('copy').textContent=t(copyStatus==='copyDone'?'copied':'copy'); el('copy-status').textContent=copyStatus?t(copyStatus):'';
  el('summary').textContent=packet.title+' · '+(packet.item_ids||[]).map(itemLabel).join(language==='en'?', ':'、');
  el('result-meta').textContent=(packet.exclusive?t('personalShort')+' · '+packet.recipient:t('campaignShort'))+'\n'+(packet.expires?t('expires',dateLabel(packet.expires)):t('noDeadline'));
}
async function request(path,options={}) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(location.pathname+'/'+path,{...options,signal:controller.signal});
    const payload=await response.json();
    if(!response.ok){const error=Error(payload.error||'');error.status=response.status;error.key=payload.error_key;throw error;}
    return payload;
  } finally { clearTimeout(timeout); }
}
function renderHistory() {
  el('history-list').replaceChildren(...entries.map(packet=>{
    const row=document.createElement('div');row.className='history-item';
    const detail=document.createElement('div'),title=document.createElement('b'),hint=document.createElement('small'),items=document.createElement('small'),button=document.createElement('button');
    title.textContent=packet.title;
    hint.textContent=dateLabel(packet.issued)+' · '+t(packet.exclusive?'personalShort':'campaignShort')+(packet.expires&&packet.expires<=Date.now()/1000?' · '+t('expired'):'');
    items.textContent=(packet.item_ids||[]).map(itemLabel).join(language==='en'?', ':'、');
    detail.append(title,items,hint);button.type='button';button.textContent=t('recover');
    button.onclick=()=>{show(packet,true);el('result').scrollIntoView({block:'nearest'});el('copy').focus({preventScroll:true});};
    row.append(detail,button);return row;
  }));
}
async function loadHistory() {
  const revision=++historyRevision; historyStatus='reading'; draw();
  try {
    const result=await request('history'); if(revision!==historyRevision)return;
    entries=result;historyStatus=entries.length?'':'historyEmpty';renderHistory();
  } catch(_){if(revision!==historyRevision)return;historyStatus='historyFailed';}
  draw();
}
function translate() {
  document.documentElement.lang=language;document.title=t('title');el('language').value=language;
  for(const node of document.querySelectorAll('[data-copy]'))node.textContent=t(node.dataset.copy);
  for(const node of document.querySelectorAll('[data-placeholder]'))node.placeholder=t(node.dataset.placeholder);
  for(const node of document.querySelectorAll('[data-label]'))node.setAttribute('aria-label',t(node.dataset.label));
  for(const node of document.querySelectorAll('[data-item]'))node.textContent=itemLabel(node.dataset.item);
  renderPacket();renderHistory();draw();
}
form.addEventListener('input',()=>{
  if(busy||pending)return;
  el('result').hidden=true;errorKey='';errorLiteral='';recipientError=false;
  document.querySelectorAll('.steps>span').forEach((n,i)=>n.classList.toggle('current',i===0));draw();
});
// Input handles text, selects and checkboxes. Repainting again on blur/change can
// cancel the first native submit-button click in WebKit while a field loses focus.
form.onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  if(!pending&&!form.reportValidity())return;
  if(!pending&&el('kind').value==='exclusive'){
    const value=el('recipient').value.trim().toUpperCase();
    if(!value.startsWith('XY-')||!/^([A-Z2-7]{26})$/.test(value.slice(3).replace(/-/g,''))){
      recipientError=true;draw();el('recipient').focus();return;
    }
  }
  if(!pending)stash({...data(),request_id:crypto.randomUUID()});
  busy=true;errorKey='';errorLiteral='';draw();el('result').hidden=true;
  try {
    const packet=await request('issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending)});
    stash(null);show(packet);void loadHistory();el('copy').focus({preventScroll:true});el('result').scrollIntoView({block:'nearest'});
  } catch(error) {
    if(error.status===400)stash(null);
    errorKey=copy[error.key]?error.key:error.name==='AbortError'?'timeout':error.status===400?'invalid':'network';
    errorLiteral=error.message;
  } finally {busy=false;draw();}
};
el('restart').onclick=()=>{stash(null);errorKey='';errorLiteral='';draw();void loadHistory();el('title').focus();};
el('copy').onclick=async()=>{
  if(!currentPacket)return;
  try{await navigator.clipboard.writeText(currentPacket.code);copyStatus='copyDone';}
  catch(_){el('code').closest('details').open=true;el('code').focus();el('code').select();copyStatus='copyFallback';}
  renderPacket();
};
el('refresh-history').onclick=()=>loadHistory();
el('language').onchange=()=>{
  const defaultName=el('title').value===t('defaultName');language=el('language').value;
  if(defaultName&&!busy&&!pending)el('title').value=t('defaultName');
  try{localStorage.setItem('mailai-gift-issuer-language',language);}catch(_){}translate();
};
if(el('title').value===copy.defaultName[0])el('title').value=t('defaultName');
try {
  const saved=JSON.parse(sessionStorage.getItem(stashKey)||'null');
  if(saved&&typeof saved.request_id==='string'&&Array.isArray(saved.items)){
    pending=saved;el('title').value=saved.title;el('kind').value=saved.recipient==='*'?'campaign':'exclusive';el('recipient').value=saved.recipient==='*'?'':saved.recipient;el('days').value=String(saved.days);boxes.forEach(n=>n.checked=saved.items.includes(n.value));
  }
}catch(_){}
translate();void loadHistory();
