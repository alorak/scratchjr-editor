export function buildZipIndex(zip,normalizeArchivePath){
  const byPath=new Map(),byBase=new Map(),files=[];
  zip.forEach((path,file)=>{
    if(file.dir)return;
    const safe=normalizeArchivePath(path);
    if(!safe)return;
    byPath.set(safe.toLowerCase(),file);files.push({path:safe,file});
    const base=safe.split('/').pop().toLowerCase(),list=byBase.get(base)||[];
    list.push({path:safe,file});byBase.set(base,list);
  });
  return {byPath,byBase,files};
}

export function createImportReport(){
  return {pages:0,characters:0,texts:0,backgrounds:0,sounds:0,issues:[]};
}

export function addImportIssue(report,kind,message){
  if(report.issues.length>=100)return;
  const key=kind+'|'+message;
  if(!report._seen)Object.defineProperty(report,'_seen',{value:new Set(),enumerable:false});
  if(report._seen.has(key))return;
  report._seen.add(key);report.issues.push({kind,message});
}

export function resolveZipFile(index,candidates,report,label,normalizeArchivePath){
  const safeCandidates=[];
  for(const raw of candidates){
    const safe=normalizeArchivePath(raw);
    if(!safe){addImportIssue(report,'warning',(label||'Asset')+' için güvensiz yol reddedildi: '+String(raw).slice(0,100));continue;}
    safeCandidates.push(safe);
    const exact=index.byPath.get(safe.toLowerCase());
    if(exact)return exact;
  }
  const base=(safeCandidates[0]||'').split('/').pop().toLowerCase();
  if(!base)return null;
  const matches=index.byBase.get(base)||[];
  if(matches.length===1){
    addImportIssue(report,'warning',(label||base)+' beklenen klasörde değildi; '+matches[0].path+' kullanıldı');
    return matches[0].file;
  }
  if(matches.length>1)addImportIssue(report,'warning',(label||base)+' için '+matches.length+' aynı adlı dosya bulundu; belirsiz olduğu için atlandı');
  return null;
}

export function safeManifestArray(value,report,label,maxItems=500){
  if(value==null)return [];
  if(!Array.isArray(value)){addImportIssue(report,'warning',label+' manifest alanı dizi değil; atlandı');return [];}
  if(value.length>maxItems)addImportIssue(report,'warning',label+' manifest alanı '+maxItems+' öğeyle sınırlandı');
  return value.slice(0,maxItems);
}

export function safeDisplayName(value,fallback){
  const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  return text.slice(0,80)||fallback;
}

export function assertZipSafety(zip,{normalizeArchivePath,maxEntries=500,maxEntryBytes=30*1024*1024,maxTotalBytes=100*1024*1024}={}){
  let entries=0,total=0,largest=0;
  zip.forEach((path,file)=>{
    if(file.dir)return;
    entries++;
    const original=file.unsafeOriginalName||path;
    if(!normalizeArchivePath(original))throw new Error('Arşiv güvensiz dosya yolu içeriyor: '+String(original).slice(0,120));
    const size=Number(file?._data?.uncompressedSize||0);
    if(Number.isFinite(size)){total+=size;largest=Math.max(largest,size);}
  });
  if(entries>maxEntries)throw new Error('Arşiv çok fazla dosya içeriyor');
  if(largest>maxEntryBytes)throw new Error('Arşivde izin verilenden büyük bir dosya var');
  if(total>maxTotalBytes)throw new Error('Arşivin açılmış boyutu güvenli sınırı aşıyor');
}

export async function readJsonEntry(entry,label,maxBytes){
  const hinted=Number(entry?._data?.uncompressedSize||0);
  if(Number.isFinite(hinted)&&hinted>maxBytes)throw new Error(label+' izin verilen metadata boyutunu aşıyor');
  const text=await entry.async('string');
  if(new TextEncoder().encode(text).length>maxBytes)throw new Error(label+' izin verilen metadata boyutunu aşıyor');
  try{return JSON.parse(text);}catch{throw new Error(label+' geçerli JSON değil');}
}
