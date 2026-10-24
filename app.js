"use strict";

const COLORS = [
  { name: "Beyaz", v: "#ecebe6" },
  { name: "Sarı", v: "#ffd84d" },
  { name: "Turuncu", v: "#ff9f43" },
  { name: "Kırmızı", v: "#ff5c5c" },
  { name: "Pembe", v: "#ff7ac6" },
  { name: "Mor", v: "#b48cff" },
  { name: "Mavi", v: "#5aa9ff" },
  { name: "Turkuaz", v: "#3ee0d0" },
  { name: "Yeşil", v: "#7bdc65" },
  { name: "Gri", v: "#8e8d95" }
];
const PAPER_NAMES = { lined: "Çizgili", grid: "Kareli", dots: "Noktalı", plain: "Düz" };
// Çizimler sayfa genişliği 1000 birim olacak şekilde saklanır; her ekranda aynı yerde durur
const UNIT_W = 1000;
const UNIT_H = Math.round(1000 * 297 / 210);
const MAX_DPR = 2;
const SYNC_URL = (window.DD_CONFIG && window.DD_CONFIG.syncUrl) || "";

const STARTER_HTML =
  '<h1><span style="color:#ffd84d">Türev</span></h1>' +
  '<h2>Temel kurallar</h2>' +
  '<p>Bu örnek bir ders. Soldan kendi derslerini ekleyebilir, bunu “⋯” menüsünden silebilirsin.</p>' +
  '<ul><li>(xⁿ)′ = n · xⁿ⁻¹</li><li>(sin x)′ = cos x</li></ul>' +
  '<h1><span style="color:#5aa9ff">İntegral</span></h1>' +
  '<h2>Belirsiz integral</h2>' +
  '<p><span style="color:#3ee0d0">∫ xⁿ dx = xⁿ⁺¹ / (n+1) + C</span></p>' +
  '<p>Sayfa dolunca yazı kendiliğinden yeni A4 sayfasına geçer. Kalem aracıyla sayfaya elle de yazabilirsin.</p>';

const state = {
  lessons: [],          // görünen dersler, sıralı
  activeId: null,
  current: null,
  mode: "text",
  color: COLORS[0].v,
  width: 4,
  penSeen: false,
  zoom: 1
};
const lessonMap = new Map();   // silinmiş dersler dahil hepsi
const pageCache = new Map();
const undoStack = [];

const $ = (s) => document.querySelector(s);
const scroller = $("#scroller");
const pagesEl = $("#pages");

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function activeLesson() {
  return state.lessons.find((l) => l.id === state.activeId) || null;
}
function lessonOfPage(page) {
  return state.lessons.find((l) => l.pages.includes(page.id)) || null;
}
function remember(key, value) {
  try { localStorage.setItem("dd-" + key, value); } catch (e) {}
}
function recall(key) {
  try { return localStorage.getItem("dd-" + key); } catch (e) { return null; }
}

/* ================= Cihazdaki kayıt (IndexedDB) ================= */

const idb = (() => {
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("ders-defteri", 1);
        req.onupgradeneeded = () => {
          ["lessons", "pages", "kv"].forEach((n) => req.result.createObjectStore(n));
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    get: (store, key) => run(store, "readonly", (s) => s.get(key)),
    put: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)),
    del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
    all: (store) => run(store, "readonly", (s) => s.getAll())
  };
})();

// Sunucuya henüz gitmemiş değişiklikler: "l:<ders>", "p:<sayfa>", "d:<silinen sayfa>"
let pending = new Set();
let pendingTimer = null;
function markPending(key) {
  pending.add(key);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => idb.put("kv", "pending", [...pending]).catch(() => {}), 300);
  renderSync();
  scheduleSync();
}

function lessonRecord(l) {
  return { id: l.id, name: l.name, color: l.color, pages: l.pages.slice(), order: l.order, updated: l.updated, deleted: !!l.deleted };
}

function lessonChanged(lesson) {
  if (lesson.example) { lesson.example = false; persistExamplePages(lesson); }
  lesson.updated = Date.now();
  idb.put("lessons", lesson.id, lessonRecord(lesson)).catch(storageError);
  markPending("l:" + lesson.id);
}

// Örnek ders ilk değişiklikte gerçek derse dönüşür
function persistExamplePages(lesson) {
  lesson.pages.forEach((id) => { const p = pageCache.get(id); if (p) schedulePageSave(p); });
}

function schedulePageSave(page) {
  page.updated = Date.now();
  page.dirty = true;
  clearTimeout(page.timer);
  page.timer = setTimeout(() => savePageLocal(page), 600);
  const lesson = lessonOfPage(page);
  if (lesson && lesson.example) lessonChanged(lesson);
}

function savePageLocal(page) {
  clearTimeout(page.timer);
  page.timer = null;
  if (page.built) page.html = page.content.innerHTML; // HTML yalnızca kayıt anında okunur, her tuşta değil
  page.dirty = false;
  const rec = { id: page.id, html: page.html, strokes: page.strokes, style: page.style, updated: page.updated };
  idb.put("pages", page.id, rec).catch(storageError);
  markPending("p:" + page.id);
}

function flushLocal() {
  pageCache.forEach((p) => { if (p.timer) savePageLocal(p); });
}

function storageError() {
  setSyncLine("err", "Cihaza kaydedilemedi. Depolama dolu olabilir.");
}

