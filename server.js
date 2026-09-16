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
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(os.tmpdir(), 'yt_automix_pro');
const TOOLS = path.join(__dirname, 'tools');
const WORKSPACE = path.join(__dirname, 'workspace');
const DEFAULTS = {
  input: path.join(WORKSPACE, 'input'),
  clips: path.join(WORKSPACE, 'clips'),
  audio: path.join(WORKSPACE, 'audio'),
  mixes: path.join(WORKSPACE, 'mixes')
};
for (const p of [ROOT, TOOLS, ...Object.values(DEFAULTS)]) fs.mkdirSync(p, { recursive: true });

const YTDLP = path.join(TOOLS, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_URL = process.platform === 'win32'
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

const VIDEO_EXT = new Set(['.mp4','.mov','.mkv','.webm','.avi','.m4v']);
const AUDIO_EXT = new Set(['.mp3','.m4a','.aac','.wav','.flac','.ogg']);
const jobs = new Map();
const queue = [];
let activeJobId = null;

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 150, standardHeaders: 'draft-7', legacyHeaders: false });
const nowIso = () => new Date().toISOString();
const mb = b => Math.round((Number(b || 0) / 1024 / 1024) * 100) / 100;
const safe = s => String(s || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110) || 'file';
const errText = e => String(e?.message || e || 'Unknown error').trim().slice(0, 1800);
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
const abs = p => path.resolve(String(p || ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function spawnChecked(command, args, { job, label, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const child = spawn(command, args, { windowsHide: true });
    if (job) job.child = child;
    const eat = (kind, d) => {
      const t = d.toString();
      if (kind === 'out') stdout = (stdout + t).slice(-40000); else stderr = (stderr + t).slice(-70000);
      if (onLine) for (const line of t.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout?.on('data', d => eat('out', d));
    child.stderr?.on('data', d => eat('err', d));
    child.on('error', reject);
    child.on('close', code => {
      if (job && job.child === child) job.child = null;
      if (job?.cancelRequested) return reject(new Error('Jarayon to‘xtatildi.'));
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label || path.basename(command)} xatosi (code ${code}): ${(stderr || stdout || 'No output').trim()}`));
    });
  });
}

async function ensureYtDlp() {
  if (exists(YTDLP) && (await fsp.stat(YTDLP)).size > 1000000) return;
  const r = await fetch(YTDLP_URL, { redirect: 'follow', headers: { 'User-Agent': 'YT-AutoMix-PRO/3.0' } });
  if (!r.ok) throw new Error(`yt-dlp yuklab bo‘lmadi: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000000) throw new Error('yt-dlp yuklamasi noto‘g‘ri.');
  await fsp.writeFile(YTDLP, buf);
  if (process.platform !== 'win32') await fsp.chmod(YTDLP, 0o755);
}

function isYouTubeUrl(s) {
  try {
    const u = new URL(String(s).trim());
    const h = u.hostname.replace(/^www\./,'').toLowerCase();
    return ['youtube.com','m.youtube.com','music.youtube.com','youtu.be'].includes(h);
  } catch { return false; }
}
function normalizeLinks(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const out = [], seen = new Set();
  for (const x of arr) {
    const s = String(x || '').trim();
    if (!s || !isYouTubeUrl(s) || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length >= 1000) break;
  }
  return out;
}
async function listFiles(folder, exts) {
  const dir = abs(folder);
  const items = await fsp.readdir(dir, { withFileTypes: true });
  return items.filter(x => x.isFile() && exts.has(path.extname(x.name).toLowerCase())).map(x => path.join(dir, x.name)).sort();
}
async function ensureDir(p) { await fsp.mkdir(abs(p), { recursive: true }); return abs(p); }

async function duration(file, job) {
  try {
    await spawnChecked(ffmpegPath, ['-hide_banner','-i',file], { job, label: 'FFmpeg probe' });
  } catch (e) {
    const m = String(e.message).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]);
    throw e;
  }
  throw new Error('Media davomiyligi aniqlanmadi.');
}

function chooseLen(settings) {
  if (settings.durationMode === 'exact') return settings.exactSeconds;
  const min = settings.minSeconds, max = settings.maxSeconds;
  return min + Math.floor(Math.random() * (max - min + 1));
}
function stopClips(j) {
  const c = j.limits.clipCount > 0 && j.clips >= j.limits.clipCount;
  const s = j.limits.totalBytes > 0 && j.totalBytes >= j.limits.totalBytes;
  if (!j.limits.clipCount && !j.limits.totalBytes) return false;
  return j.limits.stopMode === 'both' && j.limits.clipCount > 0 && j.limits.totalBytes > 0 ? c && s : c || s;
}

async function downloadSource(j, url, idx, needAudio, audioOnly = false) {
  const prefix = `src_${String(idx+1).padStart(4,'0')}_${crypto.randomBytes(3).toString('hex')}_`;
  const templ = path.join(j.tempDir, `${prefix}%(title).80s_%(id)s.%(ext)s`);
  const fmt = audioOnly ? 'ba' : (needAudio ? `bv*[height<=${j.settings.maxHeight}]+ba/b[height<=${j.settings.maxHeight}]` : `bv*[height<=${j.settings.maxHeight}]/bv*`);
  const args = ['--no-playlist','--newline','--no-part','--restrict-filenames','--js-runtimes',`node:${process.execPath}`,'--remote-components','ejs:github','--ffmpeg-location',path.dirname(ffmpegPath),'-f',fmt];
  if (needAudio && !audioOnly) args.push('--merge-output-format','mkv');
  args.push('-o',templ,url);
  j.message = `${idx+1}/${j.totalSources}: YouTube yuklanmoqda…`;
  await spawnChecked(YTDLP, args, { job: j, label: 'yt-dlp', onLine: line => {
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (m) j.message = `${idx+1}/${j.totalSources}: yuklanmoqda ${m[1]}%`;
  }});
  const names = await fsp.readdir(j.tempDir);
  const found = names.filter(n => n.startsWith(prefix) && (VIDEO_EXT.has(path.extname(n).toLowerCase()) || AUDIO_EXT.has(path.extname(n).toLowerCase())));
  if (!found.length) throw new Error('yt-dlp media fayl yaratmadi.');
  return path.join(j.tempDir, found[0]);
}

async function extractAudio(j, src, sourceIndex, sourceLabel) {
  if (j.settings.audioFormat === 'off') return null;
  const ext = j.settings.audioFormat;
  const stem = safe(path.basename(sourceLabel, path.extname(sourceLabel)).replace(/^src_\d+_[a-f0-9]+_/,''));
  const out = path.join(j.paths.audio, `${String(sourceIndex+1).padStart(4,'0')}_${stem}.${ext}`);
  let codecArgs;
  if (ext === 'mp3') codecArgs = ['-c:a','libmp3lame','-b:a','320k'];
  else if (ext === 'm4a') codecArgs = ['-c:a','aac','-b:a','256k'];
  else codecArgs = ['-c:a','pcm_s16le'];
  await spawnChecked(ffmpegPath, ['-hide_banner','-loglevel','error','-y','-i',src,'-vn',...codecArgs,out], { job: j, label: 'Audio extract' });
  const st = await fsp.stat(out);
  j.audioFiles++;
  j.audioBytes += st.size;
  j.lastAudio = { name: path.basename(out), mb: mb(st.size) };
  j.createdAudio.push(out);
  return out;
}

async function makeClip(j, src, out, start, len) {
  const h = j.settings.maxHeight;
  const vf = j.settings.orientation === '9:16'
    ? `scale=${h}:${Math.round(h*16/9)}:force_original_aspect_ratio=decrease,pad=${h}:${Math.round(h*16/9)}:(ow-iw)/2:(oh-ih)/2,setsar=1`
    : j.settings.orientation === '16:9'
      ? `scale=${Math.round(h*16/9)}:${h}:force_original_aspect_ratio=decrease,pad=${Math.round(h*16/9)}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
      : `scale='min(${Math.round(h*16/9)},iw)':-2`;
  await spawnChecked(ffmpegPath, ['-hide_banner','-loglevel','error','-y','-ss',start.toFixed(3),'-i',src,'-t',len.toFixed(3),'-map','0:v:0','-an','-vf',vf,'-c:v','libx264','-preset',j.settings.preset,'-crf',String(j.settings.crf),'-pix_fmt','yuv420p','-movflags','+faststart','-avoid_negative_ts','make_zero',out], { job: j, label: 'FFmpeg clip' });
}

async function zipSelected(files, outPath) {
  await new Promise((resolve,reject) => {
    const o = fs.createWriteStream(outPath), a = archiver('zip', { zlib: { level: 6 } });
    o.on('close', resolve); o.on('error', reject); a.on('error', reject); a.pipe(o);
    for (const f of files) if (exists(f)) a.file(f, { name: path.basename(f) });
    a.finalize();
  });
}

async function processCutter(j) {
  let sources = [];
  if (j.settings.sourceMode === 'youtube') sources = j.links.map(x => ({ kind:'youtube', value:x, label:x }));
  else {
    const files = await listFiles(j.paths.input, VIDEO_EXT);
    sources = files.map(x => ({ kind:'local', value:x, label:path.basename(x) }));
  }
  if (!sources.length) throw new Error('Manbada video topilmadi.');
  j.totalSources = sources.length;
  const needAudio = j.settings.audioFormat !== 'off';
  for (let i=0; i<sources.length; i++) {
    if (j.cancelRequested) break;
    const srcInfo = sources[i];
    const clipLimitReached = stopClips(j) || j.clips >= 20000;
    if (clipLimitReached && !(needAudio && j.settings.audioAllSources)) { j.stoppedByLimit = true; break; }
    let srcPath = null, temp = false;
    j.currentIndex = i+1; j.currentSource = srcInfo.label;
    try {
      if (srcInfo.kind === 'youtube') { srcPath = await downloadSource(j, srcInfo.value, i, needAudio, clipLimitReached && needAudio && j.settings.audioAllSources); temp = true; }
      else srcPath = srcInfo.value;
      const label = path.basename(srcPath);
      if (needAudio) {
        j.message = `${i+1}/${sources.length}: audio ajratilmoqda…`;
        await extractAudio(j, srcPath, i, label);
      }
      if (!stopClips(j) && j.clips < 20000) {
        const dur = await duration(srcPath, j);
        let cursor = 0, perSource = 0;
        while (!j.cancelRequested && cursor + 3 <= dur && j.clips < 20000) {
          if (stopClips(j)) { j.stoppedByLimit = true; break; }
          if (j.limits.perSource > 0 && perSource >= j.limits.perSource) break;
          let len = chooseLen(j.settings);
          if (cursor + len > dur) {
            const rem = dur - cursor;
            if (rem < 3) break;
            len = Math.min(7, Math.max(3, Math.floor(rem)));
          }
          const no = j.clips + 1;
          const name = `clip_${j.id.slice(0,6)}_${String(no).padStart(6,'0')}_${len}s.mp4`;
          const out = path.join(j.paths.clips, name);
          j.message = `${i+1}/${sources.length}: ${len}s klip #${no}…`;
          await makeClip(j, srcPath, out, cursor, len);
          const st = await fsp.stat(out);
          j.clips++; perSource++; j.totalBytes += st.size; j.createdClips.push(out);
          j.lastClip = { name, seconds: len, mb: mb(st.size) };
          cursor += len;
        }
      }
      j.completedSources++;
    } catch (e) {
      if (j.cancelRequested) throw e;
      j.failedSources++; j.errors.push({ source: srcInfo.label, message: errText(e), at: nowIso() });
    } finally {
      if (temp && srcPath) await fsp.rm(srcPath, { force:true }).catch(()=>{});
    }
  }
  if (j.settings.makeZip && j.createdClips.length) {
    j.message = 'Kliplar ZIP qilinmoqda…';
    j.zipPath = path.join(j.dir, `clips_${j.id.slice(0,8)}.zip`);
    await zipSelected(j.createdClips, j.zipPath);
  }
}

