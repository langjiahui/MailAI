const assert=require('node:assert/strict');
// Synthetic cards exercise missing content without editing stored messages.
async function auditMailCardEdges(page) {
 const viewport=page.viewportSize();
 const saved=await page.evaluate(()=>({language:currentI18nLanguage(),theme:document.documentElement.dataset.theme,reward:document.documentElement.dataset.rewardTheme,avatars:document.body.dataset.mailListAvatars,density:document.body.dataset.density,zoom:document.body.style.zoom,fz:document.documentElement.style.getPropertyValue('--fz')}));
 let checked=0;
 try {
  for(const language of ['zh-CN','en'])for(const mode of ['light','dark'])for(const reward of ['','theme_monochrome','theme_baowu'])for(const width of [1440,390])for(const scale of [1,1.5])for(const avatars of ['true','false'])for(const density of ['comfortable','compact']) {
   await page.setViewportSize({width,height:1000});
   await page.evaluate(({language,mode,reward,scale,avatars,density})=>{setI18nLanguage(language);applyTheme(mode);reward?document.documentElement.dataset.rewardTheme=reward:delete document.documentElement.dataset.rewardTheme;document.body.dataset.mailListAvatars=avatars;document.body.dataset.density=density;document.body.style.zoom=String(scale);document.documentElement.style.setProperty('--fz',scale);},{language,mode,reward,scale,avatars,density});
   const issues=await page.locator('#email-list').evaluate(list=>{
    const problems=[],host=document.createElement('div'),search=currentFilter.search,placeholder=mailaiText('（无主题）');
    const cases=[];
    for(const kind of ['received','sent','draft'])for(const subject of ['',null,undefined,' \t\n\u3000'])cases.push({kind,subject,summary:'Preview starts here',snippet:''});
    cases.push({kind:'sent',subject:'A long subject '.repeat(30),summary:'Preview starts here'}, {kind:'received',subject:'<img src=x onerror=alert(1)>',summary:'Preview starts here'}, {kind:'draft',subject:'',summary:' \n ',snippet:'Fallback snippet'}, {kind:'received',subject:'',summary:null,snippet:'Fallback snippet'}, {kind:'sent',subject:'',summary:'',snippet:''}, {kind:'received',subject:'',summary:'',search_match:{field:'body_text',text:'A needle in the message',highlight:'needle'}});
    try {
     list.prepend(host);
     for(const [index,item]of cases.entries()){
      currentFilter.search=item.search_match?'needle':'';
      const mail={...allEmails[0],id:99001,...item,direction:item.kind==='received'?'incoming':'outgoing',_kind:item.kind==='received'?undefined:item.kind};
      host.innerHTML=renderEmailItem(mail);const row=host.querySelector('.email-item'),title=row.querySelector('.email-subject'),preview=row.querySelector('.email-preview'),avatar=row.querySelector('.mail-sender-avatar');
      const bounds=row.getBoundingClientRect(),a=avatar.getBoundingClientRect(),t=title.getBoundingClientRect(),p=preview.getBoundingClientRect();
      if(title.textContent!==(String(item.subject??'').trim()||placeholder)||t.height<=0)problems.push({index,reason:'missing subject'});
      if(host.querySelector('img'))problems.push({index,reason:'subject became markup'});
      if(a.width>0&&(a.right>t.left-1||p.height>0&&p.top<a.bottom-1))problems.push({index,reason:'avatar overlap',avatar:a.toJSON(),title:t.toJSON(),preview:p.toJSON()});
      const tags=row.querySelector('.email-tags').getBoundingClientRect();if(a.width>0&&tags.height>0&&tags.top<a.bottom-1)problems.push({index,reason:'tags overlap avatar'});
      if(t.right>bounds.right+1||row.scrollWidth>row.clientWidth+1)problems.push({index,reason:'row overflow'});
      const expected=(String(item.summary??'').trim()||String(item.snippet??'').trim()).slice(0,120);
      if(item.search_match?!preview.textContent.includes('needle')||!preview.querySelector('mark'):preview.textContent!==expected)problems.push({index,reason:'missing preview fallback or search highlight'});
     }
    }finally{currentFilter.search=search;host.remove();}
    return problems;
   });
   assert.deepEqual(issues,[],JSON.stringify({language,mode,reward,width,scale,avatars,density}));checked++;
  }
 }finally{
  await page.setViewportSize(viewport);
  await page.evaluate(s=>{setI18nLanguage(s.language);applyTheme(s.theme);s.reward?document.documentElement.dataset.rewardTheme=s.reward:delete document.documentElement.dataset.rewardTheme;document.body.dataset.mailListAvatars=s.avatars;document.body.dataset.density=s.density;document.body.style.zoom=s.zoom;s.fz?document.documentElement.style.setProperty('--fz',s.fz):document.documentElement.style.removeProperty('--fz');},saved);
 }
 console.log(`PASS card edge cases: ${checked} language/theme/window/scale/avatar/density combinations, received/sent/draft, empty and whitespace subjects, long and escaped titles, missing previews and search highlights`);
}
module.exports={auditMailCardEdges};
