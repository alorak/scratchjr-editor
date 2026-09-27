import {cloneJson} from './roundtrip-utils.mjs';
import {createDialogManager,startOperation} from './ui-utils.mjs';
import {assertFileSize,loadImage,escapeHtml} from './file-utils.mjs';
import {ensureAudioContext,closeAudioContext,waveformPeaks} from './audio-utils.mjs';
import {createAudioRecorder} from './audio-recorder.mjs';
import {createSjrTransferController} from './sjr-import-export.mjs';
import {createStageController} from './stage-controller.mjs';
import {createAssetPipeline} from './asset-pipeline.mjs';
import {createLibraryController} from './library-controller.mjs';

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service worker registration failed',err)));
}

"use strict";
const STAGE_W=480, STAGE_H=360, MAX_PAGES=4;
const MB=1024*1024, MAX_SOUND_BYTES=20*MB;
const state={
  pages:[ newPage() ], current:0,
  charLib:[],   // {id,name,asset}
  bgLib:[],     // {id,name,asset}
  sounds:[],    // {id,name,buf,ext}
  selected:null,
  selectedText:null,
  sjrDataMeta:null,
  sjrJsonMeta:null,
};
function newPage(){ return { chars:[], texts:[], bg:{ mode:'color', color:'#eaf4ff', asset:null, bgId:null }, sjrMeta:null }; }
let uid=1; const nextId=()=>'i'+(uid++);
/* ---------- undo / redo ---------- */
const historyState={undo:[],redo:[],restoring:false};
const HISTORY_LIMIT=50;
function clonePageState(p){
  return {
    ...p,
    sjrMeta:cloneJson(p.sjrMeta),
    bg:{...p.bg},
    chars:p.chars.map(x=>({...x,sjrMeta:cloneJson(x.sjrMeta)})),
    texts:(p.texts||[]).map(x=>({...x,sjrMeta:cloneJson(x.sjrMeta)}))
  };
}
function snapshotState(){
  return {
    pages:state.pages.map(clonePageState),
    current:state.current,
    charLib:state.charLib.map(x=>({...x})),
    bgLib:state.bgLib.map(x=>({...x})),
    sounds:state.sounds.map(x=>({...x})),
    selected:state.selected, selectedText:state.selectedText,
    sjrDataMeta:cloneJson(state.sjrDataMeta), sjrJsonMeta:cloneJson(state.sjrJsonMeta),
    projectName:document.getElementById('pname').value
  };
}
function updateHistoryButtons(){
  document.getElementById('undoBtn').disabled=!historyState.undo.length;
  document.getElementById('redoBtn').disabled=!historyState.redo.length;
}
function checkpoint(){
  if(historyState.restoring) return;
  historyState.undo.push(snapshotState());
  if(historyState.undo.length>HISTORY_LIMIT) historyState.undo.shift();
  historyState.redo.length=0;
  updateHistoryButtons();
}
function restoreSnapshot(s){
  historyState.restoring=true;
  Object.assign(state,{
    pages:s.pages.map(clonePageState), current:s.current,
    charLib:s.charLib.map(x=>({...x})), bgLib:s.bgLib.map(x=>({...x})),
    sounds:s.sounds.map(x=>({...x})), selected:s.selected, selectedText:s.selectedText,
    sjrDataMeta:cloneJson(s.sjrDataMeta), sjrJsonMeta:cloneJson(s.sjrJsonMeta)
  });
  document.getElementById('pname').value=s.projectName||'Benim Projem';
  historyState.restoring=false;
  render();
}
function undo(){
  if(!historyState.undo.length) return;
  const prev=historyState.undo.pop();
  historyState.redo.push(snapshotState());
  restoreSnapshot(prev); updateHistoryButtons(); showToast('Geri alındı');
}
function redo(){
  if(!historyState.redo.length) return;
  const next=historyState.redo.pop();
  historyState.undo.push(snapshotState());
  restoreSnapshot(next); updateHistoryButtons(); showToast('Yinelendi');
}
document.getElementById('undoBtn').onclick=undo;
document.getElementById('redoBtn').onclick=redo;
document.addEventListener('keydown',e=>{
  const tag=(e.target&&e.target.tagName||'').toLowerCase();
  if(['input','textarea','select'].includes(tag)||e.target?.isContentEditable) return;
  const mod=e.ctrlKey||e.metaKey;
  if(mod&&e.key.toLowerCase()==='z'){
    e.preventDefault(); if(e.shiftKey) redo(); else undo();
  } else if(mod&&e.key.toLowerCase()==='y'){
    e.preventDefault(); redo();
  }
});

