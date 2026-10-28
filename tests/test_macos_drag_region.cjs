// Exercise the actual titlebar synchronizer with delayed/rejected bridge replies.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/web/static/macos-window.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(method) {
  const frames = new Map(), timers = new Map(), handlers = {}, observed = [], calls = [];
  let serial = 0, searchRight = 600;
  const brand = {getBoundingClientRect: () => ({left:116, right:240, width:124})};
  const search = {getBoundingClientRect: () => ({left:250, right:searchRight, width:searchRight-250, height:32})};
  const button = {getBoundingClientRect: () => ({left:1000, right:1100, width:100, height:32})};
  const header = {querySelectorAll: selector => selector.startsWith('.brand') ? [brand, search, button] : [search, button]};
  const api = method ? {set_window_drag_region: async (...args) => {calls.push(args); return method(...args);}} : {};
  const context = {
    document: {documentElement:{classList:{contains:name => name==='macos-native-window'}, matches:()=>true}, body:{},
      querySelector:selector => selector==='.topbar' ? header : selector==='.topbar .brand' ? brand : null,
      getElementById:()=>null, addEventListener:()=>{}},
    window: {pywebview:{api}, addEventListener:(name, fn)=>handlers[name]=fn}, innerWidth:1200,
    requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;}, cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,delay});return id;}, clearTimeout:id=>timers.delete(id),
    ResizeObserver:class {observe(node){observed.push(node);}}, MutationObserver:class {observe(){}},
  };
  vm.runInNewContext(source, context);
  return {calls, timers, handlers, observed, api,
    move:right=>{searchRight=right;handlers.resize();},
    frame:async()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());await tick();},
    retry:async()=>{assert.equal(timers.size,1);const [id,timer]=[...timers][0];timers.delete(id);timer.fn();await tick();},
  };
}
(async () => {
  for (const failure of [()=>({ok:false}), ()=>{throw Error('bridge unavailable');}, ()=>undefined]) {
    let attempts=0;
    const f=fixture(()=>++attempts===1 ? failure() : {ok:true});
    await f.frame();assert.equal(f.calls.length,1);
    assert.equal([...f.timers.values()][0].delay,150);
    await f.retry();await f.frame();assert.equal(f.calls.length,2,'Failures retry without a resize');
    f.handlers.resize();await f.frame();assert.equal(f.calls.length,2,'Only acknowledged geometry is cached');
    assert.equal(f.timers.size,0);
  }
  const rejected=fixture(()=>({ok:false}));await rejected.frame();
  for (const delay of [150,500,1500]) {
    assert.equal([...rejected.timers.values()][0].delay,delay);
    await rejected.retry();await rejected.frame();
  }
  assert.equal(rejected.calls.length,4);assert.equal(rejected.timers.size,0,'Persistent failure has bounded retries');
  rejected.handlers.focus();await rejected.frame();assert.equal(rejected.calls.length,5,'Focus can recover after exhausting retries');

  const changing=fixture(()=>({ok:changing.calls.length>1}));await changing.frame();
  changing.move(720);await changing.frame();assert.equal(changing.timers.size,0);
  assert.equal(changing.calls.at(-1)[3][1][0],720,'A retry must never resend stale layout');

  let release;
  const racing=fixture(()=>new Promise(resolve=>{release=resolve;}));await racing.frame();
  racing.move(700);await racing.frame();racing.move(600);await racing.frame();
  assert.equal(racing.calls.length,1,'Only one native call runs at a time');
  release({ok:true});await tick();
  assert.equal(racing.calls.length,2,'Returning to the original geometry still corrects an in-flight update');
  assert.equal(racing.calls[1][3][1][0],600,'Superseded queued geometry is discarded');
  release({ok:true});await tick();racing.handlers.resize();await racing.frame();assert.equal(racing.calls.length,2);

  const ready=fixture();await ready.frame();
  ready.api.set_window_drag_region=async(...args)=>{ready.calls.push(args);return {ok:true};};
  ready.handlers.pywebviewready();await ready.frame();
  assert.equal(ready.calls.length,1,'Geometry readiness does not depend on the theme API');
  assert.equal(ready.observed.length,4,'Observe header contents as well as its fixed outer box');
  assert.deepEqual(Array.from(ready.calls[0][3], pair=>Array.from(pair)),[[108,250],[600,1000],[1100,1200]],'Controls stay outside the drag regions');
  console.log('macOS titlebar: rejected/throwing replies, bounded recovery, latest geometry, bridge readiness and control exclusions passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
