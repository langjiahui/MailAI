const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const src = fs.readFileSync('app/web/static/workspace.js', 'utf8');
const timers = [];
const listeners = {};
const classes = new Set(['hidden']);
const host = {
  classList: {
    add(...names) { names.forEach(name => classes.add(name)); },
    remove(...names) { names.forEach(name => classes.delete(name)); },
  },
  replaceChildren() {},
  append() {},
};
const document = {
  getElementById(id) { assert.equal(id, 'workspace-notice'); return host; },
  createElement() { return {setAttribute(){}, textContent:'', onclick:null}; },
  addEventListener(name, callback) { listeners[name] = callback; },
};
const context = vm.createContext({
  console, Date, document,
  window:{matchMedia(){return null;}}, localStorage:{getItem(){return null;}},
  setTimeout(callback, delay) { timers.push({callback, delay}); return timers.length; },
  clearTimeout() {}, api:async()=>({failed:[]}), loadData:async()=>{},
});
const end = src.indexOf('\nfunction showOperationFailures');
vm.runInContext(src.slice(0, end), context);
context.offerUndo(['token-1'], 'account-1');
assert.equal(classes.has('hidden'), false, 'Undo notice should appear immediately');
assert.ok(timers.some(timer => timer.delay === 6500), 'Undo notice should schedule a short visible period');
timers.find(timer => timer.delay === 6500).callback();
assert.equal(classes.has('is-fading'), true, 'Undo notice should fade before being hidden');
assert.ok(timers.some(timer => timer.delay === 360), 'Fade should finish by removing the notice');
let prevented = false;
listeners.keydown({
  target:{matches(){return false;}, closest(){return null;}}, metaKey:true, ctrlKey:false,
  shiftKey:false, key:'z', preventDefault(){prevented = true;},
});
assert.equal(prevented, true, 'Command-Z should remain available after the notice starts fading');
console.log('Transient undo notice and retained keyboard undo passed');
