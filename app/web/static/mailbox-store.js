/* Bounded account/query snapshots. Originals and server sync never block a view. */
(() => {
  const entries = new Map(), MAX_VIEWS = 12, MAX_ROWS = 4000, WINDOW_PAGES = 5;
  let current = null, activeRequest = null, painting = false, sequence = 0;
  let reportedAt=0;
  let reporting=false;
  function report(stage,error,started=performance.now()){
    if(reporting || Date.now()-reportedAt<5000)return;reportedAt=Date.now();reporting=true;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    const code=error?.code==='REQUEST_TIMEOUT'?'REQUEST_TIMEOUT':error?.status?'HTTP_ERROR':['AbortError','TypeError','RangeError'].includes(error?.name)?error.name:'Error';
    void fetch('/api/mailbox/list-diagnostic',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',...(owner()?{'X-MailAI-Account':owner()}:{})},
      body:JSON.stringify({stage,code,milliseconds:Math.min(300000,Math.max(0,Math.round(performance.now()-started)))})}).catch(()=>{}).finally(()=>{clearTimeout(timer);reporting=false;});
  }
  const owner = () => activeMailAccount()?.id || '';
  const workflow = () => window.mailaiProductivityQuery?.() || {workflow:'all'};
  const supports = () => !currentFilter.search;
  const query = () => ({status:currentFilter.status || '',folder:currentServerFolder || '',days:currentFilter.days || 9999,
    verdict:currentFilter.verdict || '',category:currentFilter.category || '',priority:currentFilter.priority || '',
    domain:currentFilter.domain || '',unread:Boolean(currentFilter.unread),attachments:Boolean(currentFilter.attachments),
    tags:[...(currentFilter.mailTags || [])].sort(),tag_mode:currentFilter.mailTagMode || 'any',sort:currentFilter.sort || 'date-desc',
    workflow:specialMailbox?'all':workflow().workflow || 'all',unified:Boolean(unifiedMailbox),special:specialMailbox || '',conversations:Boolean(!specialMailbox && workflow().conversations)});
  const keyOf = q => JSON.stringify([owner(),q]);
  const rowKey = row => `${row._account_id || ''}:${row.id}`;
  const rowsOf = entry => [...entry.pages].sort((a,b)=>a[0]-b[0]).flatMap(([,page])=>page.items);
  const live = (key,nav) => supports() && keyOf(query())===key && mailboxNavigationRevision===nav;
  function derive(q,key){
    if(q.special || q.conversations || !['','all'].includes(q.workflow))return null;
    const source=[...entries.values()].reverse().find(entry=>{
      const base=entry.query;
      return entry.owner===owner() && entry.data && !entry.invalid && !entry.anchor && entry.pages.has(0) && !entry.data.next &&
        rowsOf(entry).length===entry.data.total && !base.special && !base.conversations &&
        base.status===q.status && base.folder===q.folder && base.unified===q.unified &&
        (base.days===9999 || base.days===365000 || base.days===q.days) &&
        !base.verdict && !base.category && !base.priority && !base.domain && !base.unread && !base.attachments && !base.tags.length && ['','all'].includes(base.workflow);
    });
    if(!source)return null;
    const date=row=>{const value=new Date(row.date || row.created_at || 0).getTime();return Number.isFinite(value)?value:0;};
    const rows=rowsOf(source).filter(row=>(!q.priority || row.priority===q.priority) && (!q.domain || getDomain(row.from_addr)===q.domain) &&
      (!q.unread || !row.is_read && row.direction!=='outgoing') && (!q.attachments || row.attachments?.length) &&
      ([9999,365000].includes(q.days) || date(row)>=Date.now()-q.days*86400000));
    const risk=row=>!q.verdict || mailVerdictKey(row)===q.verdict;
    const category=row=>!q.category || (row.category || '未分类')===q.category;
    const tags=row=>!q.tags.length || (q.tag_mode==='all'?q.tags.every(name=>row.tags?.some(tag=>tag.name===name)):q.tags.some(name=>row.tags?.some(tag=>tag.name===name)));
    const facets={risk:{},categories:{},tags:{}};
    for(const row of rows){
      if(category(row) && tags(row)){const name=mailVerdictKey(row);facets.risk[name]=(facets.risk[name] || 0)+1;}
      if(risk(row) && tags(row)){const name=row.category || '未分类';facets.categories[name]=(facets.categories[name] || 0)+1;}
      if(risk(row) && category(row))for(const tag of row.tags || [])facets.tags[tag.name]=(facets.tags[tag.name] || 0)+1;
    }
    const items=rows.filter(row=>risk(row) && category(row) && tags(row));
    items.sort((a,b)=>(q.sort==='score-desc'?(Number(b.score || 0)-Number(a.score || 0)):q.sort==='date-asc'?date(a)-date(b):date(b)-date(a)) ||
      (q.sort==='date-asc'?a.id-b.id:b.id-a.id) || (q.sort==='date-asc'?1:-1)*String(a._account_id || '').localeCompare(String(b._account_id || '')));
    const data={...source.data,items,total:items.length,facets,next:''};
    return {key,query:q,owner:owner(),pages:new Map([[0,data]]),cursors:new Map([[0,'']]),data,checked:source.checked,scroll:0};
  }
  function trim(entry) {
    entries.delete(entry.key); entries.set(entry.key,entry);
    let count = [...entries.values()].reduce((n,e)=>n+rowsOf(e).length,0);
    for (const [key,value] of entries) {
      if(entries.size<=MAX_VIEWS && count<=MAX_ROWS)break;
      if(value===entry)continue;
      count-=rowsOf(value).length;value.controller?.abort();entries.delete(key);
    }
  }
  function remember() {
    if(!current || current.owner!==owner())return;
    current.scroll=document.getElementById('email-list')?.scrollTop || 0;
    current.renderLimit=mailRenderLimit;
    const detail=selectedEmailDetail;
    // Keep one bounded reading snapshot per cached view, not attachment bytes.
    if(detail)current.reading=String(detail.body_html || '').length+String(detail.body_text || '').length<500000
      ? {id:selectedEmailId,account:selectedEmailAccountId,owner:owner(),detail} : null;
  }
  function paint(entry,{silent=true,restore=false}={}) {
    painting=true;
    try {
      current=entry;const rows=rowsOf(entry);mailboxLocalCounts=entry.data.counts;
      if(entry.query.special==='sent')sentMessages=rows;
      else if(entry.query.special==='drafts')savedDrafts=rows;
      else allEmails=rows;
      if(restore)mailRenderLimit=entry.renderLimit || 240;
      updateSidebar();
      const domain=document.getElementById('filter-domain');
      if(domain){
        const chosen=currentFilter.domain;
        const names=[...new Set([...entry.data.domains,...(chosen?[chosen]:[])])].sort();
        domain.innerHTML=`<option value="" data-i18n="ui.790b4b3e9a17">${esc(mailaiT('ui.790b4b3e9a17') || '不限域名')}</option>`+
          names.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');domain.value=chosen;
      }
      applyFilters({silent,paged:true});
      if(!entry.query.special){
        renderCategoryNav([],entry.data.facets.categories);
        window.mailaiRenderMailTags?.(rows,entry.data.facets.tags);
        for(const risk of ['phishing','suspicious','clean','unreviewed']){
          const node=document.getElementById('count-'+risk);if(node)node.textContent=entry.data.facets.risk[risk] || 0;
        }
        updateListTitle(entry.data.total);
      }else{
        const unit=entry.query.special==='drafts'?(mailaiT('list.countDraft') || ' 封草稿'):(mailaiT('list.countMail') || ' 封');
        document.getElementById('list-count').textContent=entry.data.total+unit;
      }
      const list=document.getElementById('email-list');
      list.querySelectorAll('[data-mail-page]').forEach(node=>node.remove());
      const indices=[...entry.pages.keys()].sort((a,b)=>a-b),first=indices[0],last=indices.at(-1);
      function button(text,action,atStart=false){
        const node=document.createElement('button');node.type='button';node.className='email-render-more';node.dataset.mailPage=action;
        const source=mailaiCopySource(text);mailaiBindUI(node,'textContent',()=>mailaiText(source));node.onclick=()=>navigate(entry,action);
        atStart?list.prepend(node):list.append(node);
      }
      if(first>0 || entry.anchor){button(mailaiText('返回列表开头'),'first',true);if(first>0 && entry.cursors.has(first-1))button(mailaiText('显示上一批'),'previous',true);}
      if(entry.pages.get(last)?.next && rows.length<=mailRenderLimit)button(mailaiText('显示更多'),'next');
      if(entry.error)button(mailaiText('继续加载失败，点击重试'),'next');
      if(restore){
        list.scrollTop=entry.scroll || 0;
        const reading=entry.reading;
        if(reading && reading.owner===entry.owner && allEmails.some(row=>row.id===reading.id && (!row._account_id || row._account_id===reading.account))){
          selectedEmailId=reading.id;selectedEmailAccountId=reading.account;selectedEmailDetail=reading.detail;
          document.querySelector('.reading-pane')?.classList.add('show');renderReadingPane(reading.detail);syncSelectedEmailVisual(reading.id,{accountId:reading.account});
        }
      }
    } finally {painting=false;}
  }
  async function fetchPage(entry,index,cursor,signal){
    const result=await api('/api/mailbox/list?filters='+encodeURIComponent(JSON.stringify(entry.query))+'&cursor='+encodeURIComponent(cursor || ''),
      {accountId:entry.owner,signal});
    // Reuse unchanged objects so local read/star state and selection stay stable.
    const known=new Map(rowsOf(entry).map(row=>[rowKey(row),row]));
    result.items=result.items.map(row=>{const previous=known.get(rowKey(row));return previous && JSON.stringify(previous)===JSON.stringify(row)?previous:row;});
    entry.pages.set(index,result);entry.cursors.set(index,cursor || '');
    if(result.next)entry.cursors.set(index+1,result.next);
    entry.data=result;entry.invalid=false;entry.error=false;entry.checked=Date.now();
    trim(entry);return result;
  }
  async function load({silent=false,force=false}={}) {
    if(!supports())return null;
    const q=query(),key=keyOf(q),nav=mailboxNavigationRevision,token=++sequence,started=performance.now();
    if(current && current.key!==key)remember();
    let entry=entries.get(key);
    if(!entry || entry.invalid){const derived=derive(q,key);if(derived){entry=derived;entries.set(key,entry);}}
    if(activeRequest && activeRequest.key!==key)activeRequest.controller?.abort();
    const usable=entry?.data && !entry.invalid;
    if(usable && !force){
      paint(entry,{silent:true,restore:current?.key!==key});finishMailboxTransition(nav);trim(entry);
      if(Date.now()-entry.checked>30000)void refresh(entry,key,nav).catch(()=>{});
      return true;
    }
    if(!entry){entry={key,query:q,owner:owner(),pages:new Map(),cursors:new Map([[0,'']]),scroll:0};entries.set(key,entry);}
    const old=current?.key===key && entry.data;
    if(old && entry.invalid && !force){await refreshWindow(entry,key,nav);finishMailboxTransition(nav);return true;}
    if(!old && !silent)document.getElementById('email-list').innerHTML=skeletonRows();
    try {
      if(!entry.pending){
        entry.controller=new AbortController();activeRequest=entry;
        entry.pending=(async()=>{
          const response=await api('/api/mailbox/list?filters='+encodeURIComponent(JSON.stringify(q)),{accountId:entry.owner,signal:entry.controller.signal});
          entry.pages=new Map([[0,response]]);entry.cursors=new Map([[0,''],[1,response.next]]);
          entry.data=response;entry.invalid=false;entry.error=false;entry.checked=Date.now();trim(entry);
        })().finally(()=>{entry.pending=null;if(activeRequest===entry)activeRequest=null;});
      }
      await entry.pending;
      if(!live(key,nav))return null;
      const scroll=old?document.getElementById('email-list').scrollTop:0;
      paint(entry,{silent:Boolean(old) || silent});if(old)document.getElementById('email-list').scrollTop=scroll;
      finishMailboxTransition(nav);
      // These catalogues have their own failure and stale-response handling.
      void window.mailaiRefreshTags?.(entry.owner).then(()=>{if(live(key,nav))paint(entry);}).catch(()=>{});
      return true;
    }catch(error){
      if(!live(key,nav) || error.name==='AbortError')return null;
      report('load',error,started);
      if(old){paint(entry);toast(mailaiText('刷新失败，已保留当前邮件，请重试'),'warn');}
      else {showMailboxLoadFailure();toast(mailaiText('加载数据失败：')+mailaiSystemMessage(error.message),'error');}
      return Boolean(old);
    }finally{if(token===sequence && live(key,nav))finishMailboxTransition(nav);}
  }
  async function refresh(entry,key,nav){
    const state=await api('/api/mailbox/list-revision?unified='+entry.query.unified,{accountId:entry.owner});
    entry.checked=Date.now();
    if(JSON.stringify(state.revision)===JSON.stringify(entry.data.revision))return false;
    for(const candidate of entries.values())if(candidate.owner===entry.owner || candidate.query.unified){candidate.invalid=true;candidate.reading=null;}
    if(live(key,nav))await refreshWindow(entry,key,nav);
    return true;
  }
  async function refreshWindow(entry,key,nav,fromPaging=false){
    if(entry.paging && !fromPaging){entry.refreshAfterPage=true;return;}
    if(entry.refreshing)return entry.refreshing;
    entry.refreshing=(async()=>{
      const indices=[...entry.pages.keys()].sort((a,b)=>a-b);
      const first=indices[0],pages=new Map(),cursors=new Map(entry.cursors);
      let cursor=entry.cursors.get(first) || '',data;
      for(let offset=0;offset<indices.length;offset++){
        data=await api('/api/mailbox/list?filters='+encodeURIComponent(JSON.stringify(entry.query))+'&cursor='+encodeURIComponent(cursor)+'&refresh='+(offset===0)+(!cursor && entry.anchor?'&around_id='+entry.anchor:''),{accountId:entry.owner});
        pages.set(first+offset,data);cursors.set(first+offset,cursor);cursors.set(first+offset+1,data.next);
        cursor=data.next;if(!cursor)break;
      }
      if(!live(key,nav))return;
      const list=document.getElementById('email-list'),bounds=list.getBoundingClientRect();
      const anchor=[...list.querySelectorAll('.email-item')].find(node=>node.getBoundingClientRect().bottom>bounds.top);
      const anchorKey=anchor?`${anchor.dataset.accountId || ''}:${anchor.dataset.id}`:'',top=anchor?.getBoundingClientRect().top;
      entry.pages=pages;entry.cursors=cursors;entry.data=data;entry.invalid=false;entry.checked=Date.now();
      paint(entry);
      const retained=[...list.querySelectorAll('.email-item')].find(node=>`${node.dataset.accountId || ''}:${node.dataset.id}`===anchorKey);
      if(retained && top!==undefined)list.scrollTop+=retained.getBoundingClientRect().top-top;
    })().catch(error=>{if(live(key,nav)){report('page',error);toast(mailaiText('刷新失败，已保留当前邮件，请重试'),'warn');}}).finally(()=>{entry.refreshing=null;});
    return entry.refreshing;
  }
  async function navigate(entry,action,retried=false){
    const key=entry.key,nav=mailboxNavigationRevision;
    if(!live(key,nav) || entry.paging || entry.refreshing)return;
    const indices=[...entry.pages.keys()].sort((a,b)=>a-b),first=indices[0],last=indices.at(-1);
    const index=action==='first'?0:action==='previous'?first-1:last+1;
    entry.paging=true;
    const buttons=[...document.querySelectorAll('[data-mail-page]')];buttons.forEach(node=>node.disabled=true);
    const list=document.getElementById('email-list'),anchor=[...list.querySelectorAll('.email-item')].find(node=>node.getBoundingClientRect().bottom>list.getBoundingClientRect().top);
    const anchorKey=anchor?`${anchor.dataset.accountId || ''}:${anchor.dataset.id}`:'',top=anchor?.getBoundingClientRect().top;
    try{
      if(action==='first'){entry.anchor=0;await load({silent:true,force:true});list.scrollTop=0;return;}
      await fetchPage(entry,index,entry.cursors.get(index),undefined);
      while(entry.pages.size>WINDOW_PAGES){const keys=[...entry.pages.keys()].sort((a,b)=>a-b);entry.pages.delete(action==='previous'?keys.at(-1):keys[0]);}
      if(entry.cursors.size>512)entry.cursors.delete([...entry.cursors.keys()].sort((a,b)=>a-b)[1]);
      if(!live(key,nav))return;
      mailRenderLimit=rowsOf(entry).length;paint(entry);
      const retained=[...list.querySelectorAll('.email-item')].find(node=>`${node.dataset.accountId || ''}:${node.dataset.id}`===anchorKey);
      if(retained && top!==undefined)list.scrollTop+=retained.getBoundingClientRect().top-top;
    }catch(error){
      if(!live(key,nav))return;
      report('page',error);
      if(error.status===409){
        entry.invalid=true;await refreshWindow(entry,key,nav,true);
        if(!retried && !entry.invalid && live(key,nav)){entry.paging=false;await navigate(entry,action,true);}
        else if(live(key,nav)){entry.error=true;paint(entry);}
      }
      else {entry.error=true;paint(entry);toast(mailaiText('继续加载失败，点击重试'),'warn');}
    }finally{
      entry.paging=false;buttons.forEach(node=>{if(node.isConnected)node.disabled=false;});
      if(entry.refreshAfterPage && live(key,nav)){entry.refreshAfterPage=false;void refresh(entry,key,nav).catch(()=>{});}
    }
  }
  function filterChanged(){
    if(painting || !supports())return false;
    if(current && current.key===keyOf(query()) && !current.invalid){paint(current);return true;}
    void load();return true;
  }
  function invalidate(account){
    for(const entry of entries.values())if(!account || entry.owner===account || entry.query.unified){entry.invalid=true;entry.reading=null;}
  }
  const folderSync=new Map();
  window.mailaiMailboxStore={supports,load,filterChanged,remember,invalidate,
    report,
    async reveal(id){
      if(!supports() || !current || current.query.unified || current.query.special)return;
      if(rowsOf(current).some(row=>row.id===id))return;
      const entry=current,key=entry.key,nav=mailboxNavigationRevision;
      const data=await api('/api/mailbox/list?filters='+encodeURIComponent(JSON.stringify(entry.query))+'&around_id='+id,{accountId:entry.owner});
      if(!live(key,nav))return;
      entry.anchor=id;entry.pages=new Map([[0,data]]);entry.cursors=new Map([[0,''],[1,data.next]]);entry.data=data;entry.invalid=false;
      paint(entry,{silent:false});trim(entry);
    },
    async syncFolder(folder){
      const account=owner(),key=account+':'+folder,previous=folderSync.get(key);
      if(previous && (previous.pending || Date.now()-previous.at<60000))return;
      const entry={pending:true,at:Date.now()};folderSync.set(key,entry);
      try{
        await api('/api/mail/folders/sync?folder='+encodeURIComponent(folder),{accountId:account,method:'POST'});
        invalidate(account);
        if(owner()===account && currentServerFolder===folder)await load({silent:true,force:true});
      }catch(error){if(owner()===account && currentServerFolder===folder)toast(mailaiText('同步失败，仍可查看本地邮件'),'warn');}
      finally{entry.pending=false;entry.at=Date.now();if(folderSync.size>24)folderSync.delete(folderSync.keys().next().value);}
    },
    async heartbeat(force=false){
      if(!supports() || !current)return false;
      let changed=true;
      if(force){invalidate(owner());await refreshWindow(current,current.key,mailboxNavigationRevision);}
      else changed=await refresh(current,current.key,mailboxNavigationRevision);
      return {changed:Boolean(changed)};
    },
    rendered(){if(current && supports() && current.key===keyOf(query()) && !painting)paint(current);},
    // Aggregate counters only; no mail text is exposed to diagnostics.
    diagnostics:()=>({views:entries.size,rows:[...entries.values()].reduce((n,e)=>n+rowsOf(e).length,0),window:current?rowsOf(current).length:0})};
  window.addEventListener('error',event=>{if(current)report('page_error',event.error);});
  window.addEventListener('unhandledrejection',event=>{if(current)report('page_error',event.reason);});
})();
