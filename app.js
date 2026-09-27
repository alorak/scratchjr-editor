if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service worker registration failed',err)));
}

import {cloneJson,hasSvgTransform,hasSvgRootPresentation,inspectSvgCompatibility,dataMetaWithoutJson,jsonMetaWithoutPages,pageMetaWithoutSprites,resolveCurrentPageIndex,selectBackgroundSvg,mergeSpriteMeta,mergePreservedSounds,mergeLayerOrder} from './roundtrip-utils.mjs';

"use strict";
const STAGE_W=480, STAGE_H=360, MAX_PAGES=4;
const MB=1024*1024, MAX_IMAGE_BYTES=10*MB, MAX_SOUND_BYTES=20*MB, MAX_SJR_BYTES=25*MB;
const MAX_ZIP_ENTRIES=500, MAX_ZIP_UNCOMPRESSED=100*MB, MAX_ZIP_ENTRY=30*MB;
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

/* ---------- autosave (IndexedDB) ---------- */
const AUTOSAVE_DB='sjr-atelier', AUTOSAVE_STORE='projects', AUTOSAVE_KEY='autosave-v1';
let autosaveTimer=null, autosaveErrorShown=false;
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
  autosaveTimer=setTimeout(async()=>{
    try{ await idbPut(autosavePayload()); }
    catch(err){
      console.warn('Autosave failed',err);
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

/* ---------- dosya okuma ---------- */
function assertFileSize(file,maxBytes,label){
  if(file && file.size>maxBytes) throw new Error((label||'Dosya')+' çok büyük (maks. '+Math.round(maxBytes/MB)+' MB)');
}
function assertZipSafety(zip){
  let entries=0,total=0,largest=0;
  zip.forEach((p,zf)=>{
    if(zf.dir) return;
    entries++;
    const n=Number(zf?._data?.uncompressedSize||0);
    if(Number.isFinite(n)){ total+=n; largest=Math.max(largest,n); }
  });
  if(entries>MAX_ZIP_ENTRIES) throw new Error('Arşiv çok fazla dosya içeriyor');
  if(largest>MAX_ZIP_ENTRY) throw new Error('Arşivde izin verilenden büyük bir dosya var');
  if(total>MAX_ZIP_UNCOMPRESSED) throw new Error('Arşivin açılmış boyutu güvenli sınırı aşıyor');
}
const b64=s=>btoa(unescape(encodeURIComponent(s)));
function readAsDataURL(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});}
function readAsText(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsText(f);});}
function loadImage(src){return new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=src;});}
function svgDims(text){try{const svg=new DOMParser().parseFromString(text,'image/svg+xml').querySelector('svg');
  let w=parseFloat(svg.getAttribute('width')),h=parseFloat(svg.getAttribute('height'));
  if(!w||!h){const vb=(svg.getAttribute('viewBox')||'').split(/[ ,]+/).map(Number);if(vb.length===4){w=vb[2];h=vb[3];}}
  return {w:w||150,h:h||150};}catch(e){return {w:150,h:150};}}
