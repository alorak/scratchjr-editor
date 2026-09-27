import {cloneJson,hasSvgTransform,hasSvgRootPresentation,inspectSvgCompatibility} from './roundtrip-utils.mjs';
import {createDialogManager,startOperation} from './ui-utils.mjs';
import {assertFileSize,b64,readAsDataURL,readAsText,loadImage,svgDims,wrapRasterSvg,escapeHtml} from './file-utils.mjs';
import {ensureAudioContext,closeAudioContext,waveformPeaks} from './audio-utils.mjs';
import {createAudioRecorder} from './audio-recorder.mjs';
import {createSjrTransferController} from './sjr-import-export.mjs';
import {createStageController} from './stage-controller.mjs';

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service worker registration failed',err)));
}

"use strict";
const STAGE_W=480, STAGE_H=360, MAX_PAGES=4;
const MB=1024*1024, MAX_IMAGE_BYTES=10*MB, MAX_SOUND_BYTES=20*MB;
// ScratchJr varsayılan scale=0.5'te karakter sahnenin ~%27'sini kaplasın:
// CHAR_CANONICAL_W * 0.5 = STAGE_W * 0.27  →  259 px
const CHAR_CANONICAL_W = Math.round(STAGE_W * 27 / 50);
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
let conv={ mode:'embed', colors:16 };

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
/* ---------- dosya okuma ---------- */
/* Inkscape/harici SVG'yi ScratchJr'ın beklediği sade path-tabanlı formata normalleştirir.
   pxW/pxH: tarayıcının mm→px dönüşümünden gelen gerçek piksel boyutları
   Döndürür: {text, w, h} veya null. w/h = SVG'nin kanonik boyutları (ScratchJr'ın
   intrinsik boyut olarak kullandığı viewBox[2,3] değerleri). Bu sayede data.json'daki
   w/h ile SVG dosyasının width/height özelliği her zaman örtüşür. */
/* ── SVG path veri koordinat ölçekleyici ───────────────────────────────────
   Tüm M/L/C/S/Q/T/H/V/A komutlarındaki koordinatları sx,sy ile çarpar.
   Göreli (küçük harf) ve mutlak (büyük harf) komutların hepsi ölçeklenir.
   A komutundaki large-arc/sweep bayrakları (0/1) ölçeklenmez.           */
