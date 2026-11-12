const { app, BrowserWindow, globalShortcut, ipcMain, shell, net, dialog, session } = require('electron');
const os = require('os');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const Core = require('./core');

if (!app.requestSingleInstanceLock()) app.quit();

const dir = () => app.getPath('userData');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')); } catch { return d; } };
const wr = (f, v) => fs.writeFileSync(path.join(dir(), f), JSON.stringify(v));

const DEFAULTS = {
  server: 'los-angeles',        // слаг сервера на docossum.com/legal/<server>
  lawSource: 'docossum',        // 'docossum' | 'forum' (брать текст прямо с форума)
  hotkey: 'Control+Shift+L',
  rules: [{ name: 'ПГО', url: 'https://forum.majestic-rp.ru/threads/pravila-gosudarstvennykh-organizatsii.8672/' }], // ссылки на темы с правилами на форуме
  updateUrl: '',                // пусто = GitHub Releases проекта; можно указать свою папку с version.json и app.zip
  opacity: 0.97,
  bounds: { width: 1000, height: 640 },
};
let S, win, scraper, cache, refreshing = false;
const STALE_MS = 10 * 60 * 1000;
const SNAPSHOT = process.argv.includes('--snapshot');
const REPO = 'JaosnFoxs/majestic-helper';
const DATA_URL = process.env.MH_DATA_URL || `https://github.com/${REPO}/releases/download/data/snapshot.json`; // обновляется автоматически раз в час
const SEED_DIRS = [__dirname, (global.__MH || {}).bundledApp].filter(Boolean);

const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
const status = (msg, busy = true) => send('status', { msg, busy });

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    ...S.bounds, minWidth: 640, minHeight: 400, frame: false, show: false, alwaysOnTop: true,
    backgroundColor: '#14151a', title: 'Majestic Helper',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setOpacity(S.opacity);
  win.loadFile(path.join(__dirname, 'index.html')).catch((e) => dialog.showErrorBox('Majestic Helper', 'Не удалось загрузить интерфейс: ' + e.message));
  win.once('ready-to-show', () => { win.show(); maybeRefresh(); });
  win.on('resized', saveBounds); win.on('moved', saveBounds);
  win.on('show', () => { send('shown'); maybeRefresh(); });
}
function saveBounds() { if (!win.isMinimized()) { S.bounds = win.getBounds(); wr('settings.json', S); } }
function toggle() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}
function registerHotkey() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(S.hotkey, toggle);
  if (!ok) send('status', { msg: `Не удалось занять ${S.hotkey} — выберите другое сочетание в настройках`, busy: false });
}

// ---------- загрузка страниц через скрытые окна Chromium ----------
let blocker = false;
function newScraper() {
  if (!blocker) { // картинки и шрифты не нужны — страницы грузятся заметно быстрее
    blocker = true;
    session.fromPartition('persist:scrape').webRequest.onBeforeRequest((d, cb) => cb({ cancel: ['image', 'media', 'font'].includes(d.resourceType) }));
  }
  return new BrowserWindow({ show: false, webPreferences: { partition: 'persist:scrape', backgroundThrottling: false } });
}
function getScraper() { if (!scraper || scraper.isDestroyed()) scraper = newScraper(); return scraper; }
async function load(url, script, w = getScraper(), timeout = 40000) {
  await Promise.race([
    w.loadURL(url).catch((e) => { if (!/ERR_ABORTED/.test(e.message)) throw e; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + url)), timeout)),
  ]);
  return w.webContents.executeJavaScript(script);
}
// n параллельных окон, каждое берёт следующий документ из очереди
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    const w = newScraper();
    try { while (i < items.length) await fn(items[i++], w); } finally { if (!w.isDestroyed()) w.destroy(); }
  }));
}
const INDEX_JS = (server) => `(() => {
  const seen = {}, out = [];
  for (const a of document.querySelectorAll('a[href*="/legal/${server}/document/"]')) {
    if (!/\\/document\\/\\d+\\/?$/.test(a.href) || seen[a.href]) continue;
    seen[a.href] = 1; out.push({ title: a.textContent.trim(), url: a.href });
  }
  const m = document.body.innerText.match(/Последнее обновление[^\\n]*/);
  return { docs: out, stamp: m ? m[0].trim() : '' }; })()`;
