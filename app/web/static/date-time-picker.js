/* Shared local date/time UI. Original inputs retain values, constraints, form
 * validation and existing callers; the OS picker is never opened. */
(() => {
  const selector='input[type="date"],input[type="datetime-local"],input[type="time"]';
  const controls=new WeakMap();
  const valueProperty=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
  let serial=0,active=null;
  const pad=n=>String(n).padStart(2,'0');
  const dateValue=d=>`${String(d.getFullYear()).padStart(4,'0')}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const timeValue=d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const effectiveZoom=node=>{
    let zoom=1;
    for(let parent=node;parent;parent=parent.parentElement) zoom*=parseFloat(getComputedStyle(parent).zoom)||1;
    return zoom;
  };
  const english=()=>document.documentElement.lang.startsWith('en');
  const t=key=>mailaiT(`datetime.${key}`) || MAILAI_UI_COPY[`datetime.${key}`][0];
  const localDate=value=>{
    const match=/^(\d{4,})-(\d{2})-(\d{2})/.exec(value||'');
    if (!match) return null;
    const d=new Date(0);d.setHours(0,0,0,0);d.setFullYear(+match[1],+match[2]-1,+match[3]);return d;
  };
  function button(label,cls,handler) {
    const node=document.createElement('button');node.type='button';node.className=cls;
    // Pickers live inside labels. Keep native label activation from forwarding
    // a second click/focus to the hidden date input after opening the panel.
    node.textContent=label;node.addEventListener('click',event=>{event.preventDefault();handler(event);});return node;
  }
  function enhance(input) {
    if (controls.has(input) || input.hidden || input.classList.contains('hidden')) return;
    const kind=input.type,hasDate=kind!=='time',hasTime=kind!=='date';
    const wrapper=document.createElement('span');wrapper.className='datetime-control';
    input.before(wrapper);wrapper.append(input);input.classList.add('datetime-source');
    const originalTabindex=input.getAttribute('tabindex');input.tabIndex=-1;input.setAttribute('aria-hidden','true');
    const trigger=button('','datetime-trigger',()=>opened?close(true):open());
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    icon.setAttribute('viewBox','0 0 20 20');icon.setAttribute('aria-hidden','true');
    icon.innerHTML=hasDate?'<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M6 2v4m8-4v4M3 8h14m-10 3h2m2 0h2m-6 3h2"/>':'<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>';
    const display=document.createElement('span');trigger.append(display,icon);
    const panel=document.createElement('div');panel.className='datetime-panel';panel.id=`datetime-panel-${++serial}`;
    // Outside clicks and Escape are handled here, including embedded WebKit.
    // Native auto-dismiss must not race the opening click in the host label.
    panel.setAttribute('popover','manual');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');
    trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');
    wrapper.append(trigger,panel);
    let opened=false,nativePopover=false,draftDate='',view=new Date();
    const title=document.createElement('strong');title.id=`${panel.id}-title`;
    panel.setAttribute('aria-labelledby',title.id);
    const head=document.createElement('div');head.className='datetime-heading';
    const dismiss=button('×','datetime-dismiss',()=>close(true));head.append(title,dismiss);panel.append(head);
    const shortcuts=document.createElement('div');shortcuts.className='datetime-shortcuts';panel.append(shortcuts);
    let calendar,month,year,hour,minute;
    if (hasDate) {
      const nav=document.createElement('div');nav.className='datetime-navigation';
      const prev=button('‹','datetime-month-step',()=>moveMonth(-1));
      const next=button('›','datetime-month-step',()=>moveMonth(1));
      month=document.createElement('select');year=document.createElement('select');
      prev.dataset.direction='previous';next.dataset.direction='next';
      nav.append(prev,month,year,next);panel.append(nav);
      month.addEventListener('change',()=>{view.setMonth(+month.value);renderCalendar();});
      year.addEventListener('change',()=>{view.setFullYear(+year.value);renderCalendar();});
      const weekdays=document.createElement('div');weekdays.className='datetime-weekdays';
      panel.append(weekdays);
      calendar=document.createElement('div');calendar.className='datetime-calendar';calendar.setAttribute('role','group');panel.append(calendar);
      calendar.addEventListener('keydown',event=>{
        const cell=event.target.closest('[data-date]');if (!cell) return;
        const offsets={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
        const d=localDate(cell.dataset.date);
        if (event.key in offsets) d.setDate(d.getDate()+offsets[event.key]);
        else if (event.key==='Home') d.setDate(d.getDate()-(d.getDay()+6)%7);
        else if (event.key==='End') d.setDate(d.getDate()+6-(d.getDay()+6)%7);
        else if (event.key==='PageUp' || event.key==='PageDown') {
          const day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+(event.key==='PageUp'?-1:1));
          d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));
        } else return;
        event.preventDefault();const target=dateValue(d);if (!allowedDate(target)) return;
        view=new Date(d.getFullYear(),d.getMonth(),1);renderCalendar(target);
        calendar.querySelector(`[data-date="${target}"]`)?.focus();
      });
    }
    if (hasTime) {
      const row=document.createElement('div');row.className='datetime-time';
      for (const part of ['hour','minute']) {
        const label=document.createElement('label'),caption=document.createElement('span'),field=document.createElement('input');
        caption.dataset.timePart=part;field.type='number';field.min='0';field.max=part==='hour'?'23':'59';
        field.step='1';field.inputMode='numeric';field.className=`datetime-${part}`;field.disabled=true;
        field.addEventListener('input',validate);field.addEventListener('focus',()=>field.select());
        field.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();commit();}});
        label.append(caption,field);row.append(label);if (part==='hour') hour=field;else minute=field;
      }
      const hint=document.createElement('small');hint.className='datetime-local-hint';row.append(hint);panel.append(row);
    }
    const status=document.createElement('p');status.className='datetime-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');panel.append(status);
    const footer=document.createElement('div');footer.className='datetime-footer';
    const clear=button('','datetime-clear',()=>{input.value='';emit();close(true);});
    const cancel=button('','datetime-cancel',()=>close(true));
    const apply=button('','datetime-apply',commit);footer.append(clear,cancel,apply);panel.append(footer);
    function labelText() {
      const label=input.labels?.[0]?.cloneNode(true);
      label?.querySelectorAll('.datetime-control,input,select,button').forEach(node=>node.remove());
      return input.getAttribute('aria-label') || label?.textContent?.trim() || t(hasDate?'chooseDate':'chooseTime');
    }
    function sync() {
      display.textContent=input.value?input.value.replace('T','  ').replaceAll('-',' / '):t(hasTime?(hasDate?'chooseDateTime':'chooseTime'):'chooseDate');
      trigger.classList.toggle('is-empty',!input.value);trigger.disabled=input.disabled || input.readOnly;
      wrapper.hidden=input.hidden;
      trigger.setAttribute('aria-label',`${labelText()}${input.value?`: ${input.value.replace('T',' ')}`:''}`);
      trigger.setAttribute('aria-required',String(input.required));
      if (originalTabindex!==null) trigger.tabIndex=+originalTabindex;
      if (opened && trigger.disabled) close(false);
    }
    function emit() {input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));sync();}
    function allowedDate(value) {
      return (!input.min || value>=input.min.slice(0,10)) && (!input.max || value<=input.max.slice(0,10));
    }
    function clampDate(value) {
      if(input.min && value<input.min.slice(0,10)) return input.min.slice(0,10);
      if(input.max && value>input.max.slice(0,10)) return input.max.slice(0,10);
      return value;
    }
    function candidate() {
      if (hasTime && (hour.value==='' || minute.value==='' || !hour.validity.valid || !minute.validity.valid)) return '';
      const time=hasTime?`${pad(+hour.value)}:${pad(+minute.value)}`:'';
      return kind==='time'?time:kind==='date'?draftDate:draftDate?`${draftDate}T${time}`:'';
    }
    function validate() {
      const value=candidate(),probe=document.createElement('input');probe.type=kind;probe.required=true;
      for (const attr of ['min','max','step']) if(input.hasAttribute(attr)) probe.setAttribute(attr,input.getAttribute(attr));
      probe.value=value;
      apply.disabled=!value || !probe.validity.valid;
      status.textContent=!value?t(hasTime?(hasDate?'invalidDateTime':'invalidTime'):'invalidDate'):!probe.validity.valid?
        t('rangeError'):
        value.replace('T','  ');
      return !apply.disabled;
    }
    function commit() {
      if (!validate()) return;
      input.value=candidate();emit();close(true);
    }
    function moveMonth(amount) {view.setMonth(view.getMonth()+amount);renderCalendar();}
    function renderCalendar(focusDate) {
      const bounded=localDate(clampDate(dateValue(view)));
      if(bounded)view=new Date(bounded.getFullYear(),bounded.getMonth(),1);
      month.value=String(view.getMonth());year.value=String(view.getFullYear());calendar.replaceChildren();
      const first=new Date(view.getFullYear(),view.getMonth(),1),start=new Date(first);
      start.setDate(1-(first.getDay()+6)%7);const today=dateValue(new Date());
      let focus=focusDate || draftDate || today;
      if (localDate(focus)?.getMonth()!==view.getMonth() || localDate(focus)?.getFullYear()!==view.getFullYear()) focus=dateValue(first);
      const days=[];
      for(let i=0;i<42;i++) {
        const day=new Date(start);day.setDate(start.getDate()+i);const value=dateValue(day);
        const cell=button(String(day.getDate()),'datetime-day',()=>{
          draftDate=value;view=new Date(day.getFullYear(),day.getMonth(),1);renderCalendar(value);validate();
          calendar.querySelector(`[data-date="${value}"]`)?.focus();
        });
        cell.dataset.date=value;cell.disabled=!allowedDate(value);cell.tabIndex=-1;
        cell.classList.toggle('is-outside',day.getMonth()!==view.getMonth());
        cell.classList.toggle('is-today',value===today);cell.setAttribute('aria-pressed',String(value===draftDate));
        cell.setAttribute('aria-label',new Intl.DateTimeFormat(english()?'en-US':'zh-CN',{dateStyle:'full'}).format(day));
        if (value===today) cell.setAttribute('aria-current','date');
        calendar.append(cell);days.push(cell);
      }
      const target=days.find(cell=>cell.dataset.date===focus && !cell.disabled) || days.find(cell=>!cell.disabled && !cell.classList.contains('is-outside')) || days.find(cell=>!cell.disabled);
      if(target) target.tabIndex=0;
      const prev=panel.querySelector('[data-direction="previous"]'),next=panel.querySelector('[data-direction="next"]');
      prev.disabled=view.getFullYear()<=+year.options[0].value && view.getMonth()===0;
      next.disabled=view.getFullYear()>=+year.options[year.options.length-1].value && view.getMonth()===11;
      if(input.min)prev.disabled ||= dateValue(new Date(view.getFullYear(),view.getMonth(),0))<input.min.slice(0,10);
      if(input.max)next.disabled ||= dateValue(new Date(view.getFullYear(),view.getMonth()+1,1))>input.max.slice(0,10);
      calendar.setAttribute('aria-label',t('calendar'));
    }
    function populate() {
      title.textContent=labelText();dismiss.setAttribute('aria-label',t('close'));
      clear.textContent=t('clear');cancel.textContent=t('cancel');apply.textContent=t('apply');
      clear.hidden=input.required;
      shortcuts.replaceChildren();
      const choices=hasDate?(hasTime?['later','tomorrow','next-week']:['today','tomorrow','next-week']):['now','later'];
      const names={today:'today',now:'now',later:'later',tomorrow:hasTime?'tomorrowTime':'tomorrowDate','next-week':hasTime?'nextWeekTime':'nextWeekDate'};
      for (const key of choices) shortcuts.append(button(t(names[key]),'datetime-shortcut',()=>{
        const d=new Date();d.setSeconds(0,0);
        if(key==='later')d.setMinutes(d.getMinutes()+30);
        if(key==='tomorrow'){d.setDate(d.getDate()+1);if(hasTime)d.setHours(9,0,0,0);}
        if(key==='next-week'){d.setDate(d.getDate()+((8-d.getDay())%7 || 7));if(hasTime)d.setHours(9,0,0,0);}
        draftDate=dateValue(d);if(hasDate){view=new Date(d.getFullYear(),d.getMonth(),1);renderCalendar();}
        if(hasTime){hour.value=pad(d.getHours());minute.value=pad(d.getMinutes());}validate();
      }));
      if(hasDate) {
        const clamped=localDate(clampDate(dateValue(view)));
        if(clamped)view=new Date(clamped.getFullYear(),clamped.getMonth(),1);
        month.replaceChildren();year.replaceChildren();
        for(let i=0;i<12;i++)month.add(new Option(new Intl.DateTimeFormat(english()?'en-US':'zh-CN',{month:'long'}).format(new Date(2024,i,1)),String(i)));
        const min=localDate(input.min)?.getFullYear() || Math.min(1900,view.getFullYear());
        const max=localDate(input.max)?.getFullYear() || Math.max(2100,view.getFullYear());
        for(let i=min;i<=max;i++)year.add(new Option(String(i),String(i)));
        month.setAttribute('aria-label',t('month'));year.setAttribute('aria-label',t('year'));
        panel.querySelector('[data-direction="previous"]').setAttribute('aria-label',t('previousMonth'));
        panel.querySelector('[data-direction="next"]').setAttribute('aria-label',t('nextMonth'));
        panel.querySelector('.datetime-weekdays').replaceChildren(...Array.from({length:7},(_,i)=>{const node=document.createElement('span');node.textContent=new Intl.DateTimeFormat(english()?'en-US':'zh-CN',{weekday:english()?'short':'narrow'}).format(new Date(2024,0,1+i));return node;}));
        renderCalendar();
      }
      if(hasTime) {
        panel.querySelector('[data-time-part="hour"]').textContent=t('hour');
        panel.querySelector('[data-time-part="minute"]').textContent=t('minute');
        panel.querySelector('.datetime-local-hint').textContent=t('localTime');
      }
      validate();
    }
    function position() {
      if (!opened) return;
      if (!input.isConnected || !trigger.getClientRects().length || getComputedStyle(trigger).visibility==='hidden') {close(false);return;}
      const zoom=effectiveZoom(panel),gap=8;
      panel.style.maxWidth=`${Math.max(0,innerWidth-16)/zoom}px`;
      panel.style.maxHeight=`${Math.max(0,innerHeight-16)/zoom}px`;
      const rect=trigger.getBoundingClientRect(),bounds=panel.getBoundingClientRect(),width=bounds.width,height=bounds.height;
      panel.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-width-8))/zoom}px`;
      const below=innerHeight-rect.bottom-gap,above=rect.top-gap;
      panel.style.top=`${Math.max(8,Math.min(below>=height || below>=above?rect.bottom+gap:rect.top-height-gap,innerHeight-height-8))/zoom}px`;
    }
    function open() {
      if(input.disabled || input.readOnly)return;
      active?.close(false);
      const now=new Date(),value=input.value;
      draftDate=hasDate?clampDate(value.slice(0,10)||dateValue(now)):'';
      const selected=localDate(draftDate)||now;view=new Date(selected.getFullYear(),selected.getMonth(),1);
      if(hasTime){hour.disabled=false;minute.disabled=false;const time=(kind==='time'?value:value.split('T')[1])||timeValue(now);[hour.value,minute.value]=time.split(':').slice(0,2);}
      populate();opened=true;active=control;trigger.setAttribute('aria-expanded','true');
      nativePopover=false;
      if(typeof panel.showPopover==='function') {
        try {panel.showPopover();nativePopover=panel.matches(':popover-open');} catch (_) {}
      }
      if(!nativePopover)showFallback();
      position();(calendar?.querySelector('[tabindex="0"]') || hour || dismiss).focus({preventScroll:true});
    }
    function close(restore) {
      if(!opened)return;
      opened=false;trigger.setAttribute('aria-expanded','false');
      if(hasTime){hour.disabled=true;minute.disabled=true;}
      if(nativePopover) {try {panel.hidePopover();} catch (_) {}}
      nativePopover=false;panel.classList.remove('is-open');
      if(active===control)active=null;
      if(restore && trigger.isConnected && !trigger.disabled)trigger.focus({preventScroll:true});
    }
    function showFallback() {
      nativePopover=false;panel.removeAttribute('popover');panel.classList.add('is-open');
    }
    panel.addEventListener('toggle',event=>{
      // Some embedded WebViews accept showPopover but immediately dismiss it.
      // Keep a usable panel inside the owning modal rather than an empty click.
      if(event.newState==='closed' && opened && nativePopover) {showFallback();position();}
    });
    panel.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      if(event.key==='Tab') {
        const items=[...panel.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled)')].filter(node=>node.tabIndex>=0 && !node.hidden && node.getClientRects().length);
        if(items.length){event.preventDefault();const index=items.indexOf(document.activeElement);items[(index+(event.shiftKey?-1:1)+items.length)%items.length].focus();}
      }
    });
    input.addEventListener('input',sync);input.addEventListener('change',sync);
    input.addEventListener('focus',()=>trigger.focus());
    input.addEventListener('invalid',event=>{
      event.preventDefault();
      const first=input.form && [...input.form.elements].find(node=>node.willValidate && !node.validity.valid);
      if(first && first!==input)return;
      open();
      status.textContent=input.validity.valueMissing || input.validity.badInput
        ? t(hasTime?(hasDate?'invalidDateTime':'invalidTime'):'invalidDate') : t('rangeError');
    });
    // Existing flows set .value directly when reopening a dialog or applying a
    // shortcut. Delegate to the native setter so their display stays current.
    Object.defineProperty(input,'value',{configurable:true,get(){return valueProperty.get.call(this);},set(value){
      // WebKit can retain the old native date fields after assigning an empty
      // value, rejecting the next form submission even though validity is true.
      // Recreate those fields when clearing, keeping constraints and reset values.
      if (value === '' && ['date','datetime-local','time'].includes(this.type)) {
        const nativeType=this.type;this.type='text';valueProperty.set.call(this,'');this.type=nativeType;
      } else valueProperty.set.call(this,value);
      sync();
    }});
    const control={sync,close,position,refresh(){sync();if(opened)populate();}};controls.set(input,control);sync();
  }
  function scan(root) {
    if(root.nodeType!==1 && root.nodeType!==9)return;
    if(root.matches?.(selector))enhance(root);
    root.querySelectorAll(selector).forEach(enhance);
  }
  scan(document);
  const observer=new MutationObserver(records=>{
    for(const record of records) {
      if(record.type==='childList')record.addedNodes.forEach(scan);
      else if(record.target.matches?.(selector)) {enhance(record.target);controls.get(record.target)?.sync();}
    }
    if(active)active.position();
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','readonly','required','min','max','step','hidden','aria-label','value','type']});
  let renderedLanguage=document.documentElement.lang;
  new MutationObserver(()=>{
    // applyI18n also writes lang when translating newly added calendar nodes.
    // Refresh only on a real language change to avoid a render/translate loop.
    if(renderedLanguage===document.documentElement.lang)return;
    renderedLanguage=document.documentElement.lang;
    document.querySelectorAll(selector).forEach(input=>controls.get(input)?.refresh());
  }).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  document.addEventListener('reset',()=>queueMicrotask(()=>document.querySelectorAll(selector).forEach(input=>controls.get(input)?.sync())));
  document.addEventListener('pointerdown',event=>{if(active && !event.target.closest('.datetime-control'))active.close(false);},true);
  document.addEventListener('close',()=>active?.position(),true);
  window.addEventListener('resize',()=>active?.position());
  document.addEventListener('scroll',()=>active?.position(),true);
})();