/* ================= Eşitleme (Google Apps Script) ================= */

let syncKey = recall("key") || "";
let syncing = false;
let syncTimer = null;
let lastSyncAt = Number(recall("lastSync")) || 0;
let syncError = "";

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay == null ? 4000 : delay);
}

// Google ara sıra JSON yerine hata sayfası döndürüyor; bir kez daha denenir
async function postJSON(body) {
  try { return await postOnce(body); }
  catch (e) { await new Promise((r) => setTimeout(r, 2000)); return postOnce(body); }
}

async function postOnce(body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    // text/plain: tarayıcı ön kontrol isteği göndermez, Apps Script bunu kabul eder
    const res = await fetch(SYNC_URL, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("http " + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function sync() {
  if (syncing || !SYNC_URL || !syncKey) { renderSync(); return; }
  if (!navigator.onLine) { renderSync(); return; }
  syncing = true;
  syncError = "";
  renderSync();
  try {
    flushLocal();
    const keys = [...pending];
    const lessons = [], pages = [], deleted = [];
    for (const k of keys) {
      const id = k.slice(2);
      if (k[0] === "l") { const r = await idb.get("lessons", id); if (r) lessons.push(r); }
      else if (k[0] === "p") { const r = await idb.get("pages", id); if (r) pages.push(r); }
      else if (k[0] === "d") deleted.push(id);
    }
    const since = Number(await idb.get("kv", "since")) || 0;
    const res = await postJSON({ key: syncKey, since, lessons, pages, deleted });
    if (res.error === "key") {
      syncKey = "";
      remember("key", "");
      syncError = "Anahtar yanlış. Yeniden gir.";
      return;
    }
    if (res.error) throw new Error(res.error);

    // Gönderdiklerimiz o arada yeniden değişmediyse bekleyenlerden çıkar
    lessons.forEach((r) => { const l = lessonMap.get(r.id); if (!l || l.updated === r.updated) pending.delete("l:" + r.id); });
    pages.forEach((r) => { const p = pageCache.get(r.id); if (!p || (p.updated === r.updated && !p.dirty)) pending.delete("p:" + r.id); });
    deleted.forEach((id) => pending.delete("d:" + id));
    await idb.put("kv", "pending", [...pending]);

    await applyRemote(res);
    await idb.put("kv", "since", res.now);
    lastSyncAt = Date.now();
    remember("lastSync", String(lastSyncAt));
  } catch (e) {
    syncError = navigator.onLine ? "Eşitlenemedi, sonra yeniden denenecek." : "";
  } finally {
    syncing = false;
    renderSync();
    if (pending.size && !syncError) scheduleSync(1500);
  }
}

async function applyRemote(res) {
  let lessonsChanged = false;
  for (const r of res.lessons || []) {
    const local = lessonMap.get(r.id);
    if (local && local.updated >= r.updated) continue;
    if (pending.has("l:" + r.id) && local && local.updated > r.updated) continue;
    const l = { id: r.id, name: r.name, color: r.color, pages: (r.pages || []).slice(), order: r.order || 0, updated: r.updated, deleted: !!r.deleted };
    lessonMap.set(l.id, l);
    await idb.put("lessons", l.id, lessonRecord(l));
    lessonsChanged = true;
  }

  for (const r of res.pages || []) {
    const cached = pageCache.get(r.id);
    const localUpdated = cached ? cached.updated : ((await idb.get("pages", r.id)) || {}).updated || 0;
    if (localUpdated >= r.updated) continue;
    await idb.put("pages", r.id, { id: r.id, html: r.html, strokes: r.strokes, style: r.style, updated: r.updated });
    if (cached) {
      if (cached.dirty || (cached.built && document.activeElement === cached.content)) continue;
      cached.html = r.html || "";
      cached.strokes = normStrokes(r.strokes);
      cached.style = r.style || "lined";
      cached.updated = r.updated;
      if (cached.built) {
        cached.content.innerHTML = cached.html || "<p><br></p>";
        applyPaper(cached);
        requestRedraw(cached);
      }
    }
  }

  for (const id of res.deleted || []) {
    await idb.del("pages", id).catch(() => {});
    const p = pageCache.get(id);
    if (p) { removePageDom(p); pageCache.delete(id); }
  }

  // Örnek ders, gerçek dersler gelince kaldırılır
  if (lessonsChanged) {
    state.lessons.filter((l) => l.example).forEach((l) => lessonMap.delete(l.id));
    refreshLessonList();
  }
  const lesson = activeLesson();
  if (!lesson) { await openLesson(state.lessons[0] ? state.lessons[0].id : null); return; }
  const shown = [...pagesEl.children].map((w) => w._pageId).join(",");
  if (shown !== lesson.pages.join(",")) await openLesson(lesson.id, { keepScroll: true });
  else { labelPages(); buildOutline(); }
}

function refreshLessonList() {
  state.lessons = [...lessonMap.values()].filter((l) => !l.deleted).sort((a, b) => (a.order || 0) - (b.order || 0));
  renderLessons();
  renderChip();
}

function setSyncLine(kind, text) {
  syncError = kind === "err" ? text : syncError;
  renderSync();
}

let keyFormOpen = false;
function renderSync() {
  const box = $("#syncBox");
  if (!box) return;
  box.replaceChildren();
  const line = document.createElement("div");
  line.className = "sync-line";
  const led = document.createElement("span");
  led.className = "led";
  const txt = document.createElement("span");
  txt.className = "grow";
  line.append(led, txt);

  const waiting = pending.size;
  if (!SYNC_URL) { txt.textContent = "Bu cihazda kaydediliyor"; }
  else if (!syncKey) { txt.textContent = "Bu cihazda kaydediliyor · eşitleme kapalı"; }
  else if (syncError) { line.classList.add("err"); txt.textContent = syncError; }
  else if (syncing) { line.classList.add("wait"); txt.textContent = "Eşitleniyor…"; }
  else if (!navigator.onLine) { line.classList.add("wait"); txt.textContent = "Çevrimdışı · " + (waiting ? waiting + " değişiklik bekliyor" : "her şey cihazda"); }
  else if (waiting) { line.classList.add("wait"); txt.textContent = waiting + " değişiklik bekliyor"; }
  else { line.classList.add("ok"); txt.textContent = lastSyncAt ? "Eşitlendi " + new Date(lastSyncAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "Eşitlendi"; }

  if (SYNC_URL && syncKey) {
    const now = document.createElement("button");
    now.type = "button";
    now.className = "mini";
    now.textContent = "Eşitle";
    now.addEventListener("click", () => { syncError = ""; sync(); });
    line.append(now);
  }
  box.append(line);

  if (SYNC_URL && (!syncKey || keyFormOpen)) {
    const ed = document.createElement("div");
    ed.className = "editor";
    ed.style.padding = "0";
    const input = document.createElement("input");
    input.type = "password";
    input.id = "syncKeyInput";
    input.placeholder = "Eşitleme anahtarı";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Eşitleme anahtarı");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tb";
    btn.textContent = "Cihazı bağla";
    const go = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      syncKey = v;
      remember("key", v);
      keyFormOpen = false;
      syncError = "";
      sync();
    };
    btn.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    ed.append(input, btn);
    box.append(ed);
  }
}

window.addEventListener("online", () => { renderSync(); scheduleSync(500); });
window.addEventListener("offline", renderSync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { flushLocal(); if (pending.size) sync(); }
  else scheduleSync(300);
});
window.addEventListener("pagehide", flushLocal);
setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);

/* ================= Sayfa verisi ================= */

function normStrokes(list) {
  return (list || []).map((st) => ({ c: st.c, w: st.w, p: st.p.slice() }));
}

function pageFromData(id, d) {
  d = d || {};
  return {
    id,
    html: d.html || "",
    strokes: normStrokes(d.strokes),
    style: d.style || "lined",
    updated: d.updated || 0,
    timer: null, built: false, visible: false, dirty: false
  };
}

async function ensurePagesLoaded(lesson) {
  const missing = lesson.pages.filter((id) => !pageCache.has(id));
  const datas = await Promise.all(missing.map((id) => idb.get("pages", id).catch(() => null)));
  missing.forEach((id, i) => pageCache.set(id, pageFromData(id, datas[i])));
}

/* ================= Sayfa görünümü ================= */

let visObserver = null;
let sizeObserver = null;

function buildPage(page) {
  if (page.built) return page;
  const wrap = document.createElement("section");
  wrap.className = "page-wrap";
  wrap._pageId = page.id;
  const bar = document.createElement("div");
  bar.className = "page-bar";
  const label = document.createElement("span");
  const actions = document.createElement("div");
  actions.className = "actions";
  bar.append(label, actions);

  const sheet = document.createElement("div");
  sheet.className = "page";
  const tag = document.createElement("div");
  tag.className = "page-tag";
  const content = document.createElement("div");
  content.className = "content";
  content.contentEditable = "true";
  content.spellcheck = true;
  content.innerHTML = page.html || "<p><br></p>";
  const canvas = document.createElement("canvas");
  canvas.className = "ink";
  canvas.width = 0;
  canvas.height = 0;
  sheet.append(tag, content, canvas);
  wrap.append(bar, sheet);

  Object.assign(page, { wrap, label, actions, sheet, tag, content, canvas, ctx: canvas.getContext("2d"), built: true });
  sheet._page = page;
  applyPaper(page);

  content.addEventListener("input", () => afterEdit(page));
  content.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  });
  content.addEventListener("focus", () => { setCurrent(page); if (state.mode !== "text") setMode("text"); });

  setupInk(page);
  renderPageActions(page, false);
  visObserver.observe(sheet);
  sizeObserver.observe(sheet);
  return page;
}