const DOC_JS = `(() => {
  const m = document.querySelector('main') || document.body;
  const o = [...document.querySelectorAll('a')].find(a => /Открыть оригинал/i.test(a.textContent));
  return { text: m.innerText, origin: o ? o.href : '' }; })()`;
const FORUM_JS = `(async () => {
  const st = document.createElement('style');
  st.textContent = '.bbCodeSpoiler-content,.bbCodeBlock-expandContent{display:block!important;max-height:none!important;height:auto!important;visibility:visible!important}';
  document.head.appendChild(st);
  for (let i = 0; i < 30 && !document.querySelector('.bbWrapper'); i++) await new Promise(r => setTimeout(r, 500));
  let text = [...document.querySelectorAll('.message-body .bbWrapper')].map(e => e.innerText).join('\\n');
  if (!text.trim()) text = (document.querySelector('.p-body-content') || document.body).innerText;
  return { text, title: document.title };
})()`;

// ---------- обновление данных ----------
const PRIORITY = ['Уголовный', 'Административный', 'Процессуальный', 'Дорожный', 'Конституция', 'Трудовой', 'Финансовый'];
const prio = (t) => { const i = PRIORITY.findIndex((p) => t.includes(p)); return i < 0 ? 99 : i; };
let lastPush = 0;
const pushData = (now) => { if (now || Date.now() - lastPush > 400) { lastPush = Date.now(); send('data', flatten()); } };
function flatten() {
  const records = [];
  for (const d of Object.values(cache.docs)) records.push(...d.recs);
  return { records, updated: cache.updated, errors: cache.errors || [] };
}
let queued = false, queuedForce = false;
async function loadRules(errors) {
  let j = 0;
  for (const r of S.rules) {
    status(`Правила ${++j}/${S.rules.length}: ${r.name}`);
    try {
      const f = await load(r.url, FORUM_JS);
      const recs = Core.parseDoc(f.text, { key: r.url, title: r.name, short: r.name, kind: 'rule', origin: r.url });
      if (!recs.length) {
        getScraper().show(); // вдруг форум просит проверку «я не робот» — пользователь пройдёт её в этом окне
        throw new Error(`пункты не найдены (страница: «${(f.title || '').slice(0, 50)}», ${f.text.length} символов). Если открылось окно форума — пройдите проверку и нажмите ⟳`);
      }
      if (scraper && !scraper.isDestroyed()) scraper.hide();
      cache.docs[r.url] = { recs };
    } catch (e) { errors.push(`${r.name}: ${e.message}`); }
  }
  for (const k of Object.keys(cache.docs)) if (cache.docs[k].recs[0]?.kind === 'rule' && !S.rules.some((r) => r.url === k)) delete cache.docs[k];
  pushData(true);
}

