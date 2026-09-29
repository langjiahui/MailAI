// The approved LJH study, adapted to a small local profile mark.
// Reference UVs preserve the supplied letter proportions and ribbon folds.
import * as THREE from './vendor/three/three.module.min.js';
import { SVGLoader } from './vendor/three/SVGLoader.js';

export async function createAuthorLogo(canvas, image) {
  await image.decode();
  const W=1312,H=1199,CX=656,CY=620,S=120;
  const texture=new THREE.Texture(image);texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;texture.anisotropy=4;
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:'default'});
  renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio,1.5),2));renderer.setClearColor(0x000000,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
  const scene=new THREE.Scene();
  const camera=new THREE.OrthographicCamera(-5,5,4,-4,.1,40);camera.position.set(0,0,12);
  const logo=new THREE.Group();logo.scale.z=1.32;scene.add(logo);
  scene.add(new THREE.HemisphereLight(0xe7fff5,0x16445a,2.0));
  const keyLight=new THREE.DirectionalLight(0xffffff,2.4);keyLight.position.set(-4,6,9);scene.add(keyLight);
  const bounceLight=new THREE.DirectionalLight(0x81f3d0,1.15);bounceLight.position.set(5,-2,4);scene.add(bounceLight);
  const materials=[],geometries=[];
  const globalUniforms={uTime:{value:0},uStrength:{value:1.1},uAngle:{value:0}};
  const ctxCanvas=document.createElement('canvas');ctxCanvas.width=W;ctxCanvas.height=H;
  const ctx=ctxCanvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,W,H).data;
  const sampleColor=(x,y)=>{const i=(Math.min(H-1,Math.max(0,Math.round(y)))*W+Math.min(W-1,Math.max(0,Math.round(x))))*4;return new THREE.Color().setRGB(pixels[i]/255,pixels[i+1]/255,pixels[i+2]/255,THREE.SRGBColorSpace);};
  const sampleEdge=(x,y)=>{
    let best=sampleColor(x,y),score=-1;
    for(const dx of [-8,0,8])for(const dy of [-8,0,8]){
      const color=sampleColor(x+dx,y+dy);
      const saturation=Math.max(color.r,color.g,color.b)-Math.min(color.r,color.g,color.b);
      const value=saturation/(1+(dx*dx+dy*dy)/180);
      if(value>score){score=value;best=color;}
    }
    return best.multiplyScalar(.76);
  };
  const g=(x,y,cx,cy,sx,sy)=>Math.exp(-(((x-cx)/sx)**2+((y-cy)/sy)**2));

  // Traces use the supplied image's pixel coordinates. Front view is orthographic.
  const layers=[
    {name:'H rear upright',z:0,depth:82,phase:.60,
      outline:'M 940 572 L 940 393 C 940 367 954 348 978 341 L 1045 323 C 1060 318 1073 330 1073 349 L 1073 868 C 1073 890 1064 897 1048 893 L 961 878 C 946 875 940 868 940 851 Z',
      relief:(x,y)=>8*Math.sin((x-940)/133*Math.PI)+9*(1-(y-323)/571),
      center:[[1004,334],[1004,470],[1004,700],[1004,878]]},
    {name:'J lower return and rear',z:12,depth:82,phase:.24,
      outline:'M 639 382 L 690 381 C 756 379 793 424 795 483 L 795 770 C 795 862 725 928 607 927 C 504 929 413 877 409 783 L 490 783 C 530 773 549 743 550 701 L 550 461 C 550 415 588 383 639 382 Z',
      relief:(x,y)=>13*g(x,y,701,586,123,390)+8*g(x,y,550,859,190,65),
      center:[[673,404],[755,475],[754,680],[740,821],[640,884],[518,878],[427,800]]},
    {name:'L silhouette and fold',z:29,depth:76,phase:0,
      outline:'M 245 367 C 245 343 259 322 285 315 L 350 298 C 365 294 375 303 375 320 L 375 675 L 509 675 C 526 675 535 686 535 702 L 535 715 C 535 752 510 772 471 772 L 322 772 C 270 772 245 747 245 696 Z',
      relief:(x,y)=>11*g(x,y,325,377,76,100)+17*g(x,y,278,602,51,90)+12*g(x,y,449,699,110,38),
      center:[[311,320],[311,445],[301,573],[285,646],[323,714],[423,722],[508,711]]},
    {name:'J inner curling face',z:53,depth:54,phase:.24,
      outline:'M 639 383 C 680 383 711 404 711 446 L 711 749 C 711 817 679 856 628 869 C 588 880 547 867 520 845 C 501 829 491 808 492 786 C 532 774 551 745 551 701 L 550 461 C 550 416 588 384 639 383 Z',
      relief:(x,y)=>13*g(x,y,654,425,88,70)+20*g(x,y,652,749,88,171)-9*g(x,y,569,790,69,65),
      center:[[644,405],[624,471],[593,571],[594,708],[566,778],[529,800],[577,850],[651,837],[684,763]]},
    {name:'H transverse fold and foreground leg',z:49,depth:61,phase:.49,
      outline:'M 711 459 L 711 579 C 711 633 739 664 791 664 C 841 664 886 644 930 644 C 1006 640 1068 686 1070 752 L 1070 866 C 1070 887 1063 896 1048 891 L 960 878 C 946 875 940 868 940 851 L 940 712 C 940 680 925 668 890 668 L 795 666 C 739 666 711 635 711 580 Z',
      relief:(x,y)=>21*g(x,y,855,641,122,46)+16*g(x,y,1027,735,68,175),
      center:[[745,550],[752,614],[813,635],[921,615],[1000,643],[1038,738],[1006,869]]},
    {name:'H upper satin ribbon',z:72,depth:40,phase:.49,
      outline:'M 711 459 L 711 578 C 711 633 739 664 791 664 C 841 664 886 644 930 644 C 1006 640 1068 686 1070 752 C 1069 678 1019 570 949 571 L 795 571 L 795 483 C 793 425 756 381 690 381 L 639 382 C 681 382 711 404 711 446 Z',
      relief:(x,y)=>10*g(x,y,763,486,72,118)+17*g(x,y,940,614,138,70),
      center:[[743,400],[755,480],[754,578],[790,619],[919,608],[1000,643],[1051,710]]}
  ];
  const loader=new SVGLoader();
  function addLayer(layer,layerIndex){
    const parsed=loader.parse('<svg xmlns="http://www.w3.org/2000/svg"><path d="'+layer.outline+'"/></svg>');
    const shapes=SVGLoader.createShapes(parsed.paths[0]);
    const height=(x,y)=>layer.z+layer.relief(x,y);
    for(let shape of shapes){
      const sideShape=shape;
      if(layerIndex<3){
        const contour=shape.getPoints(32);
        if(contour[0].distanceTo(contour[contour.length-1])<.01)contour.pop();
        const direction=THREE.ShapeUtils.isClockWise(contour)?-1:1;
        const expanded=contour.map((p,i)=>{
          const prev=contour[(i+contour.length-1)%contour.length],next=contour[(i+1)%contour.length];
          const incoming=p.clone().sub(prev).normalize(),outgoing=next.clone().sub(p).normalize();
          const n1=new THREE.Vector2(incoming.y,-incoming.x).multiplyScalar(direction),n2=new THREE.Vector2(outgoing.y,-outgoing.x).multiplyScalar(direction);
          const normal=n1.clone().add(n2).normalize();
          return p.clone().addScaledVector(normal,Math.min(7,4.7/Math.max(.65,normal.dot(n1))));
        });
        shape=new THREE.Shape(expanded);
      }
      const flat=new THREE.ShapeGeometry(shape,24).toNonIndexed();const input=flat.getAttribute('position');
      const positions=[],uv=[],normals=[];
      function vertex(p){
        const x=p[0],y=p[1],z=height(x,y),dx=(height(x+1,y)-height(x-1,y))/2,dy=(height(x,y+1)-height(x,y-1))/2;
        const normal=new THREE.Vector3(-dx,dy,1).normalize();
        positions.push((x-CX)/S,(CY-y)/S,z/S);uv.push(x/W,1-y/H);normals.push(normal.x,normal.y,normal.z);
      }
      const length=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2;
      function subdivide(a,b,c,depth){
        const distances=[length(a,b),length(b,c),length(c,a)];const longest=Math.max(...distances);
        if(longest<32**2||depth>12){vertex(a);vertex(c);vertex(b);return;}
        if(distances[0]===longest){const m=[(a[0]+b[0])/2,(a[1]+b[1])/2];subdivide(a,m,c,depth+1);subdivide(m,b,c,depth+1);}
        else if(distances[1]===longest){const m=[(b[0]+c[0])/2,(b[1]+c[1])/2];subdivide(a,b,m,depth+1);subdivide(a,m,c,depth+1);}
        else {const m=[(c[0]+a[0])/2,(c[1]+a[1])/2];subdivide(a,b,m,depth+1);subdivide(m,b,c,depth+1);}
      }
      for(let i=0;i<input.count;i+=3)subdivide([input.getX(i),input.getY(i)],[input.getX(i+1),input.getY(i+1)],[input.getX(i+2),input.getY(i+2)],0);
      flat.dispose();
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      const material=new THREE.ShaderMaterial({
        uniforms:{referenceMap:{value:texture},...globalUniforms,uOuter:{value:layerIndex<3?1:0}},
        vertexShader:'varying vec2 vUv; varying vec3 vNormal; varying vec3 vView; void main(){vUv=uv;vNormal=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vView=-mv.xyz;gl_Position=projectionMatrix*mv;}',
        fragmentShader:`uniform sampler2D referenceMap;uniform float uOuter;uniform float uTime;uniform float uStrength;uniform float uAngle;varying vec2 vUv;varying vec3 vNormal;varying vec3 vView;
          void main(){
            vec3 base=texture2D(referenceMap,vUv).rgb;
            vec3 n=normalize(vNormal),v=normalize(vView);
            vec2 pixel=vec2(vUv.x*1312.0,(1.0-vUv.y)*1199.0);
            float sweepPosition=(pixel.x-245.0)/829.0*.72+(pixel.y-296.0)/630.0*.28;
            sweepPosition+=n.x*.022-n.y*.012+(1.0-n.z)*.028;
            float head=fract(uTime/4.6)*1.34-.17;
            float behind=head-sweepPosition;
            float core=exp(-pow(behind/.012,2.0));
            float band=exp(-pow(behind/.030,2.0));
            float tail=smoothstep(-.006,.025,behind)*exp(-max(behind,0.0)/.075);
            float facing=pow(max(0.0,dot(n,normalize(vec3(-.6,.7,1.8)))),8.0);
            float rim=pow(1.0-max(dot(n,v),0.0),3.0);
            vec3 tint=mix(vec3(.55,.93,1.0),vec3(.70,1.0,.86),smoothstep(.55,.95,vUv.x));
            float reflection=clamp((core*.50+band*.27+tail*.17)*uStrength,0.0,.90);
            vec3 color=mix(base,mix(tint,vec3(1.0),core),reflection);
            color+=(1.0-base)*facing*tail*.035*uStrength;
            float key=max(dot(n,normalize(vec3(-.38,.58,1.0))),0.0);
            color*=.89+.14*key;
            color+=vec3(.31,.70,.62)*pow(max(dot(reflect(-normalize(vec3(-.38,.58,1.0)),n),v),0.0),28.0)*.11;
            color+=uAngle*((1.0-base)*(facing*.09+rim*.13)-base*.025);
            float low=min(min(base.r,base.g),base.b);
            float chroma=max(max(base.r,base.g),base.b)-low;
            float coverage=mix(1.0,smoothstep(.02,.065,chroma)*(1.0-smoothstep(.96,.995,low)),uOuter);
            if(coverage<.01)discard;
            gl_FragColor=vec4(color,coverage);
            #include <colorspace_fragment>
          }`,side:THREE.DoubleSide,alphaToCoverage:true,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1
      });
      const surface=new THREE.Mesh(geometry,material);surface.name=layer.name;logo.add(surface);materials.push(material);geometries.push(geometry);
      const originalContour=sideShape.getPoints(48);
      if(originalContour[0].distanceTo(originalContour[originalContour.length-1])<.01)originalContour.pop();
      const winding=THREE.ShapeUtils.isClockWise(originalContour)?-1:1;
      const contour=originalContour.map((p,i)=>{
        const previous=originalContour[(i+originalContour.length-1)%originalContour.length],next=originalContour[(i+1)%originalContour.length];
        const tangent=next.clone().sub(previous).normalize();
        const outward=new THREE.Vector2(tangent.y,-tangent.x).multiplyScalar(winding);
        return {shoulder:p.clone().addScaledVector(outward,layerIndex<3?4.7:0),wall:p.clone().addScaledVector(outward,-4.5)};
      });
      contour.push(contour[0]);
      const sidePositions=[],sideColors=[];
      function sideVertex(p,z,shade=1){const color=sampleEdge(p.x,p.y).multiplyScalar(shade);sidePositions.push((p.x-CX)/S,(CY-p.y)/S,z/S);sideColors.push(color.r,color.g,color.b);}
      for(let i=0;i<contour.length-1;i++){
        const a=contour[i],b=contour[i+1];
        const topA=height(a.shoulder.x,a.shoulder.y),topB=height(b.shoulder.x,b.shoulder.y);
        const wallA=height(a.wall.x,a.wall.y)-9,wallB=height(b.wall.x,b.wall.y)-9;
        const back=layer.z-layer.depth;
        // The rounded shoulder catches the key light before the deeper side wall.
        sideVertex(a.shoulder,topA,1.16);sideVertex(b.shoulder,topB,1.16);sideVertex(a.wall,wallA,1.03);
        sideVertex(b.shoulder,topB,1.16);sideVertex(b.wall,wallB,1.03);sideVertex(a.wall,wallA,1.03);
        sideVertex(a.wall,wallA);sideVertex(b.wall,wallB);sideVertex(a.wall,back,.83);
        sideVertex(b.wall,wallB);sideVertex(b.wall,back,.83);sideVertex(a.wall,back,.83);
      }
      const edgeGeometry=new THREE.BufferGeometry();edgeGeometry.setAttribute('position',new THREE.Float32BufferAttribute(sidePositions,3));edgeGeometry.setAttribute('color',new THREE.Float32BufferAttribute(sideColors,3));edgeGeometry.computeVertexNormals();
      const edgeMaterial=new THREE.MeshPhysicalMaterial({vertexColors:true,side:THREE.DoubleSide,roughness:.27,metalness:.18,clearcoat:.65,clearcoatRoughness:.2});
      const edge=new THREE.Mesh(edgeGeometry,edgeMaterial);logo.add(edge);materials.push(edgeMaterial);geometries.push(edgeGeometry);
    }
  }
  layers.forEach(addLayer);
  // Each highlight follows a fold already visible in the supplied reference.
  const lightTrails=[];
  const lightVertex='attribute float aArc;attribute float aSide;varying float vArc;varying float vSide;void main(){vArc=aArc;vSide=aSide;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
  const lightFragment=[
    'uniform float uTime;uniform float uStrength;uniform float uOffset;uniform vec3 uTint;varying float vArc;varying float vSide;',
    'void main(){',
    'float head=fract(uTime/3.6+uOffset)*1.28-.12;',
    'float behind=head-vArc;',
    'float tip=exp(-pow(behind/.017,2.0));',
    'float tail=smoothstep(-.01,.012,behind)*exp(-max(behind,0.0)/.095);',
    'float core=exp(-pow(vSide/.14,2.0));',
    'float rim=exp(-pow(vSide/.25,2.0));',
    'float halo=exp(-pow(vSide/.72,2.0));',
    'float energy=(tip*1.5+tail*.86)*uStrength;',
    'float alpha=clamp(energy*(core*.86+rim*.28+halo*.055),0.0,.97);',
    'alpha*=smoothstep(0.0,.012,vArc)*(1.0-smoothstep(.988,1.0,vArc));',
    'vec3 color=mix(uTint,vec3(1.0),clamp(core*.96+tip*rim*.3,0.0,1.0));',
    'if(alpha<.003)discard;',
    'gl_FragColor=vec4(color,alpha);',
    '#include <colorspace_fragment>',
    '}'
  ].join('\n');
  const flareFragment=[
    'uniform float uStrength;uniform vec3 uTint;varying vec2 vUv;',
    'void main(){vec2 p=(vUv-.5)*2.0;float r=dot(p,p);',
    'float center=exp(-r*75.0);float halo=exp(-r*9.0);',
    'float rays=exp(-pow(p.x/.035,2.0))*exp(-abs(p.y)*6.0)+exp(-pow(p.y/.05,2.0))*exp(-abs(p.x)*6.0);',
    'float alpha=clamp((center+rays*.15+halo*.11)*uStrength,0.0,.94);',
    'if(alpha<.004)discard;',
    'gl_FragColor=vec4(mix(uTint,vec3(1.0),clamp(center+rays*.8,0.0,1.0)),alpha);',
    '#include <colorspace_fragment>',
    '}'
  ].join('\n');
  function foldTrail(layerIndex,offset,color,segments){
    const curve=new THREE.CurvePath();
    for(const points of segments)curve.add(new THREE.CubicBezierCurve3(...points.map(p=>new THREE.Vector3(p[0],p[1],0))));
    const layer=layers[layerIndex],height=(x,y)=>(layer.z+layer.relief(x,y)+2.4)/S;
    const positions=[],arcs=[],sides=[],index=[],n=320;
    for(let i=0;i<=n;i++){
      const t=i/n,p=curve.getPointAt(t),tangent=curve.getTangentAt(t),normal=new THREE.Vector2(-tangent.y,tangent.x).normalize();
      for(const sign of [-1,1]){
        const x=p.x+normal.x*sign*7,y=p.y+normal.y*sign*7;
        positions.push((x-CX)/S,(CY-y)/S,height(x,y));arcs.push(t);sides.push(sign);
      }
      if(i<n){const a=i*2;index.push(a,a+1,a+2,a+1,a+3,a+2);}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('aArc',new THREE.Float32BufferAttribute(arcs,1));geometry.setAttribute('aSide',new THREE.Float32BufferAttribute(sides,1));geometry.setIndex(index);
    const tint=new THREE.Color(color);
    const material=new THREE.ShaderMaterial({uniforms:{...globalUniforms,uOffset:{value:offset},uTint:{value:tint}},vertexShader:lightVertex,fragmentShader:lightFragment,transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
    const mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=8;logo.add(mesh);materials.push(material);geometries.push(geometry);
    const flareGeometry=new THREE.PlaneGeometry(29/S,29/S);
    const flareMaterial=new THREE.ShaderMaterial({uniforms:{uStrength:globalUniforms.uStrength,uTint:{value:tint}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:flareFragment,transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide});
    const flare=new THREE.Mesh(flareGeometry,flareMaterial);flare.renderOrder=9;logo.add(flare);materials.push(flareMaterial);geometries.push(flareGeometry);
    lightTrails.push({curve,height,offset,flare});
  }
  foldTrail(2,0,'#40baff',[
    [[368,312],[378,324],[374,357],[374,381]],
    [[374,381],[374,435],[248,558],[248,609]],
    [[248,609],[247,653],[278,677],[326,677]],
    [[326,677],[386,677],[472,677],[510,677]],
    [[510,677],[536,677],[535,701],[533,719]],
    [[533,719],[529,753],[507,770],[474,770]]
  ]);
  foldTrail(3,.32,'#48e5ef',[
    [[552,465],[548,420],[589,383],[638,384]],
    [[638,384],[679,382],[710,403],[710,447]],
    [[710,447],[710,536],[710,663],[710,747]],
    [[710,747],[710,818],[678,857],[627,869]],
    [[627,869],[585,879],[546,866],[520,844]],
    [[520,844],[502,829],[491,807],[494,789]]
  ]);
  foldTrail(5,.64,'#69edbc',[
    [[712,569],[710,622],[737,663],[790,663]],
    [[790,663],[842,663],[887,644],[930,644]],
    [[930,644],[1004,640],[1065,684],[1069,746]]
  ]);

  const backgroundGeometry=new THREE.PlaneGeometry(W/S,H/S);
  // Soft grounding shadows remain continuous when the relief tilts.
  const backgroundCanvas=document.createElement('canvas');backgroundCanvas.width=W;backgroundCanvas.height=H;
  const backgroundCtx=backgroundCanvas.getContext('2d');
  function groundGlow(x,y,rx,ry,color){
    backgroundCtx.save();backgroundCtx.translate(x,y);backgroundCtx.scale(rx,ry);
    const gradient=backgroundCtx.createRadialGradient(0,0,0,0,0,1);
    gradient.addColorStop(0,'rgba('+color+',.25)');gradient.addColorStop(.25,'rgba('+color+',.19)');gradient.addColorStop(.55,'rgba('+color+',.075)');gradient.addColorStop(1,'rgba('+color+',0)');
    backgroundCtx.fillStyle=gradient;backgroundCtx.fillRect(-1,-1,2,2);backgroundCtx.restore();
  }
  groundGlow(544,944,334,143,'21,136,247');groundGlow(781,938,276,137,'36,223,176');
  const backgroundTexture=new THREE.CanvasTexture(backgroundCanvas);backgroundTexture.colorSpace=THREE.SRGBColorSpace;
  const backgroundMaterial=new THREE.MeshBasicMaterial({map:backgroundTexture,transparent:true,depthWrite:false});
  backgroundMaterial.opacity=.72;
  const background=new THREE.Mesh(backgroundGeometry,backgroundMaterial);background.position.set(0,(CY-H/2)/S,-.7);scene.add(background);

  return {
    resize(width, height) {
      const aspect=width/height,artWidth=Math.max(1000,820*aspect);
      renderer.setSize(width,height,false);
      camera.left=-artWidth/(2*S);camera.right=artWidth/(2*S);
      camera.top=artWidth/aspect/(2*S);camera.bottom=-camera.top;
      camera.updateProjectionMatrix();
    },
    render(time, yaw=0, pitch=0) {
      // Orientation comes only from the entrance gesture or the pointer.
      // Time continues to drive the surface highlights, without moving the mark.
      logo.rotation.set(pitch,yaw,0);
      globalUniforms.uTime.value=time;
      globalUniforms.uAngle.value=Math.abs(logo.rotation.x)+Math.abs(logo.rotation.y);
      for(const trail of lightTrails){
        const at=((time/3.6+trail.offset)%1)*1.28-.12;
        trail.flare.visible=at>=0&&at<=1;
        if(trail.flare.visible){
          const p=trail.curve.getPointAt(at);
          trail.flare.position.set((p.x-CX)/S,(CY-p.y)/S,trail.height(p.x,p.y)+.022);
        }
      }
      renderer.render(scene,camera);
    },
    dispose() {
      materials.forEach(material=>material.dispose());
      geometries.forEach(geometry=>geometry.dispose());
      backgroundGeometry.dispose();backgroundMaterial.dispose();
      backgroundTexture.dispose();texture.dispose();renderer.dispose();
    }
  };
}