function removePageDom(page) {
  if (!page.built) return;
  visObserver.unobserve(page.sheet);
  sizeObserver.unobserve(page.sheet);
  page.wrap.remove();
  if (state.current === page) state.current = null;
}

function applyPaper(page) {
  page.sheet.classList.remove("paper-lined", "paper-grid", "paper-dots", "paper-plain");
  page.sheet.classList.add("paper-" + page.style);
}

function renderPageActions(page, confirming) {
  page.actions.replaceChildren();
  if (confirming) {
    const q = document.createElement("span");
    q.textContent = "Sayfa silinsin mi?";
    page.actions.append(q, miniButton("Evet, sil", () => deletePage(page), true), miniButton("Vazgeç", () => renderPageActions(page, false)));
  } else {
    page.actions.append(
      miniButton("+ Altına sayfa", () => addPageAfter(page, true)),
      miniButton("Sil", () => renderPageActions(page, true))
    );
  }
}

function miniButton(text, onClick, danger) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini" + (danger ? " danger" : "");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function labelPages() {
  const lesson = activeLesson();
  if (!lesson) return;
  const total = lesson.pages.length;
  lesson.pages.forEach((id, i) => {
    const p = pageCache.get(id);
    if (!p || !p.built) return;
    p.label.textContent = "Sayfa " + (i + 1) + " / " + total + " · A4";
    p.tag.textContent = lesson.name + " · " + (i + 1);
    p.sheet.style.setProperty("--lesson", lesson.color);
  });
}

