const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const PORT = Number(process.env.PORT || 3000);
const MAX_LINKS = Math.max(1, Number(process.env.MAX_LINKS || 500));
const MAX_CLIPS = Math.max(1, Number(process.env.MAX_CLIPS || 10000));
const JOB_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.JOB_TTL_MS || 4 * 60 * 60 * 1000));
const ROOT = path.join(os.tmpdir(), 'ytvidcutter');
const TOOLS = path.join(__dirname, 'tools');
const YTDLP = path.join(TOOLS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_URL = process.platform === 'win32'
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const jobs = new Map();
const queue = [];
let activeJobId = null;
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(TOOLS, { recursive: true });

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false });

function nowIso(){ return new Date().toISOString(); }
function mb(bytes){ return Math.round(bytes / 1024 / 1024 * 100) / 100; }
function errText(e){ const s=String(e?.message||e||'Unknown error').trim(); return s.length>1400?s.slice(0,1400)+'…':s; }
function randomLen(mode){ if(mode==='mixed') return 5+Math.floor(Math.random()*3); const n=Number(mode); return [5,6,7].includes(n)?n:6; }
function isYouTubeUrl(s){
  try{
    const u=new URL(s.trim());
    const h=u.hostname.replace(/^www\./,'').toLowerCase();
    return ['youtube.com','m.youtube.com','youtu.be','music.youtube.com'].includes(h);
  }catch{return false;}
}
function normalizeLinks(input){
  const raw=Array.isArray(input)?input:String(input||'').split(/\r?\n/);
  const out=[], seen=new Set();
  for(const x of raw){
    const s=String(x||'').trim();
    if(!s||!isYouTubeUrl(s)||seen.has(s)) continue;
    seen.add(s); out.push(s);
    if(out.length>=MAX_LINKS) break;
  }
  return out;
}
function shouldStop(j){
  const ca=j.limits.clipCount>0, sa=j.limits.totalBytes>0;
  if(!ca&&!sa) return false;
  const c=ca&&j.clips>=j.limits.clipCount, s=sa&&j.totalBytes>=j.limits.totalBytes;
  return j.limits.stopMode==='both'&&ca&&sa ? c&&s : c||s;
}
function publicJob(j){
  return {
    id:j.id,status:j.status,createdAt:j.createdAt,startedAt:j.startedAt,finishedAt:j.finishedAt,
    totalLinks:j.links.length,currentIndex:j.currentIndex,currentUrl:j.currentUrl,
    completedVideos:j.completedVideos,failedVideos:j.failedVideos,clips:j.clips,totalBytes:j.totalBytes,totalMB:mb(j.totalBytes),
    lastClip:j.lastClip,message:j.message,errors:j.errors.slice(-25),settings:j.settings,limits:j.limits,
    queuePosition:j.status==='queued'?Math.max(1,queue.indexOf(j.id)+1):0,
    zipReady:j.status==='done'&&!!j.zipPath,stoppedByLimit:j.stoppedByLimit,cancelRequested:j.cancelRequested
  };
}

async function ensureYtDlp(){
  if(fs.existsSync(YTDLP) && (await fsp.stat(YTDLP)).size > 1000000) return;
  console.log('yt-dlp topilmadi. Official executable yuklanmoqda...');
  const r=await fetch(YTDLP_URL,{redirect:'follow',headers:{'User-Agent':'VideoCutterPRO/2.0'}});
  if(!r.ok) throw new Error(`yt-dlp yuklab bo‘lmadi: HTTP ${r.status}`);
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length<1000000) throw new Error('yt-dlp yuklamasi juda kichik; yuklash bekor qilindi.');
  await fsp.writeFile(YTDLP,buf);
  if(process.platform!=='win32') await fsp.chmod(YTDLP,0o755);
  console.log(`yt-dlp tayyor: ${(buf.length/1024/1024).toFixed(1)} MB`);
}

function spawnChecked(command,args,{job,label,onLine}={}){
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    const child=spawn(command,args,{windowsHide:true});
    if(job) job.child=child;
    const eat=(kind,d)=>{
      const t=d.toString();
      if(kind==='out'){ stdout=(stdout+t).slice(-30000); } else { stderr=(stderr+t).slice(-50000); }
      if(onLine) for(const line of t.split(/\r?\n/)) if(line.trim()) onLine(line.trim());
    };
    child.stdout?.on('data',d=>eat('out',d));
    child.stderr?.on('data',d=>eat('err',d));
    child.on('error',reject);
    child.on('close',code=>{
      if(job&&job.child===child) job.child=null;
      if(job?.cancelRequested) return reject(new Error('Jarayon to‘xtatildi.'));
      if(code===0) return resolve({stdout,stderr});
      reject(new Error(`${label||path.basename(command)} xatosi (code ${code}): ${(stderr||stdout||'No output').trim()}`));
    });
  });
}