function wrapRasterSvg(dataURL,w,h){return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="${dataURL}" xlink:href="${dataURL}"/></svg>`;}

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

/* ── Aynı renkteki path'leri compound path'e birleştir ────────────────────
   Fill bucket aracının çalışabilmesi için kritik:
   • Her benzersiz renk → tek bir <path> olur (nonzero fill, delik oluşmaz)
   • Path sayısı (1569 → renk sayısı kadar ~50) düşer
   • Aynı renk tüm bölgeler tek tıkla değişir
   • fill="none" ve fill="url(...)" path'leri korunur, en üste alınır
   Not: Aynı renkteki path'ler farklı z-sırasındaysa görsel katmanlama
        değişebilir; basit flat-design karakterlerde sorun çıkmaz.       */
function mergePathsByColor(svgEl){
  const NS='http://www.w3.org/2000/svg';
  const allPaths=[...svgEl.querySelectorAll('path')];
  if(allPaths.length<2) return;

  /* Sadece ART ARDA (consecutive) gelen aynı renk path'leri birleştir.
     Araya farklı renk girince yeni "run" başlar — z-order korunur.
     Örnek:  beyaz(göz) · siyah(pupil) · beyaz(highlight)
             → 3 ayrı path kalır, highlight siyah pupil'in üstünde ✓  */
  const runs=[];  // [{fill, key, ds, attrs(nofill için)}]

  for(const p of allPaths){
    const raw=(p.getAttribute('fill')||'').trim();
    const key=raw.toLowerCase();
    const d=p.getAttribute('d')||'';

    const isMergeable = key && key!=='none' && !key.startsWith('url') &&
                        key!=='inherit' && key!=='currentcolor';

    const last=runs[runs.length-1];
    if(isMergeable && last && last.key===key){
      // Önceki run ile aynı renk → birleştir
      if(d) last.ds.push(d);
    } else {
      // Yeni run
      runs.push(isMergeable
        ? {fill:raw, key, ds: d?[d]:[]}
        : {fill:raw, key:'__nofill__', ds: d?[d]:[], attrs:[...p.attributes]});
    }
    p.remove();
  }

  // Boş <g> elementlerini temizle
  svgEl.querySelectorAll('g').forEach(g=>{ if(!g.children.length) g.remove(); });

  // Run'ları sırasıyla ekle (z-order tamamen korunur)
  for(const run of runs){
    if(!run.ds.length) continue;
    const p=document.createElementNS(NS,'path');
    if(run.key==='__nofill__'){
      run.attrs.forEach(a=>p.setAttribute(a.name,a.value));
      p.setAttribute('d',run.ds[0]);
    } else {
      p.setAttribute('fill',run.fill);
      p.setAttribute('d',run.ds.join(' '));
    }
    svgEl.appendChild(p);
  }
}

/* ── SVG normalizer (paint editörü tam uyumlu çıktı) ──────────────────────
   Önceki sürümden fark:
   • <g transform="scale(...)"> YOK — koordinatlar doğrudan ölçeklenir
   • style="fill:..." → fill="..." dönüşümü
   • <circle> ve <polygon> → <path>
   • Aynı renk path'ler compound path'te birleştirilir (fill bucket çalışır)
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

/* ---------- ImageTracer (gerçek vektör) — tembel yükleme ---------- */
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
    const svgDataURL='data:image/svg+xml;base64,'+b64(text);
    const img=await loadImage(svgDataURL).catch(()=>new Image());
    const w=img.naturalWidth||svgDims(text).w||150;
    const h=img.naturalHeight||svgDims(text).h||150;

    // 1. Yalnızca deterministik olarak güvenli görülen SVG'leri doğrudan
    // vektör normalize et. Arc/transform/style/effect/unsupported geometry
    // içerenler görünüm kaybını önlemek için raster fallback'e gider.
    const svgPolicy=inspectSvgCompatibility(text);
    if(svgPolicy.externalRefs) throw new Error('SVG harici ağ kaynağı içeriyor; offline kullanım için desteklenmiyor');
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
    // Son çare: canvas da başarısız, SVG'yi ham tut (uyarı ver)
    showToast('⚠ Bu SVG önizlenemiyor — yine de eklendi, görüntü bozuk olabilir','err');
    const svgText=wrapRasterSvg(svgDataURL, w, h);
    return { isSvg:true, vector:false, svgText, dataURL:svgDataURL, w, h, img };
  }
  const dataURL=await readAsDataURL(file);
  const baseImg=await loadImage(dataURL);
  // ScratchJr max 480px — büyük PNG'ler thumbnail crash'ine neden olur
  const {pngURL,w,h}=capPng(baseImg,480);
  if(conv.mode==='trace'){
    try{
      const svgText=await rasterToVectorSvg(pngURL, conv.colors);
      const d=svgDims(svgText); const preview='data:image/svg+xml;base64,'+b64(svgText);
      return { isSvg:false, vector:true, svgText, dataURL:preview, w:d.w||w, h:d.h||h, img:await loadImage(preview) };
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
    if(policy.externalRefs) throw new Error('SVG harici ağ kaynağı içeriyor; offline kullanım için desteklenmiyor');
    const normalized=normalizeSvgForBackground(raw)||raw;
    const dataURL='data:image/svg+xml;base64,'+b64(normalized);
    const img=await loadImage(dataURL).catch(()=>new Image());
    return {isSvg:true,vector:!/<image[\s/>]/i.test(normalized),preserveSvg:true,svgText:normalized,
      dataURL,w:STAGE_W,h:STAGE_H,img};
  }
  const dataURL=await readAsDataURL(file);
  const baseImg=await loadImage(dataURL);
  const {pngURL,w,h}=capPng(baseImg,480);
  if(conv.mode==='trace'){
    try{
      const traced=await rasterToVectorSvg(pngURL,conv.colors);
      const normalized=normalizeSvgForBackground(traced)||traced;
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
document.getElementById('tabbar').addEventListener('click',e=>{
  const t=e.target.closest('.tab'); if(!t) return; setTab(t.dataset.tab);
});
function setTab(name){
  document.querySelectorAll('.tab').forEach(t=>{
    const active=t.dataset.tab===name;
    t.classList.toggle('active',active);
    t.setAttribute('aria-selected',active?'true':'false');
  });
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.dataset.tab===name));
  if(name==='stage'){ render(); }
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

/* ---------- render ---------- */
function render(){ renderBadges(); renderCharLib(); renderBgTab(); renderSounds(); renderPages(); renderStage(); renderSelPanel(); renderTextPanel(); updateHistoryButtons(); scheduleAutosave(); }
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
      }
      inp.onblur=saveName;
      inp.onkeydown=e=>{ if(e.key==='Enter') inp.blur(); if(e.key==='Escape'){ inp.value=it.name; inp.blur(); } };
      inp.onclick=ev=>ev.stopPropagation();
    };
    const addBtn=document.createElement('div'); addBtn.className='add'; addBtn.textContent='+ Sahneye ekle';
    d.append(tag, ph, nm, addBtn);
    const place=()=>{ checkpoint(); placeChar(it); setTab('stage'); render(); showToast(it.name+' sahneye eklendi'); };
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
  note.innerHTML=`Şu an düzenlenen: <b>Sayfa ${state.current+1}</b> — arkaplan: ${cur}. (Sayfayı değiştirmek için Sahne sekmesini kullan.)`;
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

const AudioContextCtor=window.AudioContext||window.webkitAudioContext;
let _waveAudioCtx=null;
function ensureAudioContext(ctx){
  if(!AudioContextCtor) throw new Error('Web Audio desteklenmiyor');
  return (!ctx||ctx.state==='closed')?new AudioContextCtor():ctx;
}
function closeAudioContext(ctx){
  if(ctx&&ctx.state!=='closed') return ctx.close().catch(()=>{});
  return Promise.resolve();
}
async function loadAndDrawWave(s,cvs,durEl){
  if(!s._waveData){
    try{
      _waveAudioCtx=ensureAudioContext(_waveAudioCtx);
      const decoded=await _waveAudioCtx.decodeAudioData(s.buf.slice(0));
      s._duration=decoded.duration;
      const ch=decoded.getChannelData(0);
      const N=300, block=Math.floor(ch.length/N);
      const peaks=[];
      for(let i=0;i<N;i++){
        let pk=0;
        for(let j=0;j<block;j++) pk=Math.max(pk,Math.abs(ch[i*block+j]||0));
        peaks.push(pk);
      }
      s._waveData=peaks;
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
function renderPageThumbSync(page,w,h){
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
  const ctx=cv.getContext('2d');
  if(page.bg.mode==='color'){ ctx.fillStyle=page.bg.color; ctx.fillRect(0,0,w,h); }
  else if(page.bg.asset&&page.bg.asset.img){ ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h); try{drawCover(ctx,page.bg.asset.img,w,h);}catch(e){} }
  else { ctx.fillStyle='#eaf4ff'; ctx.fillRect(0,0,w,h); }
  for(const c of page.chars){
    if(!c.asset||!c.asset.img) continue;
    const sc=w/STAGE_W, dispW=c.sizePct/100*STAGE_W*sc, dispH=dispW*c.aspect, x=c.fx*w, y=c.fy*h;
    ctx.save(); ctx.translate(x,y); if(c.flip)ctx.scale(-1,1);
    try{ctx.drawImage(c.asset.img,-dispW/2,-dispH/2,dispW,dispH);}catch(e){}
    ctx.restore();
  }
  for(const t of (page.texts||[])){
    const fontSize=Math.max(6,Math.round(t.fontsize*w/STAGE_W));
    ctx.font=`600 ${fontSize}px ui-rounded, system-ui, sans-serif`;
    ctx.fillStyle=t.color||'#1a1a1a';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    try{ctx.fillText(t.str||'',t.fx*w,t.fy*h);}catch(e){}
  }
  return cv.toDataURL('image/png');
}
function renderPages(){
  const panel=document.getElementById('pagesPanel'); panel.innerHTML='';
  state.pages.forEach((p,i)=>{
    const row=document.createElement('div'); row.className='page-row';
    // Action buttons (left of thumbnail)
    const acts=document.createElement('div'); acts.className='page-actions';
    const bgBtn=document.createElement('button'); bgBtn.className='page-act-btn'; bgBtn.title='Arkaplan seç';
    bgBtn.textContent='🎨';
    bgBtn.onclick=ev=>{ ev.stopPropagation(); openBgPick(i); };
    const charBtn=document.createElement('button'); charBtn.className='page-act-btn char-btn'; charBtn.title='Karakter ekle';
    charBtn.textContent='+';
    charBtn.onclick=ev=>{ ev.stopPropagation(); openCharPick(i); };
    acts.append(bgBtn,charBtn);
    // Thumbnail
    const thumb=document.createElement('div'); thumb.className='page-thumb'+(i===state.current?' active':'');
    const img=document.createElement('img'); img.src=renderPageThumbSync(p,92,69); img.alt='Sayfa '+(i+1);
    const num=document.createElement('span'); num.className='page-num'; num.textContent=i+1;
    const del=document.createElement('button'); del.className='page-del'; del.textContent='×'; del.title='Sayfayı sil';
    if(state.pages.length<=1) del.style.display='none';
    del.onclick=async ev=>{
      ev.stopPropagation();
      if(state.pages.length<=1){ showToast('En az bir sayfa olmalı','err'); return; }
      const onay=await confirmModal({
        title:'Sayfayı sil',
        okText:'Evet, sil',
        cancelText:'Vazgeç',
        bodyHtml:'<b>Sayfa '+(i+1)+'</b> silinecek. Bu sayfadaki tüm karakterler kaldırılır.<div class="warnline">↶ Gerekirse Geri Al ile işlemi geri çevirebilirsin.</div>'
      });
      if(!onay) return;
      checkpoint();
      state.pages.splice(i,1); state.current=Math.max(0,Math.min(state.current,state.pages.length-1)); state.selected=null; state.selectedText=null; render();
    };
    thumb.append(img,num,del);
    const selectPage=()=>{ state.current=i; state.selected=null; state.selectedText=null; render(); };
    thumb.onclick=selectPage; thumb.tabIndex=0; thumb.setAttribute('role','button'); thumb.setAttribute('aria-label','Sayfa '+(i+1)+' seç');
    thumb.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===thumb){e.preventDefault();selectPage();}};
    row.append(acts,thumb);
    panel.appendChild(row);
  });
  const add=document.createElement('button'); add.className='add-page'; add.textContent='+'; add.title=state.pages.length>=MAX_PAGES?'ScratchJr en fazla 4 sayfa destekler':'Yeni sayfa ekle';
  add.disabled=state.pages.length>=MAX_PAGES; add.setAttribute('aria-label',add.title);
  add.onclick=()=>{ if(state.pages.length>=MAX_PAGES){showToast('ScratchJr en fazla 4 sayfa destekler','err');return;} checkpoint(); state.pages.push(newPage()); state.current=state.pages.length-1; state.selected=null; state.selectedText=null; render(); };
  panel.appendChild(add);
}
const stageEl=document.getElementById('stage');

/* ---------- koordinat ızgarası ---------- */
let _gridVisible=false;
function initGridLabels(){
  const rowWrap=document.getElementById('stageRowLabels');
  const colWrap=document.getElementById('stageColLabels');
  // rows 1 (bottom) → 15 (top); flex-direction:column-reverse so first child = row 1
  for(let i=1;i<=15;i++){
    const el=document.createElement('div');
    el.className='stage-lbl'; el.dataset.row=i; el.textContent=i;
    rowWrap.appendChild(el);
  }
  // cols 1 (left) → 20 (right)
  for(let i=1;i<=20;i++){
    const el=document.createElement('div');
    el.className='stage-lbl'; el.dataset.col=i; el.textContent=i;
    colWrap.appendChild(el);
  }
}
function updateGridLabels(){
  document.querySelectorAll('#stageRowLabels .stage-lbl,#stageColLabels .stage-lbl')
    .forEach(el=>el.classList.remove('hl'));
  const sel=getSel();
  if(!sel) return;
  const col=Math.max(1,Math.min(20,Math.ceil(sel.fx*20)));
  const row=Math.max(1,Math.min(15,Math.ceil((1-sel.fy)*15)));
  const rEl=document.querySelector(`#stageRowLabels [data-row="${row}"]`);
  const cEl=document.querySelector(`#stageColLabels [data-col="${col}"]`);
  if(rEl) rEl.classList.add('hl');
  if(cEl) cEl.classList.add('hl');
}

document.getElementById('gridToggleBtn').addEventListener('click',()=>{
  _gridVisible=!_gridVisible;
  document.getElementById('gridToggleBtn').classList.toggle('active',_gridVisible);
  const gridEl=stageEl.querySelector('.grid');
  if(gridEl) gridEl.style.opacity=_gridVisible?'0.5':'0';
  updateGridLabels();
});

function renderStage(){
  const page=state.pages[state.current];
  [...stageEl.querySelectorAll('.sprite,.bgimg,.empty,.stage-text')].forEach(n=>n.remove());
  if(page.bg.mode==='color'){ stageEl.style.background=page.bg.color; }
  else { stageEl.style.background='#fff'; const bi=document.createElement('img'); bi.className='bgimg'; bi.src=page.bg.asset.dataURL; bi.alt=''; stageEl.insertBefore(bi,stageEl.querySelector('.grid')); }
  if(page.chars.length===0){ const e=document.createElement('div'); e.className='empty'; e.textContent='Karakterler sekmesinden bir karaktere tıklayarak sahneye ekle 🐱'; stageEl.appendChild(e); }
  const sw=stageEl.clientWidth, sh=stageEl.clientHeight;
  page.chars.forEach(c=>{
    const el=document.createElement('div'); el.className='sprite'+(c.id===state.selected?' sel':'')+(c.flip?' flip':''); el.dataset.id=c.id;
    const dispW=c.sizePct/100*sw, dispH=dispW*c.aspect;
    el.style.width=dispW+'px'; el.style.height=dispH+'px'; el.style.left=(c.fx*sw-dispW/2)+'px'; el.style.top=(c.fy*sh-dispH/2)+'px';
    const img=document.createElement('img'); img.src=c.asset.dataURL; img.alt=c.name; el.appendChild(img);
    stageEl.appendChild(el); attachDrag(el,c);
  });
  (page.texts||[]).forEach(t=>{
    const tel=document.createElement('div');
    tel.className='stage-text'+(t.id===state.selectedText?' sel':'');
    tel.dataset.textId=t.id;
    const scale=sw/STAGE_W;
    tel.style.fontSize=(t.fontsize*scale)+'px';
    tel.style.color=t.color;
    tel.style.left=(t.fx*sw)+'px';
    tel.style.top=(t.fy*sh)+'px';
    tel.textContent=t.str||'';
    stageEl.appendChild(tel);
    attachTextDrag(tel,t);
  });
  const gridEl=stageEl.querySelector('.grid');
  if(gridEl) gridEl.style.opacity=_gridVisible?'0.5':'0';
  updateGridLabels();
}
function renderSelPanel(){
  const sb=document.getElementById('selSidebar');
  const page=state.pages[state.current];
  const chars=page?page.chars:[];
  if(!chars.length){ sb.classList.remove('show'); return; }
  sb.classList.add('show');

  // sol: thumbnail listesi
  const list=document.getElementById('sidebarCharList');
  list.innerHTML='';
  chars.forEach(c=>{
    const thumb=document.createElement('div');
    thumb.className='sidebar-char-thumb'+(state.selected===c.id?' sel':'');
    const img=document.createElement('img');
    img.src=c.asset.dataURL||''; img.alt=c.name||'';
    img.style.transform=c.flip?'scaleX(-1)':'none';
    thumb.appendChild(img);
    const selectChar=()=>{ state.selected=c.id; state.selectedText=null; renderStage(); renderSelPanel(); renderTextPanel(); };
    thumb.onclick=selectChar; thumb.tabIndex=0; thumb.setAttribute('role','button'); thumb.setAttribute('aria-label',(c.name||'Karakter')+' seç');
    thumb.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectChar();}};
    list.appendChild(thumb);
  });

  // sağ: detay paneli
  const sel=getSel();
  const isEmpty=document.getElementById('sidebarDetailEmpty');
  const controls=['sidebarCharName','flipBtn','delBtn','sidebarSizeLbl','sidebarSizeRow','sizeRange'];
  if(sel){
    isEmpty.style.display='none';
    controls.forEach(id=>document.getElementById(id).style.display='');
    document.getElementById('sidebarCharName').textContent=sel.name||'Karakter';
    const v=Math.round(sel.sizePct);
    document.getElementById('sizePctVal').textContent=v+'%';
    document.getElementById('sizeRange').value=v;
  } else {
    isEmpty.style.display='';
    controls.forEach(id=>document.getElementById(id).style.display='none');
  }
}
function getSel(){ return state.pages[state.current].chars.find(c=>c.id===state.selected); }
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

