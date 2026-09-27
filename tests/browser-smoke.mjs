import {createServer} from 'node:http';
import {readFile,stat,mkdtemp,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const root=fileURLToPath(new URL('../',import.meta.url));
const mime={
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'
};

function findChrome(){
  const candidates=[process.env.CHROME_BIN,'google-chrome','google-chrome-stable','chromium','chromium-browser'].filter(Boolean);
  for(const bin of candidates){
    const r=spawnSync(bin,['--version'],{stdio:'ignore'});
    if(r.status===0) return bin;
  }
  throw new Error('Headless Chrome/Chromium bulunamadı');
}

const requests=[];
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    let rel=decodeURIComponent(url.pathname);
    if(rel==='/'||rel==='') rel='/index.html';
    const safe=normalize(rel).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/,'');
    const path=join(root,safe);
    const info=await stat(path);
    if(!info.isFile()) throw new Error('not file');
    const body=await readFile(path);
    requests.push({path:url.pathname,status:200});
    res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(body);
  }catch{
    requests.push({path:req.url,status:404});
    res.writeHead(404); res.end('Not found');
  }
});

function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

class CdpClient{
  constructor(ws){
    this.ws=ws; this.nextId=1; this.pending=new Map(); this.events=[];
    ws.addEventListener('message',event=>{
      const msg=JSON.parse(event.data);
      if(msg.id){
        const p=this.pending.get(msg.id);
        if(!p) return;
        this.pending.delete(msg.id);
        if(msg.error) p.reject(new Error(msg.error.message||JSON.stringify(msg.error)));
        else p.resolve(msg.result||{});
      }else this.events.push(msg);
    });
  }
  send(method,params={}){
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
}

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {port}=server.address();
const pageUrl=`http://127.0.0.1:${port}/index.html?smoke=1`;
const chrome=findChrome();
const profile=await mkdtemp(join(tmpdir(),'sjr-smoke-'));
const args=[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--disable-background-networking','--disable-default-apps','--no-first-run',
  '--remote-debugging-port=0','--remote-allow-origins=*',
  '--user-data-dir='+profile,'about:blank'
];

const child=spawn(chrome,args,{stdio:['ignore','ignore','pipe']});
let stderr='',devtoolsPort=null;
const devtoolsReady=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Chrome DevTools endpoint timeout')),8000);
  child.stderr.on('data',d=>{
    const text=d.toString(); stderr+=text;
    const m=text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if(m&&!devtoolsPort){devtoolsPort=Number(m[1]);clearTimeout(timer);resolve();}
  });
  child.on('error',err=>{clearTimeout(timer);reject(err);});
  child.on('exit',code=>{if(!devtoolsPort){clearTimeout(timer);reject(new Error('Chrome exited before DevTools: '+code));}});
});

