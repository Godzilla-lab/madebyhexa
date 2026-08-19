import puppeteer from 'puppeteer-core';
const PAGES=['/','/validate','/offer','/terms.html','/privacy.html','/refund.html','/login.html','/account.html','/intake.html','/thanks.html'];
const VIEWS=[[390,844,'mobile'],[1440,900,'desktop']];
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',args:['--no-sandbox']});
for(const [w,h,label] of VIEWS){
  console.log('\n=== '+label+' '+w+'px ===');
  const p=await b.newPage();await p.setViewport({width:w,height:h});
  for(const u of PAGES){
    const errs=[];
    p.removeAllListeners('pageerror');p.removeAllListeners('response');
    p.on('pageerror',e=>errs.push('JS: '+e.message.slice(0,60)));
    p.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))errs.push(r.status()+' '+r.url().split('/').pop().slice(0,30));});
    try{
      await p.goto('https://madebyhexa.co'+u,{waitUntil:'networkidle2',timeout:45000});
      await new Promise(r=>setTimeout(r,1500));
      const m=await p.evaluate(()=>({
        ow:document.documentElement.scrollWidth>window.innerWidth+1
           ?document.documentElement.scrollWidth-window.innerWidth:0,
        h:document.body.scrollHeight,
        dashes:(document.body.innerText.match(/[—–]/g)||[]).length,
      }));
      console.log((u+'').padEnd(16),'h='+String(m.h).padEnd(6),
        m.ow?('\x1b[31mOVERFLOW +'+m.ow+'px\x1b[0m'):'no-overflow',
        m.dashes?('dashes='+m.dashes):'',
        errs.length?('\x1b[31m'+[...new Set(errs)].slice(0,2).join('; ')+'\x1b[0m'):'');
    }catch(e){console.log(u.padEnd(16),'\x1b[31mERR '+e.message.slice(0,40)+'\x1b[0m');}
  }
  await p.close();
}
await b.close();
