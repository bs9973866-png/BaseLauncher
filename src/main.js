const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const { Client } = require('minecraft-launcher-core');

// ---------- paths & storage ----------
const DATA = path.join(app.getPath('userData'));
const ROOT = path.join(DATA, 'minecraft');          // shared libraries/assets/versions
const INSTANCES = path.join(DATA, 'instances');     // one game dir per instance
const JAVA_DIR = path.join(DATA, 'java');
const AUTHLIB = path.join(DATA, 'authlib-injector.jar');
const SETTINGS = path.join(DATA, 'settings.json');
[ROOT, INSTANCES, JAVA_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const defaults = {
  accounts: [],            // {type:'ely'|'offline', name, uuid, accessToken, clientToken}
  selected: -1,
  instances: [],           // {id, name, version, loader:'vanilla'|'fabric'}
  selectedInstance: null,
  ram: 4096,
  cfKey: '',
  javaPath: ''
};
let settings = { ...defaults };
try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

let win;
const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);
const UA = 'BaseLauncher/1.0 (minecraft launcher)';

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}
async function download(url, dest, headers = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed ${r.status}: ${url}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 680, minWidth: 900, minHeight: 600,
    backgroundColor: '#12151c',
    title: 'Base Launcher',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- settings / state ----------
const publicState = () => ({
  ...settings,
  accounts: settings.accounts.map((a) => ({ type: a.type, name: a.name, uuid: a.uuid })),
  platform: process.platform
});
ipcMain.handle('state:get', () => publicState());
ipcMain.handle('settings:set', (_e, patch) => {
  for (const k of ['ram', 'cfKey', 'javaPath', 'selected', 'selectedInstance']) if (k in patch) settings[k] = patch[k];
  save(); return publicState();
});
ipcMain.handle('open:folder', (_e, which) => {
  const p = which === 'root' ? DATA : path.join(INSTANCES, which);
  fs.mkdirSync(p, { recursive: true }); shell.openPath(p);
});

// ---------- accounts: Ely.by ----------
const ELY = 'https://authserver.ely.by';
ipcMain.handle('ely:login', async (_e, { login, password, totp }) => {
  const clientToken = crypto.randomUUID().replace(/-/g, '');
  // Ely.by two-factor: password + ':' + token
  const pass = totp ? `${password}:${totp}` : password;
  const r = await fetch(`${ELY}/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ username: login, password: pass, clientToken, requestUser: true })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (body.error === 'ForbiddenOperationException' && /two factor/i.test(body.errorMessage || '')) {
      throw new Error('NEED_2FA');
    }
    throw new Error(body.errorMessage || `Ошибка Ely.by (${r.status})`);
  }
  const acc = { type: 'ely', name: body.selectedProfile.name, uuid: body.selectedProfile.id, accessToken: body.accessToken, clientToken };
  settings.accounts = settings.accounts.filter((a) => !(a.type === 'ely' && a.uuid === acc.uuid));
  settings.accounts.push(acc);
  settings.selected = settings.accounts.length - 1;
  save(); return publicState();
});
ipcMain.handle('offline:add', (_e, name) => {
  const uuid = crypto.createHash('md5').update('OfflinePlayer:' + name).digest('hex');
  settings.accounts.push({ type: 'offline', name, uuid });
  settings.selected = settings.accounts.length - 1;
  save(); return publicState();
});
ipcMain.handle('account:remove', (_e, i) => {
  settings.accounts.splice(i, 1);
  settings.selected = settings.accounts.length ? 0 : -1;
  save(); return publicState();
});

async function ensureElyToken(acc) {
  // validate; refresh if needed
  const v = await fetch(`${ELY}/auth/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: acc.accessToken })
  });
  if (v.ok) return;
  const r = await fetch(`${ELY}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: acc.accessToken, clientToken: acc.clientToken })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Сессия Ely.by истекла — войдите заново');
  acc.accessToken = body.accessToken; save();
}
async function ensureAuthlib() {
  if (fs.existsSync(AUTHLIB)) return AUTHLIB;
  const meta = await getJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
  await download(meta.download_url, AUTHLIB);
  return AUTHLIB;
}

// ---------- versions ----------
let manifestCache;
ipcMain.handle('versions:list', async () => {
  if (!manifestCache) manifestCache = await getJSON('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return manifestCache.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
});

ipcMain.handle('instance:create', async (_e, { name, version, loader }) => {
  const id = (name.toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-') || 'instance') + '-' + Date.now().toString(36);
  settings.instances.push({ id, name, version, loader });
  settings.selectedInstance = id;
  fs.mkdirSync(path.join(INSTANCES, id), { recursive: true });
  save(); return publicState();
});
ipcMain.handle('instance:delete', (_e, id) => {
  settings.instances = settings.instances.filter((i) => i.id !== id);
  if (settings.selectedInstance === id) settings.selectedInstance = settings.instances[0]?.id || null;
  fs.rmSync(path.join(INSTANCES, id), { recursive: true, force: true });
  save(); return publicState();
});

// ---------- Java ----------
function javaMajorFor(mc) {
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21; // snapshots / new year-based versions
  const minor = +m[1], patch = +(m[2] || 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 17; // 1.17 needs Java 16+, 17 works
  return 8;
}
function findJavaExe(dir) {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === exe && path.basename(d) === 'bin') return p;
    }
  }
  return null;
}
async function ensureJava(mc) {
  if (settings.javaPath && fs.existsSync(settings.javaPath)) return settings.javaPath;
  const major = javaMajorFor(mc);
  const dir = path.join(JAVA_DIR, String(major));
  if (fs.existsSync(dir)) { const f = findJavaExe(dir); if (f) return f; }
  send('progress', { text: `Скачиваю Java ${major}…`, percent: 0 });
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${plat}/${arch}/jre/hotspot/normal/eclipse`;
  const tmp = path.join(DATA, `java-${major}.${plat === 'windows' ? 'zip' : 'tar.gz'}`);
  await download(url, tmp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (plat === 'windows') new AdmZip(tmp).extractAllTo(dir, true);
  else spawnSync('tar', ['-xzf', tmp, '-C', dir]);
  fs.rmSync(tmp, { force: true });
  const exe = findJavaExe(dir);
  if (!exe) throw new Error('Не удалось установить Java');
  return exe;
}

// ---------- Fabric ----------
async function ensureFabric(mc) {
  const loaders = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mc}`);
  if (!loaders.length) throw new Error(`Fabric не поддерживает версию ${mc}`);
  const lv = (loaders.find((l) => l.loader.stable) || loaders[0]).loader.version;
  const profile = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${lv}/profile/json`);
  const dir = path.join(ROOT, 'versions', profile.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${profile.id}.json`), JSON.stringify(profile));
  return profile.id;
}

// ---------- launch ----------
let running = null;
ipcMain.handle('game:launch', async (_e, instanceId) => {
  if (running) throw new Error('Игра уже запущена');
  const inst = settings.instances.find((i) => i.id === instanceId);
  if (!inst) throw new Error('Выберите сборку');
  const acc = settings.accounts[settings.selected];
  if (!acc) throw new Error('Добавьте аккаунт (Ely.by или оффлайн)');

  send('progress', { text: 'Подготовка…', percent: 0 });
  const javaPath = await ensureJava(inst.version);
  const customArgs = [];
  let authorization = {
    access_token: 'offline', client_token: 'offline', uuid: acc.uuid, name: acc.name,
    user_properties: '{}', meta: { type: 'mojang', demo: false }
  };
  if (acc.type === 'ely') {
    send('progress', { text: 'Проверка сессии Ely.by…', percent: 0 });
    await ensureElyToken(acc);
    const jar = await ensureAuthlib();
    // Ely.by shorthand supported by authlib-injector
    customArgs.push(`-javaagent:${jar}=ely.by`);
    authorization = { ...authorization, access_token: acc.accessToken, client_token: acc.clientToken };
  }

  const version = { number: inst.version, type: 'release' };
  if (inst.loader === 'fabric') {
    send('progress', { text: 'Установка Fabric…', percent: 0 });
    version.custom = await ensureFabric(inst.version);
  }

  const launcher = new Client();
  launcher.on('progress', (p) => send('progress', { text: `Загрузка: ${p.type}`, percent: p.total ? Math.round((p.task / p.total) * 100) : 0 }));
  launcher.on('debug', (m) => send('log', m));
  launcher.on('data', (m) => send('log', String(m)));
  launcher.on('close', (code) => { running = null; send('game:closed', code); });

  const proc = await launcher.launch({
    authorization,
    root: ROOT,
    javaPath,
    version,
    memory: { max: `${settings.ram}M`, min: '512M' },
    customArgs,
    overrides: { gameDirectory: path.join(INSTANCES, inst.id) }
  });
  if (!proc) throw new Error('Не удалось запустить игру — смотрите журнал');
  running = proc;
  send('progress', { text: 'Игра запущена', percent: 100 });
  return true;
});
ipcMain.handle('game:kill', () => { running?.kill(); });

// ---------- Modrinth ----------
const MR = 'https://api.modrinth.com/v2';
const MR_TYPE = { mod: 'mod', resourcepack: 'resourcepack', shader: 'shader' };
const FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };

ipcMain.handle('modrinth:search', async (_e, { query, kind, instanceId, offset }) => {
  const inst = settings.instances.find((i) => i.id === instanceId);
  const facets = [[`project_type:${MR_TYPE[kind]}`]];
  if (inst) facets.push([`versions:${inst.version}`]);
  if (inst && kind === 'mod' && inst.loader !== 'vanilla') facets.push([`categories:${inst.loader}`]);
  const u = `${MR}/search?query=${encodeURIComponent(query || '')}&limit=20&offset=${offset || 0}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const d = await getJSON(u);
  return d.hits.map((h) => ({
    source: 'modrinth', id: h.project_id, title: h.title, author: h.author, description: h.description,
    icon: h.icon_url, downloads: h.downloads
  }));
});
ipcMain.handle('modrinth:install', async (_e, { id, kind, instanceId }) => {
  const inst = settings.instances.find((i) => i.id === instanceId);
  if (!inst) throw new Error('Выберите сборку');
  const q = new URLSearchParams({ game_versions: JSON.stringify([inst.version]) });
  if (kind === 'mod' && inst.loader !== 'vanilla') q.set('loaders', JSON.stringify([inst.loader]));
  const versions = await getJSON(`${MR}/project/${id}/version?${q}`);
  if (!versions.length) throw new Error('Нет подходящей версии для этой сборки');
  const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
  const dest = path.join(INSTANCES, inst.id, FOLDER[kind], file.filename);
  await download(file.url, dest);
  // required dependencies (mods only)
  for (const dep of versions[0].dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    try {
      const dv = await getJSON(`${MR}/project/${dep.project_id}/version?${q}`);
      if (dv.length) {
        const f = dv[0].files.find((x) => x.primary) || dv[0].files[0];
        await download(f.url, path.join(INSTANCES, inst.id, FOLDER[kind], f.filename));
      }
    } catch {}
  }
  return file.filename;
});