/* ---------- sürükleme ---------- */
function attachDrag(el,c){
  el.addEventListener('pointerdown',e=>{
    e.preventDefault();
    state.selected=c.id;
    state.selectedText=null;
    stageEl.querySelectorAll('.sprite').forEach(s=>s.classList.toggle('sel',s.dataset.id===c.id));
    stageEl.querySelectorAll('.stage-text').forEach(s=>s.classList.remove('sel'));
    renderSelPanel();
    renderTextPanel();
    const rect=stageEl.getBoundingClientRect();
    checkpoint();
    el.setPointerCapture(e.pointerId); el.style.cursor='grabbing';
    const move=ev=>{
      c.fx=Math.max(0,Math.min(1,(ev.clientX-rect.left)/rect.width));
      c.fy=Math.max(0,Math.min(1,(ev.clientY-rect.top)/rect.height));
      const dispW=c.sizePct/100*rect.width,dispH=dispW*c.aspect;
      el.style.left=(c.fx*rect.width-dispW/2)+'px';
      el.style.top=(c.fy*rect.height-dispH/2)+'px';
      updateGridLabels();
    };
    const up=()=>{ el.removeEventListener('pointermove',move); el.removeEventListener('pointerup',up); el.removeEventListener('pointercancel',up); el.style.cursor='grab'; renderPages(); scheduleAutosave(); };
    el.addEventListener('pointermove',move); el.addEventListener('pointerup',up); el.addEventListener('pointercancel',up);
  });
}

/* ---------- yazı paneli ---------- */
const TEXT_COLORS=['#1a1a1a','#e84040','#f08030','#e8c000','#40b840','#2880e0','#8f56e3','#e860a0'];

function colorToHex(color){
  if(!color) return '#1a1a1a';
  const rgb=color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if(rgb) return '#'+[rgb[1],rgb[2],rgb[3]].map(n=>parseInt(n).toString(16).padStart(2,'0')).join('');
  if(color.startsWith('#')){
    return color.length===4?'#'+color[1]+color[1]+color[2]+color[2]+color[3]+color[3]:color;
  }
  return '#1a1a1a';
}

function getSelText(){ return (state.pages[state.current].texts||[]).find(t=>t.id===state.selectedText); }

function renderTextPanel(){
  const page=state.pages[state.current];
  const texts=page.texts=page.texts||[];
  if(state.selectedText&&!texts.find(t=>t.id===state.selectedText)) state.selectedText=null;
  const list=document.getElementById('textItemList');
  list.innerHTML='';
  if(!texts.length){
    const e=document.createElement('div'); e.className='text-empty-msg';
    e.textContent='Henüz yazı yok. + ile ekle.'; list.appendChild(e);
  } else {
    texts.forEach(t=>{
      const item=document.createElement('div');
      item.className='text-item'+(t.id===state.selectedText?' sel':'');
      const preview=document.createElement('span');
      preview.className='text-item-preview'; preview.style.color=t.color;
      preview.textContent=t.str||'(boş)';
      item.appendChild(preview);
      const selectText=()=>{ state.selectedText=t.id; state.selected=null;
        stageEl.querySelectorAll('.sprite').forEach(s=>s.classList.remove('sel'));
        stageEl.querySelectorAll('.stage-text').forEach(s=>s.classList.toggle('sel',s.dataset.textId===t.id));
        renderTextPanel(); renderSelPanel(); };
      item.onclick=selectText; item.tabIndex=0; item.setAttribute('role','button'); item.setAttribute('aria-label',(t.str||'Boş yazı')+' seç');
      item.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectText();}};
      list.appendChild(item);
    });
  }
  const editPanel=document.getElementById('textEditPanel');
  const sel=getSelText();
  if(sel){
    editPanel.style.display='flex';
    const inp=document.getElementById('textStrInput');
    if(inp!==document.activeElement) inp.value=sel.str;
    document.getElementById('textSizeVal').textContent=sel.fontsize;
    const colorRow=document.getElementById('textColorRow'); colorRow.innerHTML='';
    const selHex=colorToHex(sel.color);
    TEXT_COLORS.forEach(c=>{
      const sw=document.createElement('div');
      sw.className='text-color-swatch'+(selHex===c?' active':'');
      sw.style.background=c; sw.title=c;
      sw.tabIndex=0; sw.setAttribute('role','button'); sw.setAttribute('aria-label','Yazı rengini '+c+' yap');
      const setColor=()=>{checkpoint(); sel.color=c; renderTextPanel(); renderStage(); renderPages(); scheduleAutosave();};
      sw.onclick=setColor; sw.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setColor();}};
      colorRow.appendChild(sw);
    });
    const custom=document.createElement('input');
    custom.type='color'; custom.className='text-custom-color'; custom.title='Özel renk';
    custom.value=selHex;
    custom.onpointerdown=()=>checkpoint();
    custom.oninput=e=>{ sel.color=e.target.value; renderTextPanel(); renderStage(); renderPages(); scheduleAutosave(); };
    colorRow.appendChild(custom);
  } else {
    editPanel.style.display='none';
  }
}

function attachTextDrag(el,t){
  el.addEventListener('pointerdown',e=>{
    e.preventDefault();
    state.selectedText=t.id; state.selected=null;
    stageEl.querySelectorAll('.stage-text').forEach(s=>s.classList.toggle('sel',s.dataset.textId===t.id));
    stageEl.querySelectorAll('.sprite').forEach(s=>s.classList.remove('sel'));
    renderTextPanel(); renderSelPanel();
    const rect=stageEl.getBoundingClientRect();
    checkpoint();
    el.setPointerCapture(e.pointerId); el.style.cursor='grabbing';
    const move=ev=>{
      t.fx=Math.max(0,Math.min(1,(ev.clientX-rect.left)/rect.width));
      t.fy=Math.max(0,Math.min(1,(ev.clientY-rect.top)/rect.height));
      el.style.left=(t.fx*rect.width)+'px';
      el.style.top=(t.fy*rect.height)+'px';
    };
    const up=()=>{ el.removeEventListener('pointermove',move); el.removeEventListener('pointerup',up); el.removeEventListener('pointercancel',up); el.style.cursor='grab'; renderPages(); scheduleAutosave(); };
    el.addEventListener('pointermove',move); el.addEventListener('pointerup',up); el.addEventListener('pointercancel',up);
  });
}

document.getElementById('textAddBtn').onclick=()=>{
  checkpoint();
  const page=state.pages[state.current];
  page.texts=page.texts||[];
  const t={id:nextId(),str:'Yazı',color:TEXT_COLORS[5],fontsize:16,fx:0.5,fy:0.5};
  page.texts.push(t); state.selectedText=t.id; state.selected=null;
  renderTextPanel(); renderStage(); renderSelPanel(); renderPages();
};

document.getElementById('textStrInput').addEventListener('focus',()=>checkpoint());
document.getElementById('textStrInput').addEventListener('input',e=>{
  const t=getSelText(); if(!t) return;
  t.str=e.target.value;
  const tel=stageEl.querySelector(`.stage-text[data-text-id="${t.id}"]`);
  if(tel) tel.textContent=t.str;
  const listEl=document.querySelector('#textItemList .text-item.sel .text-item-preview');
  if(listEl){ listEl.textContent=t.str||'(boş)'; listEl.style.color=t.color; }
  renderPages(); scheduleAutosave();
});

document.getElementById('textSizeDown').onclick=()=>{
  const t=getSelText(); if(!t) return; checkpoint();
  t.fontsize=Math.max(8,t.fontsize-2);
  document.getElementById('textSizeVal').textContent=t.fontsize;
  renderStage(); renderPages(); scheduleAutosave();
};
document.getElementById('textSizeUp').onclick=()=>{
  const t=getSelText(); if(!t) return; checkpoint();
  t.fontsize=Math.min(96,t.fontsize+2);
  document.getElementById('textSizeVal').textContent=t.fontsize;
  renderStage(); renderPages(); scheduleAutosave();
};

document.getElementById('textDelBtn').onclick=async()=>{
  const t=getSelText(); if(!t) return;
  const onay=await confirmModal({
    title:'Yazıyı sil',
    bodyHtml:`<b>"${escapeHtml(t.str||'')}"</b> silinsin mi?`,
    okText:'Evet, sil', cancelText:'Vazgeç'
  });
  if(!onay) return;
  checkpoint();
  const page=state.pages[state.current];
  page.texts=page.texts.filter(z=>z!==t);
  state.selectedText=null; renderTextPanel(); renderStage(); renderPages();
};