function setCurrent(page) {
  if (state.current === page) return;
  if (state.current && state.current.built) state.current.wrap.classList.remove("current");
  state.current = page;
  if (page && page.built) page.wrap.classList.add("current");
  $("#paperStyle").value = page ? page.style : "lined";
}

let openToken = 0;
async function openLesson(id, opts) {
  opts = opts || {};
  const token = ++openToken;
  const keepTop = scroller.scrollTop;
  state.activeId = id;
  remember("active", id || "");
  if (!opts.keepScroll) undoStack.length = 0;
  const lesson = activeLesson();
  renderLessons();
  renderChip();
  if (!opts.keepScroll) closeSide();
  if (!lesson) { showEmpty(true); return; }
  showEmpty(false);
  if (!opts.keepScroll) { $("#loading").hidden = false; pagesEl.replaceChildren(); }
  await ensurePagesLoaded(lesson);
  if (token !== openToken) return;
  if (!lesson.pages.length) {
    const p = pageFromData(newId("pg-"), {});
    pageCache.set(p.id, p);
    lesson.pages.push(p.id);
    lessonChanged(lesson);
    schedulePageSave(p);
  }
  $("#loading").hidden = true;
  const pages = lesson.pages.map((pid) => buildPage(pageCache.get(pid)));
  pagesEl.replaceChildren(...pages.map((p) => p.wrap));
  const cur = state.current && pages.includes(state.current) ? state.current : pages[0];
  state.current = null;
  setCurrent(cur);
  labelPages();
  if (opts.keepScroll) scroller.scrollTop = keepTop;
  else { scroller.scrollTop = 0; scroller.scrollLeft = 0; }
  buildOutline();
}

function showEmpty(on) {
  $("#empty").hidden = !on;
  $("#loading").hidden = true;
  if (on) pagesEl.replaceChildren();
}

// Yeni sayfa, üstündeki sayfanın kâğıt tipini alır
function addPageAfter(page, focus) {
  const lesson = activeLesson();
  if (!lesson) return null;
  const idx = page ? lesson.pages.indexOf(page.id) : lesson.pages.length - 1;
  const above = idx >= 0 ? pageCache.get(lesson.pages[idx]) : null;
  const p = pageFromData(newId("pg-"), { style: above ? above.style : "lined" });
  pageCache.set(p.id, p);
  lesson.pages.splice(idx + 1, 0, p.id);
  buildPage(p);
  const ref = lesson.pages[idx + 2] ? pageCache.get(lesson.pages[idx + 2]) : null;
  if (ref && ref.built && ref.wrap.isConnected) pagesEl.insertBefore(p.wrap, ref.wrap); else pagesEl.append(p.wrap);
  labelPages();
  renderLessonCount();
  lessonChanged(lesson);
  schedulePageSave(p);
  if (focus) {
    setCurrent(p);
    p.wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    placeCaretAtStart(p.content);
  }
  return p;
}

function deletePage(page) {
  const lesson = lessonOfPage(page);
  if (!lesson) return;
  clearTimeout(page.timer);
  lesson.pages = lesson.pages.filter((id) => id !== page.id);
  pageCache.delete(page.id);
  removePageDom(page);
  if (!lesson.pages.length) addPageAfter(null, false);
  if (!state.current) setCurrent(pageCache.get(lesson.pages[0]));
  labelPages();
  renderLessonCount();
  buildOutline();
  lessonChanged(lesson);
  idb.del("pages", page.id).catch(() => {});
  pending.delete("p:" + page.id);
  markPending("d:" + page.id);
}