// ---------- CurseForge ----------
const CF = 'https://api.curseforge.com/v1';
const CF_CLASS = { mod: 6, resourcepack: 12, shader: 6552 };
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const cfHeaders = () => {
  if (!settings.cfKey) throw new Error('Укажите API-ключ CurseForge в настройках (console.curseforge.com)');
  return { 'x-api-key': settings.cfKey, Accept: 'application/json' };
};
ipcMain.handle('curseforge:search', async (_e, { query, kind, instanceId, offset }) => {
  const inst = settings.instances.find((i) => i.id === instanceId);
  const p = new URLSearchParams({
    gameId: '432', classId: String(CF_CLASS[kind]), searchFilter: query || '',
    sortField: '2', sortOrder: 'desc', pageSize: '20', index: String(offset || 0)
  });
  if (inst) p.set('gameVersion', inst.version);
  if (inst && kind === 'mod' && CF_LOADER[inst.loader]) p.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const d = await getJSON(`${CF}/mods/search?${p}`, { headers: cfHeaders() });
  return d.data.map((m) => ({
    source: 'curseforge', id: String(m.id), title: m.name, author: m.authors?.[0]?.name || '',
    description: m.summary, icon: m.logo?.thumbnailUrl, downloads: m.downloadCount
  }));
});
ipcMain.handle('curseforge:install', async (_e, { id, kind, instanceId }) => {
  const inst = settings.instances.find((i) => i.id === instanceId);
  if (!inst) throw new Error('Выберите сборку');
  const p = new URLSearchParams({ gameVersion: inst.version, pageSize: '10' });
  if (kind === 'mod' && CF_LOADER[inst.loader]) p.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const d = await getJSON(`${CF}/mods/${id}/files?${p}`, { headers: cfHeaders() });
  const f = d.data.find((x) => x.downloadUrl) || d.data[0];
  if (!f) throw new Error('Нет подходящего файла для этой сборки');
  if (!f.downloadUrl) throw new Error('Автор запретил скачивание вне сайта CurseForge');
  await download(f.downloadUrl, path.join(INSTANCES, inst.id, FOLDER[kind], f.fileName));
  return f.fileName;
});
