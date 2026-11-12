// Стабильная оболочка: сама почти не меняется.
// 1) Все данные хранит в папке data рядом с программой (удалил папку — удалил всё).
// 2) Выбирает, какую версию app/ запускать: обновлённую из data\app или встроенную.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const SHELL_VERSION = 2;
const oldUD = app.getPath('userData'); // %APPDATA%\majestic-helper — так хранили раньше
// рядом с .exe (портативная сборка), иначе рядом с проектом
const root = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : __dirname);
let dataDir = path.join(root, 'data');
try { fs.mkdirSync(dataDir, { recursive: true }); fs.accessSync(dataDir, fs.constants.W_OK); } catch { dataDir = oldUD; }
if (dataDir !== oldUD) {
  // однократный перенос настроек, памятки и кэша из старого места
  for (const f of ['settings.json', 'pins.json', 'cache.json'])
    try { if (!fs.existsSync(path.join(dataDir, f)) && fs.existsSync(path.join(oldUD, f))) fs.copyFileSync(path.join(oldUD, f), path.join(dataDir, f)); } catch {}
  app.setPath('userData', dataDir);
  app.setPath('sessionData', path.join(dataDir, 'browser'));
}

const ver = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'version.json'), 'utf8')).version; } catch { return null; } };
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; } return false; };

const bundled = path.join(__dirname, 'app');
const user = path.join(dataDir, 'app');
const uv = ver(user), bv = ver(bundled) || '0';
const useUser = uv && fs.existsSync(path.join(user, 'app-main.js')) && newer(uv, bv);

global.__MH = { shellVersion: SHELL_VERSION, bundledApp: bundled };
try {
  require(path.join(useUser ? user : bundled, 'app-main.js'));
} catch (e) {
  if (!useUser) throw e;
  fs.rmSync(user, { recursive: true, force: true }); // обновление оказалось битым — откат
  require(path.join(bundled, 'app-main.js'));
}
