const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const archiver = require('archiver');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const PORT = Number(process.env.PORT || 3000);
const MAX_FILES = Math.max(1, Number(process.env.MAX_FILES || 500));
const MAX_CLIPS = Math.max(1, Number(process.env.MAX_CLIPS || 5000));
const MAX_FILE_MB = Math.max(10, Number(process.env.MAX_FILE_MB || 2048));
const JOB_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.JOB_TTL_MS || 2 * 60 * 60 * 1000));
const ROOT = path.join(os.tmpdir(), 'ytvidcutter');
const jobs = new Map();
const queue = [];
let activeJobId = null;
fs.mkdirSync(ROOT, { recursive: true });

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
function nowIso(){ return new Date().toISOString(); }
function mb(bytes){ return Math.round(bytes / 1024 / 1024 * 100) / 100; }
function errText(e){ const s=String(e?.message||e||'Unknown error').trim(); return s.length>900?s.slice(0,900)+'…':s; }
function safeName(name){ return String(name||'video').replace(/[^a-zA-Z0-9._ -]+/g,'_').slice(0,100); }
function randomLen(mode){ if(mode==='mixed') return 5+Math.floor(Math.random()*3); const n=Number(mode); return [5,6,7].includes(n)?n:6; }
function publicJob(j){ return {id:j.id,status:j.status,createdAt:j.createdAt,startedAt:j.startedAt,finishedAt:j.finishedAt,expectedFiles:j.expectedFiles,uploadedFiles:j.files.length,currentFileIndex:j.currentFileIndex,currentFile:j.currentFile,completedFiles:j.completedFiles,failedFiles:j.failedFiles,clips:j.clips,totalBytes:j.totalBytes,totalMB:mb(j.totalBytes),lastClip:j.lastClip,message:j.message,errors:j.errors.slice(-20),settings:j.settings,limits:j.limits,queuePosition:j.status==='queued'?Math.max(1,queue.indexOf(j.id)+1):0,zipReady:j.status==='done'&&!!j.zipPath,stoppedByLimit:j.stoppedByLimit,cancelRequested:j.cancelRequested}; }
function shouldStop(j){ const ca=j.limits.clipCount>0, sa=j.limits.totalBytes>0; if(!ca&&!sa)return false; const c=ca&&j.clips>=j.limits.clipCount, s=sa&&j.totalBytes>=j.limits.totalBytes; return j.limits.stopMode==='both'&&ca&&sa ? c&&s : c||s; }