function scalePathData(d, sx, sy){
  if(!d||(sx===1&&sy===1)) return d;
  const re=/([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d*\.?\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?)/g;
  const tok=[]; let m;
  while((m=re.exec(d))!==null) tok.push(m[1]?{k:1,v:m[1]}:{k:0,v:+m[2]});
  let out='', i=0;
  const f = n => { const r=+(+n.toFixed(4)); return r===0?'0':String(r); };
  const pop = () => (i<tok.length&&tok[i].k===0) ? tok[i++].v : 0;
  const hasN = () => i<tok.length && tok[i].k===0;
  while(i<tok.length){
    if(tok[i].k!==1){i++;continue;}
    const cmd=tok[i++].v, C=cmd.toUpperCase();
    if(C==='Z'){out+=cmd;continue;}
    out+=cmd;
    let sep='';
    while(hasN()){
      out+=sep; sep=' ';
      if     (C==='M'||C==='L'||C==='T') out+=f(pop()*sx)+' '+f(pop()*sy);
      else if(C==='H')                    out+=f(pop()*sx);
      else if(C==='V')                    out+=f(pop()*sy);
      else if(C==='C')                    out+=[f(pop()*sx),f(pop()*sy),f(pop()*sx),f(pop()*sy),f(pop()*sx),f(pop()*sy)].join(' ');
      else if(C==='S'||C==='Q')           out+=[f(pop()*sx),f(pop()*sy),f(pop()*sx),f(pop()*sy)].join(' ');
      else if(C==='A'){const rx=pop(),ry=pop(),xr=pop(),la=pop(),sw=pop(),x=pop(),y=pop();
                       out+=[f(rx*sx),f(ry*sy),f(xr),la|0,sw|0,f(x*sx),f(y*sy)].join(' ');}
      else out+=f(pop());
    }
  }
  return out;
}

/* ── SVG normalizer (paint editörü tam uyumlu çıktı) ──────────────────────
   Önceki sürümden fark:
   • <g transform="scale(...)"> YOK — koordinatlar doğrudan ölçeklenir
   • style="fill:..." → fill="..." dönüşümü
   • <circle> ve <polygon> → <path>
   • Whitespace text node'ları kaldırılır (e.getAttribute hatası önlenir)
   • ScratchJr yorumu \n öneki olmadan eklenir                            */
function normalizeSvgForChar(svgText, pxW, pxH){
  try{
    // ── 1. Dize ön temizliği ─────────────────────────────────────────────
    svgText = svgText
      .replace(/^<\?xml[^>]*\?>\s*/,'')
      .replace(/<!--(?!Created with Scratch Jr)[^>]*-->/g,'')
      .replace(/>\s+</g,'><');

    const parser=new DOMParser();
    const doc=parser.parseFromString(svgText,'image/svg+xml');
    if(doc.querySelector('parsererror')) return null;
    const svgEl=doc.documentElement;

    // ── 2. Gereksiz elementler ve namespace nitelikleri ──────────────────
    doc.querySelectorAll('sodipodi\\:namedview,metadata,script').forEach(el=>el.remove());
    doc.querySelectorAll('*').forEach(el=>{
      [...el.attributes].forEach(a=>{
        if(a.name.startsWith('inkscape:')||a.name.startsWith('sodipodi:')||
           a.name.startsWith('dc:')||a.name.startsWith('cc:')||a.name.startsWith('rdf:'))
          el.removeAttribute(a.name);
      });
    });

    // ── 3. Kanonik boyutlar ──────────────────────────────────────────────
    const vbStr=svgEl.getAttribute('viewBox')||'';
    const vbNums=vbStr.split(/[\s,]+/).map(Number);
    let canW,canH;
    if(vbNums.length>=4&&vbNums[2]>0&&vbNums[3]>0){canW=vbNums[2];canH=vbNums[3];}
    else{canW=pxW||CHAR_CANONICAL_W;canH=pxH||CHAR_CANONICAL_W;}
    const finalW=CHAR_CANONICAL_W;
    const finalH=Math.max(1,Math.round(canH*CHAR_CANONICAL_W/canW)); // Orijinal oran korunur

    // ── 4. Varsa <g transform="scale(...)"> sarmalayıcısını çöz ─────────
    // normalizeSvgForChar'ın önceki çalışmasında eklenmiş olabilir.
    // Tek eleman çocuk bir <g scale(...)> ise ölçek faktörlerini al ve sil.
    let sx=finalW/canW, sy=finalH/canH;
    const elemKids=[...svgEl.childNodes].filter(n=>n.nodeType===1);
    if(elemKids.length===1&&elemKids[0].tagName.toLowerCase()==='g'){
      const g0=elemKids[0];
      const sm=(g0.getAttribute('transform')||'')
                .match(/^scale\(\s*([^,\s)]+)(?:[,\s]+([^)]+))?\s*\)$/);
      if(sm){
        sx=parseFloat(sm[1]); sy=sm[2]!==undefined?parseFloat(sm[2]):sx;
        while(g0.firstChild) svgEl.insertBefore(g0.firstChild,g0);
        g0.remove();
      }
    }

    // ── 5. style="fill:..." → fill="..." ────────────────────────────────
    doc.querySelectorAll('[style]').forEach(el=>{
      const s=el.getAttribute('style');
      const fm=s.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
      if(fm){
        const v=fm[1].trim();
        if(v&&v.toLowerCase()!=='none') el.setAttribute('fill',v);
        const ns=s.replace(/(?:^|;)\s*fill\s*:[^;]*/gi,'').replace(/^;+/,'').trim();
        if(ns) el.setAttribute('style',ns); else el.removeAttribute('style');
      }
    });

    // ── 6. <circle> → <path> ────────────────────────────────────────────
    const K=0.5522847498;
    doc.querySelectorAll('circle').forEach(el=>{
      const cx=+(el.getAttribute('cx')||0), cy=+(el.getAttribute('cy')||0), r=+(el.getAttribute('r')||0);
      const p=doc.createElementNS('http://www.w3.org/2000/svg','path');
      p.setAttribute('d',
        `M${cx-r} ${cy} C${cx-r} ${cy-K*r} ${cx-K*r} ${cy-r} ${cx} ${cy-r} `+
        `C${cx+K*r} ${cy-r} ${cx+r} ${cy-K*r} ${cx+r} ${cy} `+
        `C${cx+r} ${cy+K*r} ${cx+K*r} ${cy+r} ${cx} ${cy+r} `+
        `C${cx-K*r} ${cy+r} ${cx-r} ${cy+K*r} ${cx-r} ${cy} Z`);
      [...el.attributes].forEach(a=>{ if(!['cx','cy','r'].includes(a.name)) p.setAttribute(a.name,a.value); });
      el.parentNode.replaceChild(p,el);
    });

    // ── 7. <polygon> → <path> ───────────────────────────────────────────
    doc.querySelectorAll('polygon').forEach(el=>{
      const pts=(el.getAttribute('points')||'').trim().split(/[\s,]+/).map(Number);
      let d=''; for(let j=0;j<pts.length;j+=2) d+=(j?'L':'M')+pts[j]+' '+pts[j+1]+' '; d+='Z';
      const p=doc.createElementNS('http://www.w3.org/2000/svg','path');
      p.setAttribute('d',d);
      [...el.attributes].forEach(a=>{ if(a.name!=='points') p.setAttribute(a.name,a.value); });
      el.parentNode.replaceChild(p,el);
    });

    // ── 8. Tüm path koordinatlarını ölçekle ─────────────────────────────
    doc.querySelectorAll('path').forEach(el=>{
      const d=el.getAttribute('d');
      if(d) el.setAttribute('d', scalePathData(d,sx,sy));
    });

    // ── 8b. Path/grup yapısını olduğu gibi koru ─────────────────────────
    // Path'leri root'a taşıyıp birleştirmek parent style/opacity/stroke
    // bilgisini kaybettirebiliyordu. Ayrıca kullanıcı çizimine yapay stroke
    // eklemiyoruz; export edilen SVG'nin görsel semantiği korunur.

    // ── 9. SVG niteliklerini normalize et ───────────────────────────────
    [...svgEl.attributes].forEach(a=>{
      if(a.name!=='xmlns'&&a.name!=='xmlns:xlink') svgEl.removeAttribute(a.name);
    });
    svgEl.setAttribute('xmlns','http://www.w3.org/2000/svg');
    svgEl.setAttribute('xmlns:xlink','http://www.w3.org/1999/xlink');
    svgEl.setAttribute('width', finalW+'px');
    svgEl.setAttribute('height', finalH+'px');
    svgEl.setAttribute('viewBox','0 0 '+finalW+' '+finalH);

    // ── 10. Serialize + final temizlik ──────────────────────────────────
    let out=new XMLSerializer().serializeToString(doc);
    out=out.replace(/^<\?xml[^>]*\?>\s*/,'');
    out=out.replace(/(<svg[^>]*>)\s*/,'$1<!--Created with Scratch Jr-->');
    out=out.replace(/>\s+</g,'><');

    return {text:out, w:finalW, h:finalH};
  }catch(e){return null;}
}

