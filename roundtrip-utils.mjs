export const cloneJson=v=>v==null?v:JSON.parse(JSON.stringify(v));

export function hasSvgTransform(text){
  return /\btransform\s*=/i.test(String(text||''));
}

export function mergeSpriteMeta(meta,updates){
  const out=cloneJson(meta)||{};
  Object.assign(out,updates||{});
  out.scripts=Array.isArray(out.scripts)?out.scripts:[];
  return out;
}

export function mergePreservedSounds(existing,mapSoundRef,newSoundFiles,allSoundFiles){
  if(Array.isArray(existing)){
    const mapped=existing.map(ref=>mapSoundRef?mapSoundRef(ref):ref);
    return [...new Set([...mapped,...(newSoundFiles||[])])];
  }
  return ['pop.mp3',...(allSoundFiles||[])];
}

export function mergeLayerOrder(oldLayers,emittedIds){
  const old=Array.isArray(oldLayers)?oldLayers:[];
  const emitted=Array.isArray(emittedIds)?emittedIds:[];
  const allowed=new Set(emitted);
  return [
    ...old.filter(id=>allowed.has(id)),
    ...emitted.filter(id=>!old.includes(id))
  ];
}

export function hasSvgRootPresentation(text){
  const m=String(text||'').match(/<svg\b([^>]*)>/i);
  if(!m) return false;
  return /\b(?:fill|stroke|opacity|style|color|fill-opacity|stroke-opacity|stroke-width)\s*=/i.test(m[1]);
}

export function dataMetaWithoutJson(data){
  const out=cloneJson(data)||{};
  delete out.json;
  return out;
}

export function jsonMetaWithoutPages(json,pageKeys){
  const out=cloneJson(json)||{};
  for(const key of (pageKeys||[])) delete out[key];
  delete out.pages;
  delete out.currentPage;
  return out;
}

export function pageMetaWithoutSprites(page){
  const out=cloneJson(page)||{};
  const ids=Array.isArray(out.sprites)?[...out.sprites]:[];
  for(const id of ids) delete out[id];
  delete out.sprites;
  return out;
}

export function resolveCurrentPageIndex(currentPage,pageKeys){
  const pages=Array.isArray(pageKeys)?pageKeys:[];
  if(!pages.length) return 0;
  const idx=pages.indexOf(currentPage);
  return idx>=0?idx:0;
}

export function selectBackgroundSvg(asset,coverSvg){
  if(asset&&asset.preserveSvg&&asset.svgText) return asset.svgText;
  if(asset&&asset.vector&&asset.svgText) return asset.svgText;
  return coverSvg(asset);
}

function countTag(text,tag){
  const m=String(text||'').match(new RegExp('<'+tag+'(?:\\s|>)','gi'));
  return m?m.length:0;
}