/* ---------- ortak dialog / progress yardımcıları ---------- */
const {showDialog,hideDialog}=createDialogManager(document);

/* ---------- autosave (IndexedDB) ---------- */
const AUTOSAVE_DB='sjr-atelier', AUTOSAVE_STORE='projects', AUTOSAVE_KEY='autosave-v1';
let autosaveTimer=null, autosaveErrorShown=false, autosaveGeneration=0;
function setAutosaveStatus(kind,text){
  const el=document.getElementById('autosaveStatus'),label=document.getElementById('autosaveStatusText');
  if(!el||!label) return;
  el.className='autosave-status'+(kind?' '+kind:'');
  label.textContent=text;
}
function savedTimeLabel(){
  const d=new Date();
  return 'Kaydedildi '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function openAutosaveDb(){
  return new Promise((res,rej)=>{
    if(!('indexedDB' in window)) return rej(new Error('IndexedDB yok'));
    const req=indexedDB.open(AUTOSAVE_DB,1);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(AUTOSAVE_STORE)) req.result.createObjectStore(AUTOSAVE_STORE); };
    req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error);
  });
}
async function idbPut(value){
  const db=await openAutosaveDb();
  return new Promise((res,rej)=>{
    const tx=db.transaction(AUTOSAVE_STORE,'readwrite');
    tx.objectStore(AUTOSAVE_STORE).put(value,AUTOSAVE_KEY);
    tx.oncomplete=()=>{db.close();res();}; tx.onerror=()=>{db.close();rej(tx.error);};
  });
}
async function idbGet(){
  const db=await openAutosaveDb();
  return new Promise((res,rej)=>{
    const tx=db.transaction(AUTOSAVE_STORE,'readonly'), req=tx.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY);
    req.onsuccess=()=>{const v=req.result;db.close();res(v);}; req.onerror=()=>{db.close();rej(req.error);};
  });
}
function plainAsset(a){ if(!a)return null; const {img,...rest}=a; return rest; }
function autosavePayload(){
  return {
    version:1, projectName:document.getElementById('pname').value, current:state.current,
    charLib:state.charLib.map(x=>({...x,asset:plainAsset(x.asset)})),
    bgLib:state.bgLib.map(x=>({...x,asset:plainAsset(x.asset)})),
    sounds:state.sounds.map(s=>{const {_waveData,_duration,...rest}=s;return rest;}),
    sjrDataMeta:cloneJson(state.sjrDataMeta), sjrJsonMeta:cloneJson(state.sjrJsonMeta),
    pages:state.pages.map(p=>({
      ...p, sjrMeta:cloneJson(p.sjrMeta),
      bg:{...p.bg,asset:null},
      chars:p.chars.map(x=>({...x,asset:null,sjrMeta:cloneJson(x.sjrMeta)})),
      texts:(p.texts||[]).map(x=>({...x,sjrMeta:cloneJson(x.sjrMeta)}))
    }))
  };
}
function scheduleAutosave(){
  clearTimeout(autosaveTimer);
  const generation=++autosaveGeneration;
  setAutosaveStatus('saving','Değişiklik var');
  autosaveTimer=setTimeout(async()=>{
    if(generation!==autosaveGeneration) return;
    setAutosaveStatus('saving','Kaydediliyor…');
    try{
      await idbPut(autosavePayload());
      if(generation!==autosaveGeneration) return;
      autosaveErrorShown=false;
      setAutosaveStatus('saved',savedTimeLabel());
    }catch(err){
      console.warn('Autosave failed',err);
      if(generation!==autosaveGeneration) return;
      setAutosaveStatus('error','Kayıt başarısız');
      if(!autosaveErrorShown){ autosaveErrorShown=true; showToast('Otomatik kayıt başarısız oldu — tarayıcı depolama alanını kontrol et','err'); }
    }
  },450);
}
async function hydrateStoredAsset(a){
  if(!a) return null;
  const asset={...a};
  asset.img=await loadImage(asset.dataURL).catch(()=>new Image());
  return asset;
}
async function restoreAutosave(){
  let saved=null; try{saved=await idbGet();}catch(e){return false;}
  if(!saved||saved.version!==1||!Array.isArray(saved.pages)||!saved.pages.length) return false;
  const charLib=[];
  for(const x of (saved.charLib||[])) charLib.push({...x,asset:await hydrateStoredAsset(x.asset)});
  const bgLib=[];
  for(const x of (saved.bgLib||[])) bgLib.push({...x,asset:await hydrateStoredAsset(x.asset)});
  const charMap=new Map(charLib.map(x=>[x.id,x.asset])), bgMap=new Map(bgLib.map(x=>[x.id,x.asset]));
  const pages=saved.pages.slice(0,MAX_PAGES).map(p=>({
    ...p,
    bg:{...p.bg,asset:p.bg&&p.bg.bgId?bgMap.get(p.bg.bgId)||null:null},
    chars:(p.chars||[]).map(x=>({...x,asset:charMap.get(x.libId)||null})).filter(x=>x.asset),
    texts:(p.texts||[])
  }));
  Object.assign(state,{pages,current:Math.max(0,Math.min(saved.current||0,pages.length-1)),charLib,bgLib,sounds:saved.sounds||[],selected:null,selectedText:null,
    sjrDataMeta:cloneJson(saved.sjrDataMeta),sjrJsonMeta:cloneJson(saved.sjrJsonMeta)});
  const ids=[...charLib,...bgLib,...pages.flatMap(p=>[...p.chars,...p.texts])].map(x=>String(x.id||'')).map(x=>/^i(\d+)$/.exec(x)).filter(Boolean).map(m=>+m[1]);
  uid=Math.max(uid,ids.length?Math.max(...ids)+1:uid);
  document.getElementById('pname').value=saved.projectName||'Benim Projem';
  return true;
}