/* ---------- ImageTracer (yerel gerçek-vektör dönüştürücü) ---------- */
function loadTracer(){
  if(window.ImageTracer) return Promise.resolve();
  return Promise.reject(new Error('Yerel ImageTracer yüklenemedi'));
}
async function rasterToVectorSvg(dataURL,colors){
  await loadTracer();
  return await new Promise((res,rej)=>{
    try{ window.ImageTracer.imageToSVG(dataURL, svg=>res(svg),
      { numberofcolors:colors||16, pathomit:8, ltres:1, qtres:1, scale:1, roundcoords:1, viewbox:true }); }
    catch(e){ rej(e); }
  });
}

/* Bir Image nesnesini canvas üzerinden maxPx sınırına küçülterek PNG'ye dönüştürür.
   ScratchJr sahne: 480×360 — büyük PNG'ler getImagesInSVG'de drawImage 0×0 crash'ine neden olur. */
function capPng(img, maxPx){
  let w=img.naturalWidth||150, h=img.naturalHeight||150;
  const scale=Math.min(1, maxPx/w, maxPx/h);
  const nw=Math.max(1,Math.round(w*scale)), nh=Math.max(1,Math.round(h*scale));
  const cv=document.createElement('canvas'); cv.width=nw; cv.height=nh;
  cv.getContext('2d').drawImage(img,0,0,nw,nh);
  return { pngURL:cv.toDataURL('image/png'), w:nw, h:nh };
}

/* SVG data URL'ini canvas üzerinden PNG'ye çevirir, maxPx ile boyutu sınırlar */
async function svgToPngPreview(svgDataURL, w, h, maxPx=480){
  try{
    const im=await loadImage(svgDataURL);
    const rw=im.naturalWidth||w||150, rh=im.naturalHeight||h||150;
    if(!rw||!rh) return null;
    const {pngURL,w:nw,h:nh}=capPng(im, maxPx);
    return { pngURL, w:nw, h:nh, img:im };
  }catch(e){ return null; }
}