function countArcPaths(text){
  let count=0;
  const re=/<path\b[^>]*\bd\s*=\s*(["'])(.*?)\1/gis;
  let m;
  while((m=re.exec(String(text||'')))) if(/[Aa](?=[\s,0-9+.-])/.test(m[2])) count++;
  return count;
}

function isInlineSvgReference(value){
  const v=String(value||'').trim();
  return !v || v.startsWith('#') || /^data:/i.test(v);
}

function collectUnsafeSvgReferences(src){
  const unsafe=[];
  let m;
  const hrefRe=/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gis;
  while((m=hrefRe.exec(src))!==null){
    const value=m[2].trim();
    if(!isInlineSvgReference(value)) unsafe.push(value);
  }
  const urlRe=/url\(\s*(["']?)(.*?)\1\s*\)/gis;
  while((m=urlRe.exec(src))!==null){
    const value=m[2].trim();
    if(!isInlineSvgReference(value)) unsafe.push(value);
  }
  if(/@import\b/i.test(src)) unsafe.push('@import');
  return [...new Set(unsafe)];
}

export function inspectSvgCompatibility(text){
  const src=String(text||'');
  const vb=src.match(/\bviewBox\s*=\s*(["'])\s*([^"']+)\1/i);
  const vbNums=vb?vb[2].trim().split(/[\s,]+/).map(Number):[];
  const viewBoxValid=vbNums.length===4&&vbNums.every(Number.isFinite)&&vbNums[2]>0&&vbNums[3]>0;
  const viewBoxOriginNonZero=viewBoxValid&&(Math.abs(vbNums[0])>1e-6||Math.abs(vbNums[1])>1e-6);
  const unsupportedTags={
    rect:countTag(src,'rect'),
    ellipse:countTag(src,'ellipse'),
    line:countTag(src,'line'),
    polyline:countTag(src,'polyline'),
    text:countTag(src,'text'),
    use:countTag(src,'use'),
    foreignObject:countTag(src,'foreignObject')
  };
  const effectTags={
    clipPath:countTag(src,'clipPath'),
    mask:countTag(src,'mask'),
    filter:countTag(src,'filter'),
    linearGradient:countTag(src,'linearGradient'),
    radialGradient:countTag(src,'radialGradient'),
    pattern:countTag(src,'pattern')
  };
  const unsupportedCount=Object.values(unsupportedTags).reduce((a,b)=>a+b,0);
  const effectCount=Object.values(effectTags).reduce((a,b)=>a+b,0);
  const hasEmbeddedImage=/<image(?:\s|>)/i.test(src);
  const transformCount=(src.match(/\btransform\s*=/gi)||[]).length;
  const styleCount=(src.match(/\bstyle\s*=/gi)||[]).length;
  const styleElementCount=countTag(src,'style');
  const scriptCount=countTag(src,'script');
  const arcPaths=countArcPaths(src);
  const rootPresentation=hasSvgRootPresentation(src);
  const unsafeReferences=collectUnsafeSvgReferences(src);
  const externalRefs=unsafeReferences.length>0;
  const activeContent=scriptCount>0;
  const reasons=[];
  if(transformCount) reasons.push('transform');
  if(rootPresentation) reasons.push('root-presentation');
  if(styleCount) reasons.push('style-attribute');
  if(styleElementCount) reasons.push('style-element');
  if(arcPaths) reasons.push('arc-command');
  if(unsupportedCount) reasons.push('unsupported-elements');
  if(effectCount) reasons.push('paint-effects');
  if(viewBoxOriginNonZero) reasons.push('nonzero-viewbox-origin');
  if(externalRefs) reasons.push('external-reference');
  if(activeContent) reasons.push('active-content');
  return {
    hasEmbeddedImage,transformCount,styleCount,styleElementCount,scriptCount,arcPaths,rootPresentation,
    externalRefs,unsafeReferences,activeContent,
    viewBoxValid,viewBoxOriginNonZero,viewBox:vbNums,
    unsupportedTags,unsupportedCount,effectTags,effectCount,
    safeDirectVector:!hasEmbeddedImage&&reasons.length===0,
    fallbackReasons:reasons
  };
}


export function normalizeArchivePath(value){
  const raw=String(value??'').trim().replace(/\\/g,'/');
  if(!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return null;
  const out=[];
  for(const part of raw.split('/')){
    if(!part || part==='.') continue;
    if(part==='..') return null;
    out.push(part);
  }
  return out.length?out.join('/'):null;
}

export function validateScratchJrProject(data,maxPages=4){
  const errors=[],warnings=[];
  if(!data || typeof data!=='object' || Array.isArray(data)){
    return {errors:['data.json kök değeri bir nesne olmalı'],warnings,pageKeys:[],json:null,wrapped:false};
  }
  const wrapped=!!(data.json && typeof data.json==='object' && !Array.isArray(data.json));
  const json=wrapped?data.json:data;
  if(!json || typeof json!=='object' || Array.isArray(json)){
    errors.push('ScratchJr json alanı bir nesne olmalı');
    return {errors,warnings,pageKeys:[],json:null,wrapped};
  }
  if(!Array.isArray(json.pages)){
    errors.push('ScratchJr pages alanı bir dizi olmalı');
    return {errors,warnings,pageKeys:[],json,wrapped};
  }
  const pageKeys=json.pages.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim());
  if(pageKeys.length!==json.pages.length) errors.push('pages dizisindeki tüm değerler geçerli sayfa kimliği olmalı');
  if(new Set(pageKeys).size!==pageKeys.length) errors.push('pages dizisinde yinelenen sayfa kimliği var');
  if(pageKeys.length>maxPages) errors.push('Proje '+pageKeys.length+' sayfa içeriyor; en fazla '+maxPages+' sayfa destekleniyor');
  if(!pageKeys.length) warnings.push('Projede sayfa bulunamadı; boş bir sayfa oluşturulacak');
  for(const key of pageKeys){
    const page=json[key];
    if(!page || typeof page!=='object' || Array.isArray(page)){
      warnings.push(key+': sayfa nesnesi bulunamadı');
      continue;
    }
    if(page.sprites!=null && !Array.isArray(page.sprites)) warnings.push(key+': sprites alanı dizi değil; boş kabul edilecek');
    if(Array.isArray(page.sprites)){
      for(const id of page.sprites){
        if(typeof id!=='string'||!id){warnings.push(key+': geçersiz sprite kimliği atlandı');continue;}
        if(!page[id] || typeof page[id]!=='object' || Array.isArray(page[id])) warnings.push(key+': '+id+' sprite nesnesi bulunamadı');
      }
    }
  }
  return {errors,warnings,pageKeys,json,wrapped};
}
