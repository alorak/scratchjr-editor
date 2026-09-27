export function createDialogManager(doc=document,raf=requestAnimationFrame){
  const dialogState=new WeakMap(),dialogStack=[];

  function focusables(overlay){
    return [...overlay.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(el=>!el.hidden&&el.offsetParent!==null);
  }

  function showDialog(overlay,initialFocus,onEscape){
    if(!overlay) return;
    const HTMLElementCtor=doc.defaultView?.HTMLElement||globalThis.HTMLElement;
    const opener=HTMLElementCtor&&doc.activeElement instanceof HTMLElementCtor?doc.activeElement:null;
    dialogState.set(overlay,{opener,onEscape});
    const oldIndex=dialogStack.indexOf(overlay);
    if(oldIndex>=0) dialogStack.splice(oldIndex,1);
    dialogStack.push(overlay);
    overlay.classList.add('show');
    raf(()=>{
      const target=initialFocus||focusables(overlay)[0]||overlay;
      if(target===overlay&&!overlay.hasAttribute('tabindex')) overlay.setAttribute('tabindex','-1');
      target.focus?.();
    });
  }

  function hideDialog(overlay,restoreFocus=true){
    if(!overlay) return;
    overlay.classList.remove('show');
    const i=dialogStack.lastIndexOf(overlay);
    if(i>=0) dialogStack.splice(i,1);
    const stateForDialog=dialogState.get(overlay);
    dialogState.delete(overlay);
    if(restoreFocus&&stateForDialog?.opener?.isConnected) raf(()=>stateForDialog.opener.focus());
  }

  function onKey(e){
    const overlay=dialogStack[dialogStack.length-1];
    if(!overlay||!overlay.classList.contains('show')) return;
    if(e.key==='Escape'){
      e.preventDefault(); e.stopPropagation();
      const close=dialogState.get(overlay)?.onEscape;
      if(close) close(); else hideDialog(overlay);
      return;
    }
    if(e.key!=='Tab') return;
    const items=focusables(overlay);
    if(!items.length){e.preventDefault();overlay.focus();return;}
    const first=items[0],last=items[items.length-1];
    if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}
  }

  doc.addEventListener('keydown',onKey,true);
  return {
    showDialog,hideDialog,
    dispose(){doc.removeEventListener('keydown',onKey,true);dialogStack.length=0;}
  };
}

export function startOperation(title,doc=document){
  const box=doc.getElementById('operationProgress');
  const titleEl=doc.getElementById('operationProgressTitle');
  const pctEl=doc.getElementById('operationProgressPct');
  const bar=doc.getElementById('operationProgressBar');
  const label=doc.getElementById('operationProgressLabel');
  if(!box||!titleEl||!pctEl||!bar||!label){
    return {update(){},close(){}};
  }
  box.hidden=false; titleEl.textContent=title;
  const update=(percent,text)=>{
    const p=Math.max(0,Math.min(100,Math.round(Number(percent)||0)));
    const nextText=text||'İşleniyor…';
    pctEl.textContent=p+'%'; bar.style.width=p+'%';
    if(label.textContent!==nextText) label.textContent=nextText;
  };
  update(0,'Hazırlanıyor…');
  return {
    update,
    close(){box.hidden=true;bar.style.width='0%';pctEl.textContent='0%';}
  };
}