/* ---------- bir görseli asset'e çevir ---------- */
async function fileToAsset(file){
  const isSvg=/svg/.test(file.type)||/\.svg$/i.test(file.name);
  if(isSvg){
    const text=await readAsText(file);
    // SVG hiçbir şekilde browser renderer'a verilmeden önce güvenlik/offline
    // politikasından geçer.
    const svgPolicy=inspectSvgCompatibility(text);
    if(svgPolicy.externalRefs) throw new Error('SVG harici veya göreli kaynak içeriyor; offline kullanım için desteklenmiyor');
    if(svgPolicy.activeContent) throw new Error('SVG aktif script içeriği içeriyor');
    const svgDataURL='data:image/svg+xml;base64,'+b64(text);
    const img=await loadImage(svgDataURL).catch(()=>new Image());
    const w=img.naturalWidth||svgDims(text).w||150;
    const h=img.naturalHeight||svgDims(text).h||150;

    // 1. Yalnızca deterministik olarak güvenli görülen SVG'leri doğrudan
    // vektör normalize et. Arc/transform/style/effect/unsupported geometry
    // içerenler görünüm kaybını önlemek için raster fallback'e gider.
    const hasEmbedded=svgPolicy.hasEmbeddedImage;
    if(svgPolicy.safeDirectVector){
      const norm=normalizeSvgForChar(text, w, h);
      if(norm){
        const normDataURL='data:image/svg+xml;base64,'+b64(norm.text);
        const prev=await svgToPngPreview(normDataURL, norm.w, norm.h);
        // Önizleme ve export aynı normalize edilmiş asset'i kullanır (WYSIWYG).
        return { isSvg:true, vector:true, svgText:norm.text,
          dataURL:prev?prev.pngURL:normDataURL, w:norm.w, h:norm.h, img:prev?prev.img:await loadImage(normDataURL) };
      }
    }

    // 2. Inkscape SVG + gömülü raster: PNG/JPG href'i doğrudan çıkar
    try{
      const parsed=new DOMParser().parseFromString(text,'image/svg+xml');
      const imgEl=parsed.querySelector('image');
      if(imgEl){
        const rHref=imgEl.getAttribute('href')||
          imgEl.getAttributeNS('http://www.w3.org/1999/xlink','href')||'';
        if(rHref.startsWith('data:image/') && !rHref.startsWith('data:image/svg')){
          const rImg=await loadImage(rHref).catch(()=>null);
          if(rImg){
            const {pngURL,w:rw,h:rh}=capPng(rImg,480);
            const svgText=wrapRasterSvg(pngURL, rw, rh);
            return { isSvg:true, vector:false, svgText, dataURL:pngURL, w:rw, h:rh, img:rImg };
          }
        }
      }
    }catch(e){}

    // 3. Fallback: canvas'ta render et → PNG → wrapper
    //    Asla data:image/svg+xml href üretme (ScratchJr getImagesInSVG 0x0 hatası)
    const prev=await svgToPngPreview(svgDataURL, w, h);
    if(prev && prev.pngURL){
      const svgText=wrapRasterSvg(prev.pngURL, prev.w, prev.h);
      return { isSvg:true, vector:false, svgText, dataURL:prev.pngURL, w:prev.w, h:prev.h, img:prev.img };
    }
    // Güvenli rasterizasyon başarısızsa data:image/svg+xml wrapper üretme;
    // bu yapı ScratchJr tarafında 0×0 / render hatalarına yol açabiliyor.
    throw new Error('SVG güvenli biçimde rasterize edilemedi');
  }
  const dataURL=await readAsDataURL(file);
  const baseImg=await loadImage(dataURL);
  // ScratchJr max 480px — büyük PNG'ler thumbnail crash'ine neden olur
  const {pngURL,w,h}=capPng(baseImg,480);
  if(conv.mode==='trace'){
    try{
      const traced=await rasterToVectorSvg(pngURL,conv.colors);
      const tracedPolicy=inspectSvgCompatibility(traced);
      if(!tracedPolicy.safeDirectVector) throw new Error('ImageTracer çıktısı güvenli vektör kriterlerini karşılamıyor');
      const d=svgDims(traced);
      const norm=normalizeSvgForChar(traced,d.w||w,d.h||h);
      if(!norm) throw new Error('ImageTracer çıktısı normalize edilemedi');
      const preview='data:image/svg+xml;base64,'+b64(norm.text);
      return {isSvg:false,vector:true,svgText:norm.text,dataURL:preview,w:norm.w,h:norm.h,img:await loadImage(preview)};
    }catch(e){
      showToast('Vektöre çevrilemedi, gömme kullanıldı','err');
    }
  }
  return { isSvg:false, vector:false, svgText:wrapRasterSvg(pngURL,w,h), dataURL:pngURL, w, h, img:baseImg };
}

/* ---------- arkaplan asset dönüşümü ---------- */
function normalizeSvgForBackground(svgText){
  try{
    const doc=new DOMParser().parseFromString(svgText,'image/svg+xml');
    if(doc.querySelector('parsererror')) return null;
    const svg=doc.documentElement;
    doc.querySelectorAll('script').forEach(el=>el.remove());
    const dims=svgDims(svgText);
    if(!svg.getAttribute('viewBox')) svg.setAttribute('viewBox','0 0 '+dims.w+' '+dims.h);
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
    svg.setAttribute('width',STAGE_W+'px');
    svg.setAttribute('height',STAGE_H+'px');
    svg.setAttribute('preserveAspectRatio','xMidYMid slice');
    return new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/,'');
  }catch(e){ return null; }
}

