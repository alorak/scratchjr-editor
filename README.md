# scratchjr-editor

Tarayıcıda çalışan, ScratchJr `.sjr` projelerini oluşturmak, içe aktarmak, düzenlemek ve yeniden dışa aktarmak için hafif bir editör. Runtime bağımlılıkları repo içinde tutulur; uygulama ilk başarılı GitHub Pages ziyaretinden sonra service worker cache'i ile çevrimdışı yeniden açılabilir.

## Özellikler

- Karakter ve arkaplan görselleri ekleme
- Deterministik SVG uyumluluk analizi; arc/transform/style/karmaşık geometri ve efektlerde güvenli raster fallback
- Çoklu sayfa sahne düzenleme (ScratchJr uyumluluğu için en fazla 4 sayfa)
- Metin, boyut, konum ve yön düzenleme
- Ses yükleme, kayıt ve kırpma
- `.sjr` içe/dışa aktarma
- Import edilmiş projelerde sprite scriptleri, sprite-başına ses ilişkileri, layer sırası ve bilinmeyen metadata alanlarını koruma
- Undo / redo
- IndexedDB tabanlı otomatik kayıt; “Değişiklik var / Kaydediliyor / Kaydedildi” durum göstergesi ve hata bildirimi
- Thumbnail cache + debounce ile drag, text/color ve resize işlemlerinde daha düşük render maliyeti
- İçe/dışa aktarma aşama göstergesi ve gerçek ZIP sıkıştırma yüzdesi
- Modal focus trap, ESC/focus-return yönetimi ve ok tuşlarıyla sekme gezinmesi
- Telefon/tablet için yatay sayfa şeridi, tek sütun sahne düzeni ve büyütülmüş touch hedefleri
- Klavye ve dokunmatik kullanım iyileştirmeleri
- Görsel, ses ve .sjr importlarında boyut/arşiv güvenlik sınırları
- İçe aktarma doğrulaması: bozuk metadata, eksik/belirsiz asset ve duplicate basename raporu
- AudioContext / kayıt Blob URL yaşam döngüsü temizliği
- GitHub Pages için offline service worker cache'i

## Dosya yapısı

- `index.html`: uygulama iskeleti
- `app.css`: tüm stiller
- `app.js`: uygulama state'i, sahne, ses, import/export ve autosave akışları
- `roundtrip-utils.mjs`: test edilebilir ScratchJr round-trip yardımcıları
- `ui-utils.mjs`: ortak dialog focus trap/focus-return ve işlem progress altyapısı
- `file-utils.mjs`: UTF-8 base64, FileReader, image/SVG ve küçük dosya yardımcıları
- `tests/`: metadata, import doğrulama, güvenlik, offline, ses/layer, performans regresyonları ve gerçek-dünya ScratchJr archive fixture testleri
- `.github/workflows/ci.yml`: syntax + Node testleri ve gerçek headless Chrome smoke testi

## Çalıştırma

Statik dosyaları herhangi bir HTTP sunucusundan servis etmek yeterlidir. GitHub Pages ile doğrudan çalışabilir.

JSZip 3.10.1, SparkMD5 3.0.2 ve ImageTracer 1.2.6 `vendor/` altında yerel olarak tutulur; runtime sırasında CDN veya Google Fonts isteği yapılmaz. Üçüncü taraf lisans/notis bilgileri `THIRD_PARTY_NOTICES.md` altındadır.

GitHub Pages'te çevrimdışı yeniden açma için sayfayı en az bir kez çevrimiçi ve başarılı şekilde yüklemek gerekir; service worker çekirdek uygulama dosyalarını cache'e alır. Repo yerel bir statik HTTP sunucusundan servis edildiğinde de internet bağlantısı gerekmez.

## Test

Node.js ile ek bağımlılık kurmadan:

```bash
npm run check
npm test
# Node regresyonlarının tamamı:
npm run ci
# Chrome/Chromium kurulu bir ortamda gerçek browser smoke:
npm run smoke:browser
```

Testler; fixture tabanlı script/metadata koruması, gerçek-dünya ScratchJr alanlarıyla oluşturulan .sjr ZIP round-trip'i, import path traversal/duplicate basename kontrolleri, bozuk ScratchJr metadata doğrulaması, sprite-başına ses ilişkileri, aktif sayfa, layer sırası, SVG fallback politikası, CSP/offline runtime, service worker, audio lifecycle, thumbnail cache/debounce, import/export progress, dialog focus yönetimi, keyboard tab navigation ve responsive touch kurallarını kontrol eder.

## ScratchJr uyumluluğu

Editör 480×360 ScratchJr sahne koordinat sistemini kullanır ve sayfa sayısını 4 ile sınırlar. Yeni karakter SVG'lerinde yalnızca doğrudan normalize edilmesi güvenli görülen path/circle/polygon tabanlı yapılar vektör tutulur. Arc komutları, transform, root-level inherited stiller, CSS style, non-zero viewBox origin, rect/ellipse/line/polyline/text/use, clip/mask/filter/gradient/pattern gibi karmaşık yapılar görünümü korumak için otomatik raster fallback yoluna alınır. Harici http(s) kaynak referansı içeren SVG'ler offline çalışma nedeniyle reddedilir.


## Browser smoke testi

CI, ek Playwright/Puppeteer bağımlılığı kurmadan GitHub Ubuntu runner'ındaki gerçek headless Chrome'u kullanır. Küçük bir yerel HTTP sunucusu üzerinden uygulamayı açar ve ES module'ların yüklenmesini, boot'un tamamlanmasını, ilk sayfanın çizilmesini, autosave durumunun hazır olmasını ve temel tab/panel DOM'unu doğrular.