function placeCaretAtStart(el) {
  el.focus({ preventScroll: true });
  const r = document.createRange();
  r.selectNodeContents(el.firstElementChild || el);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function afterEdit(page) {
  const c = page.content;
  if (!c.firstChild) c.innerHTML = "<p><br></p>";
  fixOverflow(page);
  schedulePageSave(page);
  scheduleOutline();
}

// Sayfa dolunca taşan paragraflar bir sonraki A4 sayfasına geçer (yoksa yenisi açılır)
function fixOverflow(page) {
  const c = page.content;
  if (c.scrollHeight <= c.clientHeight + 2) return;
  const lesson = lessonOfPage(page);
  if (!lesson) return;
  let next = null;
  let guard = 0;
  while (c.scrollHeight > c.clientHeight + 2 && c.children.length > 1 && guard++ < 60) {
    const idx = lesson.pages.indexOf(page.id);
    const nextId = lesson.pages[idx + 1];
    next = nextId ? buildPage(pageCache.get(nextId)) : addPageAfter(page, false);
    const last = c.lastElementChild;
    const sel = getSelection();
    const caretInside = sel.rangeCount > 0 && last.contains(sel.anchorNode);
    const node = sel.anchorNode, offset = sel.anchorOffset;
    if (next.content.children.length <= 1 && next.content.textContent.trim() === "") next.content.replaceChildren();
    next.content.prepend(last);
    if (caretInside) {
      next.content.focus({ preventScroll: true });
      const r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      setCurrent(next);
      next.sheet.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  if (next) { schedulePageSave(next); fixOverflow(next); }
}

/* ================= Sol panel ================= */

let editingLessonId = null;
let confirmDeleteLesson = false;

function renderLessons() {
  const nav = $("#lessons");
  nav.replaceChildren();
  if (!state.lessons.length) {
    const hint = document.createElement("div");
    hint.className = "o-hint";
    hint.textContent = "Henüz ders yok.";
    nav.append(hint);
  }
  state.lessons.forEach((lesson) => {
    const box = document.createElement("div");
    box.className = "lesson" + (lesson.id === state.activeId ? " active" : "");
    const row = document.createElement("div");
    row.className = "lesson-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lesson-btn";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = lesson.color;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = lesson.name;
    const count = document.createElement("span");
    count.className = "count";
    count.dataset.lesson = lesson.id;
    count.textContent = lesson.pages.length + " sf";
    btn.append(dot, name, count);
    btn.addEventListener("click", () => {
      if (lesson.id === state.activeId) { closeSide(); return; }
      editingLessonId = null;
      openLesson(lesson.id);
    });

    const more = document.createElement("button");
    more.type = "button";
    more.className = "icon-btn";
    more.textContent = "⋯";
    more.setAttribute("aria-label", lesson.name + " dersini düzenle");
    more.addEventListener("click", () => {
      editingLessonId = editingLessonId === lesson.id ? null : lesson.id;
      confirmDeleteLesson = false;
      renderLessons();
    });
    row.append(btn, more);
    box.append(row);

    if (editingLessonId === lesson.id) box.append(lessonEditor(lesson));
    if (lesson.id === state.activeId) {
      const outline = document.createElement("div");
      outline.className = "outline";
      outline.id = "outline";
      box.append(outline);
    }
    nav.append(box);
  });
  buildOutline();
}

function renderLessonCount() {
  state.lessons.forEach((l) => {
    const el = document.querySelector('.count[data-lesson="' + l.id + '"]');
    if (el) el.textContent = l.pages.length + " sf";
  });
}

function renderChip() {
  const lesson = activeLesson();
  const chip = $("#lessonChip");
  chip.replaceChildren();
  if (!lesson) return;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = lesson.color;
  const t = document.createElement("span");
  t.textContent = lesson.name;
  chip.append(dot, t);
}

function colorPicker(selected, onPick) {
  const box = document.createElement("div");
  box.className = "mini-swatches";
  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.background = c.v;
    b.setAttribute("aria-label", c.name);
    b.setAttribute("aria-pressed", String(c.v === selected));
    b.addEventListener("click", () => {
      box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(c.v);
    });
    box.append(b);
  });
  return box;
}

function lessonEditor(lesson) {
  const ed = document.createElement("div");
  ed.className = "editor";
  const input = document.createElement("input");
  input.type = "text";
  input.id = "rename-" + lesson.id;
  input.value = lesson.name;
  input.maxLength = 60;
  input.setAttribute("aria-label", "Ders adı");
  const commit = () => {
    const v = input.value.trim();
    if (v && v !== lesson.name) { lesson.name = v; lessonChanged(lesson); renderLessons(); renderChip(); if (lesson.id === state.activeId) labelPages(); }
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

  const colors = colorPicker(lesson.color, (v) => {
    lesson.color = v;
    lessonChanged(lesson);
    renderChip();
    if (lesson.id === state.activeId) labelPages();
    const dot = ed.parentElement && ed.parentElement.querySelector(".lesson-btn .dot");
    if (dot) dot.style.background = v;
  });

  const row = document.createElement("div");
  row.className = "row";
  if (confirmDeleteLesson) {
    const w = document.createElement("span");
    w.className = "warn grow";
    w.textContent = lesson.pages.length + " sayfa silinecek.";
    const yes = document.createElement("button");
    yes.type = "button"; yes.className = "tb danger"; yes.textContent = "Evet, sil";
    yes.addEventListener("click", () => deleteLesson(lesson));
    const no = document.createElement("button");
    no.type = "button"; no.className = "tb"; no.textContent = "Vazgeç";
    no.addEventListener("click", () => { confirmDeleteLesson = false; renderLessons(); });
    row.append(w, yes, no);
  } else {
    const done = document.createElement("button");
    done.type = "button"; done.className = "tb grow"; done.textContent = "Tamam";
    done.addEventListener("click", () => { commit(); editingLessonId = null; renderLessons(); });
    const del = document.createElement("button");
    del.type = "button"; del.className = "tb danger"; del.textContent = "Dersi sil";
    del.addEventListener("click", () => { confirmDeleteLesson = true; renderLessons(); });
    row.append(done, del);
  }
  ed.append(input, colors, row);
  return ed;
}

function deleteLesson(lesson) {
  const ids = lesson.pages.slice();
  editingLessonId = null;
  confirmDeleteLesson = false;
  ids.forEach((id) => {
    const p = pageCache.get(id);
    if (p) { clearTimeout(p.timer); removePageDom(p); }
    pageCache.delete(id);
    idb.del("pages", id).catch(() => {});
    pending.delete("p:" + id);
    pending.add("d:" + id);
  });
  if (lesson.example) { lessonMap.delete(lesson.id); ids.forEach((id) => pending.delete("d:" + id)); }
  else {
    lesson.deleted = true;
    lesson.pages = [];
    lessonChanged(lesson);
  }
  refreshLessonList();
  if (state.activeId === lesson.id) openLesson(state.lessons[0] ? state.lessons[0].id : null);
}

let newLessonOpen = false;
let newLessonColor = COLORS[1].v;
function renderNewLessonBox() {
  const box = $("#newLessonBox");
  box.replaceChildren();
  if (!newLessonOpen) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tb primary";
    b.style.width = "100%";
    b.textContent = "+ Yeni ders";
    b.addEventListener("click", () => { newLessonOpen = true; renderNewLessonBox(); openSide(); });
    box.append(b);
    return;
  }
  const ed = document.createElement("div");
  ed.className = "editor";
  ed.style.padding = "0";
  const input = document.createElement("input");
  input.type = "text";
  input.id = "newLessonName";
  input.placeholder = "Ders adı, ör. Kimya";
  input.maxLength = 60;
  input.setAttribute("aria-label", "Yeni ders adı");
  const colors = colorPicker(newLessonColor, (v) => { newLessonColor = v; });
  const row = document.createElement("div");
  row.className = "row";
  const add = document.createElement("button");
  add.type = "button"; add.className = "tb primary grow"; add.textContent = "Dersi ekle";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "tb"; cancel.textContent = "Vazgeç";
  const submit = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); input.placeholder = "Önce bir ad yaz"; return; }
    createLesson(name, newLessonColor);
    newLessonOpen = false;
    renderNewLessonBox();
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  cancel.addEventListener("click", () => { newLessonOpen = false; renderNewLessonBox(); });
  row.append(add, cancel);
  ed.append(input, colors, row);
  box.append(ed);
  setTimeout(() => input.focus(), 30);
}

