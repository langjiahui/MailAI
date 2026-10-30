/* Brief reactions and sparse ambient gestures, suspended outside the foreground. */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.getElementById('mail-assistant');
  const orb = document.getElementById('assistant-orb');
  const names = ['figure','heading','look','torso','head','foot-left','foot-right','arm-left','carry','leaves','shadow','tail','flight-left','flight-right'];
  // x, y, rotation, horizontal scale, vertical scale, in SVG coordinates.
  const neutral = [0,0,0,1,1];
  const pose = (x=0,y=0,r=0,sx=1,sy=1) => [x,y,r,sx,sy];
  const profiles = {
    nature: {micro:['breathe','tilt'],gestures:['peek','stretch','step'],reactions:{}},
    ranger: {micro:['nod','alert'],gestures:['survey','ready','swim'],
      reactions:{peek:'survey',greet:'finWave',work:'rangerWork',happy:'bubbleJoy'}},
  };
  const style = () => Object.hasOwn(profiles,document.body.dataset.petStyle) ? document.body.dataset.petStyle : 'nature';
  const clips = {
    collectionPost: {duration:2800,frames:[
      [0,{}], [.18,{head:pose(0,2,5),carry:pose(0,-1,-5)}],
      [.38,{torso:pose(0,-2),carry:pose(0,-3,-10),'arm-left':pose(0,0,12)}],
      [.62,{figure:pose(0,-4),head:pose(0,-1,-3),carry:pose(0,-3,-12),'arm-left':pose(0,0,25)}],
      [.8,{figure:pose(0,-1),carry:pose(0,-1,-4)}], [1,{}],
    ]},
    dispatch: {duration:2100,frames:[
      [0,{}], [.2,{torso:pose(0,-1),head:pose(0,2,5),wave:pose(-2,0,-24)}],
      [.42,{head:pose(2,1,3),wave:pose(-3,-1,-38),bag:pose(0,-2,-12)}],
      [.65,{head:pose(0,-2,-3),wave:pose(0,-3,-68),'arm-left':pose(0,0,10)}],
      [.8,{wave:pose(0,-3,-68),torso:pose(0,-1)}], [1,{}],
    ]},
    launch: {duration:2400,frames:[
      [0,{}], [.16,{figure:pose(0,2,0,1.02,.96),head:pose(0,1,3)}],
      [.36,{figure:pose(0,-8),wave:pose(0,-1,-25),'arm-left':pose(0,-1,25),'foot-left':pose(-1,-2,-8),'foot-right':pose(1,-2,8),shadow:pose(0,0,0,.65,.75)}],
      [.62,{figure:pose(0,-8),head:pose(2,-1,4),wave:pose(0,-1,-35),'arm-left':pose(0,-1,35),shadow:pose(0,0,0,.65,.75)}],
      [.82,{figure:pose(0,2,0,1.04,.94),head:pose(0,1,2)}], [1,{}],
    ]},
    guard: {duration:1900,frames:[
      [0,{}], [.2,{torso:pose(0,-1),head:pose(0,-1,-2),wave:pose(-3,-1,-40),'arm-left':pose(2,0,35)}],
      [.46,{torso:pose(0,-1),head:pose(0,2,5),wave:pose(-3,-1,-40),'arm-left':pose(2,0,35)}],
      [.7,{head:pose(0,-1,-2),wave:pose(-2,-3,-50)}], [1,{}],
    ]},
    beacon: {duration:2500,frames:[
      [0,{}], [.18,{figure:pose(0,1,-3),wave:pose(-2,0,-20)}],
      [.38,{figure:pose(0,-4,-4),wave:pose(0,-4,-85),'arm-left':pose(0,0,18),head:pose(0,-2,-5),shadow:pose(0,0,0,.8,.9)}],
      [.64,{figure:pose(0,-4,-4),wave:pose(0,-4,-85),'arm-left':pose(0,0,18),head:pose(0,-2,-5),shadow:pose(0,0,0,.8,.9)}],
      [.8,{figure:pose(0,1,0,1.02,.98),wave:pose(-1,-2,-42)}], [1,{}],
    ]},
    deliver: {duration:2200,frames:[
      [0,{}], [.18,{figure:pose(0,2,-4,1.04,.94),head:pose(-2,1,-8)}],
      [.4,{figure:pose(0,-4,4),head:pose(2,-1,6),wave:pose(-2,-3,-60),'arm-left':pose(0,-2,28),bag:pose(0,-4,-16)}],
      [.62,{figure:pose(0,-2,2),wave:pose(-2,-3,-38),head:pose(1,0,-4)}],
      [.8,{figure:pose(0,1,0,1.04,.96),wave:pose(0,0,-18)}], [1,{}],
    ]},
    glide: {duration:2600,frames:[
      [0,{}], [.16,{figure:pose(0,3,0,1.06,.92)}],
      [.35,{figure:pose(-5,-7,-10),'flight-left':pose(0,0,-16),'flight-right':pose(0,0,16),'arm-left':pose(0,0,12),'foot-left':pose(-1,-2,-18),'foot-right':pose(1,-2,16),shadow:pose(0,0,0,.72,.8)}],
      [.61,{figure:pose(5,-6,10),head:pose(1,-1,4),'flight-left':pose(0,0,8),'flight-right':pose(0,0,-8),'arm-left':pose(0,0,8),shadow:pose(0,0,0,.76,.8)}],
      [.82,{figure:pose(0,2,0,1.06,.93)}], [1,{}],
    ]},
    bow: {duration:2100,frames:[
      [0,{}], [.2,{head:pose(0,-2,-3),wave:pose(-2,-2,-40)}],
      [.46,{figure:pose(0,2,0,1.04,.95),head:pose(0,4,9),torso:pose(0,1,5),wave:pose(-3,0,-28)}],
      [.66,{head:pose(0,4,9),torso:pose(0,1,5)}], [.84,{head:pose(0,-1,-3)}], [1,{}],
    ]},
    star: {duration:2700,frames:[
      [0,{}], [.15,{figure:pose(0,3,-5,1.07,.91)}],
      [.33,{figure:pose(-3,-7,-12),wave:pose(0,-2,-68),'arm-left':pose(0,-2,48),head:pose(-1,-2,-5),shadow:pose(0,0,0,.7,.8)}],
      [.53,{figure:pose(3,-5,12),wave:pose(0,-2,-48),'arm-left':pose(0,-2,68),head:pose(1,-2,5)}],
      [.7,{figure:pose(0,2,0,1.08,.92)}], [.85,{wave:pose(0,-1,-42),head:pose(0,-1,-4)}], [1,{}],
    ]},
    nod: {duration:1400,frames:[
      [0,{}], [.3,{head:pose(0,2.6,5),torso:pose(0,.8)}],
      [.58,{head:pose(0,-1,-3),wave:pose(0,0,-8)}], [1,{}],
    ]},
    alert: {duration:1800,frames:[
      [0,{}], [.3,{head:pose(2,-1,5),torso:pose(.5,0,2)}], [.62,{head:pose(-1.8,-.6,-5)}], [1,{}],
    ]},
    survey: {duration:2000,frames:[
      [0,{}], [.2,{head:pose(2,-1,4),torso:pose(.5,0,1)}],
      [.42,{head:pose(2,-1,4),wave:pose(0,0,-8)}],
      [.68,{head:pose(-2,-.5,-4),torso:pose(-.5,0,-1)}], [1,{}],
    ]},
    ready: {duration:1900,frames:[
      [0,{}], [.22,{figure:pose(0,.7,0,1.01,.99),head:pose(0,1,3)}],
      [.48,{torso:pose(0,-.8),head:pose(0,-1,-2),'arm-left':pose(0,0,12),wave:pose(0,0,-16)}],
      [.72,{torso:pose(0,-.3),head:pose(0,-.5,-1),wave:pose(0,0,-6)}], [1,{}],
    ]},
    salute: {duration:1500,frames:[
      [0,{}], [.22,{torso:pose(0,-.5,-1),head:pose(0,-.6,-2),wave:pose(-2,-3,-42)}],
      [.46,{torso:pose(0,-.5,-1),head:pose(0,.6,2),wave:pose(-2,-3,-42)}],
      [.7,{head:pose(0,-.3,-1),wave:pose(-1,-1,-20)}], [1,{}],
    ]},
    rangerWork: {duration:1600,frames:[
      [0,{}], [.22,{head:pose(0,1,4),torso:pose(0,.4),wave:pose(-1,0,-18)}],
      [.45,{head:pose(1,.5,2),wave:pose(-1,-1,-28),'arm-left':pose(0,0,4)}],
      [.7,{head:pose(-1,.5,-2),wave:pose(0,0,-14)}], [1,{}],
    ]},
    victory: {duration:1500,frames:[
      [0,{}], [.2,{figure:pose(0,.8,0,1.02,.98),head:pose(0,1,2)}],
      [.42,{figure:pose(0,-2,-2),wave:pose(0,-2,-48),'arm-left':pose(0,0,12),head:pose(0,-.6,-3)}],
      [.65,{figure:pose(0,-1,-1),wave:pose(0,-2,-42),head:pose(0,.5,2)}],
      [.82,{wave:pose(0,0,-12)}], [1,{}],
    ]},
    breathe: {duration:1900,frames:[
      [0,{}], [.45,{torso:pose(0,-1.4,0,1.025,1.035),head:pose(0,-1.6,-3),wave:pose(0,0,-9)}], [1,{}],
    ]},
    tilt: {duration:1800,frames:[
      [0,{}], [.35,{head:pose(1.5,-1,8),torso:pose(0,0,3),wave:pose(0,0,-12)}],
      [.65,{head:pose(1.5,-1,8)}], [1,{}],
    ]},
    work: {duration:1800,frames:[
      [0,{}], [.18,{torso:pose(0,1,-2),head:pose(0,1,-5),wave:pose(0,0,-12)}],
      [.38,{torso:pose(0,-.5,1),head:pose(0,-1,3),wave:pose(0,-1,-28),'arm-left':pose(0,0,6)}],
      [.58,{torso:pose(0,1,-1),head:pose(0,1,-4),wave:pose(0,0,-13),'arm-left':pose(0,0,-4)}],
      [.78,{torso:pose(0,-.5,1),head:pose(0,-1,2),wave:pose(0,-1,-24)}], [1,{}],
    ]},
    peek: {duration:2000, frames:[
      [0,{}], [.12,{head:pose(-2,0,-6)}],
      [.28,{torso:pose(-2,0,-5),head:pose(-3,-1,-7),wave:pose(0,0,9)}],
      [.5,{torso:pose(-2,0,-5),head:pose(-3,-1,-7)}],
      [.65,{head:pose(2,0,5),torso:pose(0,0,2)}],
      [.84,{head:pose(0,0,-2),torso:pose(0,0,-1)}], [1,{}],
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
  // Fish locomotion and the two final forms use the same bounded scheduler.
  Object.assign(clips, {
    finWave:{duration:1700,frames:[
      [0,{}],[.2,{figure:pose(0,-2,-3),wave:pose(0,-1,-28),tail:pose(0,0,12)}],
      [.4,{figure:pose(0,-2,-3),wave:pose(0,0,-8),tail:pose(0,0,-9)}],
      [.6,{figure:pose(0,-1,2),wave:pose(0,-1,-35),tail:pose(0,0,12)}],[1,{}],
    ]},
    bubbleJoy:{duration:1800,frames:[
      [0,{}],[.18,{figure:pose(0,2,0,1.04,.95)}],
      [.4,{figure:pose(0,-6,-5),wave:pose(0,0,-30),'arm-left':pose(0,0,30),tail:pose(0,0,18),shadow:pose(0,0,0,.75,.8)}],
      [.65,{figure:pose(0,-3,5),tail:pose(0,0,-14)}],[1,{}],
    ]},
    dive:{duration:2500,frames:[
      [0,{}],[.2,{figure:pose(-3,2,-10),tail:pose(0,0,18)}],
      [.43,{figure:pose(0,-7,8),tail:pose(0,0,-15),'flight-left':pose(0,0,-10),'flight-right':pose(0,0,10),shadow:pose(0,0,0,.7,.8)}],
      [.68,{figure:pose(4,-3,5),tail:pose(0,0,12),'flight-left':pose(0,0,-6),'flight-right':pose(0,0,6)}],[1,{}],
    ]},
    soar:{duration:2600,frames:[
      [0,{}],[.18,{figure:pose(0,2,0,1.03,.96)}],
      [.38,{figure:pose(-4,-6,-6),'flight-left':pose(0,0,-16),'flight-right':pose(0,0,16),tail:pose(0,0,-10),shadow:pose(0,0,0,.7,.8)}],
      [.65,{figure:pose(4,-6,6),'flight-left':pose(0,0,-8),'flight-right':pose(0,0,8),tail:pose(0,0,10)}],[1,{}],
    ]},
    phoenix:{duration:2900,frames:[
      [0,{}],[.16,{figure:pose(0,3,0,1.05,.94)}],
      [.34,{figure:pose(-2,-7,-4),'flight-left':pose(0,0,-18),'flight-right':pose(0,0,18),'arm-left':pose(0,0,12),wave:pose(0,0,-6),tail:pose(0,0,-12),leaves:pose(0,0,-7),shadow:pose(0,0,0,.65,.8)}],
      [.5,{figure:pose(0,-7,0),'flight-left':pose(0,0,12),'flight-right':pose(0,0,-12),tail:pose(0,0,7)}],
      [.67,{figure:pose(2,-6,4),'flight-left':pose(0,0,-16),'flight-right':pose(0,0,16),tail:pose(0,0,12)}],
      [.85,{figure:pose(0,1,0,1.03,.97),'arm-left':pose(0,0,20),wave:pose(0,0,-20)}],[1,{}],
    ]},
    kunpeng:{duration:3000,frames:[
      [0,{}],[.17,{figure:pose(-2,2,-3,1.03,.97),tail:pose(0,0,15)}],
      [.35,{figure:pose(-3,-7,-6),'flight-left':pose(0,0,-18),'flight-right':pose(0,0,18),wave:pose(0,0,-20),tail:pose(0,0,-12),shadow:pose(0,0,0,.65,.8)}],
      [.53,{figure:pose(0,-8,0),'flight-left':pose(0,0,-10),'flight-right':pose(0,0,10),tail:pose(0,0,12)}],
      [.72,{figure:pose(4,-5,6),'flight-left':pose(0,0,-18),'flight-right':pose(0,0,18),tail:pose(0,0,-10)}],
      [.87,{figure:pose(0,1,0,1.03,.97)}],[1,{}],
    ]},
  });
  // Compile smooth travel curves once. Playback stays browser-driven: no frame
  // callback or repeated easing that brakes at every intermediate keyframe.
  const smooth = t => { t=Math.max(0,Math.min(1,t)); return t*t*t*(t*(t*6-15)+10); };
  const headingAt = t => 1-2*smooth((t-.30)/.14)+2*smooth((t-.72)/.14);
  // Body weight follows the look, with the tail projection settling last.
  // A rigid shoulder/hip turn carries the chest, wings and letter together.
  const turnWeight = t => {
    for(const [start,direction] of [[.285,1],[.705,-1]]) {
      const u=(t-start)/.15;
      if(u>0 && u<1)return direction*Math.sin(Math.PI*u)**2;
    }
    return 0;
  };
  const travelFrames = swimming => Array.from({length:101},(_,i)=>{
    const t=i/100;
    const legs=[[0,.30,0,-6,1],[.44,.72,-6,6,1],[.86,1,6,0,.5]];
    const leg=legs.find(([a,b])=>t>=a && t<=b);
    let x=t<.44?-6:6, y=0, lean=0, swing=0, left=neutral, right=neutral, tail=0;
    if(leg) {
      const [a,b,from,to,cycles]=leg, u=(t-a)/(b-a), direction=Math.sign(to-from);
      const envelope=Math.sin(Math.PI*u)**2, phase=u*Math.PI*2*cycles;
      x=from+(to-from)*smooth(u);
      if(swimming) {
        y=-1.7*envelope*envelope;
        lean=direction*2.2*envelope;
        tail=8*Math.sin(phase-.45)*envelope;
        swing=6*Math.sin(phase)*envelope;
      } else {
        const stride=Math.sin(phase), lift=2.6*envelope;
        y=-.9*Math.sin(phase)**2*envelope;
        lean=direction*2*envelope;
        left=pose(-direction*1.5*Math.cos(phase)*envelope,-lift*Math.max(0,stride)**2,-7*stride*envelope);
        right=pose(direction*1.5*Math.cos(phase)*envelope,-lift*Math.max(0,-stride)**2,7*stride*envelope);
        swing=-7*stride*envelope;
      }
    }
    const heading=headingAt(t), look=headingAt(Math.min(1,t+.035));
    const weight=turnWeight(t), bodyHeading=headingAt(Math.min(1,t+.015));
    const active=smooth(t/.08)*(1-smooth((t-.92)/.08));
    const roll=(swimming?3.8:4.8)*weight-1.1*bodyHeading*active;
    // Pivot at the hips so the shoulder line, chest and attached objects follow
    // the new direction without flattening the body or sliding the shoulders.
    const torso=pose(.45*weight-.35*bodyHeading*active,
      (swimming?-.65:.45)*Math.abs(weight),roll);
    if(!swimming && !leg) {
      // Keep the supporting foot planted; the other heel follows the weight.
      left=pose(0,-.7*Math.max(0,weight),-2*Math.max(0,weight));
      right=pose(0,.7*Math.min(0,weight),-2*Math.min(0,weight));
    }
    return [t,{heading,look,figure:pose(x,y,lean),torso,
      'foot-left':left,'foot-right':right,
      'arm-left':pose(0,0,swing-roll*.45),tail:pose(0,0,tail)}];
  });
  clips.step={duration:3200,directional:true,frames:travelFrames(false)};
  clips.march={duration:3000,directional:true,frames:clips.step.frames};
  clips.swim={duration:3600,directional:true,frames:travelFrames(true)};
  // The startup mascot has its own strictly horizontal hand-off. Excluding it
  // here prevents the ambient character clips from adding vertical movement.
  const rigs = [];
  const enabled = () => !document.hidden && !reduced.matches && !document.body.classList.contains('companion-still') && !document.body.classList.contains('companion-paused') && !document.body.classList.contains('companion-dragging');
  const visible = rig => rig.svg.isConnected && rig.intersecting &&
    (!document.querySelector('dialog[open]') || !!rig.svg.closest('dialog[open]')) &&
    !(orb.contains(rig.svg) && document.body.classList.contains('assistant-visible')) &&
    rig.svg.getClientRects().length && getComputedStyle(rig.svg).visibility !== 'hidden';
  let awakeUntil = 0, awakeTimer = 0, ambientTimer = 0;
  const randomDelay = (min,max) => min + Math.random() * (max-min);
  let gestureAt = performance.now() + randomDelay(22000,34000);
  let activityAt = performance.now();
  // Reading, typing and scrolling postpone larger gestures, without a per-frame loop.
  for (const type of ['pointerdown','keydown','input','scroll']) {
    document.addEventListener(type,()=>{activityAt=performance.now();},{capture:true,passive:true});
  }
  const choose = (items,last) => {
    const choices=items.filter(name=>name!==last);
    return choices[Math.floor(Math.random()*choices.length)];
  };
  const stop = (rig,rest=false) => {
    // Preserve continuous turn progress on interruption, including a partly
    // occluded tail and a face already looking toward the next direction.
    for(const part of ['heading','look']) {
      const node=rig.parts[part], value=getComputedStyle(node).transform;
      node.style.transform=value;
    }
    clearTimeout(rig.timer);
    rig.finite=false;rig.settling=false;
    rig.animations.forEach(anim=>anim.cancel()); rig.animations=[];
    if(rest) for(const part of ['heading','look']) rig.parts[part].style.removeProperty('transform');
    delete rig.svg.dataset.motionKind;
    delete rig.svg.dataset.motionClip;
    delete rig.svg.dataset.expression;
    if (rig.svg.dataset.motionActive !== 'false') rig.svg.dataset.motionActive = 'false';
  };
  const transform = p => `translate(${p[0]}px,${p[1]}px) rotate(${p[2]}deg) scale(${p[3]},${p[4]})`;
  const motionKeys = new Map();
  // Match velocity across poses without overshooting a shoulder or grip limit.
  // These bounded samples are cached; the browser still drives every frame.
  const fluidKeys = (keys,duration) => {
    const spans=keys.slice(1).map((key,i)=>key.offset-keys[i].offset);
    const slopes=neutral.map((_,axis)=>{
      const speeds=spans.map((span,i)=>(keys[i+1].value[axis]-keys[i].value[axis])/span);
      return keys.map((_,i)=>{
        if(i===0 || i===keys.length-1 || speeds[i-1]*speeds[i]<=0)return 0;
        const a=2*spans[i]+spans[i-1], b=spans[i]+2*spans[i-1];
        return (a+b)/(a/speeds[i-1]+b/speeds[i]);
      });
    });
    const count=Math.ceil(duration/30);
    const offsets=[...new Set([...keys.map(key=>key.offset),...Array.from({length:count+1},(_,i)=>i/count)])].sort((a,b)=>a-b);
    let segment=0;
    return offsets.map(offset=>{
      while(segment<keys.length-2 && offset>keys[segment+1].offset)segment++;
      const h=spans[segment], t=(offset-keys[segment].offset)/h, t2=t*t, t3=t2*t;
      const value=neutral.map((_,axis)=>(2*t3-3*t2+1)*keys[segment].value[axis]+
        (t3-2*t2+t)*h*slopes[axis][segment]+(-2*t3+3*t2)*keys[segment+1].value[axis]+
        (t3-t2)*h*slopes[axis][segment+1]);
      return {offset,transform:transform(value.map(n=>Math.round(n*1e6)/1e6)),easing:'linear'};
    });
  };
  // A visible reaction has a landing, not a hard cancel. All body parts share
  // one bounded release; the holding wing and letter remain on their carry rig.
  const settle = rig => {
    const priority=['peek','happy'].includes(rig.mode) ? rig.mode : 'off';
    const outfit=[...rig.svg.querySelectorAll('.pet-reward-motion')].filter(node=>node.getClientRects().length);
    const parts=[...new Set([...Object.values(rig.parts),rig.svg.querySelector('.companion-eyes'),...outfit])].filter(Boolean);
    const poseOf=node=>{const css=getComputedStyle(node);return {transform:css.transform,opacity:css.opacity};};
    const starts=parts.map(poseOf);
    const expression=rig.svg.dataset.expression;
    // Outfit loops have their own clocks. Release them with the body instead
    // of freezing a wing, scarf or effect at an arbitrary CSS animation frame.
    rig.svg.dataset.outfitRest='true';
    stop(rig,true);rig.mode='settling';rig.settling=true;
    rig.svg.dataset.motionActive='true';rig.svg.dataset.motionKind='reaction';
    rig.svg.dataset.motionClip='settle';
    if(expression)rig.svg.dataset.expression=expression;
    parts.forEach((node,index)=>{
      const target=poseOf(node);
      if(starts[index].transform===target.transform && starts[index].opacity===target.opacity)return;
      rig.animations.push(node.animate([starts[index],target],
        {duration:420,easing:'cubic-bezier(.22,.65,.3,1)',fill:'none'}));
    });
    rig.timer=setTimeout(()=>{stop(rig,true);rig.mode=priority;refresh();},445);
  };
  const play = (rig,name) => {
    // A direct reaction may share a task with a style change; observe its new route now.
    rig.style=style();
    const start=Object.fromEntries(names.map(part=>[part,getComputedStyle(rig.parts[part]).transform]));
    stop(rig);
    if(!enabled() || !visible(rig)) return;
    delete rig.svg.dataset.outfitRest;
    rig.svg.dataset.motionKind = rig.mode === 'ambient' ? 'ambient' : 'reaction';
    const clipName=profiles[style()].reactions[name] || name;
    rig.svg.dataset.motionClip = clipName;
    rig.svg.dataset.motionActive = 'true';
    const clip=clips[clipName];
    rig.finite=name!=='work';
    const finStage=Math.max(1,Math.min(7,Number(rig.stage || document.body.dataset.petStage || 1)));
    rig.svg.dataset.expression = ['greet','salute','happy','victory','deliver','glide','star','bow','beacon','finWave','bubbleJoy','phoenix','kunpeng','soar'].includes(clipName) ? 'joy' : ['work','rangerWork','think','dispatch','guard'].includes(clipName) ? 'focus' : 'curious';
    for(const part of names) {
      if(getComputedStyle(rig.parts[part]).display==='none') continue;
      if(['heading','look'].includes(part) && !clip.directional) continue;
      if(part.startsWith('flight-') && Number(rig.stage || document.body.dataset.petStage || 1)<4) continue;
      // Accessories lag the body's turn and rebound after it settles.
      const cacheKey=`${clipName}:${rig.style}:${finStage}:${part}`;
      let keys=motionKeys.get(cacheKey);
      if(!keys) {
        const poses=clip.frames.map(([offset,frame],index)=>{
          let value=frame[part] || neutral;
          if(part==='heading') value=pose(0,0,0,frame.heading,1);
          if(part==='look') value=pose(-2.8*frame.look,0,0);
          if(clip.directional && part==='shadow') value=pose((frame.figure?.[0] || 0)*.7,0,0,1,1);
          // The round body stays rigid; only the face nods inside its silhouette.
          if(['figure','torso','head'].includes(part)) {
            value=[...value];
            value[3]=value[4]=Math.sqrt(value[3]*value[4]);
            if(part==='head') {
              value[0]=Math.max(-1.5,Math.min(1.5,value[0]));
              value[1]=Math.max(-1.5,Math.min(1.5,value[1]));
              value[2]=Math.max(-4,Math.min(4,value[2]));
            }
          }
          // The free wing greets. The holding wing and letter are children of
          // one shoulder rig, so interruption and settling cannot split the grip.
          if(part==='arm-left' && !frame[part] && frame.wave) {
            value=pose(0,frame.wave[1]*.35,Math.max(-28,Math.min(38,-frame.wave[2])));
          }
          if(part==='arm-left') {
            // The free wing also pivots at its shoulder instead of sliding off it.
            value=pose(0,0,Math.max(-28,Math.min(38,value[2])));
            // Longer fins need a smaller stroke: the tip travels farther without
            // making the shoulder jerk or pulling the front fin off the body.
            if(rig.style==='ranger') value[2]*=1-(finStage-1)*.045;
          }
          if(part.startsWith('flight-') && rig.style==='ranger') {
            const stroke=finStage===4 ? .62 : finStage===5 ? .78 : .9;
            value=pose(0,0,value[2]*stroke);
          }
          if(part==='carry') {
            // Never translate a shoulder away from the body. Small rotations lift
            // the letter as a unit; the torso supplies travel, bounce and turns.
            const angle=frame.bag ? frame.bag[2]*.45 : (frame.torso?.[2] || 0)*-.35;
            value=pose(0,0,Math.max(-8,Math.min(5,angle)));
          }
          if((part==='leaves' || part==='tail') && !frame[part]) {
            const previous=clip.frames[Math.max(0,index-1)][1];
            const turn=(previous.figure?.[2] || 0)+(previous.torso?.[2] || 0);
            value=index===clip.frames.length-1 ? neutral : pose(0,0,-turn*(part==='leaves' ? .35 : .8));
          }
          if(part==='tail' && rig.style==='ranger') {
            // A continuous tailstock stays buried in the body as the flukes sway.
            // Translation or large whole-tail swings would expose the root seam.
            value=pose(0,0,Math.max(-10,Math.min(10,value[2])));
          }
          return {offset,value};
        });
        keys=clip.directional ? poses.map(({offset,value})=>({offset,transform:transform(value),easing:'linear'})) : fluidKeys(poses,clip.duration);
        // Keep the shared cache small when trying many stages and outfits.
        if(motionKeys.size>=96)motionKeys.delete(motionKeys.keys().next().value);
        motionKeys.set(cacheKey,keys);
      }
      // Leave stationary parts alone; retain interrupted parts until they settle.
      if((start[part]==='none' || start[part]==='matrix(1, 0, 0, 1, 0, 0)') &&
        keys.every(key=>key.transform===transform(neutral))) continue;
      // Each playback owns its keys: interrupted poses must not enter the cache.
      keys=keys.map(key=>({...key}));
      let entryKeys=null,entryDuration=0;
      // Blend an interrupted pose through the first part of any clip; replacing
      // only its first dense sample would cause a one-frame jump on interaction.
      if(clip.directional || (start[part]!=='none' && start[part]!=='matrix(1, 0, 0, 1, 0, 0)')) {
        const initial=new DOMMatrixReadOnly(start[part]);
        let blendKeys=keys,blendEnd=.08;
        if(name==='work') {
          // Enter a work loop once. Baking an interrupted pose into its repeating
          // keys would snap back to that pose at the start of every cycle.
          const end=keys.findIndex(key=>key.offset>=.08);
          blendKeys=keys.slice(0,end+1).map(key=>({...key}));
          blendEnd=blendKeys.at(-1).offset;
          entryDuration=blendEnd*clip.duration;
          entryKeys=blendKeys;
        }
        blendKeys.forEach(key=>{
          const amount=smooth(key.offset/blendEnd);
          if(amount>=1)return;
          const target=new DOMMatrixReadOnly(key.transform);
          key.transform=`matrix(${['a','b','c','d','e','f'].map(k=>initial[k]+(target[k]-initial[k])*amount).join(',')})`;
        });
        if(entryKeys)entryKeys.forEach(key=>{key.offset/=blendEnd;});
      }
      if(name!=='work')keys[0].transform=start[part];
      // Save orientation at the end before releasing its browser animation.
      const anim=rig.parts[part].animate(keys,{duration:clip.duration,fill:['heading','look'].includes(part)?'forwards':'none',iterations:name==='work'?Infinity:1});
      rig.animations.push(anim);
      if(entryKeys)rig.animations.push(rig.parts[part].animate(entryKeys,{duration:entryDuration,fill:'none'}));
    }
    if(rig.mode==='ambient') {
      const eyes=rig.svg.querySelector('.companion-eyes');
      if(eyes) rig.animations.push(eyes.animate([
        {offset:0,transform:'scaleY(1)'},{offset:.35,transform:'scaleY(1)'},
        {offset:.40,transform:'scaleY(.12)'},{offset:.46,transform:'scaleY(1)'},
        {offset:1,transform:'scaleY(1)'},
      ],{duration:clip.duration,fill:'none'}));
    }
    if(name!=='work')rig.timer=setTimeout(()=>{
      if(rig.mode!=='ambient' && rig.mode!=='preview' && enabled() && visible(rig)) {
        settle(rig);return;
      }
      if(rig.mode==='ambient') {
        stop(rig,true);rig.mode='off';refresh();
      } else {
        // Keep the state priority until it expires, but release every animation.
        stop(rig,true);
        if(rig.mode==='manual' || (rig.mode==='peek' && performance.now()>=awakeUntil)) rig.mode='off';
        refresh();
      }
    },clip.duration+25);
  };
  const idleRigs = () => enabled() ? rigs.filter(rig=>!rig.welcome && visible(rig) && rig.mode==='off') : [];
  const scheduleAmbient = () => {
    // One timer and one performing mascot. A foreground return starts a fresh wait.
    if(!idleRigs().length || rigs.some(rig=>rig.mode!=='off')) {
      clearTimeout(ambientTimer);ambientTimer=0;return;
    }
    if(ambientTimer) return;
    ambientTimer=setTimeout(()=>{
      ambientTimer=0;
      const candidates=idleRigs();
      const rig=candidates.find(item=>item.svg.closest('.pet-hero-portrait,.compose-perch')) || candidates[0];
      if(!rig) return;
      const now=performance.now();
      // Keep the writing portrait subtle, and avoid large gestures during input.
      const large=now>=gestureAt && now-activityAt>=15000 && !rig.svg.closest('.compose-perch');
      const profile=profiles[style()];
      const name=large ? choose(profile.gestures,rig.lastGesture) : choose(profile.micro,rig.lastMicro);
      if(large) {rig.lastGesture=name;gestureAt=now+randomDelay(22000,34000);}
      else rig.lastMicro=name;
      rig.mode='ambient';play(rig,name);
      if(large) document.dispatchEvent(new CustomEvent('mailai:companion-idle',{detail:{svg:rig.svg}}));
    },randomDelay(8000,15000));
  };
  const refresh = () => {
    rigs.forEach(rig=>{
      const nextStyle=style(), changed=rig.style!==nextStyle;
      rig.style=nextStyle;
      // The welcome portrait is event-driven: one greeting per opening, then
      // no ambient timer, background work loop or shared wake reaction.
      if(rig.welcomePending && (!enabled() || performance.now()>rig.welcomePending)) rig.welcomePending=0;
      if(rig.welcomePending && visible(rig)) {
        rig.welcomePending=0;rig.reactedAt=performance.now();
        rig.mode='manual';play(rig,'greet');return;
      }
      let mode='off';
      if(!enabled() || !visible(rig)) mode='off';
      else if(rig.welcome) mode=rig.mode==='manual' && !changed ? 'manual' : 'off';
      else if(document.body.classList.contains('companion-working') || rig.svg.closest('.state-thinking,.compose-ai-panel.is-thinking')) mode='work';
      else if(rig.svg.closest('.companion-finished')) mode='happy';
      else if(performance.now() < awakeUntil) mode='peek';
      else if(rig.mode==='manual' && !changed) mode='manual';
      else if(rig.mode==='ambient' && !changed) mode='ambient';
      if(mode===rig.mode && !changed) return;
      if(mode==='off' && enabled() && visible(rig) && !changed) {
        // State expiry must not cut a wave, swim or landing in half. Hidden,
        // reduced-motion and background states still cancel immediately.
        if(rig.settling || (rig.finite && rig.svg.dataset.motionActive==='true')) return;
        if(rig.svg.dataset.motionActive==='true') {settle(rig);return;}
      }
      rig.mode=mode;
      if(mode==='off') {stop(rig,true);return;}
      play(rig,mode);
    });
    scheduleAmbient();
  };
  const wake = () => {
    if (!enabled()) return;
    // A new interaction can arrive after a finite peek ends but before its
    // wake window expires. Restart only on this explicit wake, never in idle.
    for(const rig of rigs) if(rig.mode==='peek' && rig.svg.dataset.motionActive==='false') rig.mode='off';
    awakeUntil = performance.now() + 3500;
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => { awakeUntil = 0; refresh(); }, 3500);
    refresh();
  };
  const signature = (stage=Number(document.body.dataset.petStage)||1) =>
    (style()==='ranger' ? ['finWave','swim','dispatch','bubbleJoy','dive','soar','kunpeng'] : ['greet','step','deliver','happy','glide','bow','phoenix'])[Math.max(0,Math.min(6,stage-1))];
  const react = (name='greet', target) => {
    if(!enabled()) return false;
    const rig=rigs.find(item=>visible(item) && (!target || target.contains(item.svg)) && item.svg.closest('.pet-hero-portrait')) ||
      rigs.find(item=>visible(item) && (!target || target.contains(item.svg)));
    if(!rig || rig.mode==='work' || document.body.classList.contains('companion-working')) return false;
    const clip=name==='signature' ? signature() : name;
    if(!clips[clip]) return false;
    awakeUntil=0;clearTimeout(awakeTimer);clearTimeout(ambientTimer);ambientTimer=0;
    rig.mode='manual';play(rig,clip);return true;
  };
  // A single disposable fitting-room rig reuses the actual creature clips.
  // It never joins ambient scheduling or changes the saved growth stage.
  let previewRig=null;
  const stopPreview=svg=>{
    if(!previewRig || (svg && previewRig.svg!==svg))return;
    stop(previewRig);
    delete previewRig.svg.dataset.motionActive;
    previewRig=null;
  };
  const preview=(svg,stage,name='signature')=>{
    stopPreview();
    if(!enabled() || !svg?.isConnected || svg.dataset.rewardVisible!=='true')return false;
    const clip=name==='signature'?signature(stage):name==='travel'?(style()==='ranger'?'swim':'march'):name;
    if(!clips[profiles[style()].reactions[clip] || clip])return false;
    previewRig={svg,stage,parts:Object.fromEntries(names.map(part=>[part,svg.querySelector(`.companion-${part}`)])),animations:[],timer:0,mode:'preview',intersecting:true};
    play(previewRig,clip);
    const current=previewRig;
    setTimeout(()=>{if(previewRig===current && current.animations.length===0)stopPreview();},clips[profiles[style()].reactions[clip] || clip].duration+40);
    return true;
  };
  window.mailaiCompanionMotion = {wake,react,signature,preview,stopPreview,scan:()=>scan()};
  let greetingAt=-Infinity;
  const greet=event=>{
    const rig=rigs.find(item=>item.svg.closest('#assistant-orb,.assistant-mini,.compose-perch,.assistant-welcome-portrait')?.contains(event.target));
    if(rig?.welcome) {
      if(!enabled() || !visible(rig) || rig.mode!=='off' || performance.now()-rig.reactedAt<3000) return;
      rig.welcomePending=0;rig.reactedAt=performance.now();
      rig.mode='manual';play(rig,style()==='ranger'?'nod':'tilt');return;
    }
    if(!rig || !enabled() || !visible(rig) || rig.mode==='work' || rig.mode==='happy' ||
      (rig.mode==='manual' && rig.finite && rig.svg.dataset.motionActive==='true') || performance.now()-greetingAt<2200) return;
    greetingAt=performance.now();wake();play(rig,'greet');
  };
  // The artwork intentionally ignores pointer events. Listen on its actual
  // button as well so a real mouse/keyboard greeting works, not just SVG events.
  orb.addEventListener('pointerenter',greet);
  orb.addEventListener('focusin',greet);
  // The launcher still occupies a rectangle when its opacity is zero. Combine
  // actual viewport intersection with the chat state before running any rig.
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const rig = rigs.find(item=>item.svg===entry.target);
      if (rig) rig.intersecting = entry.isIntersecting;
    }
    refresh();
  });
  function scan() {
    for(let i=rigs.length-1;i>=0;i--) if(!rigs[i].svg.isConnected) {
      stop(rigs[i]);intersection.unobserve(rigs[i].svg);rigs.splice(i,1);
    }
    document.querySelectorAll('.companion-art .mail-companion,.assistant-mini .mail-companion,.compose-perch .mail-companion,.pet-hero-portrait .mail-companion').forEach(svg=>{
      if(svg.closest('.app-preloader') || rigs.some(rig=>rig.svg===svg)) return;
      const rig={svg,parts:Object.fromEntries(names.map(name=>[name,svg.querySelector(`.companion-${name}`)])),animations:[],timer:0,mode:'off',style:'',intersecting:false,lastMicro:'',lastGesture:''};
      rig.welcome=!!svg.closest('.assistant-welcome-portrait');
      rig.reactedAt=-Infinity;
      rig.welcomePending=rig.welcome && enabled() && document.body.classList.contains('assistant-visible') && !svg.closest('.secretary-show-briefing') ? performance.now()+2000 : 0;
      rigs.push(rig);stop(rig);intersection.observe(svg);
      const host=svg.closest('.companion-art,.assistant-mini,.compose-perch');
      host?.addEventListener('pointerenter',greet);host?.addEventListener('focusin',greet);
    });
    refresh();
  }
  let chatOpen = document.body.classList.contains('assistant-visible');
  const sync = () => {
    const open = document.body.classList.contains('assistant-visible');
    const opened = open && !chatOpen;
    chatOpen = open;
    if (!enabled()) {
      stopPreview();
      clearTimeout(awakeTimer); awakeTimer = 0; awakeUntil = 0;
      gestureAt=performance.now()+randomDelay(22000,34000);
    }
    for(const rig of rigs) if(rig.welcome) {
      if(!open || !enabled() || rig.svg.closest('.secretary-show-briefing')) rig.welcomePending=0;
      else if(opened) rig.welcomePending=performance.now()+2000;
    }
    if (opened && !rigs.some(rig=>rig.welcome)) wake();
    refresh();
  };
  const observer=new MutationObserver(sync);
  observer.observe(document.body,{attributes:true,attributeFilter:['class','data-pet-style']});
  observer.observe(root,{attributes:true,attributeFilter:['class']});
  document.querySelectorAll('.assistant-panel,.compose-ai-panel').forEach(el=>observer.observe(el,{attributes:true,attributeFilter:['class']}));
  reduced.addEventListener('change',sync);
  document.addEventListener('visibilitychange',sync);
  document.addEventListener('mailai:foreground-changed',sync);
  window.addEventListener('resize',refresh);
  document.addEventListener('mailai:companion-journal',scan);
  document.addEventListener('mailai:assistant-portrait',scan);
  scan();
  sync();
})();