async function downloadVideo(j,url,index){
  const prefix=`src_${String(index+1).padStart(4,'0')}_${crypto.randomBytes(4).toString('hex')}`;
  const templ=path.join(j.downloadDir,`${prefix}.%(ext)s`);
  const args=[
    '--no-playlist','--newline','--no-part','--restrict-filenames',
    '--js-runtimes',`node:${process.execPath}`,
    '--remote-components','ejs:github',
    '-f',`bv*[height<=${j.settings.maxHeight}]/bv*`,
    '-o',templ,
    url
  ];
  j.message=`${index+1}/${j.links.length}: YouTube video yuklanmoqda…`;
  await spawnChecked(YTDLP,args,{job:j,label:'yt-dlp',onLine:(line)=>{
    const m=line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if(m) j.message=`${index+1}/${j.links.length}: yuklanmoqda ${m[1]}%`;
  }});
  const names=await fsp.readdir(j.downloadDir);
  const matches=names.filter(n=>n.startsWith(prefix+'.'));
  if(!matches.length) throw new Error('yt-dlp video fayl yaratmadi.');
  const full=path.join(j.downloadDir,matches[0]);
  return {path:full,name:matches[0]};
}

async function duration(file,j){
  try{
    await spawnChecked(ffmpegPath,['-hide_banner','-i',file],{job:j,label:'FFmpeg probe'});
  }catch(e){
    const m=String(e.message).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if(!m) throw e;
    return Number(m[1])*3600+Number(m[2])*60+Number(m[3]);
  }
  throw new Error('Video davomiyligi aniqlanmadi.');
}

async function makeClip(j,input,out,start,len){
  await spawnChecked(ffmpegPath,[
    '-hide_banner','-loglevel','error','-y',
    '-ss',start.toFixed(3),'-i',input,'-t',len.toFixed(3),
    '-map','0:v:0','-an',
    '-vf',`scale='min(${j.settings.maxWidth},iw)':-2`,
    '-c:v','libx264','-preset',j.settings.preset,'-crf',String(j.settings.crf),
    '-pix_fmt','yuv420p','-movflags','+faststart','-avoid_negative_ts','make_zero',out
  ],{job:j,label:'FFmpeg clip'});
}

async function zipJob(j){
  const z=path.join(j.dir,`clips_${j.id.slice(0,8)}.zip`);
  await new Promise((resolve,reject)=>{
    const o=fs.createWriteStream(z), a=archiver('zip',{zlib:{level:6}});
    o.on('close',resolve); o.on('error',reject); a.on('error',reject);
    a.pipe(o); a.directory(j.clipsDir,false); a.finalize();
  });
  j.zipPath=z;
}

async function processJob(j){
  j.status='running'; j.startedAt=nowIso();
  try{
    for(let i=0;i<j.links.length;i++){
      if(j.cancelRequested||shouldStop(j)||j.clips>=MAX_CLIPS) break;
      j.currentIndex=i+1; j.currentUrl=j.links[i];
      let src=null;
      try{
        src=await downloadVideo(j,j.links[i],i);
        const dur=await duration(src.path,j);
        let cursor=0;
        while(!j.cancelRequested && cursor+5<=dur && j.clips<MAX_CLIPS){
          if(shouldStop(j)){ j.stoppedByLimit=true; break; }
          let len=randomLen(j.settings.segmentMode);
          if(cursor+len>dur){
            const rem=dur-cursor;
            if(rem<5) break;
            len=Math.min(7,Math.floor(rem));
          }
          const no=j.clips+1;
          const name=`clip_${String(no).padStart(6,'0')}_v${String(i+1).padStart(4,'0')}_${len}s.mp4`;
          const out=path.join(j.clipsDir,name);
          j.message=`${i+1}/${j.links.length}: ${len}s klip #${no} tayyorlanmoqda…`;
          await makeClip(j,src.path,out,cursor,len);
          const st=await fsp.stat(out);
          j.clips++; j.totalBytes+=st.size;
          j.lastClip={name,bytes:st.size,mb:mb(st.size),seconds:len,source:j.links[i]};
          cursor+=len;
          if(shouldStop(j)){ j.stoppedByLimit=true; break; }
        }
        j.completedVideos++;
      }catch(e){
        if(j.cancelRequested) throw e;
        j.failedVideos++;
        j.errors.push({url:j.links[i],message:errText(e),at:nowIso()});
      }finally{
        if(src?.path) await fsp.rm(src.path,{force:true}).catch(()=>{});
      }
    }
    if(j.cancelRequested){ j.status='cancelled'; j.message='Jarayon to‘xtatildi.'; }
    else if(j.clips===0){ j.status='failed'; j.message='Hech qanday klip yaratilmadi. Xatolar bo‘limini tekshiring.'; }
    else {
      j.message='ZIP tayyorlanmoqda…';
      await zipJob(j);
      j.status='done';
      j.message=j.stoppedByLimit?'Belgilangan limitga yetildi. ZIP tayyor.':'Barcha linklar qayta ishlandi. ZIP tayyor.';
    }
  }catch(e){
    j.status=j.cancelRequested?'cancelled':'failed';
    j.message=errText(e);
    if(!j.cancelRequested) j.errors.push({url:j.currentUrl,message:errText(e),at:nowIso()});
  }finally{
    j.finishedAt=nowIso(); j.child=null; activeJobId=null; runNext();
  }
}

