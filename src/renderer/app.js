const $ = (id) => document.getElementById(id);
const inv = window.api.invoke;
let state = {};
let versions = [];

// ---------- navigation ----------
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + b.dataset.page));
  })
);

function setMsg(el, text, cls = '') { el.textContent = text; el.className = 'msg ' + cls; }

// ---------- render state ----------
function render() {
  // instances
  const sel = $('instSelect');
  sel.innerHTML = '';
  state.instances.forEach((i) => {
    const o = document.createElement('option');
    o.value = i.id;
    o.textContent = `${i.name} — ${i.version} ${i.loader === 'fabric' ? '(Fabric)' : ''}`;
    sel.appendChild(o);
  });
  if (state.selectedInstance) sel.value = state.selectedInstance;
  if (!state.instances.length) sel.innerHTML = '<option value="">Создайте первую сборку ниже</option>';

  // accounts
  const who = state.accounts[state.selected];
  $('who').textContent = who ? `${who.name} (${who.type === 'ely' ? 'Ely.by' : 'оффлайн'})` : 'Нет аккаунта';
  const list = $('accList');
  list.innerHTML = '';
  state.accounts.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<div class="ph"></div><div class="meta"><b></b><span></span></div>`;
    d.querySelector('b').textContent = a.name;
    d.querySelector('span').textContent = a.type === 'ely' ? 'Ely.by' : 'Оффлайн';
    const use = document.createElement('button');
    use.className = 'ghost';
    use.textContent = i === state.selected ? 'Выбран' : 'Выбрать';
    use.onclick = async () => { state = await inv('settings:set', { selected: i }); render(); };
    const del = document.createElement('button');
    del.className = 'ghost danger';
    del.textContent = 'Удалить';
    del.onclick = async () => { state = await inv('account:remove', i); render(); };
    d.append(use, del);
    list.appendChild(d);
  });

  // settings
  $('ram').value = state.ram; $('ramVal').textContent = state.ram;
  $('javaPath').value = state.javaPath || '';
  $('cfKey').value = state.cfKey || '';
}

// ---------- versions ----------
function fillVersions() {
  const t = $('newType').value;
  const sel = $('newVersion');
  sel.innerHTML = '';
  versions.filter((v) => t === 'all' || v.type === t).forEach((v) => {
    const o = document.createElement('option');
    o.value = v.id; o.textContent = v.id;
    sel.appendChild(o);
  });
}
$('newType').onchange = fillVersions;

$('btnCreate').onclick = async () => {
  const version = $('newVersion').value;
  if (!version) return;
  const name = $('newName').value.trim() || `Minecraft ${version}`;
  state = await inv('instance:create', { name, version, loader: $('newLoader').value });
  $('newName').value = '';
  render();
};
$('instSelect').onchange = async () => { state = await inv('settings:set', { selectedInstance: $('instSelect').value }); };
$('btnOpenInst').onclick = () => state.selectedInstance && inv('open:folder', state.selectedInstance);
$('btnDelInst').onclick = async () => {
  if (state.selectedInstance && confirm('Удалить сборку вместе с её файлами?')) {
    state = await inv('instance:delete', state.selectedInstance);
    render();
  }
};

// ---------- launch ----------
const log = $('log');
function addLog(t) { log.textContent += t + '\n'; log.scrollTop = log.scrollHeight; }
window.api.on('log', addLog);
window.api.on('progress', (p) => { $('statusText').textContent = p.text; $('barFill').style.width = (p.percent || 0) + '%'; });
window.api.on('game:closed', (code) => {
  $('statusText').textContent = `Игра закрыта (код ${code})`;
  $('barFill').style.width = '0';
  $('btnPlay').disabled = false; $('btnKill').hidden = true;
});
$('btnPlay').onclick = async () => {
  if (!state.selectedInstance) return alert('Сначала создайте сборку');
  log.textContent = '';
  $('btnPlay').disabled = true;
  try {
    await inv('game:launch', state.selectedInstance);
    $('btnKill').hidden = false;
  } catch (e) {
    $('statusText').textContent = 'Ошибка: ' + e.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('btnPlay').disabled = false;
  }
};
$('btnKill').onclick = () => inv('game:kill');

// ---------- accounts ----------
async function elyLogin() {
  const msg = $('elyMsg');
  setMsg(msg, 'Вход…');
  try {
    state = await inv('ely:login', { login: $('elyLogin').value.trim(), password: $('elyPass').value, totp: $('elyTotp').value.trim() });
    $('elyPass').value = ''; $('elyTotp').value = ''; $('rowTotp').hidden = true;
    setMsg(msg, 'Готово!', 'ok'); render();
  } catch (e) {
    if (e.message.includes('NEED_2FA')) { $('rowTotp').hidden = false; setMsg(msg, 'Введите код двухфакторной защиты', 'err'); }
    else setMsg(msg, e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), 'err');
  }
}
$('btnEly').onclick = elyLogin;
$('btnOff').onclick = async () => {
  const n = $('offName').value.trim();
  if (!/^\w{3,16}$/.test(n)) return alert('Ник: 3–16 символов, буквы/цифры/_');
  state = await inv('offline:add', n); $('offName').value = ''; render();
};

// ---------- mods ----------
let offset = 0;
async function search(more) {
  if (!state.selectedInstance) { $('modHint').textContent = 'Сначала создайте сборку — моды подбираются под её версию.'; return; }
  const src = $('modSource').value, kind = $('modKind').value;
  const inst = state.instances.find((i) => i.id === state.selectedInstance);
  $('modHint').textContent = `Сборка: ${inst.name} (${inst.version}, ${inst.loader}). Файлы попадут в её папку.`;
  if (!more) { offset = 0; $('modList').innerHTML = ''; }
  try {
    const res = await inv(src + ':search', { query: $('modQuery').value, kind, instanceId: inst.id, offset });
    offset += res.length;
    res.forEach((m) => addMod(m, kind, inst.id));
  } catch (e) {
    $('modHint').textContent = e.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }
}
function addMod(m, kind, instanceId) {
  const d = document.createElement('div');
  d.className = 'item';
  const img = m.icon ? Object.assign(document.createElement('img'), { src: m.icon }) : Object.assign(document.createElement('div'), { className: 'ph' });
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<b></b><span class="d"></span><span class="s"></span>';
  meta.querySelector('b').textContent = m.title;
  meta.querySelector('.d').textContent = m.description || '';
  meta.querySelector('.s').textContent = `${m.author} · ${(m.downloads || 0).toLocaleString('ru')} загрузок`;
  const btn = document.createElement('button');
  btn.textContent = 'Скачать';
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = '…';
    try {
      await inv(m.source + ':install', { id: m.id, kind, instanceId });
      btn.textContent = 'Установлено ✓';
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Скачать';
      alert(e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    }
  };
  d.append(img, meta, btn);
  $('modList').appendChild(d);
}
$('btnSearch').onclick = () => search(false);
$('modQuery').addEventListener('keydown', (e) => e.key === 'Enter' && search(false));
$('modList').addEventListener('scroll', () => {});
document.querySelector('main').addEventListener('scroll', (e) => {
  const m = e.target;
  if ($('page-mods').classList.contains('active') && m.scrollTop + m.clientHeight >= m.scrollHeight - 40) search(true);
});

// ---------- settings ----------
$('ram').oninput = () => { $('ramVal').textContent = $('ram').value; };
$('btnSave').onclick = async () => {
  state = await inv('settings:set', { ram: +$('ram').value, javaPath: $('javaPath').value.trim(), cfKey: $('cfKey').value.trim() });
  setMsg($('saveMsg'), 'Сохранено', 'ok'); setTimeout(() => setMsg($('saveMsg'), ''), 2000);
};
$('btnOpenData').onclick = () => inv('open:folder', 'root');

// ---------- init ----------
(async () => {
  state = await inv('state:get');
  render();
  try { versions = await inv('versions:list'); fillVersions(); }
  catch (e) { $('statusText').textContent = 'Не удалось загрузить список версий (нет интернета?)'; }
})();