let client=null,ws=null;
try{
  await devtoolsReady;
  const targets=await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then(r=>r.json());
  const target=targets.find(t=>t.type==='page');
  if(!target?.webSocketDebuggerUrl) throw new Error('Chrome page target bulunamadı');
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('CDP WebSocket timeout')),5000);
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP WebSocket açılamadı'));},{once:true});
  });
  client=new CdpClient(ws);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable').catch(()=>{});
  await client.send('Page.navigate',{url:pageUrl});

  const deadline=Date.now()+8000;
  let state=null;
  while(Date.now()<deadline){
    await wait(120);
    const result=await client.send('Runtime.evaluate',{
      expression:`JSON.stringify({
        ready:document.documentElement.dataset.appReady==='true',
        pageRows:document.querySelectorAll('.page-row').length,
        autosave:document.getElementById('autosaveStatusText')?.textContent||'',
        activeTab:document.getElementById('tab-chars')?.getAttribute('aria-selected')||'',
        stagePanel:!!document.getElementById('panel-stage')
      })`,
      returnByValue:true
    });
    try{state=JSON.parse(result.result?.value||'{}');}catch{state=null;}
    if(state?.ready) break;
  }

  let interaction=null;
  if(state?.ready){
    await client.send('Runtime.evaluate',{
      expression:`document.getElementById('tab-stage')?.click();document.getElementById('textAddBtn')?.click();`,
      returnByValue:true
    });
    await wait(120);
    const interactionResult=await client.send('Runtime.evaluate',{
      expression:`JSON.stringify({
        stageTab:document.getElementById('tab-stage')?.getAttribute('aria-selected')||'',
        stageHidden:document.getElementById('panel-stage')?.hidden??true,
        stageTexts:document.querySelectorAll('#stage .stage-text').length,
        selectedTextItem:document.querySelectorAll('#textItemList .text-item.sel').length,
        pageRows:document.querySelectorAll('.page-row').length
      })`,
      returnByValue:true
    });
    try{interaction=JSON.parse(interactionResult.result?.value||'{}');}catch{interaction=null;}
  }

  let libraryInteraction=null;
  if(state?.ready){
    const upload=await client.send('Runtime.evaluate',{
      expression:`(()=>{
        const svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path fill="#ff0000" d="M0 0 L100 0 L100 100 L0 100 Z"/></svg>';
        const file=new File([svg],'smoke-character.svg',{type:'image/svg+xml'});
        const dt=new DataTransfer();dt.items.add(file);
        const input=document.getElementById('charFile');
        input.files=dt.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`,
      returnByValue:true
    });
    if(upload.result?.value){
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        await wait(100);
        const probe=await client.send('Runtime.evaluate',{
          expression:`JSON.stringify({
            charItems:document.querySelectorAll('#charLib .libitem').length,
            charBadge:document.getElementById('badgeChars')?.textContent||'0'
          })`,
          returnByValue:true
        });
        try{libraryInteraction=JSON.parse(probe.result?.value||'{}');}catch{libraryInteraction=null;}
        if(libraryInteraction?.charItems>0)break;
      }
      if(libraryInteraction?.charItems>0){
        await client.send('Runtime.evaluate',{
          expression:`document.querySelector('#charLib .libitem')?.click()`,
          returnByValue:true
        });
        await wait(120);
        const placed=await client.send('Runtime.evaluate',{
          expression:`JSON.stringify({
            charItems:document.querySelectorAll('#charLib .libitem').length,
            charBadge:document.getElementById('badgeChars')?.textContent||'0',
            stageSprites:document.querySelectorAll('#stage .sprite').length,
            stageTab:document.getElementById('tab-stage')?.getAttribute('aria-selected')||'',
            vectorTag:document.querySelector('#charLib .libitem .tag')?.textContent||''
          })`,
          returnByValue:true
        });
        try{libraryInteraction=JSON.parse(placed.result?.value||'{}');}catch{}
      }
    }
  }

  const exceptions=client.events
    .filter(e=>e.method==='Runtime.exceptionThrown')
    .map(e=>e.params?.exceptionDetails?.exception?.description||e.params?.exceptionDetails?.text||'Runtime exception');
  const consoleErrors=client.events
    .filter(e=>e.method==='Runtime.consoleAPICalled'&&e.params?.type==='error')
    .map(e=>(e.params?.args||[]).map(a=>a.value||a.description||'').join(' '));
  const failed=[];
  if(!state?.ready) failed.push('app boot marker');
  if(!(state?.pageRows>0)) failed.push('initial page rendered');
  if(state?.autosave!=='Hazır') failed.push('autosave status ready');
  if(state?.activeTab!=='true') failed.push('character tab active');
  if(!state?.stagePanel) failed.push('stage panel present');
  if(state?.ready){
    if(interaction?.stageTab!=='true'||interaction?.stageHidden!==false) failed.push('stage tab interaction');
    if(!(interaction?.stageTexts>0)) failed.push('text add stage render');
    if(!(interaction?.selectedTextItem>0)) failed.push('text selection render');
    if(!(interaction?.pageRows>0)) failed.push('page strip after interaction');
    if(!(libraryInteraction?.charItems>0)) failed.push('SVG character upload');
    if(!(libraryInteraction?.stageSprites>0)) failed.push('library character placement');
    if(libraryInteraction?.stageTab!=='true') failed.push('library placement stage navigation');
    if(libraryInteraction?.vectorTag!=='VEKTÖR') failed.push('SVG vector pipeline');
  }
  if(exceptions.length) failed.push('runtime exception');

  if(failed.length){
    throw new Error(
      'Browser smoke failed: '+failed.join(', ')+
      '\nState: '+JSON.stringify(state)+
      '\nInteraction: '+JSON.stringify(interaction)+
      '\nLibrary interaction: '+JSON.stringify(libraryInteraction)+
      '\nRequests: '+JSON.stringify(requests)+
      '\nExceptions: '+exceptions.join(' | ')+
      '\nConsole errors: '+consoleErrors.join(' | ')+
      '\nChrome stderr: '+stderr.slice(-2500)
    );
  }
  console.log('Browser smoke passed:',JSON.stringify({state,interaction,libraryInteraction}));
}finally{
  try{ws?.close();}catch{}
  try{child.kill('SIGKILL');}catch{}
  server.close();
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
