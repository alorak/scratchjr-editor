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