/* ---------- kontroller ---------- */
function changeSizePct(val){ const c=getSel(); if(!c)return; c.sizePct=Math.max(4,Math.min(100,val)); renderStage(); renderSelPanel(); renderPages(); scheduleAutosave(); }
document.getElementById('sizeDown').onclick=()=>{ const c=getSel(); if(c){checkpoint();changeSizePct(c.sizePct-5);} };
document.getElementById('sizeUp').onclick=()=>{ const c=getSel(); if(c){checkpoint();changeSizePct(c.sizePct+5);} };
document.getElementById('sizeRange').addEventListener('pointerdown',()=>{if(getSel())checkpoint();});
document.getElementById('sizeRange').addEventListener('input',e=>changeSizePct(+e.target.value));
document.getElementById('flipBtn').onclick=()=>{ const c=getSel(); if(!c)return showToast('Önce bir karakter seç'); checkpoint(); c.flip=!c.flip; renderStage(); renderSelPanel(); renderPages(); scheduleAutosave(); };
document.getElementById('delBtn').onclick=async()=>{
  const c=getSel(); if(!c)return showToast('Önce bir karakter seç');
  const onay=await confirmModal({
    title:'Karakteri sil',
    bodyHtml:`<b>${escapeHtml(c.name||'Karakter')}</b> bu sayfadan kaldırılsın mı?`,
    okText:'Evet, sil', cancelText:'Vazgeç'
  });
  if(!onay) return;
  checkpoint();
  const p=state.pages[state.current]; p.chars=p.chars.filter(z=>z!==c);
  state.selected=null; renderStage(); renderSelPanel(); renderPages();
};

/* ---------- yüklemeler ---------- */
document.getElementById('charUpload').onclick=()=>document.getElementById('charFile').click();
document.getElementById('charFile').addEventListener('change',async e=>{
  const files=[...e.target.files]; e.target.value='';
  if(files.length) checkpoint();
  for(const f of files){ try{ assertFileSize(f,MAX_IMAGE_BYTES,'Karakter dosyası'); const a=await fileToAsset(f); addCharToLib(a, baseName(f.name)); }catch(err){ console.error(err); showToast((err.message||'Okunamadı')+': '+f.name,'err'); } }
  renderBadges(); renderCharLib(); showToast(files.length>1?files.length+' karakter eklendi':'Karakter kütüphaneye eklendi');
});
document.getElementById('bgUpload').onclick=()=>document.getElementById('bgFile').click();
document.getElementById('bgFile').addEventListener('change',async e=>{
  const files=[...e.target.files]; e.target.value='';
  if(files.length) checkpoint();
  for(const f of files){ try{ assertFileSize(f,MAX_IMAGE_BYTES,'Arkaplan dosyası'); const a=await fileToBackgroundAsset(f); const it=addBgToLib(a, baseName(f.name)); if(files.length===1) applyBg(it); }catch(err){ showToast(err.message||'Arkaplan okunamadı','err'); } }
  renderBadges(); renderBgTab(); renderStage(); renderPages(); scheduleAutosave(); showToast('Arkaplan eklendi');
});
document.getElementById('bgColor').addEventListener('pointerdown',()=>checkpoint());
document.getElementById('bgColor').addEventListener('input',e=>{ state.pages[state.current].bg={mode:'color',color:e.target.value,asset:null,bgId:null}; renderBgTab(); renderStage(); renderPages(); scheduleAutosave(); });
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
(function(){
  // State
  let mediaRecorder=null, stream=null, chunks=[], actx=null, analyser=null, mediaSource=null;
  let animId=null, playAnimId=null;
  let isRecording=false, startTime=0, waveData=[], lastSampleAt=0, discardOnStop=false;
  let recBlob=null, blobUrl=null;
  let trimStart=0, trimEnd=1;
  let dragHandle=null, dragStartX=0, dragStartPct=0;
  const SAMPLE_MS=50, MAX_MS=60000;

  // Elements
  const overlay=document.getElementById('srecOverlay');
  const cvs=document.getElementById('srecCanvas');
  const vizEl=document.getElementById('srecViz');
  const timer=document.getElementById('srecTimer');
  const recBtn=document.getElementById('srecRecBtn');
  const playBtn=document.getElementById('srecPlayBtn');
  const stopBtn=document.getElementById('srecStopBtn');
  const addBtn=document.getElementById('srecAddBtn');
  const audio=document.getElementById('srecAudio');
  const tl=document.getElementById('srecTL');
  const tr=document.getElementById('srecTR');
  const ol=document.getElementById('srecOL');
  const or_=document.getElementById('srecOR');

  function nextName(){
    const used=state.sounds.map(s=>s.name);
    for(let i=0;i<26;i++){
      const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i];
      if(!used.includes('Ses '+n)) return 'Ses '+n;
    }
    return 'Ses '+(state.sounds.length+1);
  }

  function fmtTime(ms){
    const s=Math.floor(ms/1000)%60, m=Math.floor(ms/60000), cs=Math.floor((ms%1000)/10);
    return '00:'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(cs).padStart(2,'0');
  }

  function resizeCvs(){
    cvs.width=vizEl.clientWidth||440;
    cvs.height=vizEl.clientHeight||120;
  }

  function setPlayStop(pe,se){
    playBtn.disabled=!pe; playBtn.style.opacity=pe?'1':'.45';
    stopBtn.disabled=!se; stopBtn.style.opacity=se?'1':'.45';
  }

  // During recording: bars grow left-to-right based on elapsed time
  function drawLive(){
    const ctx=cvs.getContext('2d');
    const W=cvs.width, H=cvs.height, cy=H/2, maxH=cy*0.88;
    ctx.fillStyle='#ddf0f9'; ctx.fillRect(0,0,W,H);
    ctx.beginPath(); ctx.strokeStyle='#c4e9f6'; ctx.lineWidth=1;
    ctx.moveTo(0,cy); ctx.lineTo(W,cy); ctx.stroke();
    if(!waveData.length) return;
    const pxPerSlot=W/(MAX_MS/SAMPLE_MS);
    const barW=Math.max(1.5,pxPerSlot*0.75);
    ctx.beginPath(); ctx.strokeStyle='#1a7dc7'; ctx.lineWidth=barW; ctx.lineCap='round';
    for(let i=0;i<waveData.length;i++){
      const x=i*pxPerSlot+pxPerSlot/2;
      const h=waveData[i]*maxH;
      ctx.moveTo(x,cy-h); ctx.lineTo(x,cy+h);
    }
    ctx.stroke();
    const headX=waveData.length*pxPerSlot;
    ctx.beginPath(); ctx.strokeStyle='rgba(255,70,70,.7)'; ctx.lineWidth=2;
    ctx.moveTo(headX,0); ctx.lineTo(headX,H); ctx.stroke();
  }

  // After recording: full waveform stretched to canvas width
  function drawStatic(progress){
    const ctx=cvs.getContext('2d');
    const W=cvs.width, H=cvs.height, cy=H/2, maxH=cy*0.88;
    ctx.fillStyle='#ddf0f9'; ctx.fillRect(0,0,W,H);
    ctx.beginPath(); ctx.strokeStyle='#c4e9f6'; ctx.lineWidth=1;
    ctx.moveTo(0,cy); ctx.lineTo(W,cy); ctx.stroke();
    if(waveData.length){
      const n=waveData.length, pxPerSlot=W/n;
      const barW=Math.max(1.5,pxPerSlot*0.75);
      ctx.beginPath(); ctx.strokeStyle='#1a7dc7'; ctx.lineWidth=barW; ctx.lineCap='round';
      for(let i=0;i<n;i++){
        const x=i*pxPerSlot+pxPerSlot/2;
        const h=waveData[i]*maxH;
        ctx.moveTo(x,cy-h); ctx.lineTo(x,cy+h);
      }
      ctx.stroke();
    }
    if(progress!=null && progress>=0){
      const cx=(trimStart+(trimEnd-trimStart)*progress)*W;
      ctx.beginPath(); ctx.strokeStyle='#FF4444'; ctx.lineWidth=2;
      ctx.moveTo(cx,0); ctx.lineTo(cx,H); ctx.stroke();
    }
  }

  function drawIdle(){
    const ctx=cvs.getContext('2d'), cy=cvs.height/2;
    ctx.fillStyle='#ddf0f9'; ctx.fillRect(0,0,cvs.width,cvs.height);
    ctx.beginPath(); ctx.strokeStyle='#a0d8ef'; ctx.lineWidth=1;
    ctx.moveTo(0,cy); ctx.lineTo(cvs.width,cy); ctx.stroke();
  }

  // Trim handles
  function showTrim(){
    trimStart=0; trimEnd=1;
    [tl,tr,ol,or_].forEach(el=>el.style.display='block');
    updateTrim();
  }
  function hideTrim(){
    [tl,tr,ol,or_].forEach(el=>el.style.display='none');
  }
  function updateTrim(){
    const W=vizEl.clientWidth||cvs.width;
    const lx=trimStart*W, rx=trimEnd*W;
    tl.style.left=lx+'px';
    tr.style.left=(rx-14)+'px';
    ol.style.width=lx+'px';
    or_.style.left=rx+'px'; or_.style.width=(W-rx)+'px';
  }
  function startDrag(handle,e){
    dragHandle=handle; dragStartX=e.clientX;
    dragStartPct=handle==='L'?trimStart:trimEnd;
    if(e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove',onDrag);
    document.addEventListener('pointerup',endDrag);
    document.addEventListener('pointercancel',endDrag);
    e.preventDefault();
  }
  function onDrag(e){
    const W=vizEl.clientWidth||cvs.width;
    const p=Math.max(0,Math.min(1,dragStartPct+(e.clientX-dragStartX)/W));
    if(dragHandle==='L') trimStart=Math.min(p,trimEnd-0.02);
    else trimEnd=Math.max(p,trimStart+0.02);
    updateTrim();
  }
  function endDrag(){
    dragHandle=null;
    document.removeEventListener('pointermove',onDrag);
    document.removeEventListener('pointerup',endDrag);
    document.removeEventListener('pointercancel',endDrag);
  }
  tl.onpointerdown=e=>startDrag('L',e);
  tr.onpointerdown=e=>startDrag('R',e);

  // WAV encoder
  function toWav(buf){
    const nc=buf.numberOfChannels,sr=buf.sampleRate,len=buf.length;
    const ab=new ArrayBuffer(44+len*nc*2),dv=new DataView(ab);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
    ws(0,'RIFF');dv.setUint32(4,36+len*nc*2,true);ws(8,'WAVE');
    ws(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);
    dv.setUint16(22,nc,true);dv.setUint32(24,sr,true);
    dv.setUint32(28,sr*nc*2,true);dv.setUint16(32,nc*2,true);dv.setUint16(34,16,true);
    ws(36,'data');dv.setUint32(40,len*nc*2,true);
    let o=44;
    for(let i=0;i<len;i++) for(let c=0;c<nc;c++){
      const s=Math.max(-1,Math.min(1,buf.getChannelData(c)[i]));
      dv.setInt16(o,s<0?s*0x8000:s*0x7FFF,true);o+=2;
    }
    return ab;
  }

  // Open / close
  function openModal(){
    if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}
    chunks=[];waveData=[];isRecording=false;recBlob=null;lastSampleAt=0;discardOnStop=false;
    trimStart=0;trimEnd=1;
    audio.src='';
    recBtn.classList.remove('recording');
    setPlayStop(false,false);
    addBtn.style.display='none'; addBtn.disabled=false; addBtn.textContent='✅ Projeye Ekle';
    hideTrim();
    timer.textContent='00:00:00.00';
    document.getElementById('srecTitle').textContent=nextName();
    overlay.classList.add('show');
    requestAnimationFrame(()=>{resizeCvs();drawIdle();});
  }

  function closeModal(){
    overlay.classList.remove('show');
    if(isRecording) stopRec(false);
    stopPlayback();
    cancelAnimationFrame(animId);
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
    if(mediaSource){try{mediaSource.disconnect();}catch(e){} mediaSource=null;}
    if(analyser){try{analyser.disconnect();}catch(e){} analyser=null;}
    if(actx){closeAudioContext(actx);actx=null;}
    if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}
    audio.removeAttribute('src'); audio.load();
    hideTrim();
    addBtn.style.display='none';
  }

  // Recording
  async function startRec(){
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
    catch(e){showToast('Mikrofon erisimi reddedildi');return;}
    actx=ensureAudioContext(actx);
    if(actx.state==='suspended') await actx.resume();
    analyser=actx.createAnalyser(); analyser.fftSize=1024;
    mediaSource=actx.createMediaStreamSource(stream); mediaSource.connect(analyser);
    chunks=[];waveData=[];lastSampleAt=0;discardOnStop=false;
    const mime=MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'audio/ogg';
    mediaRecorder=new MediaRecorder(stream,{mimeType:mime});
    mediaRecorder.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
    mediaRecorder.onstop=onRecStop;
    mediaRecorder.start(100);
    isRecording=true; startTime=Date.now();
    recBtn.classList.add('recording');
    const fbuf=new Uint8Array(analyser.frequencyBinCount);
    function loop(){
      if(!isRecording) return;
      const now=Date.now()-startTime;
      analyser.getByteTimeDomainData(fbuf);
      if(now-lastSampleAt>=SAMPLE_MS){
        let pk=0; for(let i=0;i<fbuf.length;i++) pk=Math.max(pk,Math.abs(fbuf[i]-128)/128);
        waveData.push(pk); lastSampleAt=now;
      }
      timer.textContent=fmtTime(now);
      drawLive();
      animId=requestAnimationFrame(loop);
    }
    loop();
    setTimeout(()=>{if(isRecording)stopRec(true);},MAX_MS);
  }

  function stopRec(keep){
    if(!mediaRecorder||mediaRecorder.state==='inactive') return;
    isRecording=false; discardOnStop=!keep;
    recBtn.classList.remove('recording');
    cancelAnimationFrame(animId);
    mediaRecorder.stop();
    if(stream){stream.getTracks().forEach(t=>t.stop()); stream=null;}
    if(!keep){waveData=[];drawIdle();}
  }

  async function onRecStop(){
    if(discardOnStop){chunks=[];recBlob=null;discardOnStop=false;return;}
    if(!chunks.length) return;
    const mime=chunks[0].type||'audio/webm';
    recBlob=new Blob(chunks,{type:mime});
    if(blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl=URL.createObjectURL(recBlob);
    audio.src=blobUrl;
    setPlayStop(true,false);
    drawStatic(null);
    showTrim();
    addBtn.style.display='block';
  }

  // Playback
  function stopPlayback(){
    audio.pause(); audio.currentTime=0;
    cancelAnimationFrame(playAnimId);
    setPlayStop(!!blobUrl,false);
    drawStatic(null);
  }

  playBtn.onclick=()=>{
    if(!blobUrl) return;
    audio.currentTime=(audio.duration||0)*trimStart;
    audio.play().catch(()=>{});
    setPlayStop(false,true);
    function ploop(){
      if(audio.paused||audio.ended){stopPlayback();return;}
      if(audio.duration&&audio.currentTime>=audio.duration*trimEnd){stopPlayback();return;}
      const prog=audio.duration?(audio.currentTime/audio.duration-trimStart)/(trimEnd-trimStart):0;
      drawStatic(Math.max(0,Math.min(1,prog)));
      playAnimId=requestAnimationFrame(ploop);
    }
    ploop();
  };
  stopBtn.onclick=stopPlayback;

  // Add to project with trim + WAV encode
  addBtn.onclick=async()=>{
    if(!recBlob) return;
    addBtn.disabled=true; addBtn.textContent='Ekleniyor…';
    let ac=null;
    try{
      const raw=await recBlob.arrayBuffer();
      ac=ensureAudioContext(null);
      const decoded=await ac.decodeAudioData(raw);
      const sStart=Math.floor(trimStart*decoded.length);
      const sEnd=Math.floor(trimEnd*decoded.length);
      const trimLen=Math.max(1,sEnd-sStart);
      const off=new OfflineAudioContext(decoded.numberOfChannels,trimLen,decoded.sampleRate);
      const src=off.createBufferSource();
      src.buffer=decoded; src.connect(off.destination);
      src.start(0,trimStart*decoded.duration,(trimEnd-trimStart)*decoded.duration);
      const trimmed=await off.startRendering();
      const wav=toWav(trimmed);
      const name=document.getElementById('srecTitle').textContent;
      checkpoint();
      state.sounds.push({id:nextId(),name,buf:wav,ext:'wav'});
      renderBadges(); renderSounds(); scheduleAutosave();
      showToast('Ses projeye eklendi');
      closeModal();
    }catch(e){
      showToast('Hata: '+e.message);
      addBtn.disabled=false; addBtn.textContent='✅ Projeye Ekle';
    }finally{
      if(ac) await closeAudioContext(ac);
    }
  };

  // Wire up
  document.getElementById('sndRecord').onclick=openModal;
  document.getElementById('srecClose').onclick=closeModal;
  overlay.addEventListener('click',e=>{if(e.target===overlay)closeModal();});
  recBtn.onclick=()=>{if(isRecording)stopRec(true);else startRec();};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('show')) closeModal();});
})();


