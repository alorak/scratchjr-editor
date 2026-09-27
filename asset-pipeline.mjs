import {inspectSvgCompatibility} from './roundtrip-utils.mjs';
import {b64,readAsDataURL,readAsText,loadImage,svgDims,wrapRasterSvg} from './file-utils.mjs';

export function scalePathData(d,sx,sy){
  if(!d||(sx===1&&sy===1))return d;
  const re=/([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d*\.?\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?)/g;
  const tokens=[];let match;
  while((match=re.exec(d))!==null)tokens.push(match[1]?{kind:'cmd',value:match[1]}:{kind:'num',value:+match[2]});
  let out='',i=0;
  const fmt=n=>{const rounded=+(+n.toFixed(4));return rounded===0?'0':String(rounded);};
  const pop=()=>i<tokens.length&&tokens[i].kind==='num'?tokens[i++].value:0;
  const hasNumber=()=>i<tokens.length&&tokens[i].kind==='num';
  while(i<tokens.length){
    if(tokens[i].kind!=='cmd'){i++;continue;}
    const cmd=tokens[i++].value,C=cmd.toUpperCase();
    if(C==='Z'){out+=cmd;continue;}
    out+=cmd;let sep='';
    while(hasNumber()){
      out+=sep;sep=' ';
      if(C==='M'||C==='L'||C==='T')out+=fmt(pop()*sx)+' '+fmt(pop()*sy);
      else if(C==='H')out+=fmt(pop()*sx);
      else if(C==='V')out+=fmt(pop()*sy);
      else if(C==='C')out+=[fmt(pop()*sx),fmt(pop()*sy),fmt(pop()*sx),fmt(pop()*sy),fmt(pop()*sx),fmt(pop()*sy)].join(' ');
      else if(C==='S'||C==='Q')out+=[fmt(pop()*sx),fmt(pop()*sy),fmt(pop()*sx),fmt(pop()*sy)].join(' ');
      else if(C==='A'){
        const rx=pop(),ry=pop(),xr=pop(),large=pop(),sweep=pop(),x=pop(),y=pop();
        out+=[fmt(rx*sx),fmt(ry*sy),fmt(xr),large|0,sweep|0,fmt(x*sx),fmt(y*sy)].join(' ');
      }else out+=fmt(pop());
    }
  }
  return out;
}

export function createAssetPipeline(options={}){
  const doc=options.document||globalThis.document;
  const win=options.window||doc?.defaultView||globalThis.window;
  const showToast=options.showToast||(()=>{});
  const STAGE_W=options.stageWidth||480,STAGE_H=options.stageHeight||360;
  const CHAR_CANONICAL_W=options.charCanonicalWidth||Math.round(STAGE_W*27/50);
  const conversion={mode:'embed',colors:16};

  function getConversion(){return {...conversion};}
  function setConversion(next={}){
    if(next.mode==='embed'||next.mode==='trace')conversion.mode=next.mode;
    if(Number.isFinite(+next.colors))conversion.colors=Math.max(2,Math.min(64,+next.colors));
    return getConversion();
  }

  function normalizeSvgForChar(svgText,pxW,pxH){
    try{
      svgText=svgText
        .replace(/^<\?xml[^>]*\?>\s*/,'')
        .replace(/<!--(?!Created with Scratch Jr)[^>]*-->/g,'')
        .replace(/>\s+</g,'><');

      const parsed=new win.DOMParser().parseFromString(svgText,'image/svg+xml');
      if(parsed.querySelector('parsererror'))return null;
      const svgEl=parsed.documentElement;

      parsed.querySelectorAll('sodipodi\\:namedview,metadata,script').forEach(el=>el.remove());
      parsed.querySelectorAll('*').forEach(el=>{
        [...el.attributes].forEach(attr=>{
          if(attr.name.startsWith('inkscape:')||attr.name.startsWith('sodipodi:')||
             attr.name.startsWith('dc:')||attr.name.startsWith('cc:')||attr.name.startsWith('rdf:'))
            el.removeAttribute(attr.name);
        });
      });

      const vb=(svgEl.getAttribute('viewBox')||'').split(/[\s,]+/).map(Number);
      let canonicalW,canonicalH;
      if(vb.length>=4&&vb[2]>0&&vb[3]>0){canonicalW=vb[2];canonicalH=vb[3];}
      else{canonicalW=pxW||CHAR_CANONICAL_W;canonicalH=pxH||CHAR_CANONICAL_W;}
      const finalW=CHAR_CANONICAL_W;
      const finalH=Math.max(1,Math.round(canonicalH*CHAR_CANONICAL_W/canonicalW));

      let sx=finalW/canonicalW,sy=finalH/canonicalH;
      const elementChildren=[...svgEl.childNodes].filter(node=>node.nodeType===1);
      if(elementChildren.length===1&&elementChildren[0].tagName.toLowerCase()==='g'){
        const group=elementChildren[0];
        const scaleMatch=(group.getAttribute('transform')||'').match(/^scale\(\s*([^,\s)]+)(?:[,\s]+([^)]+))?\s*\)$/);
        if(scaleMatch){
          sx=parseFloat(scaleMatch[1]);sy=scaleMatch[2]!==undefined?parseFloat(scaleMatch[2]):sx;
          while(group.firstChild)svgEl.insertBefore(group.firstChild,group);
          group.remove();
        }
      }

      parsed.querySelectorAll('[style]').forEach(el=>{
        const style=el.getAttribute('style'),fillMatch=style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
        if(fillMatch){
          const value=fillMatch[1].trim();
          if(value&&value.toLowerCase()!=='none')el.setAttribute('fill',value);
          const rest=style.replace(/(?:^|;)\s*fill\s*:[^;]*/gi,'').replace(/^;+/,'').trim();
          if(rest)el.setAttribute('style',rest);else el.removeAttribute('style');
        }
      });

      const K=.5522847498;
      parsed.querySelectorAll('circle').forEach(el=>{
        const cx=+(el.getAttribute('cx')||0),cy=+(el.getAttribute('cy')||0),r=+(el.getAttribute('r')||0);
        const path=parsed.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('d',
          `M${cx-r} ${cy} C${cx-r} ${cy-K*r} ${cx-K*r} ${cy-r} ${cx} ${cy-r} `+
          `C${cx+K*r} ${cy-r} ${cx+r} ${cy-K*r} ${cx+r} ${cy} `+
          `C${cx+r} ${cy+K*r} ${cx+K*r} ${cy+r} ${cx} ${cy+r} `+
          `C${cx-K*r} ${cy+r} ${cx-r} ${cy+K*r} ${cx-r} ${cy} Z`);
        [...el.attributes].forEach(attr=>{if(!['cx','cy','r'].includes(attr.name))path.setAttribute(attr.name,attr.value);});
        el.parentNode.replaceChild(path,el);
      });

      parsed.querySelectorAll('polygon').forEach(el=>{
        const points=(el.getAttribute('points')||'').trim().split(/[\s,]+/).map(Number);
        let d='';for(let i=0;i<points.length;i+=2)d+=(i?'L':'M')+points[i]+' '+points[i+1]+' ';d+='Z';
        const path=parsed.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);
        [...el.attributes].forEach(attr=>{if(attr.name!=='points')path.setAttribute(attr.name,attr.value);});
        el.parentNode.replaceChild(path,el);
      });

      parsed.querySelectorAll('path').forEach(el=>{
        const d=el.getAttribute('d');if(d)el.setAttribute('d',scalePathData(d,sx,sy));
      });

      [...svgEl.attributes].forEach(attr=>{
        if(attr.name!=='xmlns'&&attr.name!=='xmlns:xlink')svgEl.removeAttribute(attr.name);
      });
      svgEl.setAttribute('xmlns','http://www.w3.org/2000/svg');
      svgEl.setAttribute('xmlns:xlink','http://www.w3.org/1999/xlink');
      svgEl.setAttribute('width',finalW+'px');svgEl.setAttribute('height',finalH+'px');svgEl.setAttribute('viewBox','0 0 '+finalW+' '+finalH);

      let output=new win.XMLSerializer().serializeToString(parsed);
      output=output.replace(/^<\?xml[^>]*\?>\s*/,'');
      output=output.replace(/(<svg[^>]*>)\s*/,'$1<!--Created with Scratch Jr-->');
      output=output.replace(/>\s+</g,'><');
      return {text:output,w:finalW,h:finalH};
    }catch{return null;}
  }

  function normalizeSvgForBackground(svgText){
    try{
      const parsed=new win.DOMParser().parseFromString(svgText,'image/svg+xml');
      if(parsed.querySelector('parsererror'))return null;
      const svg=parsed.documentElement;
      parsed.querySelectorAll('script').forEach(el=>el.remove());
      const dims=svgDims(svgText);
      if(!svg.getAttribute('viewBox'))svg.setAttribute('viewBox','0 0 '+dims.w+' '+dims.h);
      svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
      svg.setAttribute('width',STAGE_W+'px');svg.setAttribute('height',STAGE_H+'px');
      svg.setAttribute('preserveAspectRatio','xMidYMid slice');
      return new win.XMLSerializer().serializeToString(parsed).replace(/^<\?xml[^>]*\?>\s*/,'');
    }catch{return null;}
  }

  function loadTracer(){
    if(win.ImageTracer)return Promise.resolve();
    return Promise.reject(new Error('Yerel ImageTracer yüklenemedi'));
  }

  async function rasterToVectorSvg(dataURL,colors){
    await loadTracer();
    return new Promise((resolve,reject)=>{
      try{
        win.ImageTracer.imageToSVG(dataURL,svg=>resolve(svg),{
          numberofcolors:colors||16,pathomit:8,ltres:1,qtres:1,scale:1,roundcoords:1,viewbox:true
        });
      }catch(error){reject(error);}
    });
  }

  function capPng(img,maxPx){
    const sourceW=img.naturalWidth||150,sourceH=img.naturalHeight||150;
    const scale=Math.min(1,maxPx/sourceW,maxPx/sourceH);
    const w=Math.max(1,Math.round(sourceW*scale)),h=Math.max(1,Math.round(sourceH*scale));
    const canvas=doc.createElement('canvas');canvas.width=w;canvas.height=h;
    canvas.getContext('2d').drawImage(img,0,0,w,h);
    return {pngURL:canvas.toDataURL('image/png'),w,h};
  }

  async function svgToPngPreview(svgDataURL,w,h,maxPx=480){
    try{
      const image=await loadImage(svgDataURL);
      const realW=image.naturalWidth||w||150,realH=image.naturalHeight||h||150;
      if(!realW||!realH)return null;
      const capped=capPng(image,maxPx);
      return {...capped,img:image};
    }catch{return null;}
  }

  async function fileToAsset(file){
    const isSvg=/svg/.test(file.type)||/\.svg$/i.test(file.name);
    if(isSvg){
      const text=await readAsText(file),policy=inspectSvgCompatibility(text);
      if(policy.externalRefs)throw new Error('SVG harici veya göreli kaynak içeriyor; offline kullanım için desteklenmiyor');
      if(policy.activeContent)throw new Error('SVG aktif script içeriği içeriyor');

      const rawUrl='data:image/svg+xml;base64,'+b64(text);
      const image=await loadImage(rawUrl).catch(()=>new win.Image());
      const w=image.naturalWidth||svgDims(text).w||150,h=image.naturalHeight||svgDims(text).h||150;

      if(policy.safeDirectVector){
        const normalized=normalizeSvgForChar(text,w,h);
        if(normalized){
          const normalizedUrl='data:image/svg+xml;base64,'+b64(normalized.text);
          const preview=await svgToPngPreview(normalizedUrl,normalized.w,normalized.h);
          return {
            isSvg:true,vector:true,svgText:normalized.text,dataURL:preview?preview.pngURL:normalizedUrl,
            w:normalized.w,h:normalized.h,img:preview?preview.img:await loadImage(normalizedUrl)
          };
        }
      }

      try{
        const parsed=new win.DOMParser().parseFromString(text,'image/svg+xml');
        const imageEl=parsed.querySelector('image');
        if(imageEl){
          const href=imageEl.getAttribute('href')||imageEl.getAttributeNS('http://www.w3.org/1999/xlink','href')||'';
          if(href.startsWith('data:image/')&&!href.startsWith('data:image/svg')){
            const rasterImage=await loadImage(href).catch(()=>null);
            if(rasterImage){
              const capped=capPng(rasterImage,480);
              return {
                isSvg:true,vector:false,svgText:wrapRasterSvg(capped.pngURL,capped.w,capped.h),
                dataURL:capped.pngURL,w:capped.w,h:capped.h,img:rasterImage
              };
            }
          }
        }
      }catch{}

      const preview=await svgToPngPreview(rawUrl,w,h);
      if(preview?.pngURL){
        return {
          isSvg:true,vector:false,svgText:wrapRasterSvg(preview.pngURL,preview.w,preview.h),
          dataURL:preview.pngURL,w:preview.w,h:preview.h,img:preview.img
        };
      }
      throw new Error('SVG güvenli biçimde rasterize edilemedi');
    }

    const dataURL=await readAsDataURL(file),baseImage=await loadImage(dataURL),capped=capPng(baseImage,480);
    if(conversion.mode==='trace'){
      try{
        const traced=await rasterToVectorSvg(capped.pngURL,conversion.colors),policy=inspectSvgCompatibility(traced);
        if(!policy.safeDirectVector)throw new Error('ImageTracer çıktısı güvenli vektör kriterlerini karşılamıyor');
        const dims=svgDims(traced),normalized=normalizeSvgForChar(traced,dims.w||capped.w,dims.h||capped.h);
        if(!normalized)throw new Error('ImageTracer çıktısı normalize edilemedi');
        const preview='data:image/svg+xml;base64,'+b64(normalized.text);
        return {isSvg:false,vector:true,svgText:normalized.text,dataURL:preview,w:normalized.w,h:normalized.h,img:await loadImage(preview)};
      }catch{showToast('Vektöre çevrilemedi, gömme kullanıldı','err');}
    }
    return {
      isSvg:false,vector:false,svgText:wrapRasterSvg(capped.pngURL,capped.w,capped.h),
      dataURL:capped.pngURL,w:capped.w,h:capped.h,img:baseImage
    };
  }

  async function fileToBackgroundAsset(file){
    const isSvg=/svg/.test(file.type)||/\.svg$/i.test(file.name);
    if(isSvg){
      const raw=await readAsText(file),policy=inspectSvgCompatibility(raw);
      if(policy.externalRefs)throw new Error('SVG harici veya göreli kaynak içeriyor; offline kullanım için desteklenmiyor');
      if(policy.activeContent)throw new Error('SVG aktif script içeriği içeriyor');

      if(policy.safeDirectVector){
        const normalized=normalizeSvgForBackground(raw);
        if(normalized){
          const dataURL='data:image/svg+xml;base64,'+b64(normalized);
          return {isSvg:true,vector:true,preserveSvg:true,svgText:normalized,dataURL,w:STAGE_W,h:STAGE_H,img:await loadImage(dataURL)};
        }
      }

      const dims=svgDims(raw),rawUrl='data:image/svg+xml;base64,'+b64(raw);
      const preview=await svgToPngPreview(rawUrl,dims.w,dims.h,480);
      if(!preview?.pngURL)throw new Error('Arkaplan SVG güvenli biçimde rasterize edilemedi');
      return {
        isSvg:true,vector:false,preserveSvg:false,svgText:wrapRasterSvg(preview.pngURL,preview.w,preview.h),
        dataURL:preview.pngURL,w:preview.w,h:preview.h,img:preview.img
      };
    }

    const dataURL=await readAsDataURL(file),baseImage=await loadImage(dataURL),capped=capPng(baseImage,480);
    if(conversion.mode==='trace'){
      try{
        const traced=await rasterToVectorSvg(capped.pngURL,conversion.colors),policy=inspectSvgCompatibility(traced);
        if(!policy.safeDirectVector)throw new Error('ImageTracer çıktısı güvenli vektör kriterlerini karşılamıyor');
        const normalized=normalizeSvgForBackground(traced);
        if(!normalized)throw new Error('ImageTracer arkaplan çıktısı normalize edilemedi');
        const preview='data:image/svg+xml;base64,'+b64(normalized);
        return {isSvg:false,vector:true,preserveSvg:true,svgText:normalized,dataURL:preview,w:STAGE_W,h:STAGE_H,img:await loadImage(preview)};
      }catch{showToast('Arkaplan vektöre çevrilemedi, gömme kullanıldı','err');}
    }
    return {
      isSvg:false,vector:false,preserveSvg:false,svgText:wrapRasterSvg(capped.pngURL,capped.w,capped.h),
      dataURL:capped.pngURL,w:capped.w,h:capped.h,img:baseImage
    };
  }

  return {
    getConversion,setConversion,normalizeSvgForChar,normalizeSvgForBackground,
    capPng,svgToPngPreview,fileToAsset,fileToBackgroundAsset
  };
}
