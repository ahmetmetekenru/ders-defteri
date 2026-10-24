# Ders Defteri

Tablet, telefon ve bilgisayar için siyah A4 sayfalı ders defteri.

- Uygulama GitHub Pages'te durur ve internetsiz çalışır. Notlar önce cihaza (IndexedDB) kaydedilir.
- İnternet gelince notlar Google Apps Script üzerinden sahibinin Google Drive'ındaki "Ders Defteri Verisi" klasörüne eşitlenir.
- `apps-script/` eşitleme sunucusunun kodu. Anahtar `secret.gs` dosyasındadır ve repoya konmaz.

## Güncelleme

- Uygulama dosyası değişince `sw.js` içindeki `CACHE` sürümünü artır, sonra commit ve push.
- Sunucu kodu değişince `apps-script` klasöründe: `clasp push -f`, sonra `clasp update-deployment <id>`.
