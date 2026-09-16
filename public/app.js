const $=s=>document.querySelector(s);
const linksEl=$('#links'),start=$('#startBtn'),card=$('#statusCard');
let jobId=localStorage.getItem('ytvc_job')||null,pollTimer=null;

function parseLinks(){
  const seen=new Set(),out=[];
  for(const raw of linksEl.value.split(/\r?\n/)){
    const s=raw.trim();
    if(!s||seen.has(s)) continue;
    if(/^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(s)){seen.add(s);out.push(s);}
  }
  return out.slice(0,500);
}
function countLinks(){ $('#linkCount').textContent=`${parseLinks().length} LINK`; }
function cleanDuplicates(){ linksEl.value=parseLinks().join('\n'); countLinks(); }

async function api(url,opt){
  const r=await fetch(url,opt),d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||`HTTP ${r.status}`);
  return d;
}
async function health(){
  try{
    const d=await api('/api/health');
    const e=$('#health'); e.classList.toggle('ok',d.ok);
    e.innerHTML=`<span></span>${d.ok?'Tayyor':'Komponent xatosi'} · yt-dlp ${d.ytdlp?'✓':'×'} · FFmpeg ${d.ffmpeg?'✓':'×'}`;
  }catch{ $('#health').innerHTML='<span></span>Server bilan aloqa yo‘q'; }
}
function payload(){
  return {
    links:parseLinks(),
    segmentMode:$('#segmentMode').value,
    maxHeight:Number($('#maxHeight').value),
    preset:$('#preset').value,
    crf:Number($('#crf').value||23),
    clipCount:Number($('#clipCount').value||0),
    totalMB:Number($('#totalMB').value||0),
    stopMode:$('#stopMode').value
  };
}
async function run(){
  const links=parseLinks();
  if(!links.length) return alert('Kamida 1 ta to‘g‘ri YouTube link kiriting.');
  start.disabled=true; start.textContent='Navbatga qo‘shilmoqda…'; card.classList.remove('hidden');
  try{
    const d=await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});
    jobId=d.job.id; localStorage.setItem('ytvc_job',jobId); render(d.job); beginPoll();
  }catch(e){ alert(e.message); }
  finally{ start.disabled=false; start.textContent='▶ Yuklash va kesishni boshlash'; }
}
function title(s){return{queued:'Navbatda',running:'Ishlanmoqda',done:'Tayyor',failed:'Xato',cancelled:'To‘xtatildi'}[s]||s;}
function render(j){
  card.classList.remove('hidden');
  $('#statusTitle').textContent=`${title(j.status)}${j.status==='queued'&&j.queuePosition?` · #${j.queuePosition}`:''}`;
  $('#statusMessage').textContent=j.message||'';
  $('#clipsStat').textContent=Number(j.clips||0).toLocaleString();
  $('#sizeStat').textContent=`${Number(j.totalMB||0).toLocaleString(undefined,{maximumFractionDigits:2})} MB`;
  $('#videosStat').textContent=`${j.completedVideos+j.failedVideos} / ${j.totalLinks}`;
  $('#errorsStat').textContent=j.failedVideos||0;
  let p=(j.completedVideos+j.failedVideos)/Math.max(1,j.totalLinks)*100;
  if(j.status==='done') p=100;
  $('#progressBar').style.width=`${Math.min(100,p)}%`;
  $('#lastClip').textContent=j.lastClip?`Oxirgi: ${j.lastClip.name} · ${j.lastClip.seconds}s · ${j.lastClip.mb} MB`:'Hali klip yo‘q.';
  $('#cancelBtn').classList.toggle('hidden',!['queued','running'].includes(j.status));
  const dl=$('#downloadBtn');
  if(j.zipReady){dl.classList.remove('hidden');dl.href=`/api/jobs/${j.id}/download`;} else dl.classList.add('hidden');
  if(j.errors?.length){
    $('#errorBox').classList.remove('hidden');
    $('#errorsText').textContent=j.errors.map((e,i)=>`${i+1}. ${e.url||''}\n${e.message}`).join('\n\n');
  }else $('#errorBox').classList.add('hidden');
  if(['done','failed','cancelled'].includes(j.status)&&pollTimer){clearInterval(pollTimer);pollTimer=null;}
}
async function poll(){
  if(!jobId)return;
  try{ const d=await api(`/api/jobs/${jobId}`); render(d.job); }
  catch{ if(pollTimer)clearInterval(pollTimer);pollTimer=null;localStorage.removeItem('ytvc_job'); }
}
function beginPoll(){ if(pollTimer)clearInterval(pollTimer); poll(); pollTimer=setInterval(poll,1000); }

linksEl.addEventListener('input',countLinks);
linksEl.addEventListener('keydown',e=>{ if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();run();} });
$('#cleanBtn').onclick=()=>{linksEl.value='';countLinks();};
$('#demoBtn').onclick=cleanDuplicates;
start.onclick=run;
$('#cancelBtn').onclick=async()=>{
  if(!jobId||!confirm('Jarayonni to‘xtataymi?'))return;
  try{const d=await api(`/api/jobs/${jobId}/cancel`,{method:'POST'});render(d.job);}catch(e){alert(e.message);}
};
health(); setInterval(health,15000); countLinks();
if(jobId){card.classList.remove('hidden');beginPoll();}
