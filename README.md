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
- IndexedDB tabanlı otomatik kayıt; kayıt hataları kullanıcıya bildirilir
- Klavye ve dokunmatik kullanım iyileştirmeleri
- Görsel, ses ve .sjr importlarında boyut/arşiv güvenlik sınırları
- AudioContext / kayıt Blob URL yaşam döngüsü temizliği
- GitHub Pages için offline service worker cache'i

## Dosya yapısı

- `index.html`: uygulama iskeleti
- `app.css`: tüm stiller
- `app.js`: UI, sahne, ses, import/export ve autosave akışları
- `roundtrip-utils.mjs`: test edilebilir ScratchJr round-trip yardımcıları
- `tests/`: metadata, ses/layer ve kritik kaynak regresyon testleri

## Çalıştırma

Statik dosyaları herhangi bir HTTP sunucusundan servis etmek yeterlidir. GitHub Pages ile doğrudan çalışabilir.

JSZip 3.10.1, SparkMD5 3.0.2 ve ImageTracer 1.2.6 `vendor/` altında yerel olarak tutulur; runtime sırasında CDN veya Google Fonts isteği yapılmaz. Üçüncü taraf lisans/notis bilgileri `THIRD_PARTY_NOTICES.md` altındadır.

GitHub Pages'te çevrimdışı yeniden açma için sayfayı en az bir kez çevrimiçi ve başarılı şekilde yüklemek gerekir; service worker çekirdek uygulama dosyalarını cache'e alır. Repo yerel bir statik HTTP sunucusundan servis edildiğinde de internet bağlantısı gerekmez.

## Test

Node.js ile ek bağımlılık kurmadan:

```bash
npm test
```

Testler; fixture tabanlı script/metadata koruması, sprite-başına ses ilişkileri, aktif sayfa, layer sırası, imported raster/vector arkaplan seçimi, SVG arc/karmaşık yapı fallback politikası, offline runtime bağımlılıkları, service worker cache listesi, audio lifecycle ve kritik kaynak regresyonlarını kontrol eder.

## ScratchJr uyumluluğu

Editör 480×360 ScratchJr sahne koordinat sistemini kullanır ve sayfa sayısını 4 ile sınırlar. Yeni karakter SVG'lerinde yalnızca doğrudan normalize edilmesi güvenli görülen path/circle/polygon tabanlı yapılar vektör tutulur. Arc komutları, transform, root-level inherited stiller, CSS style, non-zero viewBox origin, rect/ellipse/line/polyline/text/use, clip/mask/filter/gradient/pattern gibi karmaşık yapılar görünümü korumak için otomatik raster fallback yoluna alınır. Harici http(s) kaynak referansı içeren SVG'ler offline çalışma nedeniyle reddedilir.
