# YT Video + AutoMix PRO v3.1

Windows PC uchun lokal video pipeline.

## Yangi v3.1
- YouTube **playlist linkini** bitta qatorga tashlash mumkin.
- Dastur playlist ichidagi video ID'larni `yt-dlp --flat-playlist` orqali o‘zi chiqarib oladi va navbatga qo‘shadi.
- Oddiy video linklar va playlist linklarini birga berish mumkin.
- Dublikat video URL'lar avtomatik olib tashlanadi.
- Eski localhost:3000 Node process qolib ketgan bo‘lsa `START_PC.bat` uni to‘xtatib, yangi serverni ishga tushiradi.
- Frontend/server versiya mos kelmasa "eski server ishlayapti" degan aniq ogohlantirish chiqadi — endi noma’lum HTTP 404 bilan qolmaydi.

## Cutter + Audio
- YouTube video / playlist yoki lokal papka
- random 3–7 soniya yoki aniq 3/4/5/6/7 soniya
- jami klip soni, har manbadan max klip, jami MB limit
- kliplar NO AUDIO
- audio alohida papkaga MP3 320k / M4A / WAV
- klip limiti tugasa ham audio yig‘ishni davom ettirish opsiyasi
- natijani to‘g‘ridan-to‘g‘ri Windows papkalariga yozish
- ixtiyoriy ZIP

## AutoMix Studio
- kliplar papkasi + musiqalar papkasi
- har audio uchun avtomatik video
- video uzunligi musiqa uzunligiga teng
- kliplar yetmasa qayta ishlatiladi
- har trekda tartib random
- 16:9 yoki 9:16

## Ishga tushirish
1. Node.js 22+ o‘rnating.
2. `START_PC.bat` ni ishga tushiring.
3. Birinchi marta npm paketlar va yt-dlp avtomatik tayyorlanadi.
4. Brauzerda `http://localhost:3000` ochiladi.

Default papkalar:
- `workspace/input`
- `workspace/clips`
- `workspace/audio`
- `workspace/mixes`

Faqat o‘zingizga tegishli yoki qayta ishlash/yuklab olishga ruxsatingiz bo‘lgan media bilan foydalaning.
