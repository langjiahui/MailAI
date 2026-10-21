// A presentation preference only: filtering, selection and reading share the existing list.
function mailTableHeader() {
  if (document.body.dataset.mailListView !== 'table') return '';
  const ascending = currentFilter.sort === 'date-asc';
  const keys = ['sender','recipient','subject','date'];
  const labels = {sender:mailaiText('发件人'),recipient:mailaiText('收件人'),subject:mailaiText('主题'),date:mailaiText('日期')};
  return `<div class="mail-table-header">${keys.map((key,index) => `<div class="mail-table-heading">
    ${key === 'date' ? `<button type="button" data-table-date-sort title="${esc(mailaiText('切换日期排序'))}" aria-label="${esc(mailaiText('切换日期排序'))}"><span data-i18n="mailView.date">${esc(mailaiText('日期'))}</span><span aria-hidden="true">${currentFilter.sort === 'score-desc' ? '↕' : ascending ? '↑' : '↓'}</span></button>` : `<span data-i18n="mailView.${key}" title="${esc(labels[key])}">${esc(labels[key])}</span>`}
    ${index < 3 ? `<i class="mail-table-column-resizer" data-mail-column="${index}" tabindex="0" role="separator" aria-orientation="vertical" aria-label="${esc(mailaiText('调整列宽') + ' · ' + labels[key])}" title="${esc(mailaiText('拖动调整列宽，双击恢复默认；也可使用左右方向键'))}"></i>` : ''}
  </div>`).join('')}</div>`;
}

