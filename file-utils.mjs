const MB=1024*1024;

export function assertFileSize(file,maxBytes,label){
  if(file&&file.size>maxBytes) throw new Error((label||'Dosya')+' çok büyük (maks. '+Math.round(maxBytes/MB)+' MB)');
}

export function b64(value){
  const bytes=new TextEncoder().encode(String(value??''));
  let binary='';
  const CHUNK=0x8000;
  for(let i=0;i<bytes.length;i+=CHUNK) binary+=String.fromCharCode(...bytes.subarray(i,i+CHUNK));
  return btoa(binary);
}

export function readAsDataURL(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(reader.error||new Error('Dosya okunamadı'));
    reader.readAsDataURL(file);
  });
}

export function readAsText(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(reader.error||new Error('Dosya okunamadı'));
    reader.readAsText(file);
  });
}

export function loadImage(src){
  return new Promise((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>resolve(image);
    image.onerror=()=>reject(new Error('Görsel yüklenemedi'));
    image.src=src;
  });
}

export function svgDims(text){
  try{
    const svg=new DOMParser().parseFromString(text,'image/svg+xml').querySelector('svg');
    if(!svg) return {w:150,h:150};
    let w=parseFloat(svg.getAttribute('width')),h=parseFloat(svg.getAttribute('height'));
    if(!w||!h){
      const vb=(svg.getAttribute('viewBox')||'').split(/[ ,]+/).map(Number);
      if(vb.length===4){w=vb[2];h=vb[3];}
    }
    return {w:w||150,h:h||150};
  }catch{
    return {w:150,h:150};
  }
}

export function wrapRasterSvg(dataURL,w,h){
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="${dataURL}" xlink:href="${dataURL}"/></svg>`;
}

export function escapeHtml(value){
  return String(value??'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

export function colorToHex(color){
  if(!color) return '#1a1a1a';
  const rgb=String(color).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if(rgb) return '#'+[rgb[1],rgb[2],rgb[3]].map(n=>parseInt(n,10).toString(16).padStart(2,'0')).join('');
  if(String(color).startsWith('#')){
    const s=String(color);
    return s.length===4?'#'+s[1]+s[1]+s[2]+s[2]+s[3]+s[3]:s;
  }
  return '#1a1a1a';
}
