/* Focused workspaces: retain existing operations and move their entry points. */
(() => {
  const center = document.getElementById('attachment-center'), grid = document.getElementById('attachment-grid');
  const switcher = document.createElement('div'); switcher.className='attachment-view-switch'; switcher.setAttribute('role','group'); switcher.setAttribute('aria-label','附件显示方式');
  switcher.innerHTML='<button type="button" data-file-view="cards">卡片</button><button type="button" data-file-view="list">紧凑列表</button>';
  const filters=document.getElementById('attachment-type-filters'), bar=document.createElement('div');bar.className='attachment-view-bar';filters.before(bar);bar.append(filters,switcher);
  function fileView(view, save=false) {
    const top=grid.scrollTop;
    center.dataset.fileView=view==='list'?'list':'cards';
    switcher.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.fileView===center.dataset.fileView)));
    grid.scrollTop=top;
    if(save) try { localStorage.setItem('mailai.attachments.view.v1',center.dataset.fileView); } catch {}
  }
  const columns=document.createElement('div');columns.className='attachment-list-columns';columns.setAttribute('aria-hidden','true');
  columns.innerHTML='<div><span>文件名称</span><span>来源邮件</span><span>大小</span><span>邮件时间</span></div><span>操作</span>';grid.before(columns);
  let saved;try{saved=localStorage.getItem('mailai.attachments.view.v1')}catch{}
  fileView(saved || 'list');
  switcher.onclick=e=>{const b=e.target.closest('[data-file-view]');if(b)fileView(b.dataset.fileView,true)};

  const todo=document.getElementById('todo-center'), list=document.getElementById('todo-list');
  const tabs=document.createElement('nav');tabs.className='todo-view-tabs';tabs.setAttribute('aria-label','待办视图');
  const names={all:'全部待办',today:'今天',overdue:'已逾期',later:'以后',unplanned:'未安排'};
  tabs.innerHTML=Object.entries(names).map(([key,label])=>`<button type="button" data-todo-view="${key}" aria-pressed="${key==='all'}">${label}</button>`).join('');
  todo.querySelector('.todo-center-tools').before(tabs);
  const noticeButton=document.getElementById('btn-task-notices');tabs.append(noticeButton);noticeButton.setAttribute('aria-pressed','false');
  let view='all';
  function group(item) {
    const dates=[item.deadline,item.remind_at].filter(Boolean).map(d=>String(d).slice(0,10)).sort();
    if(!dates.length)return 'unplanned';const now=localDateKey();return dates[0]<now?'overdue':dates[0]===now?'today':'later';
  }
  window.mailaiTodoEmpty=()=>{
    const titles={all:'还没有待办事项',today:'今天没有待办',overdue:'没有逾期待办',later:'没有安排以后的待办',unplanned:'没有未安排的待办'};
    return `<div class="todo-empty-state"><b>${titles[view] || titles.all}</b><p>${view==='all'?'可以从邮件中添加待办，再设置截止时间与提醒。':'其他任务可在全部待办中查看。'}</p>${view==='all'?'':'<button type="button" data-todo-empty-all>查看全部待办</button>'}</div>`;
  };
  list.addEventListener('click',e=>{if(e.target.closest('[data-todo-empty-all]'))window.mailaiTodoTab('all')});
  window.mailaiTodoMatches=item=>view==='all'||view==='reminders'||(item.status!=='done'&&group(item)===view);
  window.mailaiTodoCounts=()=>{
    for(const [key,label] of Object.entries(names)){
      const count=todoCenterRows.filter(r=>r.status!=='done'&&(key==='all'||group(r)===key)).length;
      tabs.querySelector(`[data-todo-view="${key}"]`).innerHTML=`<span>${label}</span><small>${count}</small>`;
    }
  };
  window.mailaiTodoTab=next=>{
    view=next;const reminders=next==='reminders';
    todo.dataset.todoView=next;
    list.classList.toggle('hidden',reminders);todo.querySelector('.todo-center-tools').classList.toggle('hidden',reminders);
    tabs.querySelectorAll('[data-todo-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.todoView===next)));
    noticeButton.setAttribute('aria-pressed',String(reminders));
    if(!reminders)renderTodoCenter();
  };
  tabs.addEventListener('click',e=>{const b=e.target.closest('button[data-todo-view]');if(!b)return;document.getElementById('task-notices').close();window.mailaiTodoTab(b.dataset.todoView)});
  const tools=todo.querySelector('.todo-center-tools');
  const batch=document.createElement('button');batch.type='button';batch.id='todo-batch-toggle';batch.textContent='批量管理';batch.setAttribute('aria-pressed','false');tools.append(batch);
  batch.onclick=()=>{
    const enabled=todo.dataset.batch!=='true';todo.dataset.batch=String(enabled);batch.setAttribute('aria-pressed',String(enabled));batch.textContent=enabled?'退出批量':'批量管理';
    if(!enabled){selectedTodoIds.clear();renderTodoCenter()}
  };
  document.getElementById('todo-complete-all').textContent='完成当前视图';
  document.getElementById('todo-complete-all').removeAttribute('data-i18n');

  // Move the actual buttons, keeping their handlers and accessible names.
  let observedHost, resize, moving=[];
  function layoutReading() {
    const host=observedHost;if(!host?.isConnected)return;
    const width=host.getBoundingClientRect().width;
    for(const item of moving){const target=width<item.threshold?item.overflow:item.home;if(item.node.parentNode!==target)target.append(item.node)}
    host.classList.add('prioritized-actions');
    host.querySelectorAll('.reading-action-group').forEach(group=>group.classList.toggle('empty-actions',!group.querySelector('button')));
  }
  const observer=new MutationObserver(()=>{
    const host=document.querySelector('.reading-header .reading-actions');if(!host||host===observedHost||!host.querySelector('.reading-work-actions'))return;
    resize?.disconnect();observedHost=host;moving=[];
    const overflow=document.createElement('div');overflow.className='reading-overflow-actions';host.querySelector('.reading-more-panel').prepend(overflow);
    for(const [selector,threshold] of [['[data-reading-action="favorite"]',850],['[data-reading-action="todo"]',740],['[data-reading-action="summary"]',980],['[onclick*="reply_all"]',660]]){
      const node=host.querySelector(selector);if(node)moving.push({node,home:node.parentNode,overflow,threshold});
    }
    resize=new ResizeObserver(layoutReading);resize.observe(host);layoutReading();
  });
  observer.observe(document.getElementById('reading-content'),{childList:true,subtree:true});

  const output=document.getElementById('compose-ai-output');
  output.addEventListener('click',e=>{
    const b=e.target.closest('[data-ai-fill]');if(!b||b.disabled||!composeAiSuggestion||document.getElementById('compose-ai-panel').classList.contains('is-thinking'))return;
    applyComposeAiSuggestion(b.dataset.aiFill);b.textContent=b.dataset.aiFill==='subject'?'已填入主题':'已替换正文';
  });
  const updatePreviewButtons=()=>{
    const busy=document.getElementById('compose-ai-panel').classList.contains('is-thinking');
    output.querySelectorAll('[data-ai-fill]').forEach(b=>b.disabled=busy||!composeAiSuggestion);
  };
  new MutationObserver(updatePreviewButtons).observe(output,{childList:true,subtree:true});
  new MutationObserver(updatePreviewButtons).observe(document.getElementById('compose-ai-panel'),{attributes:true,attributeFilter:['class']});
})();
