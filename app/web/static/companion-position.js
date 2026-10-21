/* Free placement for the floating pet; save once on release, never per frame. */
(() => {
  const root=document.getElementById('mail-assistant'),orb=document.getElementById('assistant-orb');
  if(!root || !orb)return;
  const key='mailai-companion-position-v1';
  let preferred=null,drag=null,suppressClick=false,settleTimer=0,snapAnimations=[],releaseAnimations=[],releaseTimer=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const contact=document.createElement('span');contact.className='companion-edge-contact';contact.setAttribute('aria-hidden','true');root.append(contact);
  const poseNodes=[...orb.querySelectorAll('.companion-facing,.companion-dock-free,.companion-dock-carry,.companion-dock-tail')];
  const stopSnap=()=>{
    clearTimeout(settleTimer);snapAnimations.forEach(a=>a.cancel());snapAnimations=[];
    root.classList.remove('companion-snapping');
  };
  const stopRelease=()=>{
    clearTimeout(releaseTimer);releaseAnimations.forEach(a=>a.cancel());releaseAnimations=[];
    root.classList.remove('companion-releasing');
  };
  const canAnimate=()=>!reduced.matches && !document.body.classList.contains('companion-still');
  const undock=()=>{
    const edge=root.dataset.petDock;
    const from=poseNodes.map(n=>getComputedStyle(n).transform);
    stopSnap();stopRelease();root.classList.add('companion-dock-measuring');
    delete root.dataset.petDock;document.body.classList.add('companion-dragging');
    const to=poseNodes.map(n=>getComputedStyle(n).transform);
    root.classList.remove('companion-dock-measuring');
    if(!edge || !canAnimate())return;
    root.classList.add('companion-releasing');
    poseNodes.forEach((n,i)=>{
      const body=n.classList.contains('companion-facing');
      // The shoulder releases first. The torso follows a beat later, while
      // root placement continues to track the pointer without spring lag.
      const start=edge==='top' && n.classList.contains('companion-dock-free')?'rotate(105deg)':from[i];
      releaseAnimations.push(n.animate([
        {transform:start,offset:0},{transform:start,offset:body?.16:0.04,easing:'cubic-bezier(.2,.65,.3,1)'},
        {transform:to[i],offset:body?1:.8},{transform:to[i],offset:1}
      ],{duration:380}));
    });
    if(edge==='top') {
      const grip=orb.querySelector('.companion-edge-grip'),wing=orb.querySelector('.companion-rest-wing');
      // Counter the free-wing rotation at the first frame, then uncurl and
      // blend into its resting silhouette. Both remain rooted at the shoulder.
      releaseAnimations.push(grip.animate([
        {opacity:1,transform:'rotate(-105deg)'},{opacity:0,transform:'rotate(-65deg)'}
      ],{duration:160}));
      releaseAnimations.push(wing.animate([{opacity:0},{opacity:1}],{duration:180}));
    }
    releaseTimer=setTimeout(stopRelease,400);
  };
  const contactPoint=()=>{
    const fish=document.body.dataset.petStyle==='ranger',edge=root.dataset.petDock;
    let selector='.companion-facing',x=56,y=101.5;
    if(edge==='left') {selector='.companion-arm-left';x=fish?17:12;y=fish?77:79;}
    if(edge==='right') {selector=fish?'.evolution-fish-body':'.companion-torso';x=fish?91:96;y=fish?66:65;}
    if(edge==='bottom' && fish) {selector='.evolution-fish-body';y=97;}
    if(edge==='top') {selector='.companion-arm-left';x=9;y=41;}
    return new DOMPoint(x,y).matrixTransform(orb.querySelector(selector).getScreenCTM());
  };
  const edges=['left','right','top','bottom'];
  const valid=value=>value?.version===1 && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    value.x>=0 && value.x<=1 && value.y>=0 && value.y<=1 && (!value.dock || edges.includes(value.dock));
  try { const value=JSON.parse(localStorage.getItem(key));if(valid(value))preferred=value; } catch (_) {}
  const geometry=()=>{
    const scale=parseFloat(getComputedStyle(document.body).zoom)||1;
    const box=orb.getBoundingClientRect(),margin=16;
    return {scale,box,minX:margin,minY:margin,
      spanX:Math.max(0,innerWidth-box.width-margin*2),spanY:Math.max(0,innerHeight-box.height-margin*2)};
  };
  const place=(x,y,g=geometry())=>{
    // While pulling away from an edge, keep the grabbed point under the mouse
    // instead of jumping immediately to the normal 16 px free-placement margin.
    x=Math.max(drag?-g.box.width*.5:g.minX,Math.min(drag?innerWidth-g.box.width*.5:g.minX+g.spanX,x));
    y=Math.max(drag?-g.box.height*.5:g.minY,Math.min(drag?innerHeight-g.box.height*.5:g.minY+g.spanY,y));
    root.style.left=`${x/g.scale}px`;root.style.top=`${y/g.scale}px`;
    root.style.right='auto';root.style.bottom='auto';
    root.dataset.petEdgeX=x+g.box.width/2<innerWidth/2?'left':'right';
    root.dataset.petEdgeY=y<120?'top':'bottom';
    return {version:1,x:g.spanX?Math.max(0,Math.min(1,(x-g.minX)/g.spanX)):0,y:g.spanY?Math.max(0,Math.min(1,(y-g.minY)/g.spanY)):0};
  };
  const restore=(animate=false)=>{
    const from=orb.getBoundingClientRect();
    const fromPoses=poseNodes.map(n=>getComputedStyle(n).transform);
    const wingNodes=[orb.querySelector('.companion-edge-grip'),orb.querySelector('.companion-rest-wing')];
    const fromWings=wingNodes.map(n=>getComputedStyle(n).opacity);
    stopSnap();if(!animate || preferred?.dock)stopRelease();root.classList.add('companion-dock-measuring');
    if(preferred) {
      const g=geometry(),x=preferred.dock==='left'?0:preferred.dock==='right'?1:preferred.x;
      const y=preferred.dock==='top'?0:preferred.dock==='bottom'?1:preferred.y;
      place(g.minX+x*g.spanX,g.minY+y*g.spanY,g);
      if(preferred.dock) {
        root.dataset.petDock=preferred.dock;
        const point=contactPoint(),box=orb.getBoundingClientRect(),edge=preferred.dock;
        // Align actual anatomy with the viewport, not the transparent SVG or
        // button box. A small amount of transparent box may sit offscreen.
        let dx=edge==='left'?.75-point.x:edge==='right'?innerWidth-.75-point.x:0;
        if(edge==='top') {
          // Leaning moves the head sideways. Preserve its full silhouette
          // near either corner without changing the saved preferred location.
          const head=orb.querySelector('.growth-body').getBoundingClientRect();
          if(head.left<6)dx=6-head.left;
          else if(head.right>innerWidth-6)dx=innerWidth-6-head.right;
        }
        const dy=edge==='top'?.75-point.y:edge==='bottom'?innerHeight-.75-point.y:0;
        root.style.left=`${(box.left+dx)/g.scale}px`;root.style.top=`${(box.top+dy)/g.scale}px`;
        const touch=contactPoint(),vertical=edge==='left'||edge==='right';
        contact.style.width=`${(vertical?2:24)/g.scale}px`;contact.style.height=`${(vertical?20:2)/g.scale}px`;
        contact.style.left=`${(vertical?(edge==='left'?0:innerWidth-2):touch.x-12)/g.scale}px`;
        contact.style.top=`${(vertical?touch.y-10:(edge==='top'?0:innerHeight-2))/g.scale}px`;
      } else delete root.dataset.petDock;
    } else {
      for(const name of ['left','top','right','bottom'])root.style.removeProperty(name);
      delete root.dataset.petEdgeX;delete root.dataset.petEdgeY;delete root.dataset.petDock;
    }
    const to=orb.getBoundingClientRect(),toPoses=poseNodes.map(n=>getComputedStyle(n).transform);
    root.classList.remove('companion-dock-measuring');
    if(animate && preferred?.dock && !reduced.matches && !document.body.classList.contains('companion-still')) {
      const scale=geometry().scale,edge=preferred.dock;
      const recoilX=edge==='left'?1:edge==='right'?-1:0,recoilY=edge==='top'?1:edge==='bottom'?-1:0;
      const position=(x,y)=>({left:`${x/scale}px`,top:`${y/scale}px`});
      root.classList.add('companion-snapping');
      snapAnimations.push(root.animate([
        {...position(from.x,from.y),offset:0,easing:'cubic-bezier(.25,.7,.3,1)'},
        {...position(to.x,to.y),offset:.68,easing:'ease-out'},
        {...position(to.x+recoilX,to.y+recoilY),offset:.82,easing:'ease-in-out'},
        {...position(to.x,to.y),offset:1}
      ],{duration:440}));
      poseNodes.forEach((n,i)=>snapAnimations.push(n.animate([
        {transform:fromPoses[i],offset:0,easing:'cubic-bezier(.25,.7,.3,1)'},
        {transform:toPoses[i],offset:.58},{transform:toPoses[i],offset:1}
      ],{duration:440})));
      wingNodes.forEach((n,i)=>snapAnimations.push(n.animate([{opacity:fromWings[i]},{opacity:getComputedStyle(n).opacity,offset:.58},{opacity:getComputedStyle(n).opacity}],{duration:440})));
      snapAnimations.push(contact.animate([{opacity:0,offset:0},{opacity:0,offset:.6},{opacity:.28,offset:.8},{opacity:.28,offset:1}],{duration:440}));
      settleTimer=setTimeout(stopSnap,460);
    }
  };
  const finish=commit=>{
    if(!drag)return;
    const previous=drag;drag=null;
    document.body.classList.remove('companion-dragging');
    if(orb.hasPointerCapture(previous.id))orb.releasePointerCapture(previous.id);
    if(!previous.moved)return;
    suppressClick=true;
    if(commit) {
      const g=geometry(),position={...previous.position};
      const distances=[position.x*g.spanX,(1-position.x)*g.spanX,position.y*g.spanY,(1-position.y)*g.spanY];
      const nearest=Math.min(...distances);
      if(nearest<=32) {
        position.dock=edges[distances.indexOf(nearest)];
        if(position.dock==='left')position.x=0;
        if(position.dock==='right')position.x=1;
        if(position.dock==='top')position.y=0;
        if(position.dock==='bottom')position.y=1;
      }
      try { localStorage.setItem(key,JSON.stringify(position));preferred=position; }
      catch (_) { restore();return; } // The local preference adapter reports disk errors.
      restore(true);
    } else restore();
  };
  orb.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !event.isPrimary || drag || document.body.classList.contains('assistant-visible'))return;
    suppressClick=false;
    const box=orb.getBoundingClientRect();
    if(snapAnimations.length) {
      const scale=geometry().scale;stopSnap();
      root.style.left=`${box.left/scale}px`;root.style.top=`${box.top/scale}px`;
    }
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left,top:box.top,moved:false};
    orb.setPointerCapture(event.pointerId);
  });
  orb.addEventListener('pointermove',event=>{
    if(!drag || event.pointerId!==drag.id)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(!drag.moved && Math.hypot(dx,dy)<5)return;
    event.preventDefault();
    if(!drag.moved) {
      drag.moved=true;undock();
    }
    drag.position=place(drag.left+dx,drag.top+dy);
  });
  orb.addEventListener('pointerup',event=>{if(event.pointerId===drag?.id)finish(true);});
  orb.addEventListener('pointercancel',event=>{if(event.pointerId===drag?.id)finish(false);});
  orb.addEventListener('lostpointercapture',event=>{if(event.pointerId===drag?.id)finish(false);});
  orb.addEventListener('dragstart',event=>event.preventDefault());
  // Capture phase precedes the existing click-to-open handler. A drag never
  // opens the assistant, while mouse clicks and keyboard activation still do.
  orb.addEventListener('click',event=>{
    if(suppressClick && event.detail!==0) {event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && drag) {event.preventDefault();event.stopPropagation();finish(false);}
  },true);
  window.addEventListener('blur',()=>{finish(false);if(snapAnimations.length || releaseAnimations.length)restore();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){finish(false);if(snapAnimations.length || releaseAnimations.length)restore();}});
  document.addEventListener('mailai:foreground-changed',event=>{if(event.detail?.visible===false){finish(false);if(snapAnimations.length || releaseAnimations.length)restore();}});
  window.addEventListener('resize',()=>{finish(false);restore();});
  // A font-scale change updates CSS zoom without a window resize. The button
  // observer adjusts placement only when its rendered size changes.
  new ResizeObserver(()=>{if(!drag)restore();}).observe(orb);
  new MutationObserver(()=>{if(!drag)restore();}).observe(document.body,{attributes:true,attributeFilter:['style']});
  new MutationObserver(()=>{if(!drag)restore();}).observe(document.body,{attributes:true,attributeFilter:['data-pet-style','data-pet-stage']});
  reduced.addEventListener('change',()=>{if(reduced.matches && (snapAnimations.length || releaseAnimations.length))restore();});
  restore();
})();
