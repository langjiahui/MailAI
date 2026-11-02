/* Standalone owner tool: protocol identifiers and signed user content never change with language. */
const catalogue = __CATALOGUE__;
const itemNames = Object.fromEntries(Object.entries(catalogue.items).map(([id,item])=>[id,item.names]));
const copy = {
  title:['小邮礼物发放','XiaoYou gift studio'],
  intro:['选好礼物，生成领取券，再把礼物送出去。','Choose gifts, create a voucher, and send it to someone.'],
  steps:['发放步骤','Gift issuing steps'],step1:['01 选择礼物','01 Choose gifts'],step2:['02 生成领取券','02 Create voucher'],step3:['03 复制或导出','03 Copy or export'],
  name:['礼包名称','Gift name'],defaultName:['小邮见面礼','A gift from XiaoYou'],who:['发给谁','Who is it for?'],
  personal:['专属赠礼 · 指定客户端','Personal gift · One client'],campaign:['活动礼包 · 多人领取','Campaign bundle · Multiple clients'],
  deadline:['领取期限','Claim window'],unlimited:['不限期','No deadline'],days7:['7 天','7 days'],days30:['30 天','30 days'],days90:['90 天','90 days'],
  recipient:['客户端领取编号','Client recipient code'],recipientHint:['用户在「{0}」中复制给你。','Ask the recipient to copy their code from {0}.'],
  recipientPlaceholder:['粘贴完整的 XY-… 编号','Paste the complete XY-… code'],recipientInvalid:['请粘贴以 XY- 开头的完整客户端领取编号。','Paste the complete client recipient code, starting with XY-.'],
  pick:['挑选礼物','Choose gifts'],count:['{0} / 8 件','{0} / 8 selected'],itemsHint:['永久装扮与主题，免费领取，无成长等级门槛。','Permanent outfits and themes. Free to claim at any growth level.'],
  retryHint:['生成结果待核对。重试会找回同一张领取券，不会再生成一张。','The result needs checking. Retrying retrieves the same voucher without creating another.'],restart:['重新填写','Start a new gift'],
  issue:['生成领取券','Create voucher'],issuing:['正在生成…','Creating…'],retry:['核对并重试','Check and retry'],
  review:['待发放的礼物','Gift to create'],emptySelection:['选中的礼物会显示在这里','Selected gifts appear here'],
  personalHint:['指定客户端领取，转发给其他客户端无效。','Only the specified client can claim this gift.'],campaignHint:['每个客户端领取一次，可以发给多人。','Each client can claim once. You can share it with multiple people.'],
  noDeadline:['领取不限期。','No claim deadline.'],withinDays:['须在 {0} 天内领取。','Claim within {0} days.'],
  ready:['领取券已准备好','Your voucher is ready'],recovered:['已找回原领取券','Original voucher recovered'],personalShort:['专属赠礼','Personal gift'],campaignShort:['活动礼包 · 每个客户端一次','Campaign bundle · Once per client'],
  expires:['领取截止：{0}','Claim by: {0}'],copy:['复制领取券','Copy voucher'],copied:['已复制','Copied'],export:['导出文件','Export file'],voucher:['领取券','Gift voucher'],
  viewCode:['查看完整领取券','View full voucher'],sendHint:['将领取券或文件发给用户，在「{0}」中粘贴领取券或导入文件。','Send the voucher or file to the recipient. They can paste it or import the file in {0}.'],
  copyDone:['已复制，可发送给用户。','Copied. You can send it to the recipient.'],copyFallback:['请复制已选中的完整领取券。','Copy the selected voucher in full.'],
  history:['最近发放的礼物','Recent gifts'],historyHint:['最近 20 条，可找回原券','Last 20 gifts · Recover original vouchers'],refresh:['刷新','Refresh'],reading:['正在读取…','Loading…'],
  recover:['找回原券','Recover voucher'],historyEmpty:['还没有发放记录。','No gifts issued yet.'],expired:['已过领取期限','Claim window ended'],
  historyFailed:['记录暂时无法读取，可以点击刷新重试。','Could not load records. Select Refresh to try again.'],
  timeout:['等待超时，请重试核对原券。','The request timed out. Retry to check the original voucher.'],
  network:['连接中断，请重试核对原券。','Connection interrupted. Retry to check the original voucher.'],
  invalid:['请核对领取编号、礼物名称，并选择 1 到 8 件礼物。','Check the recipient code and gift name, and select 1 to 8 gifts.'],
  collections:['按套系挑选','Choose a collection'],collectionHint:['先看整套造型，再加入礼物；也可以展开单件搭配。','Preview a complete look, then add it to your gift. You can also choose individual pieces.'],
  individual:['单件搭配与工作区主题','Individual pieces & workspace themes'],
  preview:['造型预览','Outfit preview'],shape:['预览小邮形象','Preview character'],bird:['小邮雀','XiaoYou bird'],fish:['小邮鱼','XiaoYou fish'],
  previewSelection:['所选礼物','Selected gifts'],previewSet:['整套参考','Collection reference'],
  previewNotice:['造型随收礼人的成长形态变化；切换预览不会改变礼物。','The look adapts to the recipient’s growth stage. Changing the preview never changes the gift.'],
  claimHint:['领取后计入装扮收藏与套系进度，可免费整套穿戴；已有部件保留，不重复累计。','Claimed pieces count toward collections and can be worn together for free. Existing pieces are kept and counted once.'],
  addCollection:['加入整套 · {0} 件','Add full collection · {0} pieces'],addMissing:['补齐此套 · 加入 {0} 件','Complete this collection · Add {0} pieces'],removeCollection:['移除此套','Remove this collection'],
  selectedCount:['此套已选 {0} / {1} 件','Selected {0} / {1} pieces'],capacity:['每券最多 8 件；加入此套还需 {0} 个空位，请减少单件或分券发放。','Each voucher holds 8 pieces. This collection needs {0} more spaces. Remove pieces or use another voucher.'],
  clear:['清空所选','Clear selection'],selectedPreview:['当前礼物 · {0} 件','Current gift · {0} pieces'],
  selectedHint:['同一部位每次穿一件；全部礼物以下方清单为准，可在客户端切换搭配。主题在工作区启用。','One piece per slot is shown. All gifts are listed below; recipients can switch outfits. Themes apply to the workspace.'],
  referenceHint:['整套参考 · {0} / {1} 件已加入礼物','Collection reference · {0} / {1} pieces added to gift'],
  previewEmpty:['还没有选择礼物','No gifts selected yet'],previewEmptyHint:['选择整套或单件，在这里查看搭配。','Choose a collection or individual pieces to preview them here.'],
  saveFailed:['发放记录保存失败，请检查文件权限后重试。','Could not save the issuing record. Check file permissions and retry.']
};
const el = id => document.getElementById(id), form = el('issuer-form'), boxes = [...document.querySelectorAll('.items input')];
const setDisabled = (node,value) => { if(node.disabled!==!!value)node.disabled=!!value; };
let language = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
try { const saved = localStorage.getItem('mailai-gift-issuer-language'); if (['zh-CN','en'].includes(saved)) language = saved; } catch (_) {}
const t = (key,...args) => {
  const index=language==='en'?1:0;
  if(key==='recipientHint')args=[catalogue.paths.recipient[index]];
  if(key==='sendHint')args=[catalogue.paths.gifts[index]];
  return (copy[key]?.[index] || key).replace(/\{(\d+)\}/g,(_,index)=>String(args[index]??''));
};
const itemLabel = id => itemNames[id]?.[language==='en'?1:0] || id;
const dateLabel = seconds => new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'short'}).format(new Date(seconds*1000));
let downloadUrl = '', busy = false, pending = null, currentPacket = null, entries = [], historyRevision = 0;
let recovered = false, previewCollection = Object.keys(catalogue.collections)[0], previewMode = 'collection';
const collectionLabel = id => catalogue.collections[id].names[language==='en'?1:0];
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
  drawCollections();
}
function drawCollections() {
  const selected = new Set(data().items), set = catalogue.collections[previewCollection];
  for(const button of el('collections').children) {
    const id=button.dataset.collection, collection=catalogue.collections[id];
    button.setAttribute('aria-pressed',String(id===previewCollection));
    button.querySelector('b').textContent=collectionLabel(id);
    button.querySelector('small').textContent=t('selectedCount',collection.items.filter(item=>selected.has(item)).length,collection.items.length);
  }
  const missing = set.items.filter(item=>!selected.has(item));
  el('add-collection').textContent=t(!missing.length?'removeCollection':missing.length===set.items.length?'addCollection':'addMissing',missing.length);
  const overflow = Math.max(0,selected.size+missing.length-8);
  setDisabled(el('add-collection'),busy||!!pending||overflow>0);
  setDisabled(el('clear-selection'),busy||!!pending||!selected.size);
  el('capacity').textContent=overflow?t('capacity',overflow):'';
  el('collection-status').textContent=t('selectedCount',set.items.length-missing.length,set.items.length);
  drawPreview();
}
function drawPreview() {
  const set = catalogue.collections[previewCollection], selected = data().items;
  // For multi-set gifts, show the focused collection's parts for conflicting
  // slots. The full inventory remains explicit in the gift list below.
  const ids = previewMode==='collection' ? set.items : [...selected.filter(id=>!set.items.includes(id)),...set.items.filter(id=>selected.includes(id))];
  const look={};
  for(const id of ids)look[catalogue.items[id].slot]=id;
  const art=el('outfit-preview');
  art.dataset.fittingOutfits=['head','neck','body','back'].map(slot=>look[slot]).filter(Boolean).join(' ');
  art.dataset.fittingPalette=look.palette||''; art.dataset.fittingEffect=look.effect||'';
  art.dataset.collectionLook=Object.keys(catalogue.collections).find(id=>catalogue.collections[id].items.every(item=>Object.values(look).includes(item)))||'';
  art.hidden=previewMode==='selected'&&!selected.length;
  el('preview-title').textContent=previewMode==='collection'?collectionLabel(previewCollection):t(selected.length?'selectedPreview':'previewEmpty',selected.length);
  el('preview-description').textContent=previewMode==='collection'?set.descriptions[language==='en'?1:0]:t(selected.length?'selectedHint':'previewEmptyHint');
  art.setAttribute('aria-label',el('preview-title').textContent);
  art.dataset.previewItems=Object.values(look).join(' ');
  el('preview-selection').setAttribute('aria-pressed',String(previewMode==='selected'));
  el('preview-set').setAttribute('aria-pressed',String(previewMode==='collection'));
  el('preview-set').textContent=previewMode==='collection'?t('referenceHint',set.items.filter(id=>selected.includes(id)).length,set.items.length):t('previewSet');
}
function changedSelection() {
  el('result').hidden=true;errorKey='';errorLiteral='';recipientError=false;
  document.querySelectorAll('.steps>span').forEach((n,i)=>n.classList.toggle('current',i===0));draw();
}
for(const id of Object.keys(catalogue.collections)) {
  const button=document.createElement('button');button.type='button';button.dataset.collection=id;
  button.append(document.createElement('b'),document.createElement('small'));
  button.onclick=()=>{previewCollection=id;previewMode='collection';draw();};el('collections').append(button);
}
el('add-collection').onclick=()=>{
  if(busy||pending)return;
  const ids=catalogue.collections[previewCollection].items,selected=data().items;
  const remove=ids.every(id=>selected.includes(id));
  if(!remove&&new Set([...selected,...ids]).size>8)return;
  boxes.filter(n=>ids.includes(n.value)).forEach(n=>n.checked=!remove);
  previewMode='selected';changedSelection();
};
el('clear-selection').onclick=()=>{if(busy||pending)return;boxes.forEach(n=>n.checked=false);previewMode='selected';changedSelection();};
el('preview-selection').onclick=()=>{previewMode='selected';drawPreview();};
el('preview-set').onclick=()=>{previewMode='collection';drawPreview();};
el('preview-shape').onchange=()=>{document.body.dataset.petStyle=el('preview-shape').value;};
el('outfit-preview').querySelector('.pet-portrait').innerHTML=window.mailaiCompanionArt;
el('outfit-preview').querySelector('svg').setAttribute('data-evolution-stage','5');
// Share night materials with the client without enabling any motion.
const appearance=matchMedia('(prefers-color-scheme: dark)');
const setAppearance=()=>{document.documentElement.dataset.theme=appearance.matches?'dark':'light';};
appearance.addEventListener('change',setAppearance);setAppearance();

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
form.addEventListener('input',event=>{
  if(busy||pending)return;
  if(event.target.matches('[type=checkbox]'))previewMode='selected';
  changedSelection();
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