function shuffle(a) {
  const out = a.slice();
  for (let i=out.length-1;i>0;i--) { const k=Math.floor(Math.random()*(i+1)); [out[i],out[k]]=[out[k],out[i]]; }
  return out;
}
function concatEscape(p) { return String(p).replace(/\\/g,'/').replace(/'/g, "'\\\\''"); }

async function normalizeClip(j, src, cacheDir, width, height, cacheMap) {
  if (cacheMap.has(src)) return cacheMap.get(src);
  const out = path.join(cacheDir, `n_${crypto.createHash('sha1').update(src).digest('hex').slice(0,14)}.mp4`);
  if (!exists(out)) {
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
    await spawnChecked(ffmpegPath, ['-hide_banner','-loglevel','error','-y','-i',src,'-an','-vf',vf,'-c:v','libx264','-preset',j.settings.preset,'-crf',String(j.settings.crf),'-pix_fmt','yuv420p','-movflags','+faststart',out], { job:j, label:'Normalize clip' });
  }
  cacheMap.set(src, out); return out;
}

async function processMix(j) {
  const clips = await listFiles(j.paths.clips, VIDEO_EXT);
  let audios = await listFiles(j.paths.audio, AUDIO_EXT);
  if (!clips.length) throw new Error('AutoMix uchun kliplar papkasida video topilmadi.');
  if (!audios.length) throw new Error('AutoMix uchun audio papkasida musiqa topilmadi.');
  if (j.settings.maxMixes > 0) audios = audios.slice(0, j.settings.maxMixes);
  j.totalMixes = audios.length;
  const width = j.settings.orientation === '9:16' ? 1080 : 1920;
  const height = j.settings.orientation === '9:16' ? 1920 : 1080;
  const cacheDir = path.join(j.dir, 'norm'); await fsp.mkdir(cacheDir, { recursive:true });
  const cacheMap = new Map(); let previousSignature = '';
  for (let i=0;i<audios.length;i++) {
    if (j.cancelRequested) break;
    const audio = audios[i]; j.currentIndex = i+1; j.currentSource = path.basename(audio);
    try {
      const target = await duration(audio, j);
      let ordered = shuffle(clips);
      for (let tries=0; tries<5; tries++) {
        const sig = ordered.slice(0,Math.min(5,ordered.length)).map(x=>path.basename(x)).join('|');
        if (sig !== previousSignature) { previousSignature = sig; break; }
        ordered = shuffle(clips);
      }
      const seq = []; let total = 0, cycle = ordered.slice();
      while (total < target + 2) {
        if (!cycle.length) cycle = shuffle(clips);
        const src = cycle.shift();
        const d = await duration(src, j).catch(()=>5);
        seq.push(src); total += Math.max(0.5,d);
        if (!j.settings.reuseClips && seq.length >= clips.length) break;
        if (seq.length > 5000) break;
      }
      if (!j.settings.reuseClips && total < target) throw new Error('Musiqa uzunligiga yetadigan klip yo‘q. “Kliplar yetmasa qayta ishlat” ni yoqing.');
      const normalized = [];
      for (let k=0;k<seq.length;k++) {
        if (j.cancelRequested) throw new Error('Jarayon to‘xtatildi.');
        j.message = `${i+1}/${audios.length}: klip ${k+1}/${seq.length} tayyorlanmoqda…`;
        normalized.push(await normalizeClip(j, seq[k], cacheDir, width, height, cacheMap));
      }
      const listPath = path.join(j.dir, `concat_${i}.txt`);
      await fsp.writeFile(listPath, normalized.map(p=>`file '${concatEscape(p)}'`).join('\n'), 'utf8');
      const silentVideo = path.join(j.dir, `video_${i}.mp4`);
      await spawnChecked(ffmpegPath, ['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',listPath,'-c','copy',silentVideo], { job:j, label:'Concat' });
      const out = path.join(j.paths.mixes, `${String(i+1).padStart(3,'0')}_${safe(path.basename(audio,path.extname(audio)))}_AUTOMIX.mp4`);
      j.message = `${i+1}/${audios.length}: audio bilan birlashtirilmoqda…`;
      await spawnChecked(ffmpegPath, ['-hide_banner','-loglevel','error','-y','-i',silentVideo,'-i',audio,'-t',target.toFixed(3),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',out], { job:j, label:'Mux mix' });
      const st=await fsp.stat(out); j.completedMixes++; j.mixBytes += st.size; j.lastMix={name:path.basename(out),mb:mb(st.size),seconds:Math.round(target)}; j.createdMixes.push(out);
      await fsp.rm(silentVideo,{force:true}).catch(()=>{}); await fsp.rm(listPath,{force:true}).catch(()=>{});
    } catch (e) {
      if (j.cancelRequested) throw e;
      j.failedMixes++; j.errors.push({ source:path.basename(audio), message:errText(e), at:nowIso() });
    }
  }
}

function publicJob(j) {
  return {
    id:j.id,type:j.type,status:j.status,createdAt:j.createdAt,startedAt:j.startedAt,finishedAt:j.finishedAt,
    message:j.message,currentIndex:j.currentIndex,currentSource:j.currentSource,queuePosition:j.status==='queued'?Math.max(1,queue.indexOf(j.id)+1):0,
    errors:j.errors.slice(-30),cancelRequested:j.cancelRequested,
    totalSources:j.totalSources||0,completedSources:j.completedSources||0,failedSources:j.failedSources||0,clips:j.clips||0,totalMB:mb(j.totalBytes||0),audioFiles:j.audioFiles||0,audioMB:mb(j.audioBytes||0),lastClip:j.lastClip||null,lastAudio:j.lastAudio||null,stoppedByLimit:!!j.stoppedByLimit,zipReady:!!(j.zipPath&&exists(j.zipPath)),
    totalMixes:j.totalMixes||0,completedMixes:j.completedMixes||0,failedMixes:j.failedMixes||0,mixMB:mb(j.mixBytes||0),lastMix:j.lastMix||null,
    paths:j.paths
  };
}

async function runJob(j) {
  j.status='running'; j.startedAt=nowIso();
  try {
    if (j.type === 'cutter') await processCutter(j); else await processMix(j);
    if (j.cancelRequested) { j.status='cancelled'; j.message='Jarayon to‘xtatildi.'; }
    else { j.status='done'; j.message = j.type==='cutter' ? 'Kesish va audio ajratish yakunlandi.' : 'AutoMix yakunlandi.'; }
  } catch (e) {
    j.status = j.cancelRequested ? 'cancelled' : 'failed'; j.message = errText(e);
    if (!j.cancelRequested) j.errors.push({ source:j.currentSource||'', message:errText(e), at:nowIso() });
  } finally { j.finishedAt=nowIso(); j.child=null; activeJobId=null; runNext(); }
}
function runNext() {
  if (activeJobId || !queue.length) return;
  const id=queue.shift(), j=jobs.get(id);
  if (!j || j.cancelRequested) return runNext();
  activeJobId=id; runJob(j);
}

function baseJob(type, paths) {
  const id=crypto.randomUUID(), dir=path.join(ROOT,id); fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(path.join(dir,'temp'),{recursive:true});
  return { id,type,dir,tempDir:path.join(dir,'temp'),paths,status:'queued',createdAt:nowIso(),startedAt:null,finishedAt:null,message:'Navbatga qo‘shildi…',currentIndex:0,currentSource:null,errors:[],child:null,cancelRequested:false };
}

app.get('/api/health', async (_req,res)=>res.json({ ok:!!ffmpegPath&&exists(ffmpegPath)&&exists(YTDLP), ffmpeg:!!ffmpegPath, ytdlp:exists(YTDLP), node:process.version, activeJobId, queued:queue.length, defaults:DEFAULTS }));
app.get('/api/default-paths',(_req,res)=>res.json(DEFAULTS));

app.post('/api/pick-folder', async (req,res)=>{
  if (process.platform !== 'win32') return res.status(400).json({error:'Papka tanlash tugmasi Windows uchun.'});
  const current = String(req.body?.current || WORKSPACE);
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Papka tanlang'; $d.ShowNewFolderButton=$true; if(Test-Path $env:VC_CURRENT){$d.SelectedPath=$env:VC_CURRENT}; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}`;
  const env={...process.env,VC_CURRENT:current};
  const child=spawn('powershell.exe',['-NoProfile','-STA','-Command',script],{windowsHide:true,env});
  let out='',err=''; child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  child.on('close',code=>{ if(code!==0)return res.status(500).json({error:err||'Papka tanlab bo‘lmadi.'}); res.json({path:out.trim()||current}); });
});
app.post('/api/open-folder',(req,res)=>{
  const p=abs(req.body?.path||WORKSPACE); if(!exists(p))return res.status(404).json({error:'Papka topilmadi.'});
  if(process.platform==='win32') spawn('explorer.exe',[p],{detached:true,stdio:'ignore'}).unref();
  res.json({ok:true,path:p});
});

app.post('/api/jobs/cutter', limiter, async (req,res)=>{
  const sourceMode=req.body?.sourceMode==='local'?'local':'youtube';
  const links=sourceMode==='youtube'?normalizeLinks(req.body?.links):[];
  const input=abs(req.body?.inputPath||DEFAULTS.input), clips=await ensureDir(req.body?.clipsPath||DEFAULTS.clips), audio=await ensureDir(req.body?.audioPath||DEFAULTS.audio);
  if(sourceMode==='youtube'&&!links.length)return res.status(400).json({error:'Kamida 1 ta to‘g‘ri YouTube link kiriting.'});
  if(sourceMode==='local'&&!exists(input))return res.status(400).json({error:'Input papka topilmadi.'});
  const durationMode=req.body?.durationMode==='exact'?'exact':'random';
  const exactSeconds=Math.max(3,Math.min(7,Number(req.body?.exactSeconds||4)));
  let minSeconds=Math.max(3,Math.min(7,Number(req.body?.minSeconds||3))), maxSeconds=Math.max(3,Math.min(7,Number(req.body?.maxSeconds||7))); if(minSeconds>maxSeconds)[minSeconds,maxSeconds]=[maxSeconds,minSeconds];
  const settings={sourceMode,durationMode,exactSeconds,minSeconds,maxSeconds,maxHeight:[480,720,1080,1440,2160].includes(Number(req.body?.maxHeight))?Number(req.body.maxHeight):1080,orientation:['source','16:9','9:16'].includes(req.body?.orientation)?req.body.orientation:'source',preset:['ultrafast','superfast','veryfast','faster','fast'].includes(req.body?.preset)?req.body.preset:'veryfast',crf:Math.max(18,Math.min(32,Number(req.body?.crf||23))),audioFormat:['off','mp3','m4a','wav'].includes(req.body?.audioFormat)?req.body.audioFormat:'mp3',audioAllSources:req.body?.audioAllSources!==false,makeZip:!!req.body?.makeZip};
  const limits={clipCount:Math.max(0,Math.min(20000,Number(req.body?.clipCount||0))),perSource:Math.max(0,Math.min(10000,Number(req.body?.perSource||0))),totalBytes:Math.max(0,Number(req.body?.totalMB||0))*1024*1024,stopMode:req.body?.stopMode==='both'?'both':'first'};
  const j=baseJob('cutter',{input,clips,audio}); Object.assign(j,{links,settings,limits,totalSources:sourceMode==='youtube'?links.length:0,completedSources:0,failedSources:0,clips:0,totalBytes:0,audioFiles:0,audioBytes:0,lastClip:null,lastAudio:null,createdClips:[],createdAudio:[],zipPath:null,stoppedByLimit:false}); jobs.set(j.id,j);queue.push(j.id);runNext();res.status(202).json({job:publicJob(j)});
});

app.post('/api/jobs/mix', limiter, async (req,res)=>{
  const clips=abs(req.body?.clipsPath||DEFAULTS.clips), audio=abs(req.body?.audioPath||DEFAULTS.audio), mixes=await ensureDir(req.body?.mixesPath||DEFAULTS.mixes);
  if(!exists(clips)||!exists(audio))return res.status(400).json({error:'Klip yoki audio papka topilmadi.'});
  const settings={orientation:req.body?.orientation==='9:16'?'9:16':'16:9',preset:['ultrafast','superfast','veryfast','faster','fast'].includes(req.body?.preset)?req.body.preset:'veryfast',crf:Math.max(18,Math.min(32,Number(req.body?.crf||23))),reuseClips:req.body?.reuseClips!==false,maxMixes:Math.max(0,Math.min(1000,Number(req.body?.maxMixes||0)))};
  const j=baseJob('mix',{clips,audio,mixes});Object.assign(j,{settings,totalMixes:0,completedMixes:0,failedMixes:0,mixBytes:0,lastMix:null,createdMixes:[]});jobs.set(j.id,j);queue.push(j.id);runNext();res.status(202).json({job:publicJob(j)});
});

app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job topilmadi.'});res.json({job:publicJob(j)});});
app.post('/api/jobs/:id/cancel',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job topilmadi.'});j.cancelRequested=true;if(j.status==='queued'){const x=queue.indexOf(j.id);if(x>=0)queue.splice(x,1);j.status='cancelled';j.finishedAt=nowIso();j.message='Navbatdan olib tashlandi.';}if(j.child&&!j.child.killed){try{j.child.kill('SIGTERM')}catch{}}res.json({job:publicJob(j)});});
app.get('/api/jobs/:id/download',(req,res)=>{const j=jobs.get(req.params.id);if(!j?.zipPath||!exists(j.zipPath))return res.status(404).send('ZIP tayyor emas.');res.download(j.zipPath,`clips_${j.id.slice(0,8)}.zip`);});
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

setInterval(async()=>{const t=Date.now();for(const[id,j]of jobs){const ref=new Date(j.finishedAt||j.createdAt).getTime();if(['queued','running'].includes(j.status)||t-ref<6*60*60*1000)continue;jobs.delete(id);await fsp.rm(j.dir,{recursive:true,force:true}).catch(()=>{});}},10*60*1000).unref();

(async()=>{try{await ensureYtDlp();app.listen(PORT,'127.0.0.1',()=>console.log(`YT Video + AutoMix PRO v3: http://localhost:${PORT}`));}catch(e){console.error('START XATOSI:',errText(e));process.exit(1);}})();