function baseName(filename){
  return (filename||'').replace(/\.[^.]+$/,'').replace(/[_\-]+/g,' ').trim().slice(0,24)||'Karakter';
}
/* ---------- TABLAR ---------- */
const tabbar=document.getElementById('tabbar');
tabbar.addEventListener('click',e=>{
  const t=e.target.closest('.tab'); if(!t) return; setTab(t.dataset.tab);
});
tabbar.addEventListener('keydown',e=>{
  if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key)) return;
  const tabs=[...tabbar.querySelectorAll('.tab')],current=tabs.indexOf(document.activeElement);
  if(current<0) return;
  e.preventDefault();
  let next=current;
  if(e.key==='ArrowRight') next=(current+1)%tabs.length;
  if(e.key==='ArrowLeft') next=(current-1+tabs.length)%tabs.length;
  if(e.key==='Home') next=0;
  if(e.key==='End') next=tabs.length-1;
  tabs[next].focus(); setTab(tabs[next].dataset.tab);
});
function setTab(name){
  document.querySelectorAll('.tab').forEach(t=>{
    const active=t.dataset.tab===name;
    t.classList.toggle('active',active);
    t.setAttribute('aria-selected',active?'true':'false');
    t.tabIndex=active?0:-1;
  });
  document.querySelectorAll('.panel').forEach(p=>{
    const active=p.dataset.tab===name;
    p.classList.toggle('active',active);
    p.hidden=!active;
  });
  if(name==='stage'){ renderWorkspace(); }
  if(name==='bg'){ renderBgTab(); }
}

