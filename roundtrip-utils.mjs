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
