import {ensureAudioContext,closeAudioContext,audioBufferToWav} from './audio-utils.mjs';

export function createAudioRecorder(options={}){
  const doc=options.document||globalThis.document;
  const win=options.window||doc?.defaultView||globalThis.window;
  const showDialog=options.showDialog||(()=>{});
  const hideDialog=options.hideDialog||(()=>{});
  const showToast=options.showToast||(()=>{});
  const checkpoint=options.checkpoint||(()=>{});
  const nextId=options.nextId||(()=>String(Date.now()));
  const getSounds=options.getSounds||(()=>[]);
  const addSound=options.addSound||(()=>{});
  const onSoundsChanged=options.onSoundsChanged||(()=>{});
  const scheduleAutosave=options.scheduleAutosave||(()=>{});

  let mediaRecorder=null,stream=null,chunks=[],actx=null,analyser=null,mediaSource=null;
  let animId=null,playAnimId=null;
  let isRecording=false,startTime=0,waveData=[],lastSampleAt=0,discardOnStop=false;
  let recBlob=null,blobUrl=null,startRequestId=0;
  let trimStart=0,trimEnd=1;
  let dragHandle=null,dragStartX=0,dragStartPct=0;
  const SAMPLE_MS=50,MAX_MS=60000;

  const overlay=doc.getElementById('srecOverlay');
  const cvs=doc.getElementById('srecCanvas');
  const vizEl=doc.getElementById('srecViz');
  const timer=doc.getElementById('srecTimer');
  const recBtn=doc.getElementById('srecRecBtn');
  const playBtn=doc.getElementById('srecPlayBtn');
  const stopBtn=doc.getElementById('srecStopBtn');
  const addBtn=doc.getElementById('srecAddBtn');
  const audio=doc.getElementById('srecAudio');
  const tl=doc.getElementById('srecTL');
  const tr=doc.getElementById('srecTR');
  const ol=doc.getElementById('srecOL');
  const or_=doc.getElementById('srecOR');

  function nextName(){
    const sounds=getSounds();
    const used=sounds.map(s=>s.name);
    for(let i=0;i<26;i++){
      const name='Ses '+'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i];
      if(!used.includes(name)) return name;
    }
    return 'Ses '+(sounds.length+1);
  }
  function fmtTime(ms){
    const s=Math.floor(ms/1000)%60,m=Math.floor(ms/60000),cs=Math.floor((ms%1000)/10);
    return '00:'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(cs).padStart(2,'0');
  }
  function resizeCvs(){cvs.width=vizEl.clientWidth||440;cvs.height=vizEl.clientHeight||120;}
  function setPlayStop(playEnabled,stopEnabled){
    playBtn.disabled=!playEnabled;playBtn.style.opacity=playEnabled?'1':'.45';
    stopBtn.disabled=!stopEnabled;stopBtn.style.opacity=stopEnabled?'1':'.45';
  }
  function drawLive(){
    const ctx=cvs.getContext('2d'),W=cvs.width,H=cvs.height,cy=H/2,maxH=cy*.88;
    ctx.fillStyle='#ddf0f9';ctx.fillRect(0,0,W,H);
    ctx.beginPath();ctx.strokeStyle='#c4e9f6';ctx.lineWidth=1;ctx.moveTo(0,cy);ctx.lineTo(W,cy);ctx.stroke();
    if(!waveData.length)return;
    const pxPerSlot=W/(MAX_MS/SAMPLE_MS),barW=Math.max(1.5,pxPerSlot*.75);
    ctx.beginPath();ctx.strokeStyle='#1a7dc7';ctx.lineWidth=barW;ctx.lineCap='round';
    for(let i=0;i<waveData.length;i++){
      const x=i*pxPerSlot+pxPerSlot/2,h=waveData[i]*maxH;
      ctx.moveTo(x,cy-h);ctx.lineTo(x,cy+h);
    }
    ctx.stroke();
    const headX=waveData.length*pxPerSlot;
    ctx.beginPath();ctx.strokeStyle='rgba(255,70,70,.7)';ctx.lineWidth=2;ctx.moveTo(headX,0);ctx.lineTo(headX,H);ctx.stroke();
  }
  function drawStatic(progress){
    const ctx=cvs.getContext('2d'),W=cvs.width,H=cvs.height,cy=H/2,maxH=cy*.88;
    ctx.fillStyle='#ddf0f9';ctx.fillRect(0,0,W,H);
    ctx.beginPath();ctx.strokeStyle='#c4e9f6';ctx.lineWidth=1;ctx.moveTo(0,cy);ctx.lineTo(W,cy);ctx.stroke();
    if(waveData.length){
      const n=waveData.length,pxPerSlot=W/n,barW=Math.max(1.5,pxPerSlot*.75);
      ctx.beginPath();ctx.strokeStyle='#1a7dc7';ctx.lineWidth=barW;ctx.lineCap='round';
      for(let i=0;i<n;i++){
        const x=i*pxPerSlot+pxPerSlot/2,h=waveData[i]*maxH;
        ctx.moveTo(x,cy-h);ctx.lineTo(x,cy+h);
      }
      ctx.stroke();
    }
    if(progress!=null&&progress>=0){
      const x=(trimStart+(trimEnd-trimStart)*progress)*W;
      ctx.beginPath();ctx.strokeStyle='#FF4444';ctx.lineWidth=2;ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();
    }
  }
  function drawIdle(){
    const ctx=cvs.getContext('2d'),cy=cvs.height/2;
    ctx.fillStyle='#ddf0f9';ctx.fillRect(0,0,cvs.width,cvs.height);
    ctx.beginPath();ctx.strokeStyle='#a0d8ef';ctx.lineWidth=1;ctx.moveTo(0,cy);ctx.lineTo(cvs.width,cy);ctx.stroke();
  }

  function showTrim(){trimStart=0;trimEnd=1;[tl,tr,ol,or_].forEach(el=>el.style.display='block');updateTrim();}
  function hideTrim(){[tl,tr,ol,or_].forEach(el=>el.style.display='none');}
  function updateTrim(){
    const W=vizEl.clientWidth||cvs.width,lx=trimStart*W,rx=trimEnd*W;
    tl.style.left=lx+'px';tr.style.left=(rx-14)+'px';ol.style.width=lx+'px';
    or_.style.left=rx+'px';or_.style.width=(W-rx)+'px';
  }
  function startDrag(handle,event){
    dragHandle=handle;dragStartX=event.clientX;dragStartPct=handle==='L'?trimStart:trimEnd;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    doc.addEventListener('pointermove',onDrag);doc.addEventListener('pointerup',endDrag);doc.addEventListener('pointercancel',endDrag);
    event.preventDefault();
  }
  function onDrag(event){
    const W=vizEl.clientWidth||cvs.width,p=Math.max(0,Math.min(1,dragStartPct+(event.clientX-dragStartX)/W));
    if(dragHandle==='L')trimStart=Math.min(p,trimEnd-.02);else trimEnd=Math.max(p,trimStart+.02);
    updateTrim();
  }
  function endDrag(){
    dragHandle=null;doc.removeEventListener('pointermove',onDrag);doc.removeEventListener('pointerup',endDrag);doc.removeEventListener('pointercancel',endDrag);
  }

  function open(){
    startRequestId++;
    if(blobUrl){win.URL.revokeObjectURL(blobUrl);blobUrl=null;}
    chunks=[];waveData=[];isRecording=false;recBlob=null;lastSampleAt=0;discardOnStop=false;
    recBtn.disabled=false;trimStart=0;trimEnd=1;audio.src='';recBtn.classList.remove('recording');
    setPlayStop(false,false);addBtn.style.display='none';addBtn.disabled=false;addBtn.textContent='✅ Projeye Ekle';
    hideTrim();timer.textContent='00:00:00.00';doc.getElementById('srecTitle').textContent=nextName();
    showDialog(overlay,recBtn,close);win.requestAnimationFrame(()=>{resizeCvs();drawIdle();});
  }

  function cleanupMedia(){
    win.cancelAnimationFrame(animId);win.cancelAnimationFrame(playAnimId);
    if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;}
    if(mediaSource){try{mediaSource.disconnect();}catch{}mediaSource=null;}
    if(analyser){try{analyser.disconnect();}catch{}analyser=null;}
    if(actx){closeAudioContext(actx);actx=null;}
    if(blobUrl){win.URL.revokeObjectURL(blobUrl);blobUrl=null;}
  }

  function close(){
    startRequestId++;hideDialog(overlay);recBtn.disabled=false;
    if(isRecording)stopRec(false);
    stopPlayback();cleanupMedia();
    audio.removeAttribute('src');audio.load();hideTrim();addBtn.style.display='none';
  }

  async function startRec(){
    if(isRecording||recBtn.disabled)return;
    const requestId=++startRequestId;recBtn.disabled=true;let requestedStream=null;
    try{
      requestedStream=await win.navigator.mediaDevices.getUserMedia({audio:true});
      if(requestId!==startRequestId||!overlay.classList.contains('show')){
        requestedStream.getTracks().forEach(track=>track.stop());requestedStream=null;return;
      }
      stream=requestedStream;requestedStream=null;actx=ensureAudioContext(actx,win);
      if(actx.state==='suspended')await actx.resume();
      if(requestId!==startRequestId||!overlay.classList.contains('show')){
        if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;}return;
      }
      analyser=actx.createAnalyser();analyser.fftSize=1024;
      mediaSource=actx.createMediaStreamSource(stream);mediaSource.connect(analyser);
      chunks=[];waveData=[];lastSampleAt=0;discardOnStop=false;
      const Recorder=win.MediaRecorder,mime=Recorder.isTypeSupported('audio/webm')?'audio/webm':'audio/ogg';
      mediaRecorder=new Recorder(stream,{mimeType:mime});
      mediaRecorder.ondataavailable=event=>{if(event.data.size>0)chunks.push(event.data);};
      mediaRecorder.onstop=onRecStop;mediaRecorder.start(100);
      isRecording=true;startTime=Date.now();recBtn.classList.add('recording');
      const buf=new Uint8Array(analyser.frequencyBinCount);
      function loop(){
        if(!isRecording)return;
        const now=Date.now()-startTime;analyser.getByteTimeDomainData(buf);
        if(now-lastSampleAt>=SAMPLE_MS){
          let peak=0;for(let i=0;i<buf.length;i++)peak=Math.max(peak,Math.abs(buf[i]-128)/128);
          waveData.push(peak);lastSampleAt=now;
        }
        timer.textContent=fmtTime(now);drawLive();animId=win.requestAnimationFrame(loop);
      }
      loop();win.setTimeout(()=>{if(isRecording&&requestId===startRequestId)stopRec(true);},MAX_MS);
    }catch{
      if(requestId===startRequestId)showToast('Mikrofon erişimi reddedildi veya kullanılamıyor');
    }finally{
      if(requestedStream)requestedStream.getTracks().forEach(track=>track.stop());
      if(requestId===startRequestId)recBtn.disabled=false;
    }
  }

  function stopRec(keep){
    if(!mediaRecorder||mediaRecorder.state==='inactive')return;
    isRecording=false;discardOnStop=!keep;recBtn.classList.remove('recording');
    win.cancelAnimationFrame(animId);mediaRecorder.stop();
    if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;}
    if(!keep){waveData=[];drawIdle();}
  }

  async function onRecStop(){
    if(discardOnStop){chunks=[];recBlob=null;discardOnStop=false;return;}
    if(!chunks.length)return;
    const mime=chunks[0].type||'audio/webm';recBlob=new win.Blob(chunks,{type:mime});
    if(blobUrl)win.URL.revokeObjectURL(blobUrl);
    blobUrl=win.URL.createObjectURL(recBlob);audio.src=blobUrl;
    setPlayStop(true,false);drawStatic(null);showTrim();addBtn.style.display='block';
  }

  function stopPlayback(){
    audio.pause();audio.currentTime=0;win.cancelAnimationFrame(playAnimId);setPlayStop(!!blobUrl,false);drawStatic(null);
  }

  function playRecording(){
    if(!blobUrl)return;
    audio.currentTime=(audio.duration||0)*trimStart;audio.play().catch(()=>{});setPlayStop(false,true);
    function loop(){
      if(audio.paused||audio.ended){stopPlayback();return;}
      if(audio.duration&&audio.currentTime>=audio.duration*trimEnd){stopPlayback();return;}
      const progress=audio.duration?(audio.currentTime/audio.duration-trimStart)/(trimEnd-trimStart):0;
      drawStatic(Math.max(0,Math.min(1,progress)));playAnimId=win.requestAnimationFrame(loop);
    }
    loop();
  }

  async function addToProject(){
    if(!recBlob)return;
    addBtn.disabled=true;addBtn.textContent='Ekleniyor…';let decodeCtx=null;
    try{
      const raw=await recBlob.arrayBuffer();decodeCtx=ensureAudioContext(null,win);
      const decoded=await decodeCtx.decodeAudioData(raw);
      const start=Math.floor(trimStart*decoded.length),end=Math.floor(trimEnd*decoded.length),length=Math.max(1,end-start);
      const Offline=win.OfflineAudioContext,offline=new Offline(decoded.numberOfChannels,length,decoded.sampleRate);
      const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);
      source.start(0,trimStart*decoded.duration,(trimEnd-trimStart)*decoded.duration);
      const trimmed=await offline.startRendering();
      checkpoint();
      addSound({id:nextId(),name:doc.getElementById('srecTitle').textContent,buf:audioBufferToWav(trimmed),ext:'wav'});
      onSoundsChanged();scheduleAutosave();showToast('Ses projeye eklendi');close();
    }catch(error){
      showToast('Hata: '+error.message);addBtn.disabled=false;addBtn.textContent='✅ Projeye Ekle';
    }finally{
      if(decodeCtx)await closeAudioContext(decodeCtx);
    }
  }

  tl.onpointerdown=event=>startDrag('L',event);tr.onpointerdown=event=>startDrag('R',event);
  doc.getElementById('sndRecord').onclick=open;
  doc.getElementById('srecClose').onclick=close;
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  recBtn.onclick=()=>{if(isRecording)stopRec(true);else startRec();};
  playBtn.onclick=playRecording;stopBtn.onclick=stopPlayback;addBtn.onclick=addToProject;

  return {
    open,close,
    dispose(){
      startRequestId++;
      if(isRecording)stopRec(false);
      stopPlayback();cleanupMedia();endDrag();
    }
  };
}