let libraryController=null;
const assetPipeline=createAssetPipeline({
  document,window,showToast,stageWidth:STAGE_W,stageHeight:STAGE_H
});
const stageController=createStageController({
  document,window,state,newPage,nextId,checkpoint,scheduleAutosave,showToast,confirmModal,showDialog,hideDialog,
  renderBgTab:()=>libraryController?.renderBgTab(),
  renderAll:()=>render(),updateHistoryButtons,
  stageWidth:STAGE_W,stageHeight:STAGE_H,maxPages:MAX_PAGES
});
const {renderPages,renderStage,renderSelPanel,renderTextPanel,renderWorkspace,scheduleRenderPages}=stageController;

libraryController=createLibraryController({
  document,state,nextId,checkpoint,scheduleAutosave,showToast,confirmModal,showDialog,hideDialog,setTab,
  renderStage,renderPages,scheduleRenderPages,renderAll:()=>render(),assetPipeline
});
const {renderBadges,renderCharLib,renderBgTab}=libraryController;

/* ---------- render ---------- */
function render(opts={}){
  renderBadges(); renderCharLib(); renderBgTab(); renderSounds(); renderPages(); renderStage(); renderSelPanel(); renderTextPanel(); updateHistoryButtons();
  if(opts.autosave!==false) scheduleAutosave();
}
function fmtDur(sec){
  if(sec==null) return '–';
  const m=Math.floor(sec/60), s=(sec%60).toFixed(1);
  return m>0 ? m+':'+s.padStart(4,'0')+' dk' : s+' sn';
}

function renderSounds(){
  const ul=document.getElementById('soundlist'); ul.innerHTML='';
  document.getElementById('sndEmpty').style.display=state.sounds.length?'none':'block';
  state.sounds.forEach(s=>{
    const li=document.createElement('li');

    // top row
    const top=document.createElement('div'); top.className='snd-top';
    const play=document.createElement('button'); play.className='play'; play.dataset.sid=s.id;
    play.textContent=(currentPlayingId===s.id)?'■':'▶';
    if(currentPlayingId===s.id) play.style.background='var(--red)';
    play.onclick=()=>togglePlaySound(s);
    const nm=document.createElement('span'); nm.className='nm'; nm.textContent=s.name;
    const dur=document.createElement('span'); dur.className='snd-dur';
    dur.textContent=fmtDur(s._duration);
    const x=document.createElement('button'); x.className='x'; x.textContent='×'; x.setAttribute('aria-label',s.name+' sesini sil');
    x.onclick=async()=>{ const ok=await confirmModal({title:'Sesi sil',bodyHtml:`<b>${escapeHtml(s.name)}</b> silinsin mi?`,okText:'Evet, sil',cancelText:'Vazgeç'}); if(!ok)return; checkpoint(); stopCurrentSound();
      if(s.sourceFile){
        const dead=String(s.sourceFile).replace(/^.*[\\/]/,'');
        state.pages.forEach(p=>p.chars.forEach(ch=>{if(ch.sjrMeta&&Array.isArray(ch.sjrMeta.sounds)) ch.sjrMeta.sounds=ch.sjrMeta.sounds.filter(ref=>String(ref).replace(/^.*[\\/]/,'')!==dead);}));
      }
      state.sounds=state.sounds.filter(z=>z!==s); render(); };
    top.append(play,nm,dur,x);

    // waveform canvas
    const cvs=document.createElement('canvas'); cvs.className='snd-wave'; cvs.tabIndex=0; cvs.setAttribute('role','button'); cvs.setAttribute('aria-label',s.name+' sesini oynat veya durdur');
    cvs.onclick=()=>togglePlaySound(s); cvs.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();togglePlaySound(s);}};

    li.append(top,cvs);
    ul.appendChild(li);
    requestAnimationFrame(()=>loadAndDrawWave(s,cvs,dur));
  });
}

