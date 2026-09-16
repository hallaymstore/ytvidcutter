# YT Video + AutoMix PRO v3

Windows PC uchun lokal video pipeline.

## Bo‘limlar
1. Cutter + Audio
   - YouTube linklar yoki lokal papka
   - 3–7 soniya random oralig‘i yoki aniq 3/4/5/6/7 soniya
   - jami klip soni, har manbadan max klip, jami MB limit
   - kliplar NO AUDIO
   - audio alohida papkaga MP3 320k / M4A / WAV
   - klip limiti tugasa ham audio yig‘ishni davom ettirish opsiyasi
   - natijani to‘g‘ridan-to‘g‘ri Windows papkalariga yozish
   - ixtiyoriy ZIP

2. AutoMix Studio
   - kliplar papkasi + musiqalar papkasi
   - har audio uchun avtomatik video
   - video uzunligi musiqa uzunligiga teng
   - kliplar yetmasa qayta ishlatiladi
   - har trekda tartib random, bir xil opening ketma-ketligini takrorlamaslikka harakat qiladi
   - 16:9 yoki 9:16

## Ishga tushirish
- Node.js 22+ o‘rnating.
- `START_PC.bat` ni ishga tushiring.
- Birinchi marta npm paketlar va yt-dlp avtomatik tayyorlanadi.
- Brauzerda http://localhost:3000 ochiladi.

Default papkalar:
- `workspace/input`
- `workspace/clips`
- `workspace/audio`
- `workspace/mixes`

Faqat o‘zingizga tegishli yoki qayta ishlash/yuklab olishga ruxsatingiz bo‘lgan media bilan foydalaning.