// готовая база законов, которую раз в час собирает GitHub Actions: один файл вместо 36 страниц
async function importSnapshot() {
  try {
    const r = await net.fetch(DATA_URL);
    if (!r.ok) return false;
    const snap = await r.json();
    if (!snap.docs || snap.server !== S.server) return false;
    const fresh = Date.now() - (snap.updated || 0) < 3 * 3600e3;
    const have = Object.keys(cache.docs).length > 0;
    if (!(have && snap.lawStamp && snap.lawStamp === cache.lawStamp)) {
      const laws = Object.keys(snap.docs).filter((k) => snap.docs[k].recs[0]?.kind === 'law');
      for (const k of Object.keys(cache.docs)) if (cache.docs[k].recs[0]?.kind === 'law' && !laws.includes(k)) delete cache.docs[k];
      for (const k of laws) cache.docs[k] = snap.docs[k];
      for (const k of Object.keys(snap.docs)) // правила из базы — только как запасной вариант, если с форума не прочитались
        if (snap.docs[k].recs[0]?.kind === 'rule' && S.rules.some((x) => x.url === k) && !cache.docs[k]) cache.docs[k] = snap.docs[k];
      cache.lawStamp = snap.lawStamp;
      pushData(true);
    }
    return fresh;
  } catch { return false; }
}
async function refresh(force) {
  if (refreshing) { queued = true; queuedForce = queuedForce || !!force; return; }
  refreshing = true;
  const errors = [];
  try {
    await loadRules(errors); // правила первыми: их мало, они нужны сразу
    cache.errors = errors; pushData(true);

    if (!force && await importSnapshot()) { // база свежая — сайты опрашивать не нужно
      cache.updated = Date.now(); cache.errors = errors; wr('cache.json', cache); pushData(true);
      status(errors.length ? `Данные загружены, ошибок: ${errors.length}` : 'Всё актуально', false);
      return;
    }
    status('Проверяю законы…');
    let idx = { docs: [], stamp: '' };
    try { idx = await load(`https://docossum.com/legal/${S.server}`, INDEX_JS(S.server)); }
    catch (e) { errors.push('Список законов: ' + e.message); }
    const docs = idx.docs.sort((a, b) => prio(a.title) - prio(b.title));

    // на сайте ничего не менялось — перекачивать нечего
    if (!force && docs.length && idx.stamp && idx.stamp === cache.lawStamp && docs.every((d) => cache.docs[d.url])) {
      cache.updated = Date.now(); cache.errors = errors; wr('cache.json', cache);
      status(errors.length ? `Законы актуальны, ошибок: ${errors.length}` : 'Всё актуально', false); pushData(true);
      return;
    }

    let done = 0; const lawErrors = [];
    await pool(docs, 4, async (d, w) => {
      try {
        const page = await load(d.url, DOC_JS, w);
        let text = page.text; const origin = page.origin;
        if (S.lawSource === 'forum' && origin) {
          try { const f = await load(origin, FORUM_JS, w); if (f.text.length > 1500) text = f.text; }
          catch (e) { lawErrors.push(`${d.title}: форум недоступен, взято с docossum`); }
        }
        const recs = Core.parseDoc(text, { key: d.url, title: d.title, kind: 'law', origin });
        if (!recs.length) throw new Error('не удалось разобрать текст');
        cache.docs[d.url] = { recs };
      } catch (e) { lawErrors.push(`${d.title}: ${e.message}`); }
      status(`Законы ${++done}/${docs.length}`); pushData();
      if (done % 12 === 0) wr('cache.json', cache);
    });
    errors.push(...lawErrors);
    if (docs.length) for (const k of Object.keys(cache.docs)) if (k.startsWith('http') && !docs.some((d) => d.url === k) && cache.docs[k].recs[0]?.kind === 'law') delete cache.docs[k];
    if (docs.length && !lawErrors.length) cache.lawStamp = idx.stamp;
    if (docs.length) cache.updated = Date.now(); // если список не загрузился, при следующем показе окна попробуем снова
    cache.errors = errors; wr('cache.json', cache); pushData(true);
    status(errors.length ? `Обновлено с ошибками (${errors.length})` : 'Обновлено', false);
  } finally {
    refreshing = false;
    if (queued) { const f = queuedForce; queued = queuedForce = false; refresh(f).catch(() => {}); }
  }
}
function maybeRefresh() { checkUpdate(); if (Date.now() - (cache.updated || 0) > STALE_MS) refresh().catch((e) => status('Ошибка: ' + e.message, false)); }