function spawnChecked(command,args,{job,label}={}){ return new Promise((resolve,reject)=>{ let stdout='',stderr=''; const child=spawn(command,args,{windowsHide:true}); if(job)job.child=child; child.stdout?.on('data',d=>{stdout+=d; if(stdout.length>20000)stdout=stdout.slice(-20000)}); child.stderr?.on('data',d=>{stderr+=d; if(stderr.length>30000)stderr=stderr.slice(-30000)}); child.on('error',reject); child.on('close',code=>{ if(job&&job.child===child)job.child=null; if(job?.cancelRequested)return reject(new Error('Jarayon to‘xtatildi.')); if(code===0)return resolve({stdout,stderr}); reject(new Error(`${label||path.basename(command)} xatosi (code ${code}): ${(stderr||stdout||'No output').trim()}`)); }); }); }
async function duration(file,job){ try{ await spawnChecked(ffmpegPath,['-hide_banner','-i',file],{job,label:'FFmpeg probe'}); }catch(e){ const m=String(e.message).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if(!m)throw e; return Number(m[1])*3600+Number(m[2])*60+Number(m[3]); } throw new Error('Video davomiyligi aniqlanmadi.'); }
async function makeClip(j,input,out,start,len){ await spawnChecked(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',start.toFixed(3),'-i',input,'-t',len.toFixed(3),'-map','0:v:0','-an','-c:v','libx264','-preset',j.settings.preset,'-crf',String(j.settings.crf),'-pix_fmt','yuv420p','-movflags','+faststart','-avoid_negative_ts','make_zero',out],{job:j,label:'FFmpeg clip'}); }
async function zipJob(j){ const z=path.join(j.dir,`clips_${j.id.slice(0,8)}.zip`); await new Promise((resolve,reject)=>{ const o=fs.createWriteStream(z), a=archiver('zip',{zlib:{level:6}}); o.on('close',resolve); o.on('error',reject); a.on('error',reject); a.pipe(o); a.directory(j.clipsDir,false); a.finalize(); }); j.zipPath=z; }

async function processJob(j){ j.status='running'; j.startedAt=nowIso(); try{ for(let i=0;i<j.files.length;i++){ if(j.cancelRequested||shouldStop(j)||j.clips>=MAX_CLIPS)break; const item=j.files[i]; j.currentFileIndex=i+1; j.currentFile=item.originalName; j.message=`${i+1}/${j.files.length}: ${item.originalName} tekshirilmoqda…`; try{ const dur=await duration(item.path,j); let cursor=0; while(!j.cancelRequested&&cursor+5<=dur&&j.clips<MAX_CLIPS){ if(shouldStop(j)){j.stoppedByLimit=true;break;} let len=randomLen(j.settings.segmentMode); if(cursor+len>dur){const rem=dur-cursor;if(rem<5)break;len=Math.min(7,Math.floor(rem));} const no=j.clips+1; const name=`clip_${String(no).padStart(5,'0')}_f${String(i+1).padStart(3,'0')}_${len}s.mp4`; const out=path.join(j.clipsDir,name); j.message=`${i+1}/${j.files.length}: ${len}s klip ${no} tayyorlanmoqda…`; await makeClip(j,item.path,out,cursor,len); const st=await fsp.stat(out); j.clips++; j.totalBytes+=st.size; j.lastClip={name,bytes:st.size,mb:mb(st.size),seconds:len,source:item.originalName}; cursor+=len; if(shouldStop(j)){j.stoppedByLimit=true;break;} } j.completedFiles++; }catch(e){ if(j.cancelRequested)throw e; j.failedFiles++; j.errors.push({file:item.originalName,message:errText(e),at:nowIso()}); }finally{ await fsp.rm(item.path,{force:true}).catch(()=>{}); } } if(j.cancelRequested){j.status='cancelled';j.message='Jarayon to‘xtatildi.';} else if(j.clips===0){j.status='failed';j.message='Hech qanday klip yaratilmadi.';} else {j.message='ZIP tayyorlanmoqda…';await zipJob(j);j.status='done';j.message=j.stoppedByLimit?'Belgilangan limitga yetildi. ZIP tayyor.':'Barcha videolar qayta ishlandi. ZIP tayyor.';} }catch(e){j.status=j.cancelRequested?'cancelled':'failed';j.message=errText(e);if(!j.cancelRequested)j.errors.push({file:j.currentFile,message:errText(e),at:nowIso()});}finally{j.finishedAt=nowIso();j.child=null;activeJobId=null;runNext();} }
function runNext(){ if(activeJobId||!queue.length)return; const id=queue.shift(),j=jobs.get(id); if(!j||j.cancelRequested)return runNext(); activeJobId=id; processJob(j); }

const storage=multer.diskStorage({destination(req,file,cb){ const j=jobs.get(req.params.id); if(!j)return cb(new Error('Job topilmadi')); cb(null,j.uploadDir); },filename(req,file,cb){ cb(null,`${Date.now()}_${crypto.randomBytes(5).toString('hex')}_${safeName(file.originalname)}`); }});
const upload=multer({storage,limits:{fileSize:MAX_FILE_MB*1024*1024,files:1},fileFilter(_req,file,cb){ const ok=String(file.mimetype||'').startsWith('video/')||/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.originalname); cb(ok?null:new Error('Faqat video fayl qabul qilinadi.'),ok); }});

app.get('/api/health',(_req,res)=>res.json({ok:!!ffmpegPath&&fs.existsSync(ffmpegPath),node:process.version,ffmpeg:!!ffmpegPath,activeJobId,queued:queue.length,maxFiles:MAX_FILES,maxFileMB:MAX_FILE_MB}));
app.post('/api/jobs',limiter,async(req,res)=>{ const expectedFiles=Math.max(1,Math.min(MAX_FILES,Number(req.body?.expectedFiles||1))); const segmentMode=['5','6','7','mixed'].includes(String(req.body?.segmentMode))?String(req.body.segmentMode):'mixed'; const clipCount=Math.max(0,Math.min(MAX_CLIPS,Number(req.body?.clipCount||0))); const totalMB=Math.max(0,Math.min(102400,Number(req.body?.totalMB||0))); const stopMode=req.body?.stopMode==='both'?'both':'first'; const preset=['ultrafast','superfast','veryfast','faster','fast'].includes(req.body?.preset)?req.body.preset:'veryfast'; const crf=Math.max(18,Math.min(32,Number(req.body?.crf||23))); const id=crypto.randomUUID(),dir=path.join(ROOT,id),uploadDir=path.join(dir,'uploads'),clipsDir=path.join(dir,'clips'); await fsp.mkdir(uploadDir,{recursive:true}); await fsp.mkdir(clipsDir,{recursive:true}); const j={id,dir,uploadDir,clipsDir,expectedFiles,files:[],status:'uploading',createdAt:nowIso(),startedAt:null,finishedAt:null,currentFileIndex:0,currentFile:null,completedFiles:0,failedFiles:0,clips:0,totalBytes:0,lastClip:null,errors:[],message:'Fayllar yuklanmoqda…',settings:{segmentMode,preset,crf},limits:{clipCount,totalMB,totalBytes:Math.floor(totalMB*1024*1024),stopMode},child:null,cancelRequested:false,stoppedByLimit:false,zipPath:null}; jobs.set(id,j); res.status(201).json({job:publicJob(j)}); });
app.post('/api/jobs/:id/upload',limiter,(req,res)=>{ const j=jobs.get(req.params.id); if(!j)return res.status(404).json({error:'Job topilmadi.'}); if(j.status!=='uploading')return res.status(409).json({error:'Upload bosqichi yopilgan.'}); if(j.files.length>=MAX_FILES)return res.status(400).json({error:`Maksimum ${MAX_FILES} ta fayl.`}); upload.single('video')(req,res,err=>{ if(err)return res.status(400).json({error:errText(err)}); if(!req.file)return res.status(400).json({error:'Video fayl topilmadi.'}); j.files.push({path:req.file.path,originalName:req.file.originalname,size:req.file.size}); j.message=`${j.files.length}/${j.expectedFiles} fayl yuklandi.`; res.json({job:publicJob(j),file:{name:req.file.originalname,size:req.file.size,mb:mb(req.file.size)}}); }); });
app.post('/api/jobs/:id/start',(req,res)=>{ const j=jobs.get(req.params.id); if(!j)return res.status(404).json({error:'Job topilmadi.'}); if(j.status!=='uploading')return res.status(409).json({error:'Job allaqachon boshlangan.'}); if(!j.files.length)return res.status(400).json({error:'Kamida 1 ta video yuklang.'}); j.status='queued';j.expectedFiles=j.files.length;j.message='Navbatda…';queue.push(j.id);runNext();res.status(202).json({job:publicJob(j)}); });
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job topilmadi yoki muddati tugagan.'});res.json({job:publicJob(j)});});
app.post('/api/jobs/:id/cancel',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job topilmadi.'});j.cancelRequested=true;if(j.status==='queued'){const x=queue.indexOf(j.id);if(x>=0)queue.splice(x,1);j.status='cancelled';j.finishedAt=nowIso();j.message='Navbatdagi ish bekor qilindi.';}if(j.status==='uploading'){j.status='cancelled';j.finishedAt=nowIso();j.message='Upload bekor qilindi.';}if(j.child&&!j.child.killed){try{j.child.kill('SIGTERM')}catch(_){}}res.json({job:publicJob(j)});});
app.get('/api/jobs/:id/download',(req,res)=>{const j=jobs.get(req.params.id);if(!j||j.status!=='done'||!j.zipPath||!fs.existsSync(j.zipPath))return res.status(404).send('ZIP tayyor emas yoki o‘chirilgan.');res.download(j.zipPath,`video_clips_${j.clips}_${Math.round(j.totalBytes/1024/1024)}MB.zip`);});
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
setInterval(async()=>{const t=Date.now();for(const[id,j]of jobs){const ref=new Date(j.finishedAt||j.createdAt).getTime();if(['uploading','queued','running'].includes(j.status)||t-ref<JOB_TTL_MS)continue;jobs.delete(id);await fsp.rm(j.dir,{recursive:true,force:true}).catch(()=>{});}},10*60*1000).unref();
app.listen(PORT,'0.0.0.0',()=>console.log(`Video Cutter: http://localhost:${PORT}`));
