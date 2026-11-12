// Собирает портативную папку dist/MajesticHelper (запускается на Windows в GitHub Actions)
// и пакет обновления dist/update/app (+ dist/version.json).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const electron = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(dist, 'MajesticHelper');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(electron, out, { recursive: true });
for (const n of ['electron.exe', 'electron']) {
  if (fs.existsSync(path.join(out, n))) fs.renameSync(path.join(out, n), path.join(out, n === 'electron' ? 'MajesticHelper' : 'MajesticHelper.exe'));
}
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
const loc = path.join(out, 'locales');
if (fs.existsSync(loc)) for (const f of fs.readdirSync(loc)) if (!/^(en-US|ru)\.pak$/.test(f)) fs.rmSync(path.join(loc, f));

const res = path.join(out, 'resources', 'app');
fs.mkdirSync(res, { recursive: true });
fs.copyFileSync(path.join(root, 'main.js'), path.join(res, 'main.js'));
fs.copyFileSync(path.join(root, 'package.json'), path.join(res, 'package.json'));
fs.cpSync(path.join(root, 'app'), path.join(res, 'app'), { recursive: true });
fs.writeFileSync(path.join(out, 'README.txt'),
  'Majestic Helper — запуск: MajesticHelper.exe (ничего устанавливать не нужно).\r\n' +
  'Игра должна быть в режиме "Окно без рамки". Показать/скрыть окно: Ctrl+Shift+L.\r\n' +
  'Данные (настройки, памятка, кэш) лежат в папке data рядом с MajesticHelper.exe.\r\n' +
  'Обновления программа находит и ставит сама (кнопка внизу окна).\r\n');

// пакет автообновления: только app/, без тяжёлой базы законов
const upd = path.join(dist, 'update', 'app');
fs.cpSync(path.join(root, 'app'), upd, { recursive: true });
fs.rmSync(path.join(upd, 'snapshot.json'), { force: true });
fs.copyFileSync(path.join(root, 'app', 'version.json'), path.join(dist, 'version.json'));
console.log('packed:', out);
