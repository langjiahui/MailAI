/* Reuse the visible queue's selection handlers for every mailbox and view. */
(() => {
  const list=document.getElementById('email-list');
  const first=document.getElementById('reading-start-first');
  const assistant=document.getElementById('reading-start-assistant');
  const firstRow=()=>list.querySelector('.email-item');
  const update=()=>{first.disabled=!firstRow();};
  new MutationObserver(update).observe(list,{childList:true,subtree:true});
  first.addEventListener('click',()=>{
    const row=firstRow();
    if(!row){update();return;}
    row.click();
    document.getElementById('reading-pane').focus({preventScroll:true});
  });
  assistant.addEventListener('click',()=>openAssistant());
  update();
})();
