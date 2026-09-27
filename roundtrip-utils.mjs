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
  const arcPaths=countArcPaths(src);
  const rootPresentation=hasSvgRootPresentation(src);
  const externalRefs=/\b(?:href|xlink:href)\s*=\s*(["'])\s*(?:https?:|\/\/)/i.test(src);
  const reasons=[];
  if(transformCount) reasons.push('transform');
  if(rootPresentation) reasons.push('root-presentation');
  if(styleCount) reasons.push('style-attribute');
  if(arcPaths) reasons.push('arc-command');
  if(unsupportedCount) reasons.push('unsupported-elements');
  if(effectCount) reasons.push('paint-effects');
  if(viewBoxOriginNonZero) reasons.push('nonzero-viewbox-origin');
  if(externalRefs) reasons.push('external-reference');
  return {
    hasEmbeddedImage,transformCount,styleCount,arcPaths,rootPresentation,externalRefs,
    viewBoxValid,viewBoxOriginNonZero,viewBox:vbNums,
    unsupportedTags,unsupportedCount,effectTags,effectCount,
    safeDirectVector:!hasEmbeddedImage&&reasons.length===0,
    fallbackReasons:reasons
  };
}
