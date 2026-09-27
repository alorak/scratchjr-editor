import {
  cloneJson,inspectSvgCompatibility,normalizeArchivePath,validateScratchJrProject,
  dataMetaWithoutJson,jsonMetaWithoutPages,pageMetaWithoutSprites,resolveCurrentPageIndex,
  selectBackgroundSvg,mergeSpriteMeta,mergePreservedSounds,mergeLayerOrder
} from './roundtrip-utils.mjs';
import {assertFileSize,b64,loadImage,svgDims,colorToHex} from './file-utils.mjs';
import {
  assertZipSafety,readJsonEntry,buildZipIndex,createImportReport,addImportIssue,
  resolveZipFile,safeManifestArray,safeDisplayName
} from './sjr-archive-utils.mjs';

export function createSjrTransferController(options={}){
  const doc=options.document||globalThis.document;
  const win=options.window||doc?.defaultView||globalThis.window;
  const state=options.state;
  const newPage=options.newPage;
  const nextId=options.nextId;
  const checkpoint=options.checkpoint||(()=>{});
  const render=options.render||(()=>{});
  const setTab=options.setTab||(()=>{});
  const showToast=options.showToast||(()=>{});
  const startOperation=options.startOperation||(()=>({update(){},close(){}}));
  const showImportReport=options.showImportReport||(()=>{});

  const STAGE_W=options.stageWidth||480,STAGE_H=options.stageHeight||360,MAX_PAGES=options.maxPages||4;
  const MAX_SJR_BYTES=options.maxSjrBytes||25*1024*1024;
  const ZIP_LIMITS={
    maxEntries:options.maxZipEntries||500,
    maxEntryBytes:options.maxZipEntryBytes||30*1024*1024,
    maxTotalBytes:options.maxZipTotalBytes||100*1024*1024
  };

  let transferBusy=false;

  function jszip(){
    const JSZip=options.JSZip||win?.JSZip||globalThis.JSZip;
    if(!JSZip) throw new Error('Yerel sıkıştırma kütüphanesi yüklenemedi');
    return JSZip;
  }
  function spark(){
    const SparkMD5=options.SparkMD5||win?.SparkMD5||globalThis.SparkMD5;
    if(!SparkMD5) throw new Error('Yerel MD5 kütüphanesi yüklenemedi');
    return SparkMD5;
  }
  function setTransferBusy(busy){
    transferBusy=!!busy;
    const importBtn=doc.getElementById('importBtn'),exportBtn=doc.getElementById('exportBtn');
    if(importBtn)importBtn.disabled=transferBusy;
    if(exportBtn)exportBtn.disabled=transferBusy;
  }
  function isBusy(){return transferBusy;}

  function md5str(value){return spark().hash(value);}
  function md5buf(value){return spark().ArrayBuffer.hash(value);}

  function drawCover(ctx,img,W,H){
    const iw=img.naturalWidth||img.width||W,ih=img.naturalHeight||img.height||H;
    const ratio=Math.max(W/iw,H/ih),dw=iw*ratio,dh=ih*ratio;
    try{ctx.drawImage(img,(W-dw)/2,(H-dh)/2,dw,dh);}catch{}
  }

  async function renderThumb(page){
    const cv=doc.createElement('canvas');cv.width=STAGE_W;cv.height=STAGE_H;
    const ctx=cv.getContext('2d');
    if(page.bg.mode==='color'){
      ctx.fillStyle=page.bg.color;ctx.fillRect(0,0,STAGE_W,STAGE_H);
    }else{
      ctx.fillStyle='#fff';ctx.fillRect(0,0,STAGE_W,STAGE_H);
      if(page.bg.asset?.img)drawCover(ctx,page.bg.asset.img,STAGE_W,STAGE_H);
    }
    for(const c of page.chars){
      const dispW=c.sizePct/100*STAGE_W,dispH=dispW*c.aspect,x=c.fx*STAGE_W,y=c.fy*STAGE_H;
      ctx.save();ctx.translate(x,y);if(c.flip)ctx.scale(-1,1);
      try{ctx.drawImage(c.asset.img,-dispW/2,-dispH/2,dispW,dispH);}catch{}
      ctx.restore();
    }
    for(const t of page.texts||[]){
      ctx.font=`600 ${t.fontsize||16}px ui-rounded, system-ui, sans-serif`;
      ctx.fillStyle=t.color||'#1a1a1a';ctx.textAlign='center';ctx.textBaseline='middle';
      try{ctx.fillText(t.str||'',t.fx*STAGE_W,t.fy*STAGE_H);}catch{}
    }
    return new Promise((resolve,reject)=>cv.toBlob(blob=>{
      if(!blob)return reject(new Error('Thumbnail PNG oluşturulamadı'));
      blob.arrayBuffer().then(resolve,reject);
    },'image/png'));
  }

  function coverSvg(asset){
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${STAGE_W}" height="${STAGE_H}" viewBox="0 0 ${STAGE_W} ${STAGE_H}"><image width="${STAGE_W}" height="${STAGE_H}" preserveAspectRatio="xMidYMid slice" href="${asset.dataURL}" xlink:href="${asset.dataURL}"/></svg>`;
  }
  function backgroundSvg(asset){return selectBackgroundSvg(asset,coverSvg);}
  function colorSvg(color){
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${STAGE_W}" height="${STAGE_H}" viewBox="0 0 ${STAGE_W} ${STAGE_H}"><rect width="${STAGE_W}" height="${STAGE_H}" fill="${color}"/></svg>`;
  }

  async function exportProject(pagesArg){
    if(transferBusy){showToast('Başka bir içe/dışa aktarma işlemi sürüyor');return false;}
    let JSZip;
    try{JSZip=jszip();}catch(error){showToast(error.message,'err');return false;}
    const pages=Array.isArray(pagesArg)?pagesArg:state.pages;
    const btn=doc.getElementById('exportBtn'),old=btn?.textContent||'Dışa aktar';
    setTransferBusy(true);if(btn)btn.textContent='Hazırlanıyor…';
    const op=startOperation('Dışa aktarılıyor');op.update(5,'Proje yapısı hazırlanıyor…');
    try{
      const name=(doc.getElementById('pname')?.value||'Benim Projem').trim();
      const zip=new JSZip(),root=zip.folder('project');
      const charsDir=root.folder('characters'),bgDir=root.folder('backgrounds'),thumbDir=root.folder('thumbnails');
      let soundsDir=null;
      const soundFiles=[],soundOutBySource=new Map(),usedSoundNames=new Set();
      if(state.sounds.length){
        soundsDir=root.folder('sounds');
        for(const sound of state.sounds){
          let filename=sound.sourceFile?String(sound.sourceFile).replace(/^.*[\\/]/,''):'';
          if(!filename||usedSoundNames.has(filename))filename='SND'+md5buf(sound.buf)+'.'+sound.ext;
          usedSoundNames.add(filename);soundsDir.file(filename,sound.buf);soundFiles.push(filename);
          if(sound.sourceFile){
            soundOutBySource.set(String(sound.sourceFile),filename);
            soundOutBySource.set(String(sound.sourceFile).replace(/^.*[\\/]/,''),filename);
          }
        }
      }
      op.update(20,state.sounds.length?'Sesler arşive eklendi':'Ses bulunmuyor');
      const mapSoundRef=ref=>{
        const raw=String(ref||''),base=raw.replace(/^.*[\\/]/,'');
        return soundOutBySource.get(raw)||soundOutBySource.get(base)||raw;
      };
      const newSoundFiles=state.sounds.map((sound,i)=>sound.sourceFile?null:soundFiles[i]).filter(Boolean);

      const charCache=new Map();
      function charFile(asset){
        if(charCache.has(asset.svgText))return charCache.get(asset.svgText);
        const filename=md5str(asset.svgText)+'.svg';
        charsDir.file(filename,asset.svgText);charCache.set(asset.svgText,filename);return filename;
      }

      const jsonObj=state.sjrJsonMeta?cloneJson(state.sjrJsonMeta):{};
      jsonObj.pages=[];jsonObj.currentPage='page '+Math.min(pages.length,Math.max(1,state.current+1));
      let firstThumb=null;

      for(let i=0;i<pages.length;i++){
        const page=pages[i],key='page '+(i+1);jsonObj.pages.push(key);
        let bgName;
        if(page.bg.mode==='image'&&page.bg.asset){
          const svg=backgroundSvg(page.bg.asset);bgName=md5str(svg)+'.svg';bgDir.file(bgName,svg);
        }else{
          const svg=colorSvg(page.bg.color||'#ffffff');bgName=md5str(svg)+'.svg';bgDir.file(bgName,svg);
        }

        const pageObj=page.sjrMeta?cloneJson(page.sjrMeta):{textstartat:36};
        pageObj.sprites=[];pageObj.md5=bgName;pageObj.num=i+1;pageObj.lastSprite='';
        const emittedIds=[],usedIds=new Set();
        const uniqueSpriteId=(preferred,fallback)=>{
          let id=(preferred||fallback||'Sprite').trim()||'Sprite',n=2,base=id;
          while(usedIds.has(id))id=base+' '+(n++);
          usedIds.add(id);return id;
        };

        page.chars.forEach((character,index)=>{
          const spId=uniqueSpriteId(character.sjrId,(character.name||'Karakter')+' '+(index+1));
          const md5name=charFile(character.asset),w=Math.round(character.asset.w),h=Math.round(character.asset.h);
          const dispW=character.sizePct/100*STAGE_W,scale=+(dispW/w).toFixed(4);
          const xcoor=Math.round(character.fx*STAGE_W),ycoor=Math.round(character.fy*STAGE_H);
          pageObj.sprites.push(spId);emittedIds.push(spId);pageObj.lastSprite=spId;
          const originalMeta=character.sjrMeta?cloneJson(character.sjrMeta):{};
          const sp=mergeSpriteMeta(originalMeta,{
            shown:originalMeta.shown!==false,type:'sprite',md5:md5name,id:spId,flip:!!character.flip,name:character.name||'Karakter',
            angle:typeof originalMeta.angle==='number'?originalMeta.angle:0,scale,
            speed:typeof originalMeta.speed==='number'?originalMeta.speed:2,defaultScale:scale,
            xcoor,ycoor,cx:Math.round(w/2),cy:Math.round(h/2),w,h,
            homex:xcoor,homey:ycoor,homescale:scale,homeshown:originalMeta.homeshown!==false,homeflip:!!character.flip
          });
          sp.sounds=mergePreservedSounds(sp.sounds,mapSoundRef,newSoundFiles,soundFiles);
          pageObj[spId]=sp;
        });

        (page.texts||[]).forEach((text,index)=>{
          const spId=uniqueSpriteId(text.sjrId,'Text '+(index+1));
          const xcoor=Math.round(text.fx*STAGE_W),ycoor=Math.round(text.fy*STAGE_H);
          const width=Math.max(1,Math.round((text.str||'').length*(text.fontsize||16)*.594));
          const height=Math.round((text.fontsize||16)*1.125);
          pageObj.sprites.push(spId);emittedIds.push(spId);pageObj.lastSprite=spId;
          const sp=text.sjrMeta?cloneJson(text.sjrMeta):{};
          Object.assign(sp,{
            shown:sp.shown!==false,type:'text',id:spId,speed:typeof sp.speed==='number'?sp.speed:2,
            cx:Math.round(width/2),cy:Math.round(height/2),w:width,h:height,xcoor,ycoor,homex:xcoor,homey:ycoor,
            str:text.str||'',color:text.color||'#1a1a1a',fontsize:text.fontsize||16
          });
          pageObj[spId]=sp;
        });

        const oldLayers=page.sjrMeta&&Array.isArray(page.sjrMeta.layers)?page.sjrMeta.layers:[];
        pageObj.layers=mergeLayerOrder(oldLayers,emittedIds);jsonObj[key]=pageObj;
        const thumb=await renderThumb(page),thumbName=i+'_'+md5buf(thumb)+'.png';
        thumbDir.file(thumbName,thumb);if(i===0)firstThumb=thumbName;
        op.update(25+Math.round(50*(i+1)/Math.max(1,pages.length)),'Sayfa '+(i+1)+' / '+pages.length+' hazırlandı');
      }

      const charManifest=[];
      for(const item of state.charLib){
        if(!item.asset)continue;
        charManifest.push({file:charFile(item.asset),displayName:item.name||'Karakter'});
      }
      const bgManifest=[];
      for(const item of state.bgLib){
        if(!item.asset)continue;
        const svg=backgroundSvg(item.asset),filename=md5str(svg)+'.svg';
        bgDir.file(filename,svg);bgManifest.push({file:filename,name:item.name||'Arkaplan'});
      }
      const soundManifest=state.sounds.map((sound,i)=>({file:soundFiles[i],name:sound.name}));
      root.file('srjlib.json',JSON.stringify({characters:charManifest,backgrounds:bgManifest,sounds:soundManifest}));
      op.update(82,'Kütüphane manifesti hazırlanıyor…');

      const data=state.sjrDataMeta?cloneJson(state.sjrDataMeta):{};
      if(!data.id)data.id=String(Math.floor(Date.now()/1000));
      if(!data.ctime)data.ctime=new Date().toISOString();
      if(!data.version)data.version='Webv01';
      if(data.isgift==null)data.isgift='0';
      if(data.deleted==null)data.deleted='NO';
      data.name=name;data.mtime=String(Date.now());data.thumbnail={pagecount:pages.length,md5:firstThumb};data.json=jsonObj;
      root.file('data.json',JSON.stringify(data));
      op.update(90,'Arşiv sıkıştırılıyor…');
      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'},meta=>{
        const pct=90+Math.round(Math.max(0,Math.min(100,meta.percent||0))*.08);
        op.update(pct,'Arşiv sıkıştırılıyor…');
      });
      op.update(98,'İndirme hazırlanıyor…');
      const safe=name.replace(/[^\p{L}\p{N} _-]/gu,'').trim()||'proje';
      const anchor=doc.createElement('a');
      anchor.href=win.URL.createObjectURL(blob);anchor.download=safe+'.sjr';
      doc.body.appendChild(anchor);anchor.click();anchor.remove();
      win.setTimeout(()=>win.URL.revokeObjectURL(anchor.href),4000);
      op.update(100,'Tamamlandı');showToast('✓ '+safe+'.sjr indirildi');
      return true;
    }catch(error){
      console.error(error);showToast('Dışa aktarma sırasında hata oluştu','err');return false;
    }finally{
      op.close();setTransferBusy(false);if(btn)btn.textContent=old;
    }
  }

  function solidColorSvgFill(svgText){
    try{
      const parsed=new win.DOMParser().parseFromString(svgText,'image/svg+xml');
      if(parsed.querySelector('parsererror'))return null;
      const svg=parsed.documentElement;
      const children=[...svg.children].filter(el=>!['defs','metadata','title','desc'].includes(el.tagName.toLowerCase()));
      if(children.length!==1||children[0].tagName.toLowerCase()!=='rect')return null;
      return children[0].getAttribute('fill')||null;
    }catch{return null;}
  }

  async function svgTextToAsset(text,opts={}){
    const policy=inspectSvgCompatibility(text);
    if(policy.externalRefs)throw new Error('Projedeki SVG harici veya göreli kaynak içeriyor');
    if(policy.activeContent)throw new Error('Projedeki SVG aktif script içeriği içeriyor');
    const {w,h}=svgDims(text),dataURL='data:image/svg+xml;base64,'+b64(text);
    let img;
    try{img=await loadImage(dataURL);}catch{img=new win.Image();}
    return {
      isSvg:true,vector:!policy.hasEmbeddedImage,preserveSvg:!!opts.preserveSvg,
      svgText:text,dataURL,w:w||150,h:h||150,img
    };
  }

  async function importProject(file,progress=()=>{}){
    const JSZip=jszip();
    assertFileSize(file,MAX_SJR_BYTES,'.sjr dosyası');
    progress(5,'Arşiv açılıyor…');
    const zip=await JSZip.loadAsync(file);
    assertZipSafety(zip,ZIP_LIMITS);progress(14,'Arşiv doğrulandı');
    const report=createImportReport(),zipIndex=buildZipIndex(zip);

    const dataEntries=zipIndex.files.filter(item=>/(^|\/)data\.json$/i.test(item.path));
    let dataEntry=null;
    const canonical=dataEntries.find(item=>item.path.toLowerCase()==='project/data.json');
    if(canonical)dataEntry=canonical;
    else if(dataEntries.length===1)dataEntry=dataEntries[0];
    else if(dataEntries.length>1)throw new Error('Arşivde birden fazla data.json bulundu; proje kökü belirsiz');
    if(!dataEntry)throw new Error('Geçerli bir .sjr değil: data.json bulunamadı');

    const prefix=dataEntry.path.replace(/data\.json$/i,'');
    const data=await readJsonEntry(dataEntry.file,'data.json');
    const validation=validateScratchJrProject(data,MAX_PAGES);
    if(validation.errors.length)throw new Error(validation.errors.join(' · '));
    validation.warnings.forEach(message=>addImportIssue(report,'warning',message));
    const wrappedData=validation.wrapped,J=validation.json,pageKeys=validation.pageKeys;
    progress(24,'Proje metadata’sı doğrulandı');

    const ns={
      pages:[],current:resolveCurrentPageIndex(J.currentPage,pageKeys),charLib:[],bgLib:[],sounds:[],
      selected:null,selectedText:null,sjrDataMeta:wrappedData?dataMetaWithoutJson(data):{},sjrJsonMeta:jsonMetaWithoutPages(J,pageKeys)
    };
    const charLibByFile=new Map(),bgLibByFile=new Map();

    async function getCharLib(md5file,context='Karakter'){
      const safeRef=normalizeArchivePath(md5file);
      if(!safeRef){addImportIssue(report,'warning',context+': geçersiz karakter dosya yolu');return null;}
      if(charLibByFile.has(safeRef))return charLibByFile.get(safeRef);
      const assetFile=resolveZipFile(zipIndex,[prefix+'characters/'+safeRef,'characters/'+safeRef],report,context+' / '+safeRef);
      if(!assetFile){addImportIssue(report,'missing',context+': '+safeRef+' karakter dosyası bulunamadı');return null;}
      try{
        const asset=await svgTextToAsset(await assetFile.async('string'));
        const item={id:nextId(),name:'Karakter',asset};
        ns.charLib.push(item);charLibByFile.set(safeRef,item);report.characters++;return item;
      }catch(error){
        addImportIssue(report,'skipped',context+': '+safeRef+' okunamadı ('+(error.message||'SVG hatası')+')');return null;
      }
    }

    async function getBgLib(md5file,bgText,context='Arkaplan'){
      const safeRef=normalizeArchivePath(md5file);
      if(!safeRef){addImportIssue(report,'warning',context+': geçersiz arkaplan dosya yolu');return null;}
      if(bgLibByFile.has(safeRef))return bgLibByFile.get(safeRef);
      try{
        const asset=await svgTextToAsset(bgText,{preserveSvg:true});
        const item={id:nextId(),name:'Arkaplan',asset};
        ns.bgLib.push(item);bgLibByFile.set(safeRef,item);report.backgrounds++;return item;
      }catch(error){
        addImportIssue(report,'skipped',context+': '+safeRef+' okunamadı ('+(error.message||'SVG hatası')+')');return null;
      }
    }

    let libManifest=null;
    const libFile=resolveZipFile(zipIndex,[prefix+'srjlib.json','srjlib.json'],report,'srjlib.json');
    if(libFile){
      try{libManifest=await readJsonEntry(libFile,'srjlib.json');}
      catch(error){addImportIssue(report,'warning',error.message);}
    }

    if(libManifest&&typeof libManifest==='object'){
      for(const entry of safeManifestArray(libManifest.characters||libManifest.chars,report,'characters')){
        if(!entry||typeof entry!=='object'){addImportIssue(report,'warning','Geçersiz karakter manifest öğesi atlandı');continue;}
        const item=await getCharLib(entry.file,'Kütüphane karakteri');
        if(item)item.name=safeDisplayName(entry.displayName||entry.name,'Karakter');
      }
      for(const entry of safeManifestArray(libManifest.backgrounds||libManifest.bgs,report,'backgrounds')){
        if(!entry||typeof entry!=='object'){addImportIssue(report,'warning','Geçersiz arkaplan manifest öğesi atlandı');continue;}
        const safeRef=normalizeArchivePath(entry.file);
        if(!safeRef){addImportIssue(report,'warning','Kütüphane arkaplanı: geçersiz dosya yolu');continue;}
        const bgFile=resolveZipFile(zipIndex,[prefix+'backgrounds/'+safeRef,'backgrounds/'+safeRef],report,'Kütüphane arkaplanı / '+safeRef);
        if(!bgFile){addImportIssue(report,'missing','Kütüphane arkaplanı: '+safeRef+' bulunamadı');continue;}
        const item=await getBgLib(safeRef,await bgFile.async('string'),'Kütüphane arkaplanı');
        if(item)item.name=safeDisplayName(entry.name,'Arkaplan');
      }
    }

    progress(38,'Karakter ve arkaplan kütüphanesi işlendi');
    const soundNames=new Map();
    if(libManifest&&typeof libManifest==='object'){
      for(const entry of safeManifestArray(libManifest.sounds,report,'sounds')){
        if(!entry||typeof entry!=='object')continue;
        const safeRef=normalizeArchivePath(entry.file);
        if(safeRef)soundNames.set(safeRef.split('/').pop().toLowerCase(),safeDisplayName(entry.name,'Ses'));
      }
    }

    const soundList=zipIndex.files.filter(item=>/(^|\/)sounds\//i.test(item.path)&&/\.(wav|mp3|webm|m4a|ogg)$/i.test(item.path));
    const soundGroups=new Map();
    for(const item of soundList){
      const base=item.path.split('/').pop(),key=base.toLowerCase(),group=soundGroups.get(key)||[];
      group.push({...item,base});soundGroups.set(key,group);
    }
    const soundBases=new Set();let soundNumber=0;
    for(const [key,group] of soundGroups){
      if(group.length>1){
        addImportIssue(report,'warning','Ses '+group[0].base+' için '+group.length+' aynı adlı dosya bulundu; belirsiz olduğu için atlandı');
        continue;
      }
      const item=group[0],base=item.base;
      let ext=(item.path.split('.').pop()||'wav').toLowerCase();
      if(!['wav','mp3','webm','m4a','ogg'].includes(ext))ext='wav';
      soundBases.add(base);
      try{
        ns.sounds.push({id:nextId(),name:soundNames.get(key)||('Ses '+(++soundNumber)),buf:await item.file.async('arraybuffer'),ext,sourceFile:base});
        report.sounds++;
      }catch{addImportIssue(report,'skipped','Ses okunamadı: '+base);}
    }

    progress(52,'Sesler işlendi');
    for(let i=0;i<pageKeys.length;i++){
      const key=pageKeys[i],sourcePage=J[key],page=newPage();
      if(sourcePage&&typeof sourcePage==='object'&&!Array.isArray(sourcePage)){
        page.sjrMeta=pageMetaWithoutSprites(sourcePage);

        if(sourcePage.md5){
          const safeRef=normalizeArchivePath(sourcePage.md5);
          if(!safeRef)addImportIssue(report,'warning',key+': geçersiz arkaplan yolu');
          else{
            const bgFile=resolveZipFile(zipIndex,[prefix+'backgrounds/'+safeRef,'backgrounds/'+safeRef],report,key+' arkaplanı / '+safeRef);
            if(!bgFile)addImportIssue(report,'missing',key+': '+safeRef+' arkaplan dosyası bulunamadı');
            else{
              try{
                const bgText=await bgFile.async('string'),solidFill=solidColorSvgFill(bgText);
                if(solidFill)page.bg={mode:'color',color:solidFill,asset:null,bgId:null};
                else{
                  const item=await getBgLib(safeRef,bgText,key+' arkaplanı');
                  if(item)page.bg={mode:'image',asset:item.asset,color:'#fff',bgId:item.id};
                }
              }catch{addImportIssue(report,'skipped',key+': arkaplan okunamadı');}
            }
          }
        }

        const sprites=Array.isArray(sourcePage.sprites)?sourcePage.sprites:[];
        for(const spId of sprites){
          if(typeof spId!=='string'||!spId){addImportIssue(report,'skipped',key+': geçersiz sprite kimliği');continue;}
          const sp=Object.prototype.hasOwnProperty.call(sourcePage,spId)?sourcePage[spId]:null;
          if(!sp||typeof sp!=='object'||Array.isArray(sp)){addImportIssue(report,'missing',key+': '+spId+' sprite nesnesi bulunamadı');continue;}

          if(sp.type==='text'){
            const fx=((typeof sp.xcoor==='number')?sp.xcoor:STAGE_W/2)/STAGE_W;
            const fy=((typeof sp.ycoor==='number')?sp.ycoor:STAGE_H/2)/STAGE_H;
            page.texts.push({
              id:nextId(),str:String(sp.str??'').slice(0,2000),color:colorToHex(sp.color||'#1a1a1a'),fontsize:sp.fontsize||16,
              fx:Math.max(0,Math.min(1,fx)),fy:Math.max(0,Math.min(1,fy)),sjrId:spId,sjrMeta:cloneJson(sp)
            });
            report.texts++;continue;
          }

          if(sp.type!=='sprite'){
            addImportIssue(report,'skipped',key+': '+spId+' desteklenmeyen sprite tipi ('+String(sp.type||'yok')+')');continue;
          }

          const lib=await getCharLib(sp.md5,key+' / '+spId);
          if(!lib){addImportIssue(report,'skipped',key+': '+spId+' karakteri asset eksik olduğu için atlandı');continue;}
          if(sp.name&&lib.name==='Karakter')lib.name=safeDisplayName(sp.name,'Karakter');

          if(Array.isArray(sp.sounds)){
            for(const ref of sp.sounds){
              const base=String(ref||'').replace(/^.*[\\/]/,'');
              if(base&&base!=='pop.mp3'&&!soundBases.has(base))addImportIssue(report,'missing',key+' / '+spId+': ses bulunamadı '+base);
            }
          }

          const w=sp.w||lib.asset.w||150,h=sp.h||lib.asset.h||150,aspect=h/w;
          const scale=typeof sp.scale==='number'?sp.scale:(typeof sp.defaultScale==='number'?sp.defaultScale:(STAGE_W*.27/w));
          const sizePct=Math.max(4,Math.min(100,(scale*w)/STAGE_W*100));
          const fx=((typeof sp.xcoor==='number')?sp.xcoor:STAGE_W/2)/STAGE_W;
          const fy=((typeof sp.ycoor==='number')?sp.ycoor:STAGE_H/2)/STAGE_H;
          page.chars.push({
            id:nextId(),libId:lib.id,name:safeDisplayName(sp.name||lib.name,'Karakter'),asset:lib.asset,
            fx:Math.max(0,Math.min(1,fx)),fy:Math.max(0,Math.min(1,fy)),sizePct,flip:!!sp.flip,aspect,
            sjrId:spId,sjrMeta:cloneJson(sp)
          });
        }
      }
      ns.pages.push(page);report.pages++;
      progress(55+Math.round(35*(i+1)/Math.max(1,pageKeys.length)),'Sayfa '+(i+1)+' / '+pageKeys.length+' içe aktarılıyor');
    }

    if(!ns.pages.length){ns.pages.push(newPage());report.pages=1;}
    progress(94,'Çalışma alanı hazırlanıyor…');
    checkpoint();
    Object.assign(state,ns);
    state.current=Math.max(0,Math.min(ns.current,ns.pages.length-1));state.selected=null;
    const nameInput=doc.getElementById('pname');
    if(nameInput)nameInput.value=safeDisplayName(data&&data.name,'Benim Projem').slice(0,40);
    render();setTab('chars');progress(100,'İçe aktarma tamamlandı');
    return report;
  }

  async function runImport(file){
    if(transferBusy){showToast('Başka bir içe/dışa aktarma işlemi sürüyor');return null;}
    const btn=doc.getElementById('importBtn'),old=btn?.textContent||'İçe aktar';
    setTransferBusy(true);if(btn)btn.textContent='Yükleniyor…';
    const op=startOperation('İçe aktarılıyor');
    try{
      const report=await importProject(file,op.update);
      op.close();showImportReport(report);return report;
    }catch(error){
      console.error(error);showToast('İçe aktarılamadı: '+(error.message||'dosya okunamadı'),'err');return null;
    }finally{
      op.close();setTransferBusy(false);if(btn)btn.textContent=old;
    }
  }

  return {exportProject,importProject,runImport,isBusy,setTransferBusy};
}