async function loadAndDrawWave(s,cvs,durEl){
  if(!s._waveData){
    try{
      _waveAudioCtx=ensureAudioContext(_waveAudioCtx);
      const decoded=await _waveAudioCtx.decodeAudioData(s.buf.slice(0));
      s._duration=decoded.duration;
      s._waveData=waveformPeaks(decoded,300);
      if(durEl) durEl.textContent=fmtDur(s._duration);
    }catch(e){ s._waveData=[]; }
  }
  drawWaveCanvas(s,cvs);
}

function drawWaveCanvas(s,cvs){
  const W=cvs.offsetWidth||400;
  cvs.width=W; cvs.height=44;
  const ctx=cvs.getContext('2d'), cy=22, maxH=19;
  ctx.fillStyle='#e8f5e4'; ctx.fillRect(0,0,W,44);
  // center line
  ctx.beginPath(); ctx.strokeStyle='#b8e0b4'; ctx.lineWidth=1;
  ctx.moveTo(0,cy); ctx.lineTo(W,cy); ctx.stroke();
  const data=s._waveData||[];
  if(!data.length) return;
  const n=data.length, pxPerBar=W/n;
  const barW=Math.max(1,pxPerBar*0.72);
  // fill bars
  ctx.beginPath(); ctx.strokeStyle='#3d9a30'; ctx.lineWidth=barW; ctx.lineCap='round';
  for(let i=0;i<n;i++){
    const x=i*pxPerBar+pxPerBar/2, h=data[i]*maxH;
    ctx.moveTo(x,cy-h); ctx.lineTo(x,cy+h);
  }
  ctx.stroke();
  // playback progress tint
  if(currentPlayingId===s.id && _playStartTime!=null){
    const elapsed=(Date.now()-_playStartTime)/1000;
    const pct=s._duration>0 ? Math.min(1,elapsed/s._duration) : 0;
    const px=pct*W;
    ctx.fillStyle='rgba(56,160,40,.18)'; ctx.fillRect(0,0,px,44);
    ctx.beginPath(); ctx.strokeStyle='#FF4444'; ctx.lineWidth=2;
    ctx.moveTo(px,0); ctx.lineTo(px,44); ctx.stroke();
  }
}
/* ---------- yüklemeler ---------- */
document.getElementById('sndUpload').onclick=()=>document.getElementById('sndFile').click();
document.getElementById('sndFile').addEventListener('change',async e=>{
  if(e.target.files.length) checkpoint();
  for(const f of e.target.files){ try{ assertFileSize(f,MAX_SOUND_BYTES,'Ses dosyası'); const buf=await f.arrayBuffer(); let ext=(f.name.split('.').pop()||'wav').toLowerCase();
    if(!['wav','mp3','webm','m4a','ogg'].includes(ext)) ext='wav'; state.sounds.push({id:nextId(),name:baseName(f.name),buf,ext}); }
    catch(err){ showToast((err.message||'Ses okunamadı')+': '+f.name,'err'); }
  }
  e.target.value=''; renderBadges(); renderSounds(); scheduleAutosave(); showToast('Sesler işlendi');
});

/* ---- SES KAYIT MODALI ---- */
const audioRecorderController=createAudioRecorder({
  document,window,showDialog,hideDialog,showToast,checkpoint,nextId,
  getSounds:()=>state.sounds,
  addSound:sound=>state.sounds.push(sound),
  onSoundsChanged:()=>{renderBadges();renderSounds();},
  scheduleAutosave
});

let audioCtx=null, currentPlayingNode=null, currentPlayingId=null, _playStartTime=null, _playRafId=null, playbackGeneration=0;