function createLesson(name, color) {
  const p = pageFromData(newId("pg-"), {});
  pageCache.set(p.id, p);
  const lesson = { id: newId("ls-"), name, color, pages: [p.id], order: Date.now(), updated: 0, deleted: false };
  lessonMap.set(lesson.id, lesson);
  lessonChanged(lesson);
  schedulePageSave(p);
  refreshLessonList();
  const unused = COLORS.map((c) => c.v).filter((v) => !state.lessons.some((l) => l.color === v));
  newLessonColor = unused[0] || COLORS[1].v;
  openLesson(lesson.id);
}

let outlineTimer = null;
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(buildOutline, 350);
}

function headingColor(h) {
  const colored = h.querySelector('[style*="color"], font[color]');
  if (colored) return colored.style.color || colored.getAttribute("color");
  return "var(--fg)";
}

function buildOutline() {
  const box = document.getElementById("outline");
  const lesson = activeLesson();
  if (!box || !lesson) return;
  const items = [];
  lesson.pages.forEach((id) => {
    const p = pageCache.get(id);
    if (!p || !p.built) return;
    p.content.querySelectorAll("h1, h2").forEach((h) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "o-item " + (h.tagName === "H1" ? "l1" : "l2");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = headingColor(h);
      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = h.textContent.trim() || "(adsız başlık)";
      b.append(dot, txt);
      b.addEventListener("click", () => { h.scrollIntoView({ behavior: "smooth", block: "center" }); closeSide(); });
      items.push(b);
    });
  });
  if (!items.length) {
    const hint = document.createElement("div");
    hint.className = "o-hint";
    hint.textContent = "Konu başlığı ekleyince burada görünür.";
    items.push(hint);
  }
  box.replaceChildren(...items);
}

function openSide() {
  $("#side").classList.add("open");
  $("#scrim").classList.add("show");
}
function closeSide() {
  $("#side").classList.remove("open");
  $("#scrim").classList.remove("show");
}
$("#toggleSide").addEventListener("click", openSide);
$("#scrim").addEventListener("click", closeSide);
$("#emptyAdd").addEventListener("click", () => { newLessonOpen = true; renderNewLessonBox(); openSide(); });

/* ================= Yazı araçları ================= */

let savedRange = null;
document.addEventListener("selectionchange", () => {
  const s = getSelection();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  if (node && node.closest && node.closest(".content")) savedRange = r.cloneRange();
});

function restoreSelection() {
  if (!savedRange) return null;
  const node = savedRange.startContainer.nodeType === 1 ? savedRange.startContainer : savedRange.startContainer.parentElement;
  const content = node && node.isConnected ? node.closest(".content") : null;
  if (!content) return null;
  content.focus({ preventScroll: true });
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(savedRange);
  return content;
}

function pageOfContent(content) {
  const sheet = content.parentElement;
  return sheet ? sheet._page : null;
}

function hint(text) {
  syncError = "";
  const line = document.querySelector(".sync-line .grow");
  if (line) line.textContent = text;
}

