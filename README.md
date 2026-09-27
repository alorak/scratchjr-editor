# scratchjr-editor

Tarayıcıda çalışan, ScratchJr `.sjr` projelerini oluşturmak, içe aktarmak, düzenlemek ve yeniden dışa aktarmak için hafif bir editör.

## Özellikler

- Karakter ve arkaplan görselleri ekleme
- SVG uyumluluk analizi ve güvenli raster fallback
- Çoklu sayfa sahne düzenleme (ScratchJr uyumluluğu için en fazla 4 sayfa)
- Metin, boyut, konum ve yön düzenleme
- Ses yükleme, kayıt ve kırpma
- `.sjr` içe/dışa aktarma
- Import edilmiş projelerde sprite scriptleri, sprite-başına ses ilişkileri, layer sırası ve bilinmeyen metadata alanlarını koruma
- Undo / redo
- IndexedDB tabanlı otomatik kayıt
- Klavye ve dokunmatik kullanım iyileştirmeleri

## Dosya yapısı

- `index.html`: uygulama iskeleti
- `app.css`: tüm stiller
- `app.js`: UI, sahne, ses, import/export ve autosave akışları
- `roundtrip-utils.mjs`: test edilebilir ScratchJr round-trip yardımcıları
- `tests/`: metadata, ses/layer ve kritik kaynak regresyon testleri

## Çalıştırma

Statik dosyaları herhangi bir HTTP sunucusundan servis etmek yeterlidir. GitHub Pages ile doğrudan çalışabilir.

Harici kütüphaneler (JSZip, SparkMD5 ve gerektiğinde ImageTracer) CDN üzerinden yüklenir.

## Test

Node.js ile ek bağımlılık kurmadan:

```bash
npm test
```

Testler; script/metadata koruması, sprite-başına ses ilişkileri, layer sırası, transform algılama ve kritik kaynak regresyonlarını kontrol eder.

## ScratchJr uyumluluğu

Editör 480×360 ScratchJr sahne koordinat sistemini kullanır ve sayfa sayısını 4 ile sınırlar. Transform içeren harici SVG'ler görsel bozulmayı önlemek için destrüktif biçimde flatten edilmek yerine güvenli raster fallback yoluna alınır.
