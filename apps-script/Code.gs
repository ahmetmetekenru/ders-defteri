// Ders Defteri eşitleme sunucusu.
// Notlar, senin Google Drive'ında "Ders Defteri Verisi" klasöründe saklanır:
//   index.json  -> dersler ve her sayfanın son değişiklik zamanı
//   pg-*.json   -> her A4 sayfası ayrı dosya
// Anahtar (SYNC_KEY) secret.gs dosyasında durur ve GitHub'a yüklenmez.

const FOLDER_NAME = "Ders Defteri Verisi";

function doGet() {
  return ContentService.createTextOutput("Ders Defteri eşitleme sunucusu çalışıyor.");
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ error: "bad_request" });
  }
  if (!req || req.key !== SYNC_KEY) return reply({ error: "key" });

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    return reply(handleSync(req));
  } catch (err) {
    return reply({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function handleSync(req) {
  const folder = getFolder();
  const index = readIndex(folder);
  const now = Date.now();

  // Dersler: hangisi daha yeni değiştirildiyse o kalır
  (req.lessons || []).forEach(function (l) {
    const cur = index.lessons[l.id];
    if (!cur || l.updated > cur.updated) {
      index.lessons[l.id] = {
        id: l.id, name: l.name, color: l.color, pages: l.pages || [],
        order: l.order || 0, updated: l.updated, deleted: !!l.deleted, serverTime: now
      };
    }
  });

  // Sayfalar
  (req.pages || []).forEach(function (p) {
    const cur = index.pages[p.id];
    if (cur && cur.deleted) return;
    if (cur && cur.updated >= p.updated) return;
    const body = JSON.stringify({ id: p.id, html: p.html || "", strokes: p.strokes || [], style: p.style || "lined", updated: p.updated });
    let fileId = cur && cur.fileId;
    if (fileId) {
      DriveApp.getFileById(fileId).setContent(body);
    } else {
      fileId = folder.createFile(p.id + ".json", body, "application/json").getId();
    }
    index.pages[p.id] = { updated: p.updated, fileId: fileId, serverTime: now };
  });

  // Silinen sayfalar çöp kutusuna gider (30 gün içinde Drive'dan geri alınabilir)
  (req.deleted || []).forEach(function (id) {
    const cur = index.pages[id];
    if (cur && cur.fileId) {
      try { DriveApp.getFileById(cur.fileId).setTrashed(true); } catch (err) {}
    }
    index.pages[id] = { deleted: true, updated: now, serverTime: now };
  });

  writeIndex(folder, index);

  // Bu cihazın son eşitlemesinden sonra değişenleri geri gönder
  const since = Number(req.since) || 0;
  const lessons = [];
  Object.keys(index.lessons).forEach(function (id) {
    const l = index.lessons[id];
    if (l.serverTime > since) lessons.push(l);
  });
  const pages = [];
  const deleted = [];
  Object.keys(index.pages).forEach(function (id) {
    const p = index.pages[id];
    if (p.serverTime <= since) return;
    if (p.deleted) { deleted.push(id); return; }
    try { pages.push(JSON.parse(DriveApp.getFileById(p.fileId).getBlob().getDataAsString())); } catch (err) {}
  });

  return { now: now, lessons: lessons, pages: pages, deleted: deleted };
}

function getFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("folderId");
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) {}
  }
  const folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty("folderId", folder.getId());
  return folder;
}

function readIndex(folder) {
  const files = folder.getFilesByName("index.json");
  if (!files.hasNext()) return { lessons: {}, pages: {} };
  const data = JSON.parse(files.next().getBlob().getDataAsString());
  return { lessons: data.lessons || {}, pages: data.pages || {} };
}

function writeIndex(folder, index) {
  const body = JSON.stringify(index);
  const files = folder.getFilesByName("index.json");
  if (files.hasNext()) files.next().setContent(body);
  else folder.createFile("index.json", body, "application/json");
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Kurulumdan sonra bir kez editörde çalıştırılırsa Drive izni verilir ve klasör oluşturulur
function setup() {
  Logger.log("Klasör: " + getFolder().getUrl());
}
