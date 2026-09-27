import {inspectSvgCompatibility} from './roundtrip-utils.mjs';
import {assertFileSize,escapeHtml} from './file-utils.mjs';

export function createLibraryController(options={}){
  const doc=options.document||globalThis.document;
  const state=options.state;
  const nextId=options.nextId;
  const checkpoint=options.checkpoint||(()=>{});
  const scheduleAutosave=options.scheduleAutosave||(()=>{});
  const showToast=options.showToast||(()=>{});
  const confirmModal=options.confirmModal||(()=>Promise.resolve(false));
  const showDialog=options.showDialog||(()=>{});
  const hideDialog=options.hideDialog||(()=>{});
  const setTab=options.setTab||(()=>{});
  const renderStage=options.renderStage||(()=>{});
  const renderPages=options.renderPages||(()=>{});
  const scheduleRenderPages=options.scheduleRenderPages||(()=>{});
  const renderAll=options.renderAll||(()=>{});
  const assetPipeline=options.assetPipeline;
  const maxImageBytes=options.maxImageBytes||10*1024*1024;
  let bound=false;

  function baseName(filename){
    return (filename||'').replace(/\.[^.]+$/,'').replace(/[_\-]+/g,' ').trim().slice(0,24)||'Karakter';
  }

  function addCharToLib(asset,name){
    const item={id:nextId(),name:name||'Karakter',asset};state.charLib.push(item);return item;
  }
  function placeChar(item){
    const asset=item.asset,aspect=asset.h/asset.w;
    state.pages[state.current].chars.push({
      id:nextId(),libId:item.id,name:item.name,asset,fx:.5,fy:.5,sizePct:27,flip:false,aspect
    });
    state.selected=state.pages[state.current].chars.at(-1).id;
  }
  function addBgToLib(asset,name){
    const item={id:nextId(),name:name||'Arkaplan',asset};state.bgLib.push(item);return item;
  }
  function applyBg(item){
    state.pages[state.current].bg={mode:'image',asset:item.asset,color:'#fff',bgId:item.id};
  }

  function renderBadges(){
    doc.getElementById('badgeChars').textContent=state.charLib.length;
    doc.getElementById('badgeBg').textContent=state.bgLib.length;
    doc.getElementById('badgeSnd').textContent=state.sounds.length;
  }

  function renderCharLib(){
    const wrap=doc.getElementById('charLib');wrap.innerHTML='';
    doc.getElementById('charEmpty').style.display=state.charLib.length?'none':'block';
    state.charLib.forEach(item=>{
      const card=doc.createElement('div');card.className='libitem';
      const tag=doc.createElement('span');tag.className='tag '+(item.asset.vector?'vec':'emb');tag.textContent=item.asset.vector?'VEKTÖR':'GÖMÜLÜ';
      const preview=doc.createElement('div');preview.className='ph';
      const image=doc.createElement('img');image.src=item.asset.dataURL;image.alt='';preview.appendChild(image);
      const name=doc.createElement('div');name.className='nm';name.textContent=item.name;name.title='Yeniden adlandırmak için tıkla';

      name.onclick=function editName(event){
        event.stopPropagation();checkpoint();
        const input=doc.createElement('input');input.className='nm-input';input.type='text';input.value=item.name;input.maxLength=30;
        event.currentTarget.replaceWith(input);input.focus();input.select();
        function save(){
          const value=input.value.trim();if(value)item.name=value;
          state.pages.forEach(page=>page.chars.filter(character=>character.libId===item.id).forEach(character=>character.name=item.name));
          const next=doc.createElement('div');next.className='nm';next.textContent=item.name;next.title='Yeniden adlandırmak için tıkla';next.onclick=editName;
          input.replaceWith(next);scheduleAutosave();
        }
        input.onblur=save;
        input.onkeydown=e=>{if(e.key==='Enter')input.blur();if(e.key==='Escape'){input.value=item.name;input.blur();}};
        input.onclick=e=>e.stopPropagation();
      };

      const add=doc.createElement('div');add.className='add';add.textContent='+ Sahneye ekle';
      card.append(tag,preview,name,add);
      const place=()=>{checkpoint();placeChar(item);setTab('stage');scheduleAutosave();showToast(item.name+' sahneye eklendi');};
      card.onclick=place;card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',item.name+' karakterini sahneye ekle');
      card.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===card){e.preventDefault();place();}};

      const remove=doc.createElement('button');remove.className='x';remove.textContent='×';remove.setAttribute('aria-label',item.name+' karakterini kütüphaneden sil');
      remove.onclick=e=>{e.stopPropagation();removeCharLib(item);};
      const info=doc.createElement('button');info.className='info';info.textContent='i';info.title='SVG bilgileri';info.setAttribute('aria-label',item.name+' SVG bilgileri');
      info.onclick=e=>{e.stopPropagation();showSvgInfo(item);};
      card.append(remove,info);wrap.appendChild(card);
    });
  }

  async function removeCharLib(item){
    const used=state.pages.reduce((count,page)=>count+page.chars.filter(character=>character.libId===item.id).length,0);
    const confirmed=await confirmModal({
      title:'Karakteri kütüphaneden sil',
      bodyHtml:`<b>${escapeHtml(item.name)}</b> silinsin mi?`+(used?`<div class="warnline">⚠ ${used} sahne örneği de kaldırılacak.</div>`:''),
      okText:'Evet, sil',cancelText:'Vazgeç'
    });
    if(!confirmed)return;
    checkpoint();state.charLib=state.charLib.filter(entry=>entry!==item);
    state.pages.forEach(page=>{page.chars=page.chars.filter(character=>character.libId!==item.id);});
    renderAll();
  }

  function renderBgTab(){
    const wrap=doc.getElementById('bgLib');wrap.innerHTML='';
    doc.getElementById('bgEmpty').style.display=state.bgLib.length?'none':'block';
    const page=state.pages[state.current];
    state.bgLib.forEach(item=>{
      const card=doc.createElement('div');card.className='libitem bgadd';
      card.style.outline=(page.bg.mode==='image'&&page.bg.bgId===item.id)?'3px solid var(--blue)':'';
      const tag=doc.createElement('span');tag.className='tag '+(item.asset.vector?'vec':'emb');tag.textContent=item.asset.vector?'VEKTÖR':'GÖMÜLÜ';
      const preview=doc.createElement('div');preview.className='ph';
      const image=doc.createElement('img');image.src=item.asset.dataURL;image.alt='';preview.appendChild(image);
      const name=doc.createElement('div');name.className='nm';name.textContent=item.name;
      const add=doc.createElement('div');add.className='add';add.textContent='Bu sayfaya uygula';
      card.append(tag,preview,name,add);
      const apply=()=>{
        checkpoint();applyBg(item);renderBgTab();renderStage();renderPages();scheduleAutosave();
        showToast('Arkaplan Sayfa '+(state.current+1)+'\'e uygulandı');
      };
      card.onclick=apply;card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',item.name+' arkaplanını bu sayfaya uygula');
      card.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===card){e.preventDefault();apply();}};
      const remove=doc.createElement('button');remove.className='x';remove.textContent='×';remove.setAttribute('aria-label',item.name+' arkaplanını kütüphaneden sil');
      remove.onclick=e=>{e.stopPropagation();removeBgLib(item);};card.appendChild(remove);wrap.appendChild(card);
    });

    const note=doc.getElementById('bgPageNote'),current=page.bg.mode==='color'?('düz renk '+page.bg.color):'bir resim';
    const strong=doc.createElement('b');strong.textContent='Sayfa '+(state.current+1);
    note.replaceChildren(doc.createTextNode('Şu an düzenlenen: '),strong,doc.createTextNode(' — arkaplan: '+current+'. (Sayfayı değiştirmek için Sahne sekmesini kullan.)'));
    doc.getElementById('bgColor').value=page.bg.mode==='color'?page.bg.color:'#eaf4ff';
  }

  async function removeBgLib(item){
    const used=state.pages.filter(page=>page.bg.bgId===item.id).length;
    const confirmed=await confirmModal({
      title:'Arkaplanı kütüphaneden sil',
      bodyHtml:`<b>${escapeHtml(item.name)}</b> silinsin mi?`+(used?`<div class="warnline">⚠ ${used} sayfanın arkaplanı varsayılan renge dönecek.</div>`:''),
      okText:'Evet, sil',cancelText:'Vazgeç'
    });
    if(!confirmed)return;
    checkpoint();state.bgLib=state.bgLib.filter(entry=>entry!==item);
    state.pages.forEach(page=>{if(page.bg.bgId===item.id)page.bg={mode:'color',color:'#eaf4ff',asset:null,bgId:null};});
    renderAll();
  }

  function analyzeSvg(svgText){
    const text=svgText||'',policy=inspectSvgCompatibility(text);
    const byteSize=new TextEncoder().encode(text).length;
    const paths=(text.match(/<path[\s>]/gi)||[]).length,circles=(text.match(/<circle[\s>]/gi)||[]).length;
    const polygons=(text.match(/<polygon[\s>]/gi)||[]).length,directFills=(text.match(/\bfill="[^"]*"/gi)||[]).length;
    const colors=new Set((text.match(/fill="(#[0-9a-fA-F]{3,8})"/gi)||[]).map(value=>value.toLowerCase())).size;
    const vb=text.match(/viewBox="([^"]*)"/i),w=text.match(/\bwidth="([^"]*)"/i),h=text.match(/\bheight="([^"]*)"/i);
    return {...policy,byteSize,paths,circles,polygons,directFills,colors,vbVal:vb?vb[1]:'—',w:w?w[1]:'—',h:h?h[1]:'—'};
  }

  function showSvgInfo(item){
    const analysis=analyzeSvg(item.asset.svgText),safe=value=>escapeHtml(String(value));
    doc.getElementById('infoTitle').textContent=item.name+' — SVG Bilgileri';
    const unsupported=Object.entries(analysis.unsupportedTags).filter(([,n])=>n).map(([key,n])=>key+' ×'+n).join(', ')||'Yok';
    const effects=Object.entries(analysis.effectTags).filter(([,n])=>n).map(([key,n])=>key+' ×'+n).join(', ')||'Yok';
    const rows=[
      ['Çıktı türü',item.asset.vector?'Vektör':'Güvenli raster / gömülü'],
      ['Dosya boyutu',(analysis.byteSize/1024).toFixed(1)+' KB'],['Path sayısı',analysis.paths],
      ['Renk sayısı',analysis.colors],['Boyut',analysis.w+' × '+analysis.h],['viewBox',analysis.vbVal]
    ];
    const checks=[
      {ok:!analysis.externalRefs,label:'Harici/göreli kaynak',value:analysis.externalRefs?analysis.unsafeReferences.join(', '):'Yok',note:'Offline çalışma için yalnızca data: ve #fragment referansları kabul edilir.'},
      {ok:!analysis.activeContent,label:'Aktif içerik',value:analysis.activeContent?'script var':'Yok',note:'Script içeren SVG dosyaları kabul edilmez.'},
      {ok:analysis.transformCount===0,label:'Transform',value:analysis.transformCount?analysis.transformCount+' adet':'Yok',note:'Transform içeren yüklemeler görünümü korumak için raster fallback kullanır.'},
      {ok:analysis.arcPaths===0,label:'Arc komutu A/a',value:analysis.arcPaths?analysis.arcPaths+' path':'Yok',note:'Arc içeren yüklemeler doğrudan vektör normalize edilmez; raster fallback kullanılır.'},
      {ok:analysis.unsupportedCount===0,label:'Ek geometri',value:unsupported,note:'rect/ellipse/line/polyline/text/use gibi yapılar doğrudan vektör yoluna alınmaz.'},
      {ok:analysis.effectCount===0,label:'Clip / mask / gradient / filter',value:effects,note:'Efektli SVG görünümü korunmak için raster fallback kullanılır.'},
      {ok:(analysis.styleCount+analysis.styleElementCount)===0,label:'CSS style',value:(analysis.styleCount+analysis.styleElementCount)?(analysis.styleCount+' attribute, '+analysis.styleElementCount+' <style>'):'Yok',note:'style attribute veya <style> elementi içeren SVG otomatik normalizasyonda raster fallback kullanır.'},
      {ok:!analysis.rootPresentation,label:'Kök SVG presentation',value:analysis.rootPresentation?'Var':'Yok',note:'Kökten miras alınan fill/stroke/opacity gibi stiller raster fallback ile korunur.'},
      {ok:!analysis.viewBoxOriginNonZero,label:'viewBox başlangıcı',value:analysis.viewBoxValid?(analysis.viewBox[0]+' '+analysis.viewBox[1]):'Belirsiz',note:'0,0 dışında başlayan viewBox doğrudan koordinat ölçeklemesine sokulmaz.'}
    ];

    let html='<div class="info-section-title">Genel</div><div class="info-stats-grid">';
    rows.forEach(([label,value],index)=>{
      const span=index===rows.length-1&&rows.length%2===1?' span2':'';
      html+=`<div class="stat-card${span}"><div class="lbl">${safe(label)}</div><div class="val">${safe(value)}</div></div>`;
    });
    html+='</div><div class="info-section-title">Vektör güvenlik politikası</div><div class="compat-grid">';
    html+=checks.map(check=>`
      <div class="compat-check ${check.ok?'check-ok':'check-err'}">
        <span class="check-icon">${check.ok?'✓':'↪'}</span>
        <div class="check-body"><div class="check-top"><span class="lbl">${safe(check.label)}</span><span class="val">${safe(check.value)}</span></div>
        ${check.ok?'':`<div class="check-note">${safe(check.note)}</div>`}</div>
      </div>`).join('');
    html+='</div>';doc.getElementById('infoStats').innerHTML=html;

    const compatibility=doc.getElementById('infoCompat');
    if(!item.asset.vector||analysis.hasEmbeddedImage){
      compatibility.className='compat-bar good';compatibility.textContent='✓ Güvenli raster/gömülü çıktı — karmaşık SVG özellikleri görsel olarak korunur.';
    }else if(analysis.safeDirectVector){
      compatibility.className='compat-bar good';compatibility.textContent='✓ Doğrudan vektör normalizasyon kriterleri temiz.';
    }else{
      compatibility.className='compat-bar warn';compatibility.textContent='↪ Kaynak vektör korunuyor; yeni yüklemelerde bu yapı otomatik olarak raster fallback yoluna alınır.';
    }
    const overlay=doc.getElementById('infoOverlay');showDialog(overlay,doc.getElementById('infoClose'),closeInfoDialog);
  }

  function closeInfoDialog(){hideDialog(doc.getElementById('infoOverlay'));}

  function syncConversion(){
    const conversion=assetPipeline.getConversion();
    doc.querySelectorAll('[data-conv]').forEach(bar=>{
      bar.querySelectorAll('.seg button').forEach(button=>button.classList.toggle('on',button.dataset.m===conversion.mode));
      bar.querySelector('[data-colors]').value=String(conversion.colors);
    });
  }

  function bind(){
    if(bound)return;bound=true;
    doc.querySelectorAll('[data-conv]').forEach(bar=>{
      bar.querySelectorAll('.seg button').forEach(button=>button.onclick=()=>{assetPipeline.setConversion({mode:button.dataset.m});syncConversion();});
      bar.querySelector('[data-colors]').onchange=event=>{assetPipeline.setConversion({colors:+event.target.value});syncConversion();};
    });
    syncConversion();

    doc.getElementById('charUpload').onclick=()=>doc.getElementById('charFile').click();
    doc.getElementById('charFile').addEventListener('change',async event=>{
      const files=[...event.target.files];event.target.value='';if(files.length)checkpoint();
      for(const file of files){
        try{
          assertFileSize(file,maxImageBytes,'Karakter dosyası');
          addCharToLib(await assetPipeline.fileToAsset(file),baseName(file.name));
        }catch(error){console.error(error);showToast((error.message||'Okunamadı')+': '+file.name,'err');}
      }
      renderBadges();renderCharLib();scheduleAutosave();
      if(files.length)showToast(files.length>1?files.length+' karakter eklendi':'Karakter kütüphaneye eklendi');
    });

    doc.getElementById('bgUpload').onclick=()=>doc.getElementById('bgFile').click();
    doc.getElementById('bgFile').addEventListener('change',async event=>{
      const files=[...event.target.files];event.target.value='';if(files.length)checkpoint();
      for(const file of files){
        try{
          assertFileSize(file,maxImageBytes,'Arkaplan dosyası');
          const item=addBgToLib(await assetPipeline.fileToBackgroundAsset(file),baseName(file.name));
          if(files.length===1)applyBg(item);
        }catch(error){showToast(error.message||'Arkaplan okunamadı','err');}
      }
      renderBadges();renderBgTab();renderStage();renderPages();scheduleAutosave();
      if(files.length)showToast('Arkaplan eklendi');
    });

    doc.getElementById('bgColor').addEventListener('pointerdown',()=>checkpoint());
    doc.getElementById('bgColor').addEventListener('input',event=>{
      state.pages[state.current].bg={mode:'color',color:event.target.value,asset:null,bgId:null};
      renderBgTab();renderStage();scheduleRenderPages();scheduleAutosave();
    });
    doc.getElementById('bgClear').onclick=()=>{
      checkpoint();state.pages[state.current].bg={mode:'color',color:'#eaf4ff',asset:null,bgId:null};
      renderBgTab();renderStage();renderPages();scheduleAutosave();
    };

    doc.getElementById('infoClose').onclick=closeInfoDialog;
    doc.getElementById('infoCloseBtn').onclick=closeInfoDialog;
    doc.getElementById('infoOverlay').addEventListener('click',event=>{if(event.target===doc.getElementById('infoOverlay'))closeInfoDialog();});
  }

  return {
    bind,renderBadges,renderCharLib,renderBgTab,addCharToLib,addBgToLib,placeChar,applyBg,showSvgInfo,syncConversion
  };
}
