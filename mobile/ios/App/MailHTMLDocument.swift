import Foundation

/// Adapt authored mail without enabling JavaScript supplied by the sender.
enum MailHTMLDocument {
    static let darkBackground = "#172330"
    static let darkForeground = "#eaf1f8"

    static func render(_ html: String, fontSize: Double = 17, dark: Bool = false) -> String {
        let size = fontSize.isFinite && fontSize > 0 ? fontSize : 17
        // This policy precedes untrusted markup; later policies cannot relax it.
        let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'"
        return """
        <!doctype html><html data-mailai-dark='\(dark)'><head><meta http-equiv='Content-Security-Policy' content="\(csp)"><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='color-scheme' content='\(dark ? "dark" : "light")'><style>
        html{color-scheme:only \(dark ? "dark" : "light");background-color:\(dark ? darkBackground : "#ffffff");color:\(dark ? darkForeground : "#000000")}
        body{font:\(size)px -apple-system;line-height:1.6;margin:0;padding:12px;box-sizing:border-box;overflow-wrap:anywhere}
        img{max-width:100%;height:auto}table{max-width:100%}
        </style></head><body>\(html)</body></html>
        """
    }

    // Runs in WebKit's isolated client world. Snapshot computed styles before
    // changing ancestors, so inherited legacy colors are not transformed twice.
    // Foreground contrast is checked against each adapted, composited background;
    // images are never inverted and chromatic emphasis retains its hue.
    static let appearanceScript = #"""
    (() => {
      if (document.documentElement.dataset.mailaiDark !== 'true' || !document.body) return;
      const surface = [23,35,48,1], ink = [234,241,248,1], muted = [160,176,192,1];
      const cache = new Map(), context = document.createElement('canvas').getContext('2d', {willReadFrequently:true});
      const parse = value => {
        if (cache.has(value)) return cache.get(value);
        const numbers = value.match(/^rgba?\(([^)]+)\)$/);
        let result;
        if (numbers) {
          const parts = numbers[1].split(/[,\s/]+/).filter(Boolean).map(Number);
          result = [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
        } else if (value === 'transparent') result = [0,0,0,0];
        else {
          context.clearRect(0,0,1,1); context.fillStyle = value; context.fillRect(0,0,1,1);
          const data = context.getImageData(0,0,1,1).data;
          result = [data[0],data[1],data[2],data[3]/255];
        }
        cache.set(value,result); return result;
      };
      const css = c => `rgba(${c.slice(0,3).map(Math.round).join(',')},${c[3]})`;
      const mix = (a,b,t) => a.map((v,i) => i === 3 ? 1 : v*(1-t)+b[i]*t);
      const composite = (a,b) => a.map((v,i) => i === 3 ? 1 : v*a[3]+b[i]*(1-a[3]));
      const luminance = c => c.slice(0,3).map(v => {v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
      const contrast = (a,b) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
      const neutral = c => Math.max(...c.slice(0,3))-Math.min(...c.slice(0,3)) < 24;
      // Leave headroom for rounding to CSS's 8-bit channels.
      const readable = (color,background,minimum=4.6) => {
        const opaque = composite(color,background);
        if (contrast(opaque,background) >= minimum) return opaque;
        let low=0,high=1;
        for(let i=0;i<12;i++){const t=(low+high)/2;if(contrast(mix(opaque,[255,255,255,1],t),background)>=minimum)high=t;else low=t;}
        return mix(opaque,[255,255,255,1],high);
      };
      const darken = color => {
        if (neutral(color) && luminance(color) > .2) return [...surface.slice(0,3),color[3]];
        if (luminance(color) <= .065) return color;
        let low=0,high=1;
        for(let i=0;i<12;i++){const t=(low+high)/2;if(luminance(mix(color,[0,0,0,1],t))>.065)low=t;else high=t;}
        return [...mix(color,[0,0,0,1],high).slice(0,3),color[3]];
      };
      const borders = ['top','right','bottom','left'];
      const records = [document.body,...document.body.querySelectorAll('*')].filter(e => e instanceof HTMLElement && !['SCRIPT','STYLE','LINK','META','IMG','PICTURE','SOURCE','CANVAS'].includes(e.tagName)).map(element => {
        const s=getComputedStyle(element);
        return {element, color:parse(s.color), fill:parse(s.webkitTextFillColor || s.color), background:parse(s.backgroundColor), image:s.backgroundImage,
          borders:borders.map(side=>({side,width:parseFloat(s.getPropertyValue(`border-${side}-width`)),color:parse(s.getPropertyValue(`border-${side}-color`))}))};
      });
      const backgrounds = new Map();
      document.documentElement.style.setProperty('background-color',css(surface),'important');
      document.documentElement.style.setProperty('color',css(ink),'important');
      document.documentElement.style.setProperty('color-scheme','only dark','important');
      for(const record of records){
        const {element}=record;
        const set=(property,value)=>element.style.setProperty(property,value,'important');
        const parent=backgrounds.get(element.parentElement)||surface;
        let background=element===document.body?surface:darken(record.background);
        if(record.image!=='none'){
          // Dim decorative background images/gradients; embedded <img> is untouched.
          background=surface;set('background-blend-mode','multiply');
        }
        if(background[3]>0)set('background-color',css(background));
        const effective=composite(background,parent);backgrounds.set(element,effective);
        const foreground=source=>{
          if(source[3]===0)return source;
          let color=source;
          if(neutral(source)&&contrast(composite(source,effective),effective)<4.5)color=luminance(source)>.08?muted:ink;
          if(element.closest('a')&&(neutral(source)||source[2]>source[0]*1.3))color=[114,184,245,1];
          return readable(color,effective);
        };
        set('color',css(foreground(record.color)));
        set('-webkit-text-fill-color',css(foreground(record.fill)));
        set('text-shadow','none');
        for(const border of record.borders){
          if(border.width>0&&border.color[3]>0)set(`border-${border.side}-color`,css(readable(neutral(border.color)?[59,74,89,1]:border.color,effective,1.6)));
        }
      }
      document.documentElement.dataset.mailaiAppearance='dark';
    })();
    """#
}