async function fileToBackgroundAsset(file){
  const isSvg=/svg/.test(file.type)||/\.svg$/i.test(file.name);
  if(isSvg){
    const raw=await readAsText(file);
    const policy=inspectSvgCompatibility(raw);
    if(policy.externalRefs) throw new Error('SVG harici veya göreli kaynak içeriyor; offline kullanım için desteklenmiyor');
    if(policy.activeContent) throw new Error('SVG aktif script içeriği içeriyor');

    if(policy.safeDirectVector){
      const normalized=normalizeSvgForBackground(raw);
      if(normalized){
        const dataURL='data:image/svg+xml;base64,'+b64(normalized);
        return {isSvg:true,vector:true,preserveSvg:true,svgText:normalized,
          dataURL,w:STAGE_W,h:STAGE_H,img:await loadImage(dataURL)};
      }
    }

    // Karakterlerdekiyle aynı politika: karmaşık SVG arkaplanlar da
    // browser görünümü korunarak raster fallback'e çevrilir.
    const dims=svgDims(raw);
    const rawURL='data:image/svg+xml;base64,'+b64(raw);
    const prev=await svgToPngPreview(rawURL,dims.w,dims.h,480);
    if(!prev||!prev.pngURL) throw new Error('Arkaplan SVG güvenli biçimde rasterize edilemedi');
    return {isSvg:true,vector:false,preserveSvg:false,svgText:wrapRasterSvg(prev.pngURL,prev.w,prev.h),
      dataURL:prev.pngURL,w:prev.w,h:prev.h,img:prev.img};
  }
  const dataURL=await readAsDataURL(file);
  const baseImg=await loadImage(dataURL);
  const {pngURL,w,h}=capPng(baseImg,480);
  if(conv.mode==='trace'){
    try{
      const traced=await rasterToVectorSvg(pngURL,conv.colors);
      const tracedPolicy=inspectSvgCompatibility(traced);
      if(!tracedPolicy.safeDirectVector) throw new Error('ImageTracer çıktısı güvenli vektör kriterlerini karşılamıyor');
      const normalized=normalizeSvgForBackground(traced);
      if(!normalized) throw new Error('ImageTracer arkaplan çıktısı normalize edilemedi');
      const preview='data:image/svg+xml;base64,'+b64(normalized);
      return {isSvg:false,vector:true,preserveSvg:true,svgText:normalized,dataURL:preview,
        w:STAGE_W,h:STAGE_H,img:await loadImage(preview)};
    }catch(e){ showToast('Arkaplan vektöre çevrilemedi, gömme kullanıldı','err'); }
  }
  return {isSvg:false,vector:false,preserveSvg:false,svgText:wrapRasterSvg(pngURL,w,h),dataURL:pngURL,w,h,img:baseImg};
}

/* ---------- kütüphane / yerleştirme ---------- */
function addCharToLib(asset,name){ const it={id:nextId(),name:name||'Karakter',asset}; state.charLib.push(it); return it; }
function placeChar(libItem){
  const a=libItem.asset; const aspect=a.h/a.w;
  state.pages[state.current].chars.push({ id:nextId(), libId:libItem.id, name:libItem.name, asset:a, fx:0.5, fy:0.5, sizePct:27, flip:false, aspect });
  state.selected=state.pages[state.current].chars[state.pages[state.current].chars.length-1].id;
}
function addBgToLib(asset,name){ const it={id:nextId(),name:name||'Arkaplan',asset}; state.bgLib.push(it); return it; }
function applyBg(libItem){ state.pages[state.current].bg={ mode:'image', asset:libItem.asset, color:'#fff', bgId:libItem.id }; }

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

/* ---------- conversion bar (iki sekmede paylaşılır) ---------- */
document.querySelectorAll('[data-conv]').forEach(bar=>{
  bar.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{ conv.mode=b.dataset.m; syncConv(); });
  bar.querySelector('[data-colors]').onchange=e=>{ conv.colors=+e.target.value; syncConv(); };
});
function syncConv(){
  document.querySelectorAll('[data-conv]').forEach(bar=>{
    bar.querySelectorAll('.seg button').forEach(b=>b.classList.toggle('on',b.dataset.m===conv.mode));
    bar.querySelector('[data-colors]').value=String(conv.colors);
  });
}

const stageController=createStageController({
  document,window,state,newPage,nextId,checkpoint,scheduleAutosave,showToast,confirmModal,showDialog,hideDialog,
  renderBgTab,renderAll:()=>render(),updateHistoryButtons,
  stageWidth:STAGE_W,stageHeight:STAGE_H,maxPages:MAX_PAGES
});
const {renderPages,renderStage,renderSelPanel,renderTextPanel,renderWorkspace,scheduleRenderPages}=stageController;

