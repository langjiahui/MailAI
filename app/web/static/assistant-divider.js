/* Viewport clamps never overwrite the user's preferred dock width. Floating sizes stay independent. */
(() => {
  const key='mailai.assistant.dockWidth.v1',defaultWidth=420;
  const handle=document.getElementById('assistant-dock-divider'),panel=document.getElementById('assistant-panel');
  const pane=document.querySelector('.reading-pane'),layout=document.querySelector('.layout');
  let preferred=defaultWidth,drag=null,limits={min:320,max:720},effective=defaultWidth;
  try { const value=Number(localStorage.getItem(key));if(Number.isFinite(value)&&value>=240&&value<=720)preferred=value; } catch (_) {}
  const scale=()=>Number.parseFloat(getComputedStyle(document.body).zoom)||1;
  const enabled=()=>document.body.matches('.assistant-visible:is(.assistant-split,.assistant-docked)')&&!panel.classList.contains('hidden');
  function save(){
    try { if(preferred===defaultWidth)localStorage.removeItem(key);else localStorage.setItem(key,String(preferred)); }
    catch (_) { toast(mailaiText('显示偏好未保存，请稍后重试'),'warn'); }
  }
  function update(){
    handle.hidden=!enabled();
    if(handle.hidden){if(drag)finish(false);return;}
    const zoom=scale(),style=getComputedStyle(layout),box=layout.getBoundingClientRect();
    const fixed=[...layout.children].filter(node=>node!==pane&&node.getClientRects().length);
    const reserved=fixed.reduce((sum,node)=>sum+node.getBoundingClientRect().width/zoom,0)
      +(parseFloat(style.columnGap)||0)*fixed.length+(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0);
    limits.max=Math.max(240,Math.min(720,Math.floor(innerWidth/zoom-box.left/zoom-14-reserved-440)));
    limits.min=Math.min(320,limits.max);
    effective=Math.round(Math.max(limits.min,Math.min(limits.max,preferred)));
    const readingTop=pane.scrollTop,messages=document.getElementById('assistant-messages');
    const heldTop=window.mailaiAssistantScroll?.isFollowing()===false?messages.scrollTop:null;
    const width=effective+'px';
    if(document.body.style.getPropertyValue('--assistant-dock-width')!==width)document.body.style.setProperty('--assistant-dock-width',width);
    const rect=panel.getBoundingClientRect();
    handle.style.setProperty('--assistant-divider-left',rect.left/zoom+'px');
    handle.style.setProperty('--assistant-divider-top',rect.top/zoom+'px');
    handle.style.setProperty('--assistant-divider-height',rect.height/zoom+'px');
    handle.setAttribute('aria-valuemin',String(limits.min));handle.setAttribute('aria-valuemax',String(limits.max));
    handle.setAttribute('aria-valuenow',String(effective));handle.setAttribute('aria-valuetext',mailaiTemplate`${effective} 像素`);
    pane.scrollTop=readingTop;if(heldTop!==null)messages.scrollTop=heldTop;
  }
  function finish(commit){
    if(!drag)return;
    const previous=drag;drag=null;
    if(commit&&previous.moved){preferred=effective;save();}else preferred=previous.preferred;
    handle.classList.remove('is-dragging');document.body.classList.remove('assistant-width-adjusting');
    if(handle.hasPointerCapture(previous.pointerId))handle.releasePointerCapture(previous.pointerId);
    update();
  }
  function reset(){preferred=defaultWidth;save();update();}
  handle.addEventListener('pointerdown',event=>{
    if(!enabled()||event.button!==0||!event.isPrimary||drag)return;
    event.preventDefault();handle.focus({preventScroll:true});
    drag={x:event.clientX,width:effective,preferred,zoom:scale(),pointerId:event.pointerId};
    handle.setPointerCapture(event.pointerId);handle.classList.add('is-dragging');document.body.classList.add('assistant-width-adjusting');
  });
  handle.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    if(Math.abs(drag.x-event.clientX)>2)drag.moved=true;
    preferred=drag.width+(drag.x-event.clientX)/drag.zoom;update();
  });
  handle.addEventListener('pointerup',event=>{if(event.pointerId===drag?.pointerId)finish(true);});
  handle.addEventListener('pointercancel',event=>{if(event.pointerId===drag?.pointerId)finish(false);});
  handle.addEventListener('lostpointercapture',()=>finish(false));
  handle.addEventListener('dblclick',()=>{finish(false);reset();});
  handle.addEventListener('keydown',event=>{
    if(event.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='Escape'&&drag){event.preventDefault();event.stopPropagation();finish(false);return;}
    if(!enabled()||drag||!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Enter'){reset();return;}
    const step=event.shiftKey?48:16;
    preferred=event.key==='Home'?limits.min:event.key==='End'?limits.max:effective+(event.key==='ArrowLeft'?step:-step);
    preferred=Math.max(limits.min,Math.min(limits.max,preferred));save();update();
  });
  window.addEventListener('blur',()=>finish(false));
  window.addEventListener('resize',()=>{finish(false);update();});
  document.addEventListener('mailai:language-changed',update);
  let layoutFrame=0;
  const schedule=()=>{if(!layoutFrame)layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;update();});};
  window.mailaiAssistantDivider={update:schedule};
  update();
})();