// ---------- обновление приложения ----------
const readVer = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'version.json'), 'utf8')); } catch { return null; } };
const VERSION = (readVer(__dirname) || {}).version || '0';
const SHELL = (global.__MH || {}).shellVersion || 1;
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
function findApp(d, depth = 0) {
  if (fs.existsSync(path.join(d, 'app-main.js'))) return d;
  if (depth > 3) return null;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const r = findApp(path.join(d, e.name), depth + 1); if (r) return r; }
  return null;
}
async function installFromZip(zip) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
  try {
    await new Promise((res, rej) => execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MH_ZIP -DestinationPath $env:MH_OUT -Force'],
      { env: { ...process.env, MH_ZIP: zip, MH_OUT: tmp } }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res())));
    const src = findApp(tmp);
    if (!src) throw new Error('в архиве нет app-main.js — это не архив обновления');
    const nv = readVer(src);
    if (!nv) throw new Error('в архиве нет version.json');
    if ((nv.minShell || 1) > SHELL) throw new Error('эта версия требует полной переустановки (скачайте полный архив)');
    const dest = path.join(app.getPath('userData'), 'app'), stage = dest + '.new';
    fs.rmSync(stage, { recursive: true, force: true });
    fs.cpSync(src, stage, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
    return nv.version;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const restart = () => setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
const base = () => (process.env.MH_UPDATE_URL || S.updateUrl || `https://github.com/${REPO}/releases/latest/download/`).replace(/\/*$/, '/');
let lastCheck = 0;
async function checkUpdate() {
  if (Date.now() - lastCheck < 3600e3) return;
  lastCheck = Date.now();
  try {
    const j = await (await net.fetch(base() + 'version.json')).json();
    if (cmpVer(j.version, VERSION) > 0) send('update', { version: j.version });
  } catch { /* нет сети — не страшно */ }
}
ipcMain.handle('update-zip', async (_, p) => {
  try {
    if (!p) {
      const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Архив обновления', extensions: ['zip'] }], properties: ['openFile'] });
      if (r.canceled) return;
      p = r.filePaths[0];
    }
    status('Устанавливаю обновление…');
    const v = await installFromZip(p);
    status(`Обновлено до ${v}, перезапуск…`); restart();
  } catch (e) { status('Обновление не удалось: ' + e.message, false); }
});
ipcMain.handle('update-now', async () => {
  try {
    status('Скачиваю обновление…');
    const r = await net.fetch(base() + 'app.zip');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const f = path.join(os.tmpdir(), 'mh-update.zip');
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    const v = await installFromZip(f);
    status(`Обновлено до ${v}, перезапуск…`); restart();
  } catch (e) { status('Обновление не удалось: ' + e.message, false); }
});

// ---------- IPC ----------
ipcMain.handle('state', () => ({ settings: S, data: flatten(), pins: rd('pins.json', []), version: VERSION, dataDir: dir() }));
ipcMain.handle('refresh', () => refresh().catch((e) => status('Ошибка: ' + e.message, false)));
ipcMain.handle('pins', (_, p) => wr('pins.json', p));
ipcMain.handle('settings', (_, s) => {
  const changed = s.server !== S.server || s.lawSource !== S.lawSource || JSON.stringify(s.rules) !== JSON.stringify(S.rules);
  if (s.server !== S.server) cache.docs = {};
  S = { ...S, ...s }; wr('settings.json', S);
  win.setOpacity(S.opacity); registerHotkey();
  if (changed) refresh(true).catch(() => {});
  return S;
});
ipcMain.on('hide', () => win.hide());
ipcMain.on('quit', () => app.quit());
ipcMain.on('open', (_, u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); });

app.whenReady().then(async () => {
  S = { ...DEFAULTS, ...rd('settings.json', {}) };
  if (SNAPSHOT) { // npm run snapshot: скачать всё и сохранить как встроенные данные для сборки
    cache = { docs: {}, updated: 0 };
    try { const prev = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshot.json'), 'utf8')); if (prev.server === S.server) cache = { docs: prev.docs, updated: 0 }; } catch {}
    await refresh(true);
    const n = Object.values(cache.docs).reduce((t, d) => t + d.recs.length, 0);
    fs.writeFileSync(path.join(__dirname, 'snapshot.json'), JSON.stringify({ server: S.server, docs: cache.docs, updated: cache.updated, lawStamp: cache.lawStamp }));
    console.log(`SNAPSHOT: документов ${Object.keys(cache.docs).length}, статей ${n}, ошибок ${(cache.errors || []).length}`);
    (cache.errors || []).forEach((e) => console.log(' - ' + e));
    return app.exit(n ? 0 : 1);
  }
  cache = rd('cache.json', null);
  if (!cache || !Object.keys(cache.docs || {}).length) { // первый запуск: берём встроенные данные, если они есть
    cache = { docs: {}, updated: 0 };
    for (const d of SEED_DIRS) { try { cache = JSON.parse(fs.readFileSync(path.join(d, 'snapshot.json'), 'utf8')); break; } catch {} }
  }
  createWindow(); registerHotkey();
});
app.on('second-instance', () => { win.show(); win.focus(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
