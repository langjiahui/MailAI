/* Short, coordinated acting beats with breathing room between them. */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.getElementById('mail-assistant');
  const orb = document.getElementById('assistant-orb');
  const names = ['figure','torso','head','foot-left','foot-right','arm-left','wave','leaves','bag','shadow'];
  // x, y, rotation, horizontal scale, vertical scale, in SVG coordinates.
  const neutral = [0,0,0,1,1];
  const pose = (x=0,y=0,r=0,sx=1,sy=1) => [x,y,r,sx,sy];
  const clips = {
    peek: {duration:2000, frames:[
      [0,{}], [.12,{head:pose(-2,0,-6)}],
      [.28,{torso:pose(-2,0,-5),head:pose(-3,-1,-7),wave:pose(0,0,9)}],
      [.5,{torso:pose(-2,0,-5),head:pose(-3,-1,-7)}],
      [.65,{head:pose(2,0,5),torso:pose(0,0,2)}],
      [.84,{head:pose(0,0,-2),torso:pose(0,0,-1)}], [1,{}],
    ]},
    step: {duration:1800,frames:[
      [0,{}], [.12,{figure:pose(0,1,-2,1.03,.96),head:pose(-2,0,-4)}],
      [.27,{figure:pose(-3,-2,-4),torso:pose(0,0,-3),'foot-left':pose(-2,-5,-20),'foot-right':pose(2,1,6),'arm-left':pose(0,0,-17),wave:pose(0,0,18)}],
      [.4,{figure:pose(-4,1,0,1.04,.96),'foot-left':pose(-1,0,-3),'foot-right':pose(1,0,3)}],
      [.58,{figure:pose(-1,-2,3),'foot-left':pose(-1,1,-5),'foot-right':pose(2,-5,20),'arm-left':pose(0,0,14),wave:pose(0,0,-15)}],
      [.73,{figure:pose(1,1,1,1.025,.975),'foot-right':pose(1,0,3)}],
      [.87,{figure:pose(0,-.5,-1)}], [1,{}],
    ]},
    stretch: {duration:2300,frames:[
      [0,{}], [.16,{figure:pose(0,2,0,1.05,.94),head:pose(0,1,2)}],
      [.36,{figure:pose(0,-2,0,.96,1.05),'arm-left':pose(0,-1,38),wave:pose(0,-1,-40),head:pose(0,-2,-4)}],
      [.55,{figure:pose(0,-2,-3,.97,1.04),'arm-left':pose(0,-1,32),wave:pose(0,-1,-45)}],
      [.76,{figure:pose(0,1,1,1.035,.97),'arm-left':pose(0,0,-8),wave:pose(0,0,8)}], [1,{}],
    ]},
    greet: {duration:1600,frames:[
      [0,{}], [.1,{figure:pose(0,2,2,1.05,.94),head:pose(-1,1,-4)}],
      [.25,{figure:pose(-2,-3,-5,.98,1.02),head:pose(-2,-1,-5),wave:pose(0,-1,-48),'foot-left':pose(-1,-3,-16)}],
      [.39,{figure:pose(-2,-2,-5),wave:pose(0,0,-18)}],
      [.51,{figure:pose(-2,-2,-4),wave:pose(0,0,-55)}],
      [.63,{wave:pose(0,0,-20),figure:pose(-1,-1,-3)}],
      [.76,{wave:pose(0,0,-42),figure:pose(0,0,-2)}],
      [.9,{figure:pose(0,1,1,1.02,.98),wave:pose(0,0,6)}], [1,{}],
    ]},
    think: {duration:2500,frames:[
      [0,{}], [.14,{head:pose(-2,-1,-7)}],
      [.33,{torso:pose(-1,0,-4),head:pose(-2,-1,-8),wave:pose(-1,-2,-36),'arm-left':pose(0,0,6)}],
      [.53,{torso:pose(-1,0,-4),head:pose(-1,0,-5),wave:pose(-1,-2,-32)}],
      [.69,{head:pose(0,-1,2),wave:pose(0,0,-19)}],
      [.84,{torso:pose(0,0,1),head:pose(0,0,-1),wave:pose(0,0,4)}], [1,{}],
    ]},
    happy: {duration:1500,frames:[
      [0,{}], [.13,{figure:pose(0,3,2,1.09,.88),head:pose(0,1,3)}],
      [.29,{figure:pose(-1,-8,-7,.96,1.04),'foot-left':pose(-2,-2,-18),'foot-right':pose(2,-2,18),'arm-left':pose(0,0,27),wave:pose(0,0,-45),shadow:pose(0,0,0,.7,.8)}],
      [.44,{figure:pose(0,2,1,1.08,.91),shadow:pose(0,0,0,1.08,1)}],
      [.59,{figure:pose(1,-3,4,.99,1.02),wave:pose(0,0,-26),shadow:pose(0,0,0,.87,.9)}],
      [.73,{figure:pose(0,1,-1,1.035,.97)}],
      [.87,{figure:pose(0,-.5,.5)}], [1,{}],
    ]},
  };
  const rigs = [...document.querySelectorAll('.mail-companion')].map(svg => ({
    svg, parts:Object.fromEntries(names.map(name=>[name,svg.querySelector(`.companion-${name}`)])),
    animations:[],timer:0,mode:'',next:0,
  }));
  const enabled = () => !document.hidden && !reduced.matches && !document.body.classList.contains('companion-still');
  const visible = rig => rig.svg.getClientRects().length && getComputedStyle(rig.svg).visibility !== 'hidden';
  const stop = rig => {
    clearTimeout(rig.timer);
    rig.animations.forEach(anim=>anim.cancel()); rig.animations=[];
  };
  const transform = p => `translate(${p[0]}px,${p[1]}px) rotate(${p[2]}deg) scale(${p[3]},${p[4]})`;
  const play = (rig,name,after) => {
    const start=Object.fromEntries(names.map(part=>[part,getComputedStyle(rig.parts[part]).transform]));
    stop(rig);
    if(!enabled() || !visible(rig)) return;
    const clip=clips[name];
    for(const part of names) {
      // Accessories lag the body's turn and rebound after it settles.
      const keys=clip.frames.map(([offset,frame],index)=>{
        let value=frame[part] || neutral;
        if(part==='bag' || part==='leaves') {
          const previous=clip.frames[Math.max(0,index-1)][1];
          const turn=(previous.figure?.[2] || 0)+(previous.torso?.[2] || 0);
          value=index===clip.frames.length-1 ? neutral : pose(0,0,-turn*(part==='leaves'?1.8:1.4));
        }
        return {offset,transform:transform(value),easing:'cubic-bezier(.22,.65,.3,1)'};
      });
      // Preserve the actual pose when interrupted, avoiding snaps on hover/state changes.
      keys[0].transform=start[part];
      const anim=rig.parts[part].animate(keys,{duration:clip.duration,fill:'none'});
      rig.animations.push(anim);
    }
    rig.timer=setTimeout(()=>{rig.animations=[];if(after) after();},clip.duration+25);
  };
  const schedule = rig => {
    if(!enabled() || !visible(rig)) return;
    const thinking=rig.mode==='think';
    rig.timer=setTimeout(()=>{
      const name=thinking?'think':['peek','step','stretch'][rig.next++%3];
      play(rig,name,()=>schedule(rig));
    },thinking?1200:4000+Math.random()*2500);
  };
  const refresh = () => rigs.forEach(rig=>{
    let mode='idle';
    if(!enabled() || !visible(rig)) mode='off';
    else if(rig.svg.closest('.state-thinking,.compose-ai-panel.is-thinking')) mode='think';
    else if(rig.svg.closest('.companion-finished')) mode='happy';
    else if(rig.svg.closest('.state-danger,.state-warn')) mode='attentive';
    if(mode===rig.mode) return;
    rig.mode=mode;
    if(mode==='off') {stop(rig);return;}
    if(mode==='happy') play(rig,'happy');
    else if(mode==='think') play(rig,'think',()=>schedule(rig));
    else play(rig,'peek',()=>schedule(rig));
  });
  let greetingAt=-Infinity;
  const greet=()=>{
    const rig=rigs.find(item=>orb.contains(item.svg));
    if(!rig || !enabled() || rig.mode==='think' || rig.mode==='happy' || performance.now()-greetingAt<2200) return;
    greetingAt=performance.now();play(rig,'greet',()=>rig.mode==='idle' && schedule(rig));
  };
  orb.addEventListener('pointerenter',greet);
  orb.addEventListener('focus',greet);
  const observer=new MutationObserver(refresh);
  observer.observe(document.body,{attributes:true,attributeFilter:['class']});
  observer.observe(root,{attributes:true,attributeFilter:['class']});
  document.querySelectorAll('.assistant-panel,.compose-ai-panel').forEach(el=>observer.observe(el,{attributes:true,attributeFilter:['class']}));
  reduced.addEventListener('change',refresh);
  document.addEventListener('visibilitychange',refresh);
  window.addEventListener('resize',refresh);
  refresh();
})();
