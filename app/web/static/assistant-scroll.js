/* Follow live output until the reader chooses an earlier part of the chat. */
(() => {
  const host=document.getElementById('assistant-messages');
  const jump=document.getElementById('assistant-jump-latest');
  let following=true;
  const atEnd=()=>host.scrollHeight-host.clientHeight-host.scrollTop<=24;
  function update(){
    jump.hidden=!host.querySelector('.assistant-message') || atEnd();
  }
  function changed(){
    if(following)host.scrollTop=host.scrollHeight;
    update();
  }
  function follow(){following=true;changed();}
  function pause(){following=false;}
  function restore(top){
    following=false;
    host.scrollTop=top;
    update();
  }
  host.addEventListener('scroll',()=>{following=atEnd();update();},{passive:true});
  // Wheel intent is available before the first scroll event or a new token.
  host.addEventListener('wheel',event=>{if(event.deltaY<0)pause();},{passive:true});
  host.addEventListener('keydown',event=>{
    if(event.target===host && ['ArrowUp','PageUp','Home'].includes(event.key))pause();
    if(event.target===host&&event.key==='Home'&&!event.altKey&&!event.metaKey&&!event.ctrlKey){
      event.preventDefault();restore(0);
    }
  });
  jump.addEventListener('click',()=>{follow();host.focus({preventScroll:true});});
  let resizeFrame=0;
  const resize=new ResizeObserver(()=>{
    if(!resizeFrame)resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;changed();});
  });
  resize.observe(host);
  const observed=new Set();
  new MutationObserver(()=>{
    for(const node of observed)if(node.parentElement!==host){resize.unobserve(node);observed.delete(node);}
    for(const node of host.children)if(!observed.has(node)){resize.observe(node);observed.add(node);}
    changed();
  }).observe(host,{childList:true,subtree:true,characterData:true});
  window.mailaiAssistantScroll={changed,follow,pause,restore,isFollowing:()=>following};
})();