/* ---------- render ---------- */
function render(opts={}){
  renderBadges(); renderCharLib(); renderBgTab(); renderSounds(); renderPages(); renderStage(); renderSelPanel(); renderTextPanel(); updateHistoryButtons();
  if(opts.autosave!==false) scheduleAutosave();
}
function renderBadges(){
  document.getElementById('badgeChars').textContent=state.charLib.length;
  document.getElementById('badgeBg').textContent=state.bgLib.length;
  document.getElementById('badgeSnd').textContent=state.sounds.length;
}
function renderCharLib(){
  const wrap=document.getElementById('charLib'); wrap.innerHTML='';
  document.getElementById('charEmpty').style.display=state.charLib.length?'none':'block';
  state.charLib.forEach(it=>{
    const d=document.createElement('div'); d.className='libitem';
    const tag=document.createElement('span'); tag.className='tag '+(it.asset.vector?'vec':'emb');
    tag.textContent=it.asset.vector?'VEKTÖR':'GÖMÜLÜ';
    const ph=document.createElement('div'); ph.className='ph';
    const img=document.createElement('img'); img.src=it.asset.dataURL; img.alt=''; ph.appendChild(img);
    // İsim alanı: normalde text, tıklayınca input'a dönüşür
    const nm=document.createElement('div'); nm.className='nm'; nm.textContent=it.name;
    nm.title='Yeniden adlandırmak için tıkla';
    nm.onclick=function editName(ev){
      ev.stopPropagation();
      checkpoint();
      const nmEl=ev.currentTarget;
      const inp=document.createElement('input'); inp.className='nm-input';
      inp.type='text'; inp.value=it.name; inp.maxLength=30;
      nmEl.replaceWith(inp); inp.focus(); inp.select();
      function saveName(){
        const val=inp.value.trim();
        if(val) it.name=val;
        state.pages.forEach(p=>p.chars.filter(c=>c.libId===it.id).forEach(c=>c.name=it.name));
        const nm2=document.createElement('div'); nm2.className='nm'; nm2.textContent=it.name;
        nm2.title='Yeniden adlandırmak için tıkla';
        nm2.onclick=editName;
        inp.replaceWith(nm2);
        scheduleAutosave();
      }
      inp.onblur=saveName;
      inp.onkeydown=e=>{ if(e.key==='Enter') inp.blur(); if(e.key==='Escape'){ inp.value=it.name; inp.blur(); } };
      inp.onclick=ev=>ev.stopPropagation();
    };
    const addBtn=document.createElement('div'); addBtn.className='add'; addBtn.textContent='+ Sahneye ekle';
    d.append(tag, ph, nm, addBtn);
    const place=()=>{ checkpoint(); placeChar(it); setTab('stage'); scheduleAutosave(); showToast(it.name+' sahneye eklendi'); };
    d.onclick=place; d.tabIndex=0; d.setAttribute('role','button'); d.setAttribute('aria-label',it.name+' karakterini sahneye ekle');
    d.onkeydown=e=>{ if((e.key==='Enter'||e.key===' ')&&e.target===d){ e.preventDefault(); place(); } };
    const x=document.createElement('button'); x.className='x'; x.textContent='×'; x.setAttribute('aria-label',it.name+' karakterini kütüphaneden sil');
    x.onclick=ev=>{ ev.stopPropagation(); removeCharLib(it); };
    const ib=document.createElement('button'); ib.className='info'; ib.textContent='i';
    ib.title='SVG bilgileri'; ib.setAttribute('aria-label',it.name+' SVG bilgileri'); ib.onclick=ev=>{ ev.stopPropagation(); showSvgInfo(it); };
    d.appendChild(x); d.appendChild(ib); wrap.appendChild(d);
  });
}
async function removeCharLib(it){
  const used=state.pages.reduce((n,p)=>n+p.chars.filter(c=>c.libId===it.id).length,0);
  const onay=await confirmModal({
    title:'Karakteri kütüphaneden sil',
    bodyHtml:`<b>${escapeHtml(it.name)}</b> silinsin mi?`+(used?`<div class="warnline">⚠ ${used} sahne örneği de kaldırılacak.</div>`:''),
    okText:'Evet, sil', cancelText:'Vazgeç'
  });
  if(!onay) return;
  checkpoint();
  state.charLib=state.charLib.filter(z=>z!==it);
  state.pages.forEach(p=>{ p.chars=p.chars.filter(c=>c.libId!==it.id); });
  render();
}
function renderBgTab(){
  const wrap=document.getElementById('bgLib'); wrap.innerHTML='';
  document.getElementById('bgEmpty').style.display=state.bgLib.length?'none':'block';
  const page=state.pages[state.current];
  state.bgLib.forEach(it=>{
    const d=document.createElement('div'); d.className='libitem bgadd'+(page.bg.bgId===it.id?'':'');
    d.style.outline = (page.bg.mode==='image'&&page.bg.bgId===it.id)?'3px solid var(--blue)':'';
    const tag=document.createElement('span'); tag.className='tag '+(it.asset.vector?'vec':'emb'); tag.textContent=it.asset.vector?'VEKTÖR':'GÖMÜLÜ';
    const ph=document.createElement('div'); ph.className='ph';
    const img=document.createElement('img'); img.src=it.asset.dataURL; img.alt=''; ph.appendChild(img);
    const nm=document.createElement('div'); nm.className='nm'; nm.textContent=it.name;
    const add=document.createElement('div'); add.className='add'; add.textContent='Bu sayfaya uygula';
    d.append(tag,ph,nm,add);
    const apply=()=>{ checkpoint(); applyBg(it); renderBgTab(); renderStage(); renderPages(); scheduleAutosave(); showToast('Arkaplan Sayfa '+(state.current+1)+'\'e uygulandı'); };
    d.onclick=apply; d.tabIndex=0; d.setAttribute('role','button'); d.setAttribute('aria-label',it.name+' arkaplanını bu sayfaya uygula');
    d.onkeydown=e=>{ if((e.key==='Enter'||e.key===' ')&&e.target===d){ e.preventDefault(); apply(); } };
    const x=document.createElement('button'); x.className='x'; x.textContent='×'; x.setAttribute('aria-label',it.name+' arkaplanını kütüphaneden sil');
    x.onclick=ev=>{ ev.stopPropagation(); removeBgLib(it); };
    d.appendChild(x); wrap.appendChild(d);
  });
  const note=document.getElementById('bgPageNote');
  const cur=page.bg.mode==='color'?('düz renk '+page.bg.color):'bir resim';
  const strong=document.createElement('b'); strong.textContent='Sayfa '+(state.current+1);
  note.replaceChildren(document.createTextNode('Şu an düzenlenen: '),strong,
    document.createTextNode(' — arkaplan: '+cur+'. (Sayfayı değiştirmek için Sahne sekmesini kullan.)'));
  document.getElementById('bgColor').value = page.bg.mode==='color'?page.bg.color:'#eaf4ff';
}
async function removeBgLib(it){
  const used=state.pages.filter(p=>p.bg.bgId===it.id).length;
  const onay=await confirmModal({
    title:'Arkaplanı kütüphaneden sil',
    bodyHtml:`<b>${escapeHtml(it.name)}</b> silinsin mi?`+(used?`<div class="warnline">⚠ ${used} sayfanın arkaplanı varsayılan renge dönecek.</div>`:''),
    okText:'Evet, sil', cancelText:'Vazgeç'
  });
  if(!onay) return;
  checkpoint();
  state.bgLib=state.bgLib.filter(z=>z!==it);
  state.pages.forEach(p=>{ if(p.bg.bgId===it.id) p.bg={mode:'color',color:'#eaf4ff',asset:null,bgId:null}; });
  render();
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
document.getElementById('charUpload').onclick=()=>document.getElementById('charFile').click();
document.getElementById('charFile').addEventListener('change',async e=>{
  const files=[...e.target.files]; e.target.value='';
  if(files.length) checkpoint();
  for(const f of files){ try{ assertFileSize(f,MAX_IMAGE_BYTES,'Karakter dosyası'); const a=await fileToAsset(f); addCharToLib(a, baseName(f.name)); }catch(err){ console.error(err); showToast((err.message||'Okunamadı')+': '+f.name,'err'); } }
  renderBadges(); renderCharLib(); scheduleAutosave(); showToast(files.length>1?files.length+' karakter eklendi':'Karakter kütüphaneye eklendi');
});
document.getElementById('bgUpload').onclick=()=>document.getElementById('bgFile').click();
document.getElementById('bgFile').addEventListener('change',async e=>{
  const files=[...e.target.files]; e.target.value='';
  if(files.length) checkpoint();
  for(const f of files){ try{ assertFileSize(f,MAX_IMAGE_BYTES,'Arkaplan dosyası'); const a=await fileToBackgroundAsset(f); const it=addBgToLib(a, baseName(f.name)); if(files.length===1) applyBg(it); }catch(err){ showToast(err.message||'Arkaplan okunamadı','err'); } }
  renderBadges(); renderBgTab(); renderStage(); renderPages(); scheduleAutosave(); showToast('Arkaplan eklendi');
});
document.getElementById('bgColor').addEventListener('pointerdown',()=>checkpoint());
document.getElementById('bgColor').addEventListener('input',e=>{ state.pages[state.current].bg={mode:'color',color:e.target.value,asset:null,bgId:null}; renderBgTab(); renderStage(); scheduleRenderPages(); scheduleAutosave(); });
document.getElementById('bgClear').onclick=()=>{ checkpoint(); state.pages[state.current].bg={mode:'color',color:'#eaf4ff',asset:null,bgId:null}; renderBgTab(); renderStage(); renderPages(); scheduleAutosave(); };

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

/* ---------- SVG bilgi analizi ---------- */
function analyzeSvg(svgText){
  const text=svgText||'';
  const policy=inspectSvgCompatibility(text);
  const byteSize=new TextEncoder().encode(text).length;
  const paths=(text.match(/<path[\s>]/gi)||[]).length;
  const circles=(text.match(/<circle[\s>]/gi)||[]).length;
  const polygons=(text.match(/<polygon[\s>]/gi)||[]).length;
  const directFills=(text.match(/\bfill="[^"]*"/gi)||[]).length;
  const colors=new Set((text.match(/fill="(#[0-9a-fA-F]{3,8})"/gi)||[]).map(m=>m.toLowerCase())).size;
  const vbMatch=text.match(/viewBox="([^"]*)"/i);
  const wMatch=text.match(/\bwidth="([^"]*)"/i);
  const hMatch=text.match(/\bheight="([^"]*)"/i);
  return {...policy,byteSize,paths,circles,polygons,directFills,colors,
    vbVal:vbMatch?vbMatch[1]:'—',w:wMatch?wMatch[1]:'—',h:hMatch?hMatch[1]:'—'};
}