let audioCtx=null, currentPlayingNode=null, currentPlayingId=null, _playStartTime=null, _playRafId=null;

function stopCurrentSound(){
  if(currentPlayingNode){
    try{currentPlayingNode.stop();}catch(e){}
    try{currentPlayingNode.disconnect();}catch(e){}
    currentPlayingNode=null;
  }
  currentPlayingId=null; _playStartTime=null;
  cancelAnimationFrame(_playRafId);
  renderSounds();
}

function togglePlaySound(s){
  if(currentPlayingId===s.id){ stopCurrentSound(); return; }
  stopCurrentSound();
  try{
    audioCtx=ensureAudioContext(audioCtx);
    if(audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
    audioCtx.decodeAudioData(s.buf.slice(0)).then(b=>{
      const node=audioCtx.createBufferSource();
      node.buffer=b; node.connect(audioCtx.destination);
      node.onended=()=>{ if(currentPlayingId===s.id){ currentPlayingNode=null; currentPlayingId=null; _playStartTime=null; cancelAnimationFrame(_playRafId); renderSounds(); } };
      node.start();
      currentPlayingNode=node; currentPlayingId=s.id; _playStartTime=Date.now();
      renderSounds();
      // animate progress cursor
      function tickCursor(){
        const cvs=document.querySelector('.soundlist [data-sid="'+s.id+'"]')?.closest('li')?.querySelector('.snd-wave');
        if(cvs) drawWaveCanvas(s,cvs);
        if(currentPlayingId===s.id) _playRafId=requestAnimationFrame(tickCursor);
      }
      tickCursor();
    }).catch(()=>showToast('Bu format önizlenemiyor (yine de dışa aktarılır)'));
  }catch(e){ showToast('Önizleme yapılamadı'); }
}

function playSound(s){ togglePlaySound(s); }

function disposeAudioResources(){
  stopCurrentSound();
  const contexts=[audioCtx,_waveAudioCtx];
  audioCtx=null; _waveAudioCtx=null;
  contexts.forEach(ctx=>closeAudioContext(ctx));
}
window.addEventListener('pagehide',disposeAudioResources);

/* ---------- dışa aktarma ---------- */
const md5str=s=>SparkMD5.hash(s); const md5buf=b=>SparkMD5.ArrayBuffer.hash(b);
function baseName(fn){ return (fn||'').replace(/\.[^.]+$/,'').replace(/[_\-]+/g,' ').trim().slice(0,24)||'Karakter'; }
function pad(n){return n<10?'0'+n:''+n;}
function nowCtime(){const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;}
async function renderThumb(page){
  const cv=document.createElement('canvas'); cv.width=STAGE_W; cv.height=STAGE_H; const ctx=cv.getContext('2d');
  if(page.bg.mode==='color'){ ctx.fillStyle=page.bg.color; ctx.fillRect(0,0,STAGE_W,STAGE_H); }
  else { ctx.fillStyle='#fff'; ctx.fillRect(0,0,STAGE_W,STAGE_H); drawCover(ctx,page.bg.asset.img,STAGE_W,STAGE_H); }
  for(const c of page.chars){ const dispW=c.sizePct/100*STAGE_W,dispH=dispW*c.aspect,x=c.fx*STAGE_W,y=c.fy*STAGE_H;
    ctx.save(); ctx.translate(x,y); if(c.flip)ctx.scale(-1,1); try{ctx.drawImage(c.asset.img,-dispW/2,-dispH/2,dispW,dispH);}catch(e){} ctx.restore(); }
  for(const t of (page.texts||[])){
    ctx.font=`600 ${t.fontsize||16}px ui-rounded, system-ui, sans-serif`;
    ctx.fillStyle=t.color||'#1a1a1a';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    try{ctx.fillText(t.str||'',t.fx*STAGE_W,t.fy*STAGE_H);}catch(e){}
  }
  return await new Promise(res=>cv.toBlob(b=>b.arrayBuffer().then(res),'image/png'));
}
function drawCover(ctx,img,W,H){ const iw=img.naturalWidth||img.width||W,ih=img.naturalHeight||img.height||H,r=Math.max(W/iw,H/ih),dw=iw*r,dh=ih*r;
  try{ctx.drawImage(img,(W-dw)/2,(H-dh)/2,dw,dh);}catch(e){} }

async function exportSRJ(pagesArg){
  if(typeof JSZip==='undefined') return showToast('Sıkıştırma kütüphanesi yüklenemedi (internet?)','err');
  const pages=Array.isArray(pagesArg)?pagesArg:state.pages;
  // Hiç sahneye eklenmemiş karakter uyarısı
  const btn=document.getElementById('exportBtn'); btn.disabled=true; const old=btn.textContent; btn.textContent='Hazırlanıyor…';
  try{
    const name=(document.getElementById('pname').value||'Benim Projem').trim();
    const zip=new JSZip(); const root=zip.folder('project');
    const charsDir=root.folder('characters'), bgDir=root.folder('backgrounds'), thumbDir=root.folder('thumbnails');
    let soundsDir=null; const soundFiles=[]; const soundOutBySource=new Map(); const usedSoundNames=new Set();
    if(state.sounds.length){ soundsDir=root.folder('sounds');
      for(const s of state.sounds){
        let fn=s.sourceFile ? String(s.sourceFile).replace(/^.*[\\/]/,'') : '';
        if(!fn || usedSoundNames.has(fn)) fn='SND'+md5buf(s.buf)+'.'+s.ext;
        usedSoundNames.add(fn); soundsDir.file(fn,s.buf); soundFiles.push(fn);
        if(s.sourceFile){
          soundOutBySource.set(String(s.sourceFile),fn);
          soundOutBySource.set(String(s.sourceFile).replace(/^.*[\\/]/,''),fn);
        }
      }
    }
    const mapSoundRef=ref=>{
      const raw=String(ref||''), base=raw.replace(/^.*[\\/]/,'');
      return soundOutBySource.get(raw)||soundOutBySource.get(base)||raw;
    };
    const newSoundFiles=state.sounds.map((s,i)=>s.sourceFile?null:soundFiles[i]).filter(Boolean);
    const charCache=new Map();
    function charFile(asset){ if(charCache.has(asset.svgText))return charCache.get(asset.svgText);
      const fn=md5str(asset.svgText)+'.svg'; charsDir.file(fn,asset.svgText); charCache.set(asset.svgText,fn); return fn; }
    function coverSvg(asset){ return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${STAGE_W}" height="${STAGE_H}" viewBox="0 0 ${STAGE_W} ${STAGE_H}"><image width="${STAGE_W}" height="${STAGE_H}" preserveAspectRatio="xMidYMid slice" href="${asset.dataURL}" xlink:href="${asset.dataURL}"/></svg>`; }
    function backgroundSvg(asset){ return selectBackgroundSvg(asset,coverSvg); }
    function colorSvg(color){ return `<svg xmlns="http://www.w3.org/2000/svg" width="${STAGE_W}" height="${STAGE_H}" viewBox="0 0 ${STAGE_W} ${STAGE_H}"><rect width="${STAGE_W}" height="${STAGE_H}" fill="${color}"/></svg>`; }

    const jsonObj=state.sjrJsonMeta ? cloneJson(state.sjrJsonMeta) : {};
    jsonObj.pages=[]; jsonObj.currentPage='page '+Math.min(pages.length,Math.max(1,state.current+1));
    let firstThumb=null;
    for(let i=0;i<pages.length;i++){
      const page=pages[i], key='page '+(i+1); jsonObj.pages.push(key);
      let bgName;
      if(page.bg.mode==='image'&&page.bg.asset){ const svg=backgroundSvg(page.bg.asset); bgName=md5str(svg)+'.svg'; bgDir.file(bgName,svg); }
      else { const svg=colorSvg(page.bg.color||'#ffffff'); bgName=md5str(svg)+'.svg'; bgDir.file(bgName,svg); }
      const pageObj=page.sjrMeta ? cloneJson(page.sjrMeta) : {textstartat:36};
      pageObj.sprites=[]; pageObj.md5=bgName; pageObj.num=i+1; pageObj.lastSprite='';
      const emittedIds=[], usedIds=new Set();
      const uniqueSpriteId=(preferred,fallback)=>{
        let id=(preferred||fallback||'Sprite').trim()||'Sprite', n=2, base=id;
        while(usedIds.has(id)) id=base+' '+(n++);
        usedIds.add(id); return id;
      };
      page.chars.forEach((c,idx)=>{
        const spId=uniqueSpriteId(c.sjrId,(c.name||'Karakter')+' '+(idx+1)), md5name=charFile(c.asset);
        const w=Math.round(c.asset.w),h=Math.round(c.asset.h),dispW=c.sizePct/100*STAGE_W,scale=+(dispW/w).toFixed(4);
        const xcoor=Math.round(c.fx*STAGE_W),ycoor=Math.round(c.fy*STAGE_H);
        pageObj.sprites.push(spId); emittedIds.push(spId); pageObj.lastSprite=spId;
        const originalMeta=c.sjrMeta ? cloneJson(c.sjrMeta) : {};
        const sp=mergeSpriteMeta(originalMeta,{shown:originalMeta.shown!==false,type:'sprite',md5:md5name,id:spId,flip:!!c.flip,name:c.name||'Karakter',
          angle:typeof originalMeta.angle==='number'?originalMeta.angle:0,scale,speed:typeof originalMeta.speed==='number'?originalMeta.speed:2,
          defaultScale:scale,xcoor,ycoor,cx:Math.round(w/2),cy:Math.round(h/2),w,h,
          homex:xcoor,homey:ycoor,homescale:scale,homeshown:originalMeta.homeshown!==false,homeflip:!!c.flip});
        sp.sounds=mergePreservedSounds(sp.sounds,mapSoundRef,newSoundFiles,soundFiles);
        pageObj[spId]=sp;
      });
      (page.texts||[]).forEach((t,ti)=>{
        const spId=uniqueSpriteId(t.sjrId,'Text '+(ti+1));
        const xcoor=Math.round(t.fx*STAGE_W), ycoor=Math.round(t.fy*STAGE_H);
        const wt=Math.max(1,Math.round((t.str||'').length*(t.fontsize||16)*0.594));
        const ht=Math.round((t.fontsize||16)*1.125);
        pageObj.sprites.push(spId); emittedIds.push(spId); pageObj.lastSprite=spId;
        const sp=t.sjrMeta ? cloneJson(t.sjrMeta) : {};
        Object.assign(sp,{shown:sp.shown!==false,type:'text',id:spId,
          speed:typeof sp.speed==='number'?sp.speed:2,
          cx:Math.round(wt/2),cy:Math.round(ht/2),w:wt,h:ht,
          xcoor,ycoor,homex:xcoor,homey:ycoor,
          str:t.str||'',color:t.color||'#1a1a1a',fontsize:t.fontsize||16});
        pageObj[spId]=sp;
      });
      const oldLayers=page.sjrMeta&&Array.isArray(page.sjrMeta.layers)?page.sjrMeta.layers:[];
      pageObj.layers=mergeLayerOrder(oldLayers,emittedIds);
      jsonObj[key]=pageObj;
      const tb=await renderThumb(page); const tn=i+'_'+md5buf(tb)+'.png'; thumbDir.file(tn,tb); if(i===0)firstThumb=tn;
    }
    // Karakter kütüphanesindeki kullanılmayan öğeleri de editör round-trip'i için koru.
    const charManifest=[];
    for(const it of state.charLib){
      if(!it.asset) continue;
      const fn=charFile(it.asset);
      charManifest.push({file:fn,displayName:it.name||'Karakter'});
    }
    // bgLib'deki tüm arkaplanları ZIP'e ekle (sayfalara atanmamış olanlar dahil)
    const bgManifest=[];
    for(const it of state.bgLib){
      if(!it.asset) continue;
      const svg=backgroundSvg(it.asset);
      const fn=md5str(svg)+'.svg';
      bgDir.file(fn,svg); // sayfa döngüsünde eklenmişse üzerine yazmak sorun değil
      bgManifest.push({file:fn, name:it.name||'Arkaplan'});
    }
    // srjlib.json — import sırasında tüm bgLib'i geri yüklemek için
    const sndManifest=state.sounds.map((s,i)=>({file:soundFiles[i], name:s.name}));
    root.file('srjlib.json', JSON.stringify({characters:charManifest, backgrounds:bgManifest, sounds:sndManifest}));

    const data=state.sjrDataMeta ? cloneJson(state.sjrDataMeta) : {};
    if(!data.id) data.id=String(Math.floor(Date.now()/1000));
    if(!data.ctime) data.ctime=new Date().toISOString();
    if(!data.version) data.version='Webv01';
    if(data.isgift==null) data.isgift='0';
    if(data.deleted==null) data.deleted='NO';
    data.name=name; data.mtime=String(Date.now());
    data.thumbnail={pagecount:pages.length,md5:firstThumb}; data.json=jsonObj;
    root.file('data.json', JSON.stringify(data));
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
    const safe=name.replace(/[^\p{L}\p{N} _-]/gu,'').trim()||'proje';
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=safe+'.sjr';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    showToast('✓ '+safe+'.sjr indirildi');
  }catch(err){ console.error(err); showToast('Dışa aktarma sırasında hata oluştu','err'); }
  finally{ btn.disabled=false; btn.textContent=old; }
}
document.getElementById('exportBtn').onclick=exportSRJ;

/* ---------- içe aktarma (.srj) ---------- */
function svgImageHref(svgText){
  try{ const im=new DOMParser().parseFromString(svgText,'image/svg+xml').querySelector('image');
    if(!im) return null;
    return im.getAttribute('href')||im.getAttribute('xlink:href')||im.getAttributeNS('http://www.w3.org/1999/xlink','href')||null;
  }catch(e){ return null; }
}
function svgRectFill(svgText){
  try{ const r=new DOMParser().parseFromString(svgText,'image/svg+xml').querySelector('rect');
    return r?(r.getAttribute('fill')||null):null;
  }catch(e){ return null; }
}
function solidColorSvgFill(svgText){
  try{
    const doc=new DOMParser().parseFromString(svgText,'image/svg+xml');
    if(doc.querySelector('parsererror')) return null;
    const svg=doc.documentElement;
    const kids=[...svg.children].filter(el=>!['defs','metadata','title','desc'].includes(el.tagName.toLowerCase()));
    if(kids.length!==1 || kids[0].tagName.toLowerCase()!=='rect') return null;
    return kids[0].getAttribute('fill')||null;
  }catch(e){ return null; }
}
async function svgTextToAsset(text,opts={}){
  const policy=inspectSvgCompatibility(text);
  if(policy.externalRefs) throw new Error('Projedeki SVG harici ağ kaynağı içeriyor');
  const hasImage=policy.hasEmbeddedImage;
  const {w,h}=svgDims(text);
  const dataURL='data:image/svg+xml;base64,'+b64(text);
  let img; try{ img=await loadImage(dataURL); }catch(e){ img=new Image(); }
  return { isSvg:true, vector:!hasImage, preserveSvg:!!opts.preserveSvg, svgText:text, dataURL, w:w||150, h:h||150, img };
}
function findZipFile(zip,candidates){
  for(const c of candidates){ const f=zip.file(c); if(f) return f; }
  const base=(candidates[0]||'').split('/').pop().toLowerCase();
  let found=null;
  zip.forEach((p,zf)=>{ if(!found && !zf.dir && p.toLowerCase().split('/').pop()===base) found=zf; });
  return found;
}

async function importSRJ(file){
  if(typeof JSZip==='undefined') throw new Error('Sıkıştırma kütüphanesi yüklenemedi');
  assertFileSize(file,MAX_SJR_BYTES,'.sjr dosyası');
  const zip=await JSZip.loadAsync(file);
  assertZipSafety(zip);

  // data.json'u bul (genelde project/data.json)
  let dataFile=null;
  zip.forEach((p,zf)=>{ if(!dataFile && !zf.dir && /(^|\/)data\.json$/i.test(p)) dataFile=zf; });
  if(!dataFile) throw new Error('Geçerli bir .srj değil: data.json bulunamadı');
  const prefix=dataFile.name.replace(/data\.json$/i,'');           // ör. "project/"
  const data=JSON.parse(await dataFile.async('string'));
  const wrappedData=!!(data && data.json);
  const J=wrappedData ? data.json : (data||{});
  const pageKeys=Array.isArray(J.pages)?J.pages:[];
  if(pageKeys.length>MAX_PAGES) throw new Error('Bu proje '+pageKeys.length+' sayfa içeriyor. ScratchJr en fazla '+MAX_PAGES+' sayfa destekler.');

  const ns={ pages:[], current:resolveCurrentPageIndex(J.currentPage,pageKeys), charLib:[], bgLib:[], sounds:[], selected:null, selectedText:null,
    sjrDataMeta:wrappedData?dataMetaWithoutJson(data):{}, sjrJsonMeta:jsonMetaWithoutPages(J,pageKeys) };
  const charLibByFile=new Map();   // karakter dosyası -> kütüphane öğesi
  const bgLibByFile=new Map();     // arkaplan dosyası -> kütüphane öğesi

  async function getCharLib(md5file){
    if(!md5file) return null;
    if(charLibByFile.has(md5file)) return charLibByFile.get(md5file);
    const f=findZipFile(zip,[prefix+'characters/'+md5file,'characters/'+md5file]);
    if(!f) return null;
    const asset=await svgTextToAsset(await f.async('string'));
    const it={ id:nextId(), name:'Karakter', asset };
    ns.charLib.push(it); charLibByFile.set(md5file,it); return it;
  }
  async function getBgLib(md5file,bgText){
    if(bgLibByFile.has(md5file)) return bgLibByFile.get(md5file);
    const asset=await svgTextToAsset(bgText,{preserveSvg:true});
    const it={ id:nextId(), name:'Arkaplan', asset };
    ns.bgLib.push(it); bgLibByFile.set(md5file,it); return it;
  }

  // kütüphane bildirimi: bu araçla "sadece kütüphane" olarak dışa aktarılmış dosyaları geri yükle
  let libManifest=null;
  const libFile=findZipFile(zip,[prefix+'srjlib.json','srjlib.json']);
  if(libFile){ try{ libManifest=JSON.parse(await libFile.async('string')); }catch(e){ libManifest=null; } }
  if(libManifest){
    // Yeni format: characters dizisi; eski format: chars dizisi — ikisini de destekle
    const charList=libManifest.characters||libManifest.chars||[];
    for(const c of charList){
      const it=await getCharLib(c.file);
      if(it){ it.name=c.displayName||c.name||'Karakter'; }
    }
    const bgList=libManifest.backgrounds||libManifest.bgs||[];
    for(const bb of bgList){
      const bf=findZipFile(zip,[prefix+'backgrounds/'+bb.file,'backgrounds/'+bb.file]);
      if(bf){ const t=await bf.async('string'); const it=await getBgLib(bb.file,t); if(it && bb.name) it.name=bb.name; }
    }
  }
  const sndNameByFile={}; if(libManifest) for(const sm of (libManifest.sounds||[])) sndNameByFile[sm.file]=sm.name;

  // sesler (sounds/ klasöründeki ses dosyaları)
  const sndList=[];
  zip.forEach((p,zf)=>{ if(!zf.dir && /(^|\/)sounds\//i.test(p) && /\.(wav|mp3|webm|m4a|ogg)$/i.test(p)) sndList.push({path:p,f:zf}); });
  let sN=0;
  for(const s of sndList){
    let ext=(s.path.split('.').pop()||'wav').toLowerCase();
    if(!['wav','mp3','webm','m4a','ogg'].includes(ext)) ext='wav';
    const base=s.path.split('/').pop();
    ns.sounds.push({ id:nextId(), name: sndNameByFile[base] || ('Ses '+(++sN)), buf:await s.f.async('arraybuffer'), ext, sourceFile:base });
  }

  // sayfalar
  for(let i=0;i<pageKeys.length;i++){
    const po=J[pageKeys[i]];
    const page=newPage();
    if(po){
      page.sjrMeta=pageMetaWithoutSprites(po);
      // arkaplan
      if(po.md5){
        const bf=findZipFile(zip,[prefix+'backgrounds/'+po.md5,'backgrounds/'+po.md5]);
        if(bf){
          const bgText=await bf.async('string');
          const solidFill=solidColorSvgFill(bgText);
          if(solidFill){
            page.bg={ mode:'color', color:solidFill, asset:null, bgId:null };
          } else {
            const it=await getBgLib(po.md5,bgText);
            if(it) page.bg={ mode:'image', asset:it.asset, color:'#fff', bgId:it.id };
          }
        }
      }
      // karakterler
      const sprites=Array.isArray(po.sprites)?po.sprites:[];
      for(const spId of sprites){
        const sp=po[spId]; if(!sp) continue;
        if(sp.type==='text'){
          const fx=((typeof sp.xcoor==='number')?sp.xcoor:STAGE_W/2)/STAGE_W;
          const fy=((typeof sp.ycoor==='number')?sp.ycoor:STAGE_H/2)/STAGE_H;
          page.texts=page.texts||[];
          page.texts.push({id:nextId(),str:sp.str||'',
            color:colorToHex(sp.color||'#1a1a1a'),fontsize:sp.fontsize||16,
            fx:Math.max(0,Math.min(1,fx)),fy:Math.max(0,Math.min(1,fy)),
            sjrId:spId,sjrMeta:cloneJson(sp)});
          continue;
        }
        if(sp.type!=='sprite') continue;
        const lib=await getCharLib(sp.md5); if(!lib) continue;
        if(sp.name && lib.name==='Karakter') lib.name=sp.name;
        const w=sp.w||lib.asset.w||150, h=sp.h||lib.asset.h||150, aspect=h/w;
        const scale=(typeof sp.scale==='number')?sp.scale:((typeof sp.defaultScale==='number')?sp.defaultScale:(STAGE_W*0.27/w));
        const sizePct=Math.max(4,Math.min(100,(scale*w)/STAGE_W*100));
        const fx=((typeof sp.xcoor==='number')?sp.xcoor:STAGE_W/2)/STAGE_W;
        const fy=((typeof sp.ycoor==='number')?sp.ycoor:STAGE_H/2)/STAGE_H;
        page.chars.push({ id:nextId(), libId:lib.id, name:sp.name||lib.name||'Karakter',
          asset:lib.asset, fx:Math.max(0,Math.min(1,fx)), fy:Math.max(0,Math.min(1,fy)), sizePct, flip:!!sp.flip, aspect,
          sjrId:spId,sjrMeta:cloneJson(sp) });
      }
    }
    ns.pages.push(page);
  }
  if(!ns.pages.length) ns.pages.push(newPage());

  // mevcut durumu tamamen değiştir
  Object.assign(state,ns); state.current=Math.max(0,Math.min(ns.current,ns.pages.length-1)); state.selected=null;
  document.getElementById('pname').value=(data && data.name)?String(data.name).slice(0,40):'Benim Projem';
  render(); setTab('chars');
}

document.getElementById('importBtn').onclick=()=>document.getElementById('srjFile').click();
document.getElementById('srjFile').addEventListener('change',async e=>{
  const file=e.target.files[0]; e.target.value='';
  if(!file) return;
  const onay=await confirmModal({
    title:'İçe aktarma',
    okText:'Evet, içe aktar',
    cancelText:'Vazgeç',
    bodyHtml:'Bu işlem <b>şu anki tüm çalışmanı</b> — karakterler, arkaplanlar, sesler ve sahneler — '
      +'kaldırıp yerine <span class="fname">'+escapeHtml(file.name)+'</span> dosyasındaki projeyi yükler.'
      +'<div class="warnline">↶ İçe aktardıktan sonra gerekirse Geri Al ile önceki çalışmana dönebilirsin.</div>'
  });
  if(!onay){ showToast('İçe aktarma iptal edildi'); return; }
  checkpoint();
  const btn=document.getElementById('importBtn'); btn.disabled=true; const old=btn.textContent; btn.textContent='Yükleniyor…';
  try{
    await importSRJ(file);
    showToast('✓ Proje içe aktarıldı — düzenleyip yeniden dışa aktarabilirsin');
  }catch(err){
    console.error(err);
    showToast('İçe aktarılamadı: '+(err.message||'dosya okunamadı'),'err');
  }finally{ btn.disabled=false; btn.textContent=old; }
});

/* ---------- modal onayı ---------- */
function confirmModal(opts){
  opts=opts||{};
  return new Promise(res=>{
    const ov=document.getElementById('confirmOverlay');
    const okBtn=document.getElementById('confirmOk'), cancelBtn=document.getElementById('confirmCancel');
    document.getElementById('confirmTitle').textContent=opts.title||'Emin misin?';
    document.getElementById('confirmBody').innerHTML=opts.bodyHtml||'';
    okBtn.textContent=opts.okText||'Evet';
    cancelBtn.textContent=opts.cancelText||'Vazgeç';
    function close(val){
      ov.classList.remove('show');
      okBtn.removeEventListener('click',onOk); cancelBtn.removeEventListener('click',onCancel);
      ov.removeEventListener('click',onBackdrop); document.removeEventListener('keydown',onKey);
      res(val);
    }
    const onOk=()=>close(true), onCancel=()=>close(false);
    const onBackdrop=e=>{ if(e.target===ov) close(false); };
    const onKey=e=>{ if(e.key==='Escape') close(false); else if(e.key==='Enter') close(true); };
    okBtn.addEventListener('click',onOk); cancelBtn.addEventListener('click',onCancel);
    ov.addEventListener('click',onBackdrop); document.addEventListener('keydown',onKey);
    ov.classList.add('show'); okBtn.focus();
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
    {ok:!a.externalRefs,label:'Harici ağ kaynağı',value:a.externalRefs?'Var':'Yok',
      errNote:'Offline çalışma ve güvenlik için http(s) kaynakları kabul edilmez.'},
    {ok:a.transformCount===0,label:'Transform',value:a.transformCount?a.transformCount+' adet':'Yok',
      errNote:'Transform içeren yüklemeler görünümü korumak için raster fallback kullanır.'},
    {ok:a.arcPaths===0,label:'Arc komutu A/a',value:a.arcPaths?a.arcPaths+' path':'Yok',
      errNote:'Arc içeren yüklemeler doğrudan vektör normalize edilmez; raster fallback kullanılır.'},
    {ok:a.unsupportedCount===0,label:'Ek geometri',value:unsupported,
      errNote:'rect/ellipse/line/polyline/text/use gibi yapılar doğrudan vektör yoluna alınmaz.'},
    {ok:a.effectCount===0,label:'Clip / mask / gradient / filter',value:effects,
      errNote:'Efektli SVG görünümü korunmak için raster fallback kullanır.'},
    {ok:a.styleCount===0,label:'style attribute',value:a.styleCount?a.styleCount+' adet':'Yok',
      errNote:'CSS style içeren SVG otomatik normalizasyonda raster fallback kullanır.'},
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
  document.getElementById('infoOverlay').classList.add('show');
}

document.getElementById('infoClose').onclick=()=>document.getElementById('infoOverlay').classList.remove('show');
document.getElementById('infoCloseBtn').onclick=()=>document.getElementById('infoOverlay').classList.remove('show');
document.getElementById('infoOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('infoOverlay'))document.getElementById('infoOverlay').classList.remove('show');});

/* ---------- arkaplan picker ---------- */
let bgPickTarget=null;
function openBgPick(pageIdx){
  bgPickTarget=pageIdx;
  document.getElementById('bgPickTitle').textContent='Arkaplan Seç — Sayfa '+(pageIdx+1);
  const grid=document.getElementById('bgPickGrid'); grid.innerHTML='';
  const empty=document.getElementById('bgPickEmpty');
  const curPg=state.pages[pageIdx];
  document.getElementById('bgPickColor').value=curPg.bg.mode==='color'?curPg.bg.color:'#eaf4ff';
  if(!state.bgLib.length){ empty.style.display='block'; grid.style.display='none'; }
  else {
    empty.style.display='none'; grid.style.display='';
    state.bgLib.forEach(it=>{
      const item=document.createElement('div'); item.className='pick-item bgitem';
      if(curPg.bg.bgId===it.id) item.style.borderColor='var(--blue)';
      const img=document.createElement('img'); img.src=it.asset.dataURL; img.alt=escapeHtml(it.name);
      const nm=document.createElement('div'); nm.className='nm'; nm.textContent=it.name;
      item.append(img,nm);
      const choose=()=>{ checkpoint(); applyBgToPage(pageIdx,it); closeBgPick(); };
      item.onclick=choose; item.tabIndex=0; item.setAttribute('role','button'); item.setAttribute('aria-label',it.name+' arkaplanını seç');
      item.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};
      grid.appendChild(item);
    });
  }
  document.getElementById('bgPickOverlay').classList.add('show');
}
function closeBgPick(){ document.getElementById('bgPickOverlay').classList.remove('show'); bgPickTarget=null; }
function applyBgToPage(pageIdx,libItem){
  state.pages[pageIdx].bg={mode:'image',asset:libItem.asset,color:'#fff',bgId:libItem.id};
  if(pageIdx===state.current) renderStage();
  renderPages(); renderBgTab();
}
document.getElementById('bgPickClose').onclick=closeBgPick;
document.getElementById('bgPickOverlay').addEventListener('click',e=>{ if(e.target===document.getElementById('bgPickOverlay')) closeBgPick(); });
document.getElementById('bgPickColor').addEventListener('pointerdown',()=>{if(bgPickTarget!==null)checkpoint();});
document.getElementById('bgPickColor').addEventListener('input',e=>{
  if(bgPickTarget===null) return;
  state.pages[bgPickTarget].bg={mode:'color',color:e.target.value,asset:null,bgId:null};
  if(bgPickTarget===state.current) renderStage();
  renderPages(); renderBgTab();
});

/* ---------- karakter picker ---------- */
let charPickTarget=null;
function openCharPick(pageIdx){
  charPickTarget=pageIdx;
  document.getElementById('charPickTitle').textContent='Karakter Ekle — Sayfa '+(pageIdx+1);
  const grid=document.getElementById('charPickGrid'); grid.innerHTML='';
  const empty=document.getElementById('charPickEmpty');
  if(!state.charLib.length){ empty.style.display='block'; grid.style.display='none'; }
  else {
    empty.style.display='none'; grid.style.display='';
    state.charLib.forEach(it=>{
      const item=document.createElement('div'); item.className='pick-item';
      const img=document.createElement('img'); img.src=it.asset.dataURL; img.alt=escapeHtml(it.name);
      const nm=document.createElement('div'); nm.className='nm'; nm.textContent=it.name;
      item.append(img,nm);
      const choose=()=>{ checkpoint(); addCharToPage(pageIdx,it); closeCharPick(); };
      item.onclick=choose; item.tabIndex=0; item.setAttribute('role','button'); item.setAttribute('aria-label',it.name+' karakterini ekle');
      item.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};
      grid.appendChild(item);
    });
  }
  document.getElementById('charPickOverlay').classList.add('show');
}
function closeCharPick(){ document.getElementById('charPickOverlay').classList.remove('show'); charPickTarget=null; }
function addCharToPage(pageIdx,libItem){
  const a=libItem.asset; const aspect=a.h/a.w;
  state.pages[pageIdx].chars.push({id:nextId(),libId:libItem.id,name:libItem.name,asset:a,fx:0.5,fy:0.5,sizePct:27,flip:false,aspect});
  if(pageIdx===state.current){
    state.selected=state.pages[pageIdx].chars[state.pages[pageIdx].chars.length-1].id;
    renderStage(); renderSelPanel();
  }
  renderPages();
  showToast(libItem.name+' Sayfa '+(pageIdx+1)+'\'e eklendi');
}
document.getElementById('charPickClose').onclick=closeCharPick;
document.getElementById('charPickOverlay').addEventListener('click',e=>{ if(e.target===document.getElementById('charPickOverlay')) closeCharPick(); });
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  document.getElementById('infoOverlay').classList.remove('show');
  closeBgPick(); closeCharPick();
});

/* ---------- toast ---------- */
let toastTimer=null;
function showToast(msg,kind){ const t=document.getElementById('toast'); t.textContent=msg; t.className='toast show'+(kind==='err'?' err':'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className='toast'+(kind==='err'?' err':''),2600); }

/* ---------- başlat ---------- */
document.getElementById('pname').addEventListener('input',scheduleAutosave);
window.addEventListener('resize',()=>{ if(document.querySelector('.panel[data-tab=stage]').classList.contains('active')){ renderStage(); renderPages(); } });
stageEl.addEventListener('pointerdown',e=>{ if(e.target===stageEl||e.target.classList.contains('grid')||e.target.classList.contains('bgimg')){ state.selected=null; state.selectedText=null; renderStage(); renderSelPanel(); renderTextPanel(); }});
async function boot(){
  initGridLabels(); syncConv();
  const restored=await restoreAutosave();
  render();
  if(restored) showToast('Otomatik kaydedilen çalışma geri yüklendi');
}
boot();