function runCommand(name, value) {
  const content = restoreSelection();
  if (!content) { hint("Önce sayfada bir yere dokun."); return; }
  document.execCommand("styleWithCSS", false, true);
  document.execCommand(name, false, value);
  const page = pageOfContent(content);
  if (page) afterEdit(page);
}

function setBlock(tag) {
  const content = restoreSelection();
  if (!content) { hint("Önce sayfada bir yere dokun."); return; }
  const current = (document.queryCommandValue("formatBlock") || "").toLowerCase();
  document.execCommand("formatBlock", false, "<" + (current === tag ? "p" : tag) + ">");
  const page = pageOfContent(content);
  if (page) afterEdit(page);
}

// Araç çubuğuna dokununca yazıdaki seçim kaybolmasın
$("#toolbar").addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) e.preventDefault();
});
document.querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", () => setBlock(b.dataset.block)));
document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => runCommand(b.dataset.cmd)));

function buildSwatches() {
  const box = $("#swatches");
  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.backgroundColor = c.v;
    b.title = c.name;
    b.setAttribute("aria-label", c.name);
    b.setAttribute("aria-pressed", String(c.v === state.color));
    b.addEventListener("click", () => {
      state.color = c.v;
      box.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-pressed", String(s === b)));
      if (state.mode === "eraser") setMode("pen");
      if (state.mode === "text") runCommand("foreColor", c.v);
    });
    box.append(b);
  });
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.remove("mode-text", "mode-pen", "mode-eraser");
  document.body.classList.add("mode-" + mode);
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  $("#textTools").hidden = mode !== "text";
  $("#penTools").hidden = mode === "text";
  if (mode !== "text" && document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function setWidth(w) {
  state.width = w;
  document.querySelectorAll("[data-width]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.width) === w)));
}
document.querySelectorAll("[data-width]").forEach((b) => b.addEventListener("click", () => { setWidth(Number(b.dataset.width)); if (state.mode !== "pen") setMode("pen"); }));

$("#paperStyle").addEventListener("change", (e) => {
  const page = state.current;
  if (!page) return;
  page.style = e.target.value;
  applyPaper(page);
  schedulePageSave(page);
  hint("Bu sayfa: " + PAPER_NAMES[page.style] + ". Yeni sayfalar da böyle açılır.");
});

$("#addPageBtn").addEventListener("click", () => {
  const lesson = activeLesson();
  if (!lesson) { newLessonOpen = true; renderNewLessonBox(); openSide(); return; }
  addPageAfter(state.current, true);
});

/* ================= Yakınlaştırma (telefonda okunur boyut) ================= */

function fitWidth() {
  return Math.max(240, Math.min(scroller.clientWidth - 32, 820));
}
let zoomRaf = 0;
function applyZoom() {
  cancelAnimationFrame(zoomRaf);
  zoomRaf = requestAnimationFrame(() => {
    pagesEl.style.setProperty("--page-w", Math.round(fitWidth() * state.zoom) + "px");
  });
}
$("#zoom").addEventListener("change", (e) => {
  state.zoom = Number(e.target.value);
  remember("zoom", String(state.zoom));
  applyZoom();
});
window.addEventListener("resize", applyZoom);

/* ================= Kalem ve silgi ================= */

// Tuval yalnızca ekrana yakın sayfalarda bellekte tutulur; uzaktakiler boşaltılır
function makeObservers() {
  visObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const page = en.target._page;
      if (!page) return;
      page.visible = en.isIntersecting;
      if (page.visible) sizeCanvas(page);
      else { page.canvas.width = 0; page.canvas.height = 0; }
    });
  }, { root: scroller, rootMargin: "800px 400px" });

  sizeObserver = new ResizeObserver((entries) => {
    entries.forEach((en) => { const p = en.target._page; if (p && p.visible) sizeCanvas(p); });
  });
}

function sizeCanvas(page) {
  const w = page.sheet.clientWidth;
  if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const cw = Math.round(w * dpr);
  const ch = Math.round(cw * UNIT_H / UNIT_W);
  if (page.canvas.width === cw && page.canvas.height === ch) return;
  page.canvas.width = cw;
  page.canvas.height = ch;
  redraw(page);
}

function applyScale(page) {
  const s = page.canvas.width / UNIT_W;
  page.ctx.setTransform(s, 0, 0, s, 0, 0);
}

function strokeStyle(ctx, st) {
  ctx.strokeStyle = st.c;
  ctx.lineWidth = st.w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = st.w >= 16 ? 0.38 : 1;
}

