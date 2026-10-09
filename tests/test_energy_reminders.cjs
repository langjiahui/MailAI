const i18nContext = require('./helpers/i18n.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
let now=0,items=[],callback,next,initial,notices=0,fetches=0,visible=true;
const events={},seen=new Map(),window={mailaiEnergy:{active:()=>visible,register:(name,fn)=>callback=fn,
  reschedule:(name,delay)=>next=delay,run:()=>visible?callback():undefined},addEventListener:(name,fn)=>events[name]=fn};
const context=vm.createContext(i18nContext({window,Date:Object.assign(class extends Date {},{now:()=>now}),
 activeMailAccount:()=>({id:'a'}),initialLoad:{then:fn=>initial=fn},
 api:async()=>{fetches++;return items},sessionStorage:{getItem:k=>seen.get(k),setItem:(k,v)=>seen.set(k,v)},
 taskNotice:()=>notices++}));
vm.runInContext(fs.readFileSync('app/web/static/energy-reminders.js','utf8'),context);
(async()=>{
 items=[{account_id:'a',todo_id:1,email_id:5,at:new Date(5000).toISOString()}];
 await initial();assert.equal(next,5000);assert.equal(notices,0);
 now=5000;await callback();assert.equal(notices,1,'Due notices work without opening the task panel');
 await callback();assert.equal(notices,1,'A submitted in-app notice is not duplicated');
 items=[];events['mailai-tasks-changed']();await Promise.resolve();assert.equal(next,60000);
 const readers=[];context.api=()=>new Promise(resolve=>readers.push(resolve));
 const pending=callback();events['mailai-tasks-changed']();
 readers[0]([{account_id:'a',todo_id:2,at:new Date(0).toISOString()}]);
 await pending;assert.equal(notices,1,'An outdated response cannot revive an edited task');
 readers[1]([]);await Promise.resolve();await Promise.resolve();
 const late=callback();visible=false;
 readers[2]([{account_id:'a',todo_id:3,at:new Date(0).toISOString()}]);
 await late;assert.equal(notices,1,'Hidden windows must not consume unseen alerts');
 visible=true;context.api=async()=>[{account_id:'a',todo_id:3,at:new Date(0).toISOString()}];
 await callback();assert.equal(notices,2,'The alert is still available when the window returns');
 console.log('PASS energy reminders: deadline scheduling, closed-panel delivery, deduplication and task changes');
})().catch(e=>{console.error(e);process.exitCode=1;});