function showSvgInfo(libItem){
  const a=analyzeSvg(libItem.asset.svgText);
  document.getElementById('infoTitle').textContent=libItem.name+' — SVG Bilgileri';
  const safe=v=>escapeHtml(String(v));
  const unsupported=Object.entries(a.unsupportedTags).filter(([,n])=>n).map(([k,n])=>k+' ×'+n).join(', ')||'Yok';
  const effects=Object.entries(a.effectTags).filter(([,n])=>n).map(([k,n])=>k+' ×'+n).join(', ')||'Yok';
  const genRows=[
    ['Çıktı türü',libItem.asset.vector?'Vektör':'Güvenli raster / gömülü'],
    ['Dosya boyutu',(a.byteSize/1024).toFixed(1)+' KB'],
    ['Path sayısı',a.paths],
    ['Renk sayısı',a.colors],
    ['Boyut',a.w+' × '+a.h],
    ['viewBox',a.vbVal]
  ];
  const checks=[
    {ok:!a.externalRefs,label:'Harici/göreli kaynak',value:a.externalRefs?a.unsafeReferences.join(', '):'Yok',
      errNote:'Offline çalışma için yalnızca data: ve #fragment referansları kabul edilir.'},
    {ok:!a.activeContent,label:'Aktif içerik',value:a.activeContent?'script var':'Yok',
      errNote:'Script içeren SVG dosyaları kabul edilmez.'},
    {ok:a.transformCount===0,label:'Transform',value:a.transformCount?a.transformCount+' adet':'Yok',
      errNote:'Transform içeren yüklemeler görünümü korumak için raster fallback kullanır.'},
    {ok:a.arcPaths===0,label:'Arc komutu A/a',value:a.arcPaths?a.arcPaths+' path':'Yok',
      errNote:'Arc içeren yüklemeler doğrudan vektör normalize edilmez; raster fallback kullanılır.'},
    {ok:a.unsupportedCount===0,label:'Ek geometri',value:unsupported,
      errNote:'rect/ellipse/line/polyline/text/use gibi yapılar doğrudan vektör yoluna alınmaz.'},
    {ok:a.effectCount===0,label:'Clip / mask / gradient / filter',value:effects,
      errNote:'Efektli SVG görünümü korunmak için raster fallback kullanır.'},
    {ok:(a.styleCount+a.styleElementCount)===0,label:'CSS style',value:(a.styleCount+a.styleElementCount)?(a.styleCount+' attribute, '+a.styleElementCount+' <style>'):'Yok',
      errNote:'style attribute veya <style> elementi içeren SVG otomatik normalizasyonda raster fallback kullanır.'},
    {ok:!a.rootPresentation,label:'Kök SVG presentation',value:a.rootPresentation?'Var':'Yok',
      errNote:'Kökten miras alınan fill/stroke/opacity gibi stiller raster fallback ile korunur.'},
    {ok:!a.viewBoxOriginNonZero,label:'viewBox başlangıcı',value:a.viewBoxValid?(a.viewBox[0]+' '+a.viewBox[1]):'Belirsiz',
      errNote:'0,0 dışında başlayan viewBox doğrudan koordinat ölçeklemesine sokulmaz.'}
  ];

  let html='<div class="info-section-title">Genel</div><div class="info-stats-grid">';
  genRows.forEach(([l,v],i)=>{
    const span=(i===genRows.length-1&&genRows.length%2===1)?' span2':'';
    html+=`<div class="stat-card${span}"><div class="lbl">${safe(l)}</div><div class="val">${safe(v)}</div></div>`;
  });
  html+='</div><div class="info-section-title">Vektör güvenlik politikası</div><div class="compat-grid">';
  html+=checks.map(ch=>`
    <div class="compat-check ${ch.ok?'check-ok':'check-err'}">
      <span class="check-icon">${ch.ok?'✓':'↪'}</span>
      <div class="check-body"><div class="check-top">
        <span class="lbl">${safe(ch.label)}</span><span class="val">${safe(ch.value)}</span>
      </div>${ch.ok?'':`<div class="check-note">${safe(ch.errNote)}</div>`}</div>
    </div>`).join('');
  html+='</div>';
  document.getElementById('infoStats').innerHTML=html;

  const compatEl=document.getElementById('infoCompat');
  if(!libItem.asset.vector || a.hasEmbeddedImage){
    compatEl.className='compat-bar good';
    compatEl.textContent='✓ Güvenli raster/gömülü çıktı — karmaşık SVG özellikleri görsel olarak korunur.';
  }else if(a.safeDirectVector){
    compatEl.className='compat-bar good';
    compatEl.textContent='✓ Doğrudan vektör normalizasyon kriterleri temiz.';
  }else{
    compatEl.className='compat-bar warn';
    compatEl.textContent='↪ Kaynak vektör korunuyor; yeni yüklemelerde bu yapı otomatik olarak raster fallback yoluna alınır.';
  }
  const overlay=document.getElementById('infoOverlay');
  showDialog(overlay,document.getElementById('infoClose'),closeInfoDialog);
}
function closeInfoDialog(){hideDialog(document.getElementById('infoOverlay'));}
document.getElementById('infoClose').onclick=closeInfoDialog;
document.getElementById('infoCloseBtn').onclick=closeInfoDialog;
document.getElementById('infoOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('infoOverlay'))closeInfoDialog();});

/* ---------- toast ---------- */
let toastTimer=null;
function showToast(msg,kind){ const t=document.getElementById('toast'); t.textContent=msg; t.className='toast show'+(kind==='err'?' err':'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className='toast'+(kind==='err'?' err':''),2600); }

/* ---------- başlat ---------- */
document.getElementById('pname').addEventListener('input',scheduleAutosave);
async function boot(){
  stageController.bind(); syncConv();
  const restored=await restoreAutosave();
  render({autosave:false});
  setAutosaveStatus('saved',restored?'Otomatik kayıt yüklendi':'Hazır');
  if(restored) showToast('Otomatik kaydedilen çalışma geri yüklendi');
  document.documentElement.dataset.appReady='true';
}
boot();
