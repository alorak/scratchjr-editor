import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

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
    res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(body);
  }catch{
    res.writeHead(404); res.end('Not found');
  }
});

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {port}=server.address();
const url=`http://127.0.0.1:${port}/index.html?smoke=1`;
const chrome=findChrome();
const args=[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--disable-background-networking','--disable-default-apps','--no-first-run',
  '--virtual-time-budget=3500','--dump-dom',url
];

const child=spawn(chrome,args,{stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';
child.stdout.on('data',d=>stdout+=d);
child.stderr.on('data',d=>stderr+=d);
const code=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Browser smoke timeout'));},15000);
  child.on('error',err=>{clearTimeout(timer);reject(err);});
  child.on('close',code=>{clearTimeout(timer);resolve(code);});
});
server.close();

if(code!==0) throw new Error(`Chrome exit ${code}: ${stderr.slice(-2000)}`);
const checks=[
  ['app boot marker',/data-app-ready="true"/.test(stdout)],
  ['initial page rendered',/class="page-row"/.test(stdout)],
  ['autosave status ready',/id="autosaveStatusText">Hazır<\/span>/.test(stdout)],
  ['character tab active',/id="tab-chars"[^>]*aria-selected="true"/.test(stdout)],
  ['stage panel present',/id="panel-stage"[^>]*role="tabpanel"/.test(stdout)]
];
const failed=checks.filter(([,ok])=>!ok).map(([name])=>name);
if(failed.length){
  throw new Error('Browser smoke failed: '+failed.join(', ')+'\nDOM tail:\n'+stdout.slice(-4000)+'\nChrome stderr:\n'+stderr.slice(-2000));
}
console.log('Browser smoke passed:',checks.map(([name])=>name).join(', '));
