# Video Cutter PRO

Ko‘p video faylni ketma-ket serverga yuklab, 5/6/7 soniyali **ovozsiz** MP4 kliplarga kesadigan desktop-friendly web app. Har klipdan keyin real fayl hajmi hisoblanadi; klip soni yoki umumiy MB limitiga yetganda avtomatik to‘xtaydi va yakunda ZIP beradi.

## Funksiyalar
- 1–500 ta video faylni bir martada tanlash / drag & drop
- Upload birma-bir: brauzer va server RAM'ini ortiqcha bosmaydi
- 5s / 6s / 7s / aralash 5–7s
- No sound (`-an`)
- Klip soni limiti
- Jami hajm (MB) limiti
- Birinchi limit yoki ikkala limit rejimi
- Har klipdan keyin hajm va jami statistika
- Xato faylni o'tkazib keyingisiga davom etish
- Cancel, queue, ZIP download
- Temp fayllar 2 soatdan keyin o‘chadi
- PC/mobile responsive

## Local PC
Node.js 20+ kerak.

```bash
npm install
npm start
```

Brauzer: `http://localhost:3000`

Windows uchun `START_PC.bat` ni ikki marta bosish ham mumkin.

## Render
- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- Tavsiya env: `MAX_FILES=500`, `MAX_CLIPS=5000`, `MAX_FILE_MB=2048`, `JOB_TTL_MS=7200000`

> O‘zingizga tegishli yoki qayta ishlashga ruxsatingiz bor videolardan foydalaning.