function stopCurrentSound(shouldRender=true){
  playbackGeneration++;
  if(currentPlayingNode){
    try{currentPlayingNode.stop();}catch(e){}
    try{currentPlayingNode.disconnect();}catch(e){}
    currentPlayingNode=null;
  }
  currentPlayingId=null; _playStartTime=null;
  cancelAnimationFrame(_playRafId);
  if(shouldRender) renderSounds();
}

function togglePlaySound(s){
  if(currentPlayingId===s.id){ stopCurrentSound(); return; }
  stopCurrentSound();
  const generation=playbackGeneration;
  try{
    audioCtx=ensureAudioContext(audioCtx);
    if(audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
    audioCtx.decodeAudioData(s.buf.slice(0)).then(b=>{
      if(generation!==playbackGeneration) return;
      const node=audioCtx.createBufferSource();
      node.buffer=b; node.connect(audioCtx.destination);
      node.onended=()=>{
        try{node.disconnect();}catch(e){}
        if(generation===playbackGeneration&&currentPlayingId===s.id){
          currentPlayingNode=null; currentPlayingId=null; _playStartTime=null;
          cancelAnimationFrame(_playRafId); renderSounds();
        }
      };
      if(generation!==playbackGeneration){try{node.disconnect();}catch(e){} return;}
      node.start();
      currentPlayingNode=node; currentPlayingId=s.id; _playStartTime=Date.now();
      renderSounds();
      function tickCursor(){
        if(generation!==playbackGeneration) return;
        const cvs=document.querySelector('.soundlist [data-sid="'+s.id+'"]')?.closest('li')?.querySelector('.snd-wave');
        if(cvs) drawWaveCanvas(s,cvs);
        if(currentPlayingId===s.id) _playRafId=requestAnimationFrame(tickCursor);
      }
      tickCursor();
    }).catch(()=>{if(generation===playbackGeneration)showToast('Bu format önizlenemiyor (yine de dışa aktarılır)');});
  }catch(e){ if(generation===playbackGeneration)showToast('Önizleme yapılamadı'); }
}

function playSound(s){ togglePlaySound(s); }

function disposeAudioResources(){
  audioRecorderController.dispose();
  stopCurrentSound(false);
  const contexts=[audioCtx,_waveAudioCtx];
  audioCtx=null; _waveAudioCtx=null;
  contexts.forEach(ctx=>closeAudioContext(ctx));
}
window.addEventListener('pagehide',disposeAudioResources);

/* ---------- .sjr içe / dışa aktarma ---------- */
const sjrTransfer=createSjrTransferController({
  document,window,state,newPage,nextId,checkpoint,render,setTab,showToast,startOperation,showImportReport,
  stageWidth:STAGE_W,stageHeight:STAGE_H,maxPages:MAX_PAGES
});

document.getElementById('exportBtn').onclick=()=>sjrTransfer.exportProject();
document.getElementById('importBtn').onclick=()=>document.getElementById('srjFile').click();
document.getElementById('srjFile').addEventListener('change',async event=>{
  const file=event.target.files[0]; event.target.value='';
  if(!file) return;
  const confirmed=await confirmModal({
    title:'İçe aktarma',
    okText:'Evet, içe aktar',
    cancelText:'Vazgeç',
    bodyHtml:'Bu işlem <b>şu anki tüm çalışmanı</b> — karakterler, arkaplanlar, sesler ve sahneler — '
      +'kaldırıp yerine <span class="fname">'+escapeHtml(file.name)+'</span> dosyasındaki projeyi yükler.'
      +'<div class="warnline">↶ İçe aktardıktan sonra gerekirse Geri Al ile önceki çalışmana dönebilirsin.</div>'
  });
  if(!confirmed){showToast('İçe aktarma iptal edildi');return;}
  await sjrTransfer.runImport(file);
});


function showImportReport(report){
  const ov=document.getElementById('importReportOverlay');
  const summary=document.getElementById('importReportSummary');
  const issues=document.getElementById('importReportIssues');
  const parts=[
    report.pages+' sayfa',
    report.characters+' karakter asseti',
    report.texts+' metin',
    report.backgrounds+' arkaplan',
    report.sounds+' ses'
  ];
  summary.textContent='Yüklendi: '+parts.join(' · ');
  issues.replaceChildren();
  if(report.issues.length){
    for(const issue of report.issues){
      const li=document.createElement('li');
      li.className='import-issue '+issue.kind;
      li.textContent=(issue.kind==='missing'?'Eksik: ':issue.kind==='skipped'?'Atlandı: ':'Uyarı: ')+issue.message;
      issues.appendChild(li);
    }
  }else{
    const li=document.createElement('li'); li.className='import-issue ok'; li.textContent='Herhangi bir eksik veya atlanan öğe tespit edilmedi.'; issues.appendChild(li);
  }
  showDialog(ov,document.getElementById('importReportClose'),closeImportReport);
}
function closeImportReport(){hideDialog(document.getElementById('importReportOverlay'));}
document.getElementById('importReportClose').onclick=closeImportReport;
document.getElementById('importReportOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('importReportOverlay'))closeImportReport();});

/* ---------- modal onayı ---------- */
function setSafeModalHtml(target,html){
  const tpl=document.createElement('template'); tpl.innerHTML=String(html||'');
  const allowedTags=new Set(['B','SPAN','DIV']);
  [...tpl.content.querySelectorAll('*')].forEach(el=>{
    if(!allowedTags.has(el.tagName)){el.replaceWith(document.createTextNode(el.textContent||''));return;}
    [...el.attributes].forEach(a=>{if(a.name!=='class')el.removeAttribute(a.name);});
    const cls=el.getAttribute('class');
    if(cls&&!['fname','warnline'].includes(cls)) el.removeAttribute('class');
  });
  target.replaceChildren(tpl.content.cloneNode(true));
}
function confirmModal(opts){
  opts=opts||{};
  return new Promise(res=>{
    const ov=document.getElementById('confirmOverlay');
    const okBtn=document.getElementById('confirmOk'), cancelBtn=document.getElementById('confirmCancel');
    document.getElementById('confirmTitle').textContent=opts.title||'Emin misin?';
    setSafeModalHtml(document.getElementById('confirmBody'),opts.bodyHtml||'');
    okBtn.textContent=opts.okText||'Evet';
    cancelBtn.textContent=opts.cancelText||'Vazgeç';
    function close(val){
      hideDialog(ov);
      okBtn.removeEventListener('click',onOk); cancelBtn.removeEventListener('click',onCancel);
      ov.removeEventListener('click',onBackdrop);
      res(val);
    }
    const onOk=()=>close(true), onCancel=()=>close(false);
    const onBackdrop=e=>{ if(e.target===ov) close(false); };
    okBtn.addEventListener('click',onOk); cancelBtn.addEventListener('click',onCancel);
    ov.addEventListener('click',onBackdrop);
    showDialog(ov,okBtn,()=>close(false));
  });
}

/* ---------- toast ---------- */
let toastTimer=null;
function showToast(msg,kind){ const t=document.getElementById('toast'); t.textContent=msg; t.className='toast show'+(kind==='err'?' err':'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className='toast'+(kind==='err'?' err':''),2600); }

/* ---------- başlat ---------- */
document.getElementById('pname').addEventListener('input',scheduleAutosave);
async function boot(){
  stageController.bind(); libraryController.bind();
  const restored=await restoreAutosave();
  render({autosave:false});
  setAutosaveStatus('saved',restored?'Otomatik kayıt yüklendi':'Hazır');
  if(restored) showToast('Otomatik kaydedilen çalışma geri yüklendi');
  document.documentElement.dataset.appReady='true';
}
boot();