function drawStroke(ctx, st) {
  const p = st.p;
  strokeStyle(ctx, st);
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  if (p.length <= 4) {
    ctx.lineTo(p[p.length - 2] + 0.01, p[p.length - 1]);
  } else {
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function redraw(page) {
  page.redrawQueued = false;
  if (!page.built || !page.canvas.width) return;
  const ctx = page.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, page.canvas.width, page.canvas.height);
  applyScale(page);
  for (const st of page.strokes) drawStroke(ctx, st);
}

// Yeniden çizim ekran tazelenme hızıyla sınırlı; silgi ve fosforlu kalem donmasın
function requestRedraw(page) {
  if (page.redrawQueued) return;
  page.redrawQueued = true;
  requestAnimationFrame(() => redraw(page));
}

function toUnits(rect, e) {
  return [
    Math.round((e.clientX - rect.left) / rect.width * UNIT_W * 10) / 10,
    Math.round((e.clientY - rect.top) / rect.height * UNIT_H * 10) / 10
  ];
}

function eraseAt(page, x, y) {
  const rad = 14;
  const before = page.strokes.length;
  page.strokes = page.strokes.filter((st) => {
    const reach = rad + st.w / 2;
    const r2 = reach * reach;
    const p = st.p;
    for (let i = 0; i < p.length; i += 2) {
      const dx = p[i] - x, dy = p[i + 1] - y;
      if (dx * dx + dy * dy < r2) return false;
    }
    return true;
  });
  return page.strokes.length !== before;
}

function setupInk(page) {
  const canvas = page.canvas;
  let active = null;
  let erasing = false;
  let rect = null;
  let scrollTouch = null; // kalem algılandıysa parmak sayfayı kaydırır

  canvas.addEventListener("pointerdown", (e) => {
    if (state.mode === "text") return;
    if (e.pointerType === "pen") state.penSeen = true;
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch" && state.penSeen) {
      scrollTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    setCurrent(page);
    rect = canvas.getBoundingClientRect();
    undoStack.push({ page, strokes: page.strokes.slice() });
    if (undoStack.length > 60) undoStack.shift();
    const [x, y] = toUnits(rect, e);
    if (state.mode === "eraser") {
      erasing = true;
      if (eraseAt(page, x, y)) requestRedraw(page);
    } else {
      active = { id: e.pointerId, st: { c: state.color, w: state.width, p: [x, y] } };
      page.strokes.push(active.st);
      applyScale(page);
      drawStroke(page.ctx, active.st);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (scrollTouch && e.pointerId === scrollTouch.id) {
      scroller.scrollTop -= e.clientY - scrollTouch.y;
      scroller.scrollLeft -= e.clientX - scrollTouch.x;
      scrollTouch.x = e.clientX;
      scrollTouch.y = e.clientY;
      return;
    }
    if (!erasing && (!active || e.pointerId !== active.id)) return;
    const events = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    if (erasing) {
      let changed = false;
      for (const ev of events) { const [x, y] = toUnits(rect, ev); if (eraseAt(page, x, y)) changed = true; }
      if (changed) requestRedraw(page);
      return;
    }
    const st = active.st;
    const p = st.p;
    const ctx = page.ctx;
    const highlighter = st.w >= 16;
    if (!highlighter) { applyScale(page); strokeStyle(ctx, st); ctx.beginPath(); ctx.moveTo(p[p.length - 2], p[p.length - 1]); }
    for (const ev of events) {
      const [x, y] = toUnits(rect, ev);
      const lx = p[p.length - 2], ly = p[p.length - 1];
      if ((x - lx) * (x - lx) + (y - ly) * (y - ly) < 2.5) continue;
      p.push(x, y);
      if (!highlighter) ctx.lineTo(x, y);
    }
    if (highlighter) requestRedraw(page); // üst üste binip koyulaşmasın
    else { ctx.stroke(); ctx.globalAlpha = 1; }
  });

  function end(e) {
    if (scrollTouch && e.pointerId === scrollTouch.id) { scrollTouch = null; return; }
    if (erasing) { erasing = false; schedulePageSave(page); return; }
    if (!active || e.pointerId !== active.id) return;
    active = null;
    requestRedraw(page);
    schedulePageSave(page);
  }
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

$("#undoInk").addEventListener("click", () => {
  while (undoStack.length) {
    const step = undoStack.pop();
    if (!pageCache.has(step.page.id)) continue;
    step.page.strokes = step.strokes;
    requestRedraw(step.page);
    schedulePageSave(step.page);
    return;
  }
  hint("Geri alınacak çizim yok.");
});

/* ================= Açılış ================= */

async function start() {
  makeObservers();
  buildSwatches();
  setMode("text");
  setWidth(4);

  const savedZoom = Number(recall("zoom"));
  state.zoom = savedZoom || (fitWidth() < 520 ? 2 : 1);
  $("#zoom").value = String(state.zoom);
  applyZoom();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  try {
    pending = new Set((await idb.get("kv", "pending")) || []);
    const records = await idb.all("lessons");
    records.forEach((r) => lessonMap.set(r.id, { id: r.id, name: r.name, color: r.color, pages: (r.pages || []).slice(), order: r.order || 0, updated: r.updated || 0, deleted: !!r.deleted }));
  } catch (e) {
    storageError();
  }

  if (![...lessonMap.values()].some((l) => !l.deleted) && !(Number(await idb.get("kv", "since").catch(() => 0)) > 0)) {
    // İlk açılış: örnek ders yalnızca bellekte; değiştirilince kaydedilir, eşitlemeden ders gelince kaldırılır
    const p = pageFromData(newId("pg-"), { html: STARTER_HTML });
    pageCache.set(p.id, p);
    const ex = { id: newId("ls-"), name: "Matematik (örnek)", color: "#ffd84d", pages: [p.id], order: 0, updated: 0, deleted: false, example: true };
    lessonMap.set(ex.id, ex);
  }

  refreshLessonList();
  renderNewLessonBox();
  renderSync();
  const last = recall("active");
  const first = state.lessons.find((l) => l.id === last) || state.lessons[0];
  await openLesson(first ? first.id : null);
  if (document.fonts) document.fonts.ready.then(buildOutline);
  scheduleSync(800);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

start();
