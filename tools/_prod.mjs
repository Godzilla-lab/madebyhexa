import puppeteer from 'puppeteer-core';
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',args:['--no-sandbox']});
const p=await b.newPage();await p.setViewport({width:1440,height:1000});
const errs=[];p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('requestfailed',r=>errs.push('404/FAIL: '+r.url()));
p.on('response',r=>{if(r.status()>=400)errs.push(r.status()+' '+r.url());});
await p.goto('https://madebyhexa.co/',{waitUntil:'networkidle2',timeout:60000});
await new Promise(r=>setTimeout(r,4000));
const r1=await p.evaluate(()=>{
  const f=[...document.querySelectorAll('.work-filter')];
  return {filters:f.map(x=>x.textContent), pressed:f.filter(x=>x.getAttribute('aria-pressed')==='true').map(x=>x.textContent),
    tiles:document.querySelectorAll('.work-tile').length,
    imgsLoaded:[...document.querySelectorAll('.work-tile img')].filter(i=>i.naturalWidth>0).length,
    imgsTotal:document.querySelectorAll('.work-tile img').length,
    h1:document.querySelector('h1')?.innerText.replace(/\n/g,' '),
    passes:document.querySelectorAll('.how-step').length,
    height:document.body.scrollHeight};
});
console.log(JSON.stringify(r1,null,1));
// click through every tab
for(const i of [1,2]){
  await p.evaluate((n)=>document.querySelectorAll('.work-filter')[n].click(),i);
  await new Promise(r=>setTimeout(r,900));
  const t=await p.evaluate(()=>({tab:[...document.querySelectorAll('.work-filter')].find(x=>x.getAttribute('aria-pressed')==='true').textContent,
    tiles:document.querySelectorAll('.work-tile').length,
    vids:document.querySelectorAll('.work-tile video').length}));
  console.log('tab ->',JSON.stringify(t));
}
console.log(errs.length?('\nERRORS:\n'+[...new Set(errs)].slice(0,8).join('\n')):'\nno console/network errors');
await b.close();
