import {colorToHex,escapeHtml} from './file-utils.mjs';

export function createStageController(options={}){
  const doc=options.document||globalThis.document;
  const win=options.window||doc?.defaultView||globalThis.window;
  const state=options.state;
  const newPage=options.newPage;
  const nextId=options.nextId;
  const checkpoint=options.checkpoint||(()=>{});
  const scheduleAutosave=options.scheduleAutosave||(()=>{});
  const showToast=options.showToast||(()=>{});
  const confirmModal=options.confirmModal||(()=>Promise.resolve(false));
  const showDialog=options.showDialog||(()=>{});
  const hideDialog=options.hideDialog||(()=>{});
  const renderBgTab=options.renderBgTab||(()=>{});
  const renderAll=options.renderAll||(()=>{});
  const updateHistoryButtons=options.updateHistoryButtons||(()=>{});
  const STAGE_W=options.stageWidth||480,STAGE_H=options.stageHeight||360,MAX_PAGES=options.maxPages||4;

  const stageEl=doc.getElementById('stage');
  const TEXT_COLORS=['#1a1a1a','#e84040','#f08030','#e8c000','#40b840','#2880e0','#8f56e3','#e860a0'];
  const pageThumbCache=new WeakMap(),thumbAssetIds=new WeakMap();
  let thumbAssetSeq=1,renderPagesTimer=null,gridVisible=false,bgPickTarget=null,charPickTarget=null,bound=false;

  function drawCover(ctx,img,W,H){
    const iw=img.naturalWidth||img.width||W,ih=img.naturalHeight||img.height||H;
    const ratio=Math.max(W/iw,H/ih),dw=iw*ratio,dh=ih*ratio;
    try{ctx.drawImage(img,(W-dw)/2,(H-dh)/2,dw,dh);}catch{}
  }

  function thumbAssetId(asset){
    if(!asset||typeof asset!=='object')return 'none';
    if(!thumbAssetIds.has(asset))thumbAssetIds.set(asset,'a'+thumbAssetSeq++);
    return thumbAssetIds.get(asset);
  }

  function pageThumbSignature(page){
    return JSON.stringify([
      page.bg?.mode,page.bg?.color,page.bg?.bgId,thumbAssetId(page.bg?.asset),
      (page.chars||[]).map(c=>[
        c.id,c.libId,thumbAssetId(c.asset),+Number(c.fx||0).toFixed(4),+Number(c.fy||0).toFixed(4),
        +Number(c.sizePct||0).toFixed(2),!!c.flip,+Number(c.aspect||1).toFixed(4)
      ]),
      (page.texts||[]).map(t=>[t.id,t.str,t.color,t.fontsize,+Number(t.fx||0).toFixed(4),+Number(t.fy||0).toFixed(4)])
    ]);
  }

  function renderPageThumbSync(page,w,h){
    const canvas=doc.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d');
    if(page.bg.mode==='color'){
      ctx.fillStyle=page.bg.color;ctx.fillRect(0,0,w,h);
    }else if(page.bg.asset?.img){
      ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);drawCover(ctx,page.bg.asset.img,w,h);
    }else{
      ctx.fillStyle='#eaf4ff';ctx.fillRect(0,0,w,h);
    }
    for(const character of page.chars||[]){
      if(!character.asset?.img)continue;
      const scale=w/STAGE_W,dispW=character.sizePct/100*STAGE_W*scale,dispH=dispW*character.aspect;
      const x=character.fx*w,y=character.fy*h;
      ctx.save();ctx.translate(x,y);if(character.flip)ctx.scale(-1,1);
      try{ctx.drawImage(character.asset.img,-dispW/2,-dispH/2,dispW,dispH);}catch{}
      ctx.restore();
    }
    for(const text of page.texts||[]){
      const fontSize=Math.max(6,Math.round(text.fontsize*w/STAGE_W));
      ctx.font=`600 ${fontSize}px ui-rounded, system-ui, sans-serif`;
      ctx.fillStyle=text.color||'#1a1a1a';ctx.textAlign='center';ctx.textBaseline='middle';
      try{ctx.fillText(text.str||'',text.fx*w,text.fy*h);}catch{}
    }
    return canvas.toDataURL('image/png');
  }

  function getPageThumb(page,w,h){
    const signature=pageThumbSignature(page),cached=pageThumbCache.get(page);
    if(cached&&cached.signature===signature&&cached.w===w&&cached.h===h)return cached.url;
    const url=renderPageThumbSync(page,w,h);
    pageThumbCache.set(page,{signature,w,h,url});
    return url;
  }

  function scheduleRenderPages(delay=80){
    win.clearTimeout(renderPagesTimer);
    renderPagesTimer=win.setTimeout(()=>{renderPagesTimer=null;renderPages();},delay);
  }

  function renderPages(){
    if(renderPagesTimer){win.clearTimeout(renderPagesTimer);renderPagesTimer=null;}
    const panel=doc.getElementById('pagesPanel');panel.innerHTML='';
    state.pages.forEach((page,index)=>{
      const row=doc.createElement('div');row.className='page-row';
      const actions=doc.createElement('div');actions.className='page-actions';

      const bgBtn=doc.createElement('button');bgBtn.className='page-act-btn';bgBtn.title='Arkaplan seç';
      bgBtn.dataset.pageBg=String(index);bgBtn.textContent='🎨';
      bgBtn.onclick=event=>{event.stopPropagation();openBgPick(index);};

      const charBtn=doc.createElement('button');charBtn.className='page-act-btn char-btn';charBtn.title='Karakter ekle';
      charBtn.dataset.pageChar=String(index);charBtn.textContent='+';
      charBtn.onclick=event=>{event.stopPropagation();openCharPick(index);};
      actions.append(bgBtn,charBtn);

      const thumb=doc.createElement('div');thumb.className='page-thumb'+(index===state.current?' active':'');
      const img=doc.createElement('img');img.src=getPageThumb(page,92,69);img.alt='Sayfa '+(index+1);
      const num=doc.createElement('span');num.className='page-num';num.textContent=index+1;
      const del=doc.createElement('button');del.className='page-del';del.textContent='×';del.title='Sayfayı sil';
      if(state.pages.length<=1)del.style.display='none';
      del.onclick=async event=>{
        event.stopPropagation();
        if(state.pages.length<=1){showToast('En az bir sayfa olmalı','err');return;}
        const confirmed=await confirmModal({
          title:'Sayfayı sil',okText:'Evet, sil',cancelText:'Vazgeç',
          bodyHtml:'<b>Sayfa '+(index+1)+'</b> silinecek. Bu sayfadaki tüm karakterler kaldırılır.<div class="warnline">↶ Gerekirse Geri Al ile işlemi geri çevirebilirsin.</div>'
        });
        if(!confirmed)return;
        checkpoint();
        state.pages.splice(index,1);
        state.current=Math.max(0,Math.min(state.current,state.pages.length-1));
        state.selected=null;state.selectedText=null;renderAll();
      };
      thumb.append(img,num,del);
      const selectPage=()=>{
        state.current=index;state.selected=null;state.selectedText=null;
        renderWorkspace();renderBgTab();
      };
      thumb.onclick=selectPage;thumb.tabIndex=0;thumb.setAttribute('role','button');thumb.setAttribute('aria-label','Sayfa '+(index+1)+' seç');
      thumb.onkeydown=event=>{if((event.key==='Enter'||event.key===' ')&&event.target===thumb){event.preventDefault();selectPage();}};
      row.append(actions,thumb);panel.appendChild(row);
    });

    const add=doc.createElement('button');add.className='add-page';add.textContent='+';
    add.title=state.pages.length>=MAX_PAGES?'ScratchJr en fazla 4 sayfa destekler':'Yeni sayfa ekle';
    add.disabled=state.pages.length>=MAX_PAGES;add.setAttribute('aria-label',add.title);
    add.onclick=()=>{
      if(state.pages.length>=MAX_PAGES){showToast('ScratchJr en fazla 4 sayfa destekler','err');return;}
      checkpoint();state.pages.push(newPage());state.current=state.pages.length-1;state.selected=null;state.selectedText=null;renderAll();
    };
    panel.appendChild(add);
  }

  function getSel(){return state.pages[state.current]?.chars.find(character=>character.id===state.selected);}
  function getSelText(){return (state.pages[state.current]?.texts||[]).find(text=>text.id===state.selectedText);}

  function initGridLabels(){
    const rowWrap=doc.getElementById('stageRowLabels'),colWrap=doc.getElementById('stageColLabels');
    if(!rowWrap||!colWrap)return;
    if(!rowWrap.children.length){
      for(let i=1;i<=15;i++){
        const el=doc.createElement('div');el.className='stage-lbl';el.dataset.row=i;el.textContent=i;rowWrap.appendChild(el);
      }
    }
    if(!colWrap.children.length){
      for(let i=1;i<=20;i++){
        const el=doc.createElement('div');el.className='stage-lbl';el.dataset.col=i;el.textContent=i;colWrap.appendChild(el);
      }
    }
  }

  function updateGridLabels(){
    doc.querySelectorAll('#stageRowLabels .stage-lbl,#stageColLabels .stage-lbl').forEach(el=>el.classList.remove('hl'));
    const selected=getSel();if(!selected)return;
    const col=Math.max(1,Math.min(20,Math.ceil(selected.fx*20)));
    const row=Math.max(1,Math.min(15,Math.ceil((1-selected.fy)*15)));
    doc.querySelector(`#stageRowLabels [data-row="${row}"]`)?.classList.add('hl');
    doc.querySelector(`#stageColLabels [data-col="${col}"]`)?.classList.add('hl');
  }

  function renderStage(){
    const page=state.pages[state.current];if(!page||!stageEl)return;
    [...stageEl.querySelectorAll('.sprite,.bgimg,.empty,.stage-text')].forEach(node=>node.remove());
    if(page.bg.mode==='color'){
      stageEl.style.background=page.bg.color;
    }else{
      stageEl.style.background='#fff';
      const bg=doc.createElement('img');bg.className='bgimg';bg.src=page.bg.asset.dataURL;bg.alt='';
      stageEl.insertBefore(bg,stageEl.querySelector('.grid'));
    }
    if(!page.chars.length){
      const empty=doc.createElement('div');empty.className='empty';
      empty.textContent='Karakterler sekmesinden bir karaktere tıklayarak sahneye ekle 🐱';stageEl.appendChild(empty);
    }
    const sw=stageEl.clientWidth,sh=stageEl.clientHeight;
    page.chars.forEach(character=>{
      const el=doc.createElement('div');
      el.className='sprite'+(character.id===state.selected?' sel':'')+(character.flip?' flip':'');el.dataset.id=character.id;
      const dispW=character.sizePct/100*sw,dispH=dispW*character.aspect;
      el.style.width=dispW+'px';el.style.height=dispH+'px';
      el.style.left=(character.fx*sw-dispW/2)+'px';el.style.top=(character.fy*sh-dispH/2)+'px';
      const img=doc.createElement('img');img.src=character.asset.dataURL;img.alt=character.name;el.appendChild(img);
      stageEl.appendChild(el);attachDrag(el,character);
    });
    for(const text of page.texts||[]){
      const el=doc.createElement('div');el.className='stage-text'+(text.id===state.selectedText?' sel':'');el.dataset.textId=text.id;
      const scale=sw/STAGE_W;
      el.style.fontSize=(text.fontsize*scale)+'px';el.style.color=text.color;
      el.style.left=(text.fx*sw)+'px';el.style.top=(text.fy*sh)+'px';el.textContent=text.str||'';
      stageEl.appendChild(el);attachTextDrag(el,text);
    }
    const grid=stageEl.querySelector('.grid');if(grid)grid.style.opacity=gridVisible?'0.5':'0';
    updateGridLabels();
  }

  function renderSelPanel(){
    const sidebar=doc.getElementById('selSidebar'),page=state.pages[state.current],chars=page?page.chars:[];
    if(!chars.length){sidebar.classList.remove('show');return;}
    sidebar.classList.add('show');
    const list=doc.getElementById('sidebarCharList');list.innerHTML='';
    chars.forEach(character=>{
      const thumb=doc.createElement('div');thumb.className='sidebar-char-thumb'+(state.selected===character.id?' sel':'');
      const img=doc.createElement('img');img.src=character.asset.dataURL||'';img.alt=character.name||'';img.style.transform=character.flip?'scaleX(-1)':'none';
      thumb.appendChild(img);
      const select=()=>{state.selected=character.id;state.selectedText=null;renderStage();renderSelPanel();renderTextPanel();};
      thumb.onclick=select;thumb.tabIndex=0;thumb.setAttribute('role','button');thumb.setAttribute('aria-label',(character.name||'Karakter')+' seç');
      thumb.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}};
      list.appendChild(thumb);
    });

    const selected=getSel(),empty=doc.getElementById('sidebarDetailEmpty');
    const controls=['sidebarCharName','flipBtn','delBtn','sidebarSizeLbl','sidebarSizeRow','sizeRange'];
    if(selected){
      empty.style.display='none';controls.forEach(id=>doc.getElementById(id).style.display='');
      doc.getElementById('sidebarCharName').textContent=selected.name||'Karakter';
      const value=Math.round(selected.sizePct);doc.getElementById('sizePctVal').textContent=value+'%';doc.getElementById('sizeRange').value=value;
    }else{
      empty.style.display='';controls.forEach(id=>doc.getElementById(id).style.display='none');
    }
  }

  function attachDrag(el,character){
    el.addEventListener('pointerdown',event=>{
      event.preventDefault();state.selected=character.id;state.selectedText=null;
      stageEl.querySelectorAll('.sprite').forEach(sprite=>sprite.classList.toggle('sel',sprite.dataset.id===character.id));
      stageEl.querySelectorAll('.stage-text').forEach(text=>text.classList.remove('sel'));
      renderSelPanel();renderTextPanel();
      const rect=stageEl.getBoundingClientRect();checkpoint();
      el.setPointerCapture(event.pointerId);el.style.cursor='grabbing';
      const move=moveEvent=>{
        character.fx=Math.max(0,Math.min(1,(moveEvent.clientX-rect.left)/rect.width));
        character.fy=Math.max(0,Math.min(1,(moveEvent.clientY-rect.top)/rect.height));
        const dispW=character.sizePct/100*rect.width,dispH=dispW*character.aspect;
        el.style.left=(character.fx*rect.width-dispW/2)+'px';el.style.top=(character.fy*rect.height-dispH/2)+'px';
        updateGridLabels();
      };
      const up=()=>{
        el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);
        el.style.cursor='grab';scheduleRenderPages(0);scheduleAutosave();
      };
      el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);
    });
  }

  function renderTextPanel(){
    const page=state.pages[state.current],texts=page.texts=page.texts||[];
    if(state.selectedText&&!texts.find(text=>text.id===state.selectedText))state.selectedText=null;
    const list=doc.getElementById('textItemList');list.innerHTML='';
    if(!texts.length){
      const empty=doc.createElement('div');empty.className='text-empty-msg';empty.textContent='Henüz yazı yok. + ile ekle.';list.appendChild(empty);
    }else{
      texts.forEach(text=>{
        const item=doc.createElement('div');item.className='text-item'+(text.id===state.selectedText?' sel':'');
        const preview=doc.createElement('span');preview.className='text-item-preview';preview.style.color=text.color;preview.textContent=text.str||'(boş)';
        item.appendChild(preview);
        const select=()=>{
          state.selectedText=text.id;state.selected=null;
          stageEl.querySelectorAll('.sprite').forEach(sprite=>sprite.classList.remove('sel'));
          stageEl.querySelectorAll('.stage-text').forEach(node=>node.classList.toggle('sel',node.dataset.textId===text.id));
          renderTextPanel();renderSelPanel();
        };
        item.onclick=select;item.tabIndex=0;item.setAttribute('role','button');item.setAttribute('aria-label',(text.str||'Boş yazı')+' seç');
        item.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}};
        list.appendChild(item);
      });
    }

    const editPanel=doc.getElementById('textEditPanel'),selected=getSelText();
    if(!selected){editPanel.style.display='none';return;}
    editPanel.style.display='flex';
    const input=doc.getElementById('textStrInput');if(input!==doc.activeElement)input.value=selected.str;
    doc.getElementById('textSizeVal').textContent=selected.fontsize;
    const colorRow=doc.getElementById('textColorRow');colorRow.innerHTML='';
    const selectedHex=colorToHex(selected.color);
    TEXT_COLORS.forEach(color=>{
      const swatch=doc.createElement('div');swatch.className='text-color-swatch'+(selectedHex===color?' active':'');
      swatch.style.background=color;swatch.title=color;swatch.tabIndex=0;swatch.setAttribute('role','button');swatch.setAttribute('aria-label','Yazı rengini '+color+' yap');
      const setColor=()=>{checkpoint();selected.color=color;renderTextPanel();renderStage();scheduleRenderPages();scheduleAutosave();};
      swatch.onclick=setColor;swatch.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setColor();}};
      colorRow.appendChild(swatch);
    });
    const custom=doc.createElement('input');custom.type='color';custom.className='text-custom-color';custom.title='Özel renk';custom.value=selectedHex;
    custom.onpointerdown=()=>checkpoint();
    custom.oninput=event=>{selected.color=event.target.value;renderTextPanel();renderStage();scheduleRenderPages();scheduleAutosave();};
    colorRow.appendChild(custom);
  }

  function attachTextDrag(el,text){
    el.addEventListener('pointerdown',event=>{
      event.preventDefault();state.selectedText=text.id;state.selected=null;
      stageEl.querySelectorAll('.stage-text').forEach(node=>node.classList.toggle('sel',node.dataset.textId===text.id));
      stageEl.querySelectorAll('.sprite').forEach(sprite=>sprite.classList.remove('sel'));
      renderTextPanel();renderSelPanel();
      const rect=stageEl.getBoundingClientRect();checkpoint();
      el.setPointerCapture(event.pointerId);el.style.cursor='grabbing';
      const move=moveEvent=>{
        text.fx=Math.max(0,Math.min(1,(moveEvent.clientX-rect.left)/rect.width));
        text.fy=Math.max(0,Math.min(1,(moveEvent.clientY-rect.top)/rect.height));
        el.style.left=(text.fx*rect.width)+'px';el.style.top=(text.fy*rect.height)+'px';
      };
      const up=()=>{
        el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);
        el.style.cursor='grab';scheduleRenderPages(0);scheduleAutosave();
      };
      el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);
    });
  }

  function changeSizePct(value){
    const selected=getSel();if(!selected)return;
    selected.sizePct=Math.max(4,Math.min(100,value));renderStage();renderSelPanel();scheduleRenderPages();scheduleAutosave();
  }

  function openBgPick(pageIndex){
    bgPickTarget=pageIndex;
    doc.getElementById('bgPickTitle').textContent='Arkaplan Seç — Sayfa '+(pageIndex+1);
    const grid=doc.getElementById('bgPickGrid');grid.innerHTML='';
    const empty=doc.getElementById('bgPickEmpty'),page=state.pages[pageIndex];
    doc.getElementById('bgPickColor').value=page.bg.mode==='color'?page.bg.color:'#eaf4ff';
    if(!state.bgLib.length){empty.style.display='block';grid.style.display='none';}
    else{
      empty.style.display='none';grid.style.display='';
      state.bgLib.forEach(item=>{
        const card=doc.createElement('div');card.className='pick-item bgitem';
        if(page.bg.bgId===item.id)card.style.borderColor='var(--blue)';
        const img=doc.createElement('img');img.src=item.asset.dataURL;img.alt=item.name||'';
        const name=doc.createElement('div');name.className='nm';name.textContent=item.name;card.append(img,name);
        const choose=()=>{checkpoint();applyBgToPage(pageIndex,item);closeBgPick();scheduleAutosave();};
        card.onclick=choose;card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',item.name+' arkaplanını seç');
        card.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}};
        grid.appendChild(card);
      });
    }
    const overlay=doc.getElementById('bgPickOverlay');showDialog(overlay,doc.getElementById('bgPickClose'),closeBgPick);
  }

  function closeBgPick(){
    const target=bgPickTarget;hideDialog(doc.getElementById('bgPickOverlay'));bgPickTarget=null;
    if(target!==null)win.requestAnimationFrame(()=>doc.querySelector('[data-page-bg="'+target+'"]')?.focus());
  }

  function applyBgToPage(pageIndex,item){
    state.pages[pageIndex].bg={mode:'image',asset:item.asset,color:'#fff',bgId:item.id};
    if(pageIndex===state.current)renderStage();
    renderPages();renderBgTab();
  }

  function openCharPick(pageIndex){
    charPickTarget=pageIndex;
    doc.getElementById('charPickTitle').textContent='Karakter Ekle — Sayfa '+(pageIndex+1);
    const grid=doc.getElementById('charPickGrid');grid.innerHTML='';
    const empty=doc.getElementById('charPickEmpty');
    if(!state.charLib.length){empty.style.display='block';grid.style.display='none';}
    else{
      empty.style.display='none';grid.style.display='';
      state.charLib.forEach(item=>{
        const card=doc.createElement('div');card.className='pick-item';
        const img=doc.createElement('img');img.src=item.asset.dataURL;img.alt=item.name||'';
        const name=doc.createElement('div');name.className='nm';name.textContent=item.name;card.append(img,name);
        const choose=()=>{checkpoint();addCharToPage(pageIndex,item);closeCharPick();scheduleAutosave();};
        card.onclick=choose;card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',item.name+' karakterini ekle');
        card.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}};
        grid.appendChild(card);
      });
    }
    const overlay=doc.getElementById('charPickOverlay');showDialog(overlay,doc.getElementById('charPickClose'),closeCharPick);
  }

  function closeCharPick(){
    const target=charPickTarget;hideDialog(doc.getElementById('charPickOverlay'));charPickTarget=null;
    if(target!==null)win.requestAnimationFrame(()=>doc.querySelector('[data-page-char="'+target+'"]')?.focus());
  }

  function addCharToPage(pageIndex,item){
    const asset=item.asset,aspect=asset.h/asset.w;
    state.pages[pageIndex].chars.push({
      id:nextId(),libId:item.id,name:item.name,asset,fx:.5,fy:.5,sizePct:27,flip:false,aspect
    });
    if(pageIndex===state.current){
      state.selected=state.pages[pageIndex].chars.at(-1).id;renderStage();renderSelPanel();
    }
    renderPages();showToast(item.name+' Sayfa '+(pageIndex+1)+'\'e eklendi');
  }

  function renderWorkspace(opts={}){
    if(opts.pages!==false)renderPages();
    renderStage();renderSelPanel();renderTextPanel();updateHistoryButtons();
  }

  function bind(){
    if(bound)return;bound=true;initGridLabels();

    doc.getElementById('gridToggleBtn').addEventListener('click',()=>{
      gridVisible=!gridVisible;doc.getElementById('gridToggleBtn').classList.toggle('active',gridVisible);
      const grid=stageEl.querySelector('.grid');if(grid)grid.style.opacity=gridVisible?'0.5':'0';updateGridLabels();
    });

    doc.getElementById('textAddBtn').onclick=()=>{
      checkpoint();const page=state.pages[state.current];page.texts=page.texts||[];
      const text={id:nextId(),str:'Yazı',color:TEXT_COLORS[5],fontsize:16,fx:.5,fy:.5};
      page.texts.push(text);state.selectedText=text.id;state.selected=null;
      renderTextPanel();renderStage();renderSelPanel();renderPages();scheduleAutosave();
    };
    doc.getElementById('textStrInput').addEventListener('focus',()=>checkpoint());
    doc.getElementById('textStrInput').addEventListener('input',event=>{
      const text=getSelText();if(!text)return;text.str=event.target.value;
      const stageText=stageEl.querySelector(`.stage-text[data-text-id="${text.id}"]`);if(stageText)stageText.textContent=text.str;
      const listText=doc.querySelector('#textItemList .text-item.sel .text-item-preview');
      if(listText){listText.textContent=text.str||'(boş)';listText.style.color=text.color;}
      scheduleRenderPages();scheduleAutosave();
    });
    doc.getElementById('textSizeDown').onclick=()=>{
      const text=getSelText();if(!text)return;checkpoint();text.fontsize=Math.max(8,text.fontsize-2);
      doc.getElementById('textSizeVal').textContent=text.fontsize;renderStage();scheduleRenderPages();scheduleAutosave();
    };
    doc.getElementById('textSizeUp').onclick=()=>{
      const text=getSelText();if(!text)return;checkpoint();text.fontsize=Math.min(96,text.fontsize+2);
      doc.getElementById('textSizeVal').textContent=text.fontsize;renderStage();scheduleRenderPages();scheduleAutosave();
    };
    doc.getElementById('textDelBtn').onclick=async()=>{
      const text=getSelText();if(!text)return;
      const confirmed=await confirmModal({
        title:'Yazıyı sil',bodyHtml:`<b>"${escapeHtml(text.str||'')}"</b> silinsin mi?`,okText:'Evet, sil',cancelText:'Vazgeç'
      });
      if(!confirmed)return;
      checkpoint();const page=state.pages[state.current];page.texts=page.texts.filter(item=>item!==text);
      state.selectedText=null;renderTextPanel();renderStage();renderPages();scheduleAutosave();
    };

    doc.getElementById('sizeDown').onclick=()=>{const selected=getSel();if(selected){checkpoint();changeSizePct(selected.sizePct-5);}};
    doc.getElementById('sizeUp').onclick=()=>{const selected=getSel();if(selected){checkpoint();changeSizePct(selected.sizePct+5);}};
    doc.getElementById('sizeRange').addEventListener('pointerdown',()=>{if(getSel())checkpoint();});
    doc.getElementById('sizeRange').addEventListener('input',event=>changeSizePct(+event.target.value));
    doc.getElementById('flipBtn').onclick=()=>{
      const selected=getSel();if(!selected)return showToast('Önce bir karakter seç');
      checkpoint();selected.flip=!selected.flip;renderStage();renderSelPanel();renderPages();scheduleAutosave();
    };
    doc.getElementById('delBtn').onclick=async()=>{
      const selected=getSel();if(!selected)return showToast('Önce bir karakter seç');
      const confirmed=await confirmModal({
        title:'Karakteri sil',bodyHtml:`<b>${escapeHtml(selected.name||'Karakter')}</b> bu sayfadan kaldırılsın mı?`,
        okText:'Evet, sil',cancelText:'Vazgeç'
      });
      if(!confirmed)return;
      checkpoint();const page=state.pages[state.current];page.chars=page.chars.filter(item=>item!==selected);
      state.selected=null;renderStage();renderSelPanel();renderPages();scheduleAutosave();
    };

    doc.getElementById('bgPickClose').onclick=closeBgPick;
    doc.getElementById('bgPickOverlay').addEventListener('click',event=>{if(event.target===doc.getElementById('bgPickOverlay'))closeBgPick();});
    doc.getElementById('bgPickColor').addEventListener('pointerdown',()=>{if(bgPickTarget!==null)checkpoint();});
    doc.getElementById('bgPickColor').addEventListener('input',event=>{
      if(bgPickTarget===null)return;
      state.pages[bgPickTarget].bg={mode:'color',color:event.target.value,asset:null,bgId:null};
      if(bgPickTarget===state.current)renderStage();
      scheduleRenderPages();renderBgTab();scheduleAutosave();
    });

    doc.getElementById('charPickClose').onclick=closeCharPick;
    doc.getElementById('charPickOverlay').addEventListener('click',event=>{if(event.target===doc.getElementById('charPickOverlay'))closeCharPick();});

    win.addEventListener('resize',()=>{
      if(doc.querySelector('.panel[data-tab=stage]')?.classList.contains('active')){renderStage();scheduleRenderPages(60);}
    });
    stageEl.addEventListener('pointerdown',event=>{
      if(event.target===stageEl||event.target.classList.contains('grid')||event.target.classList.contains('bgimg')){
        state.selected=null;state.selectedText=null;renderStage();renderSelPanel();renderTextPanel();
      }
    });
  }

  return {
    bind,renderPages,renderStage,renderSelPanel,renderTextPanel,renderWorkspace,scheduleRenderPages,
    getSel,getSelText,openBgPick,openCharPick,applyBgToPage,addCharToPage,updateGridLabels
  };
}