function runNext(){
  if(activeJobId||!queue.length) return;
  const id=queue.shift(),j=jobs.get(id);
  if(!j||j.cancelRequested) return runNext();
  activeJobId=id; processJob(j);
}

app.get('/api/health',(_req,res)=>res.json({
  ok:!!ffmpegPath&&fs.existsSync(ffmpegPath)&&fs.existsSync(YTDLP),
  node:process.version,ffmpeg:!!ffmpegPath,ytdlp:fs.existsSync(YTDLP),activeJobId,queued:queue.length,maxLinks:MAX_LINKS
}));

app.post('/api/jobs',limiter,async(req,res)=>{
  const links=normalizeLinks(req.body?.links);
  if(!links.length) return res.status(400).json({error:'Kamida 1 ta to‘g‘ri YouTube link kiriting.'});
  const segmentMode=['5','6','7','mixed'].includes(String(req.body?.segmentMode))?String(req.body.segmentMode):'mixed';
  const clipCount=Math.max(0,Math.min(MAX_CLIPS,Number(req.body?.clipCount||0)));
  const totalMB=Math.max(0,Math.min(1024000,Number(req.body?.totalMB||0)));
  const stopMode=req.body?.stopMode==='both'?'both':'first';
  const preset=['ultrafast','superfast','veryfast','faster','fast'].includes(req.body?.preset)?req.body.preset:'veryfast';
  const crf=Math.max(18,Math.min(32,Number(req.body?.crf||23)));
  const maxHeight=[480,720,1080,1440,2160].includes(Number(req.body?.maxHeight))?Number(req.body.maxHeight):1080;
  const maxWidth=Math.round(maxHeight*16/9);
  const id=crypto.randomUUID(),dir=path.join(ROOT,id),downloadDir=path.join(dir,'downloads'),clipsDir=path.join(dir,'clips');
  await fsp.mkdir(downloadDir,{recursive:true}); await fsp.mkdir(clipsDir,{recursive:true});
  const j={
    id,dir,downloadDir,clipsDir,links,status:'queued',createdAt:nowIso(),startedAt:null,finishedAt:null,
    currentIndex:0,currentUrl:null,completedVideos:0,failedVideos:0,clips:0,totalBytes:0,lastClip:null,errors:[],
    message:'Navbatga qo‘shildi…',settings:{segmentMode,preset,crf,maxHeight,maxWidth},
    limits:{clipCount,totalMB,totalBytes:Math.floor(totalMB*1024*1024),stopMode},
    child:null,cancelRequested:false,stoppedByLimit:false,zipPath:null
  };
  jobs.set(id,j); queue.push(id); runNext();
  res.status(202).json({job:publicJob(j)});
});

app.get('/api/jobs/:id',(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j) return res.status(404).json({error:'Job topilmadi yoki muddati tugagan.'});
  res.json({job:publicJob(j)});
});

app.post('/api/jobs/:id/cancel',(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j) return res.status(404).json({error:'Job topilmadi.'});
  j.cancelRequested=true;
  if(j.status==='queued'){
    const x=queue.indexOf(j.id); if(x>=0) queue.splice(x,1);
    j.status='cancelled'; j.finishedAt=nowIso(); j.message='Navbatdagi ish bekor qilindi.';
  }
  if(j.child&&!j.child.killed){ try{j.child.kill('SIGTERM')}catch{} }
  res.json({job:publicJob(j)});
});

app.get('/api/jobs/:id/download',(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j||j.status!=='done'||!j.zipPath||!fs.existsSync(j.zipPath)) return res.status(404).send('ZIP tayyor emas yoki o‘chirilgan.');
  res.download(j.zipPath,`youtube_clips_${j.clips}_${Math.round(j.totalBytes/1024/1024)}MB.zip`);
});

app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

setInterval(async()=>{
  const t=Date.now();
  for(const[id,j]of jobs){
    const ref=new Date(j.finishedAt||j.createdAt).getTime();
    if(['queued','running'].includes(j.status)||t-ref<JOB_TTL_MS) continue;
    jobs.delete(id); await fsp.rm(j.dir,{recursive:true,force:true}).catch(()=>{});
  }
},10*60*1000).unref();

(async()=>{
  try{
    await ensureYtDlp();
    app.listen(PORT,'127.0.0.1',()=>console.log(`Video Cutter PRO: http://localhost:${PORT}`));
  }catch(e){
    console.error('\nSTART XATOSI:',errText(e));
    console.error('Internetni tekshiring va START_PC.bat ni qayta ishga tushiring.');
    process.exit(1);
  }
})();
