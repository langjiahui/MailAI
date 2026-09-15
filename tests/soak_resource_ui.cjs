// Five-minute fixture-only UI soak with pet animation and background polling on.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[],samples=[];let requests=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',()=>requests++);
  const started=Date.now();
  try {
    await page.goto('http://127.0.0.1:18795/');
    await page.waitForSelector('#email-list .email-item');
    assert.ok((await page.evaluate(()=>api('/api/system/config'))).accounts.every(a=>a.user.endsWith('@example.test')));
    const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
    const pid=Number(process.env.MAILAI_FIXTURE_PID);
    const sample=async phase=>{
      await cdp.send('HeapProfiler.collectGarbage');
      const data=await cdp.send('Performance.getMetrics');
      const m=Object.fromEntries(data.metrics.map(m=>[m.name,m.value]));
      const backend=pid?execFileSync('ps',['-p',String(pid),'-o','rss=,%cpu='],{encoding:'utf8'}).trim():null;
      samples.push({phase,elapsed:Math.round((Date.now()-started)/1000),requests,heap:m.JSHeapUsedSize,nodes:m.Nodes,documents:m.Documents,taskSeconds:m.TaskDuration,backend});
      console.log(JSON.stringify(samples.at(-1)));
    };
    for(let n=0;n<15;n++)await page.locator('#email-list .email-item').nth(n%12).click();
    await sample('warm');
    for(let n=0;n<150;n++){
      await page.locator('#email-list .email-item').nth(n%12).click();
      if(n%10===0){
        await page.locator('#btn-preferences').click();
        for(const tab of ['account','maintenance','guide','preferences'])await page.locator(`[data-system-tab="${tab}"]`).click();
        await page.locator('#btn-close-system').click();
      }
    }
    await sample('active');
    while(Date.now()-started<300000){
      await page.waitForTimeout(15000);await sample('idle');
    }
    const idle=samples.filter(s=>s.phase==='idle');
    const first=idle[0],last=idle.at(-1);
    const idleCpuPercent=(last.taskSeconds-first.taskSeconds)/(last.elapsed-first.elapsed)*100;
    assert.ok(last.heap-first.heap<12*1024*1024,'Idle JS heap grew more than 12 MB');
    assert.ok(last.nodes-first.nodes<500,'Idle DOM keeps accumulating');
    assert.ok(idleCpuPercent<10,'Idle renderer uses more than 10% of one CPU core');
    assert.deepEqual(errors,[]);
    const result={durationSeconds:last.elapsed,mailSwitches:165,settingsVisits:15,idleCpuPercent,samples,errors};
    fs.writeFileSync(path.join(__dirname,'../build/resource-soak-results.json'),JSON.stringify(result,null,2));
    console.log('PASS',JSON.stringify({duration:last.elapsed,idleCpuPercent,heapStart:first.heap,heapEnd:last.heap}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