function renderMailTableItem(e, {selected, bulkSelected, risk, unread, hasAtt, outgoing}) {
  // Local draft/sent adapters use from_addr for the counterpart, not the real sender.
  const senderAddress = e._kind ? (e._account_user || activeMailAccount()?.user || '') : e.from_addr || '';
  const sender = e._kind ? senderAddress : e.from_name || senderAddress || mailaiText('未知联系人');
  const recipients = e.to_addr || e.cc_addr || e.bcc_addr || '';
  const date = new Date(e.date || e.created_at || '');
  const dateText = Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}` : '—';
  const pending = e.pending_action ? (e.pending_error ? mailaiText('后台重试中') : mailaiText('正在同步删除')) : '';
  const chips = [e._account_user, ...(e.tags || []).map(tag => tag.name), e.category ? mailCategoryLabel(e.category) : '', e.priority ? mailPriorityLabel(e.priority) : '', pending].filter(Boolean).join(' · ');
  return `<div class="email-item mail-table-item ${selected} ${bulkSelected} ${unread ? 'unread' : ''} ${outgoing ? 'outgoing-mail' : ''} risk-${risk.class}"
    data-id="${e.id}" data-account-id="${esc(e._account_id || '')}" data-read-state="${outgoing ? 'not-applicable' : unread ? 'unread' : 'read'}" tabindex="0" aria-selected="${bulkSelected ? 'true' : 'false'}">
    <span class="mail-table-sender" title="${esc(senderAddress && sender !== senderAddress ? `${sender} <${senderAddress}>` : sender)}">${esc(sender)}</span>
    <span class="mail-table-recipient" title="${esc(recipients)}">${esc(recipients || '—')}</span>
    <span class="mail-table-subject" title="${esc([e.subject, chips, e.summary || e.snippet].filter(Boolean).join('\n'))}"><span>${esc(e.subject || mailaiText('无主题'))}</span>${e._conversationCount > 1 ? `<small> ${Number(e._conversationCount)}</small>` : ''}</span>
    <time class="mail-table-date" title="${esc(dateText)}"><span class="mail-table-date-full">${dateText}</span><span class="mail-table-date-short">${dateText.length>5?dateText.slice(5):dateText}</span></time>
    ${currentFilter.search && e.search_match ? `<div class="mail-table-match">${renderSearchPreview(e)}</div>` : ''}
  </div>`;
}

(() => {
  document.body.dataset.mailListView = localStorage.getItem('mailai-mail-list-view') === 'table' ? 'table' : 'cards';
  window.dispatchEvent(new Event('mailai:list-view-changed'));
  const list = document.getElementById('email-list');
  const columnKey = 'mailai-mail-table-columns';
  let savedColumns = null, columnFrame;
  const applyColumns = widths => {
    list.style.setProperty('--mail-table-custom-columns', widths.map(width => `minmax(0,${width}fr)`).join(' '));
  };
  try {
    const saved = JSON.parse(localStorage.getItem(columnKey));
    if (Array.isArray(saved) && [4,6].includes(saved.length) && saved.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 10000)) savedColumns = saved.length === 6 ? saved.slice(2) : saved;
  } catch (_) {}
  const columnWidths = () => {
    const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    return [...list.querySelectorAll('.mail-table-heading')].map(node => node.getBoundingClientRect().width / zoom);
  };
  const measure = document.createElement('canvas').getContext('2d');
  const minimumWidths = () => [...list.querySelectorAll('.mail-table-heading')].map((node,index) => {
    const label=node.querySelector('span'), style=getComputedStyle(label);
    measure.font=style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return Math.ceil(measure.measureText(label.textContent).width)+16+(index===3?20:0);
  });
  const fitColumns = () => {
    const header=list.querySelector('.mail-table-header');
    if (!header || !header.getClientRects().length) return;
    const style=getComputedStyle(header), available=header.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    const minimum=minimumWidths(), totalMin=minimum.reduce((a,b)=>a+b,0);
    if (available <= totalMin) {applyColumns(minimum); return;}
    let desired;
    if (savedColumns) {
      const total=savedColumns.reduce((a,b)=>a+b,0);
      desired=savedColumns.map((width,index)=>Math.max(0,width/total*available-minimum[index]));
    } else {
      // Reserve a readable date and give the subject most of the remaining room.
      desired=[.2,.2,.6,0];
      const dateExtra=Math.min(available*.19,132)-minimum[3];
      minimum[3]+=Math.max(0,Math.min(dateExtra,available-totalMin));
    }
    const free=available-minimum.reduce((a,b)=>a+b,0), total=desired.reduce((a,b)=>a+b,0);
    applyColumns(minimum.map((width,index)=>width+free*(total?desired[index]/total:index===2?1:0)));
  };
  const scheduleColumns = () => {cancelAnimationFrame(columnFrame); columnFrame=requestAnimationFrame(fitColumns);};
  new ResizeObserver(scheduleColumns).observe(list);
  new MutationObserver(scheduleColumns).observe(list,{childList:true});
  document.addEventListener('mailai:language-changed',scheduleColumns);
  scheduleColumns();
  const resizedColumns = (start,index,delta) => {
    const widths = [...start], pair = widths[index] + widths[index+1], minimum=minimumWidths();
    const leftMin=Math.min(minimum[index],pair/2), rightMin=Math.min(minimum[index+1],pair/2);
    widths[index] = Math.max(leftMin, Math.min(pair-rightMin, start[index]+delta));
    widths[index+1] = pair-widths[index];
    return widths;
  };
  list.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-mail-column]');
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    handle.focus({preventScroll:true});
    const index = Number(handle.dataset.mailColumn), start = columnWidths(), startX = event.clientX;
    let widths = start;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('mail-column-resizing');
    const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const move = event => { widths = resizedColumns(start,index,(event.clientX-startX)/zoom); applyColumns(widths); };
    const end = event => {
      handle.removeEventListener('pointermove',move);
      handle.removeEventListener('pointerup',end);
      handle.removeEventListener('pointercancel',end);
      handle.removeEventListener('lostpointercapture',end);
      document.body.classList.remove('mail-column-resizing');
      if (event.type === 'pointercancel') {applyColumns(start); return;}
      savedColumns=widths; localStorage.setItem(columnKey,JSON.stringify(widths));
    };
    handle.addEventListener('pointermove',move);
    handle.addEventListener('pointerup',end);
    handle.addEventListener('pointercancel',end);
    handle.addEventListener('lostpointercapture',end);
  });
  list.addEventListener('keydown', event => {
    const handle=event.target.closest('[data-mail-column]');
    if (!handle || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const widths=resizedColumns(columnWidths(),Number(handle.dataset.mailColumn),event.key==='ArrowRight'?12:-12);
    savedColumns=widths; localStorage.setItem(columnKey,JSON.stringify(widths)); applyColumns(widths);
  });
  list.addEventListener('dblclick',event => {
    if (!event.target.closest('[data-mail-column]')) return;
    localStorage.removeItem(columnKey); savedColumns=null; fitColumns();
  });
  list.addEventListener('click', event => {
    if (!event.target.closest('[data-table-date-sort]')) return;
    const sort = document.getElementById('list-sort');
    sort.value = currentFilter.sort === 'date-desc' ? 'date-asc' : 'date-desc';
    sort.dispatchEvent(new Event('change'));
    document.querySelector('[data-table-date-sort]')?.focus({preventScroll:true});
  });
})();
