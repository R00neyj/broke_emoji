'use strict';

const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const { removeBackground, alphaBBox, fitBox } = window.imaging;

// Imported images are stored at most this large (KakaoTalk emoticon reference size).
const STORE_MAX = 360;
const KAKAO_DEFAULT_BG = '#bacee0';

const DEFAULTS = { bg: KAKAO_DEFAULT_BG, size: 150, pad: 4, removeBg: true, tol: 24, pinned: false, dir: '', theme: 'system' };
// settings.json next to the exe, injected by the backend before this script runs.
const settings = { ...DEFAULTS, ...parseSettings(window.__SETTINGS__) };
function parseSettings(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
const saveSettings = () => invoke('save_settings', { json: JSON.stringify(settings, null, 2) }).catch((e) => toast(String(e), true));

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let tabs = [];
let current = '';
const urls = new Map(); // "tab/name" -> object URL

// ---------- toast / menu ----------

let toastTimer;
function toast(msg, isError, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms ?? (isError ? 3500 : 1600));
}

function showMenu(x, y, items) {
  const m = $('menu');
  m.replaceChildren(...items.map(([label, fn]) => {
    const b = el('button', null, label);
    b.onclick = () => { hideMenu(); fn(); };
    return b;
  }));
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 4) + 'px';
}
const hideMenu = () => { $('menu').hidden = true; };
addEventListener('click', hideMenu);
addEventListener('blur', hideMenu);
addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- gallery ----------

async function imageUrl(tab, name) {
  const key = tab + '/' + name;
  if (!urls.has(key)) {
    const bytes = await invoke('read_image', { tab, name });
    urls.set(key, URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
  }
  return urls.get(key);
}

async function refresh() {
  tabs = await invoke('list_tabs');
  if (!tabs.some((t) => t.name === current)) current = '';
  await Promise.all([renderPacks(), renderGrid()]);
}

async function renderPacks() {
  const nav = $('packs');
  const nodes = [];
  for (const t of tabs) {
    const b = el('button', 'pack' + (t.name === current ? ' on' : ''));
    b.title = t.name || '기본';
    if (t.files.length) {
      const img = el('img');
      img.src = await imageUrl(t.name, t.files[0]);
      b.append(img);
    } else {
      b.append(el('span', 'pack-text', (t.name || '기본').slice(0, 2)));
    }
    b.onclick = () => { current = t.name; refresh(); };
    if (t.name) {
      b.oncontextmenu = (e) => showMenu(e.clientX, e.clientY, [
        ['이름 변경', () => editTabName(b, t.name, async (name) => {
          if (name === t.name) return;
          await invoke('rename_tab', { from: t.name, to: name });
          for (const [key, url] of urls) {
            if (key.startsWith(t.name + '/')) { URL.revokeObjectURL(url); urls.delete(key); }
          }
          if (current === t.name) current = name;
        })],
        ['탭 삭제 (빈 탭만)', () => run(async () => { await invoke('delete_tab', { name: t.name }); await refresh(); })],
      ]);
    }
    nodes.push(b);
  }
  const add = el('button', 'pack pack-add', '+');
  add.title = '탭 추가';
  add.onclick = () => editTabName(add, '', async (name) => {
    await invoke('create_tab', { name });
    current = name;
  });
  nodes.push(add);
  nav.replaceChildren(...nodes);
}

// Swaps `node` for an inline name input; Enter/blur submits, Escape cancels.
function editTabName(node, initial, submit) {
  const input = el('input', 'pack-input');
  input.placeholder = '탭 이름';
  input.value = initial;
  node.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (ok && name) await run(() => submit(name));
    await refresh();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

async function renderGrid() {
  const grid = $('grid');
  const tab = tabs.find((t) => t.name === current);
  if (!tab || !tab.files.length) {
    grid.replaceChildren(el('p', 'empty', '이미지를 끌어다 놓거나\nCtrl+V로 붙여넣으세요'));
    return;
  }
  const cells = await Promise.all(tab.files.map(async (name) => {
    const cell = el('button', 'cell');
    const img = el('img');
    img.src = await imageUrl(tab.name, name);
    img.draggable = false;
    cell.append(img);
    cell.onclick = () => {
      if (dragged) return;
      run(() => copyImage(img, cell));
    };
    cell.onpointerdown = (e) => {
      if (e.button === 0) dragFrom = { x: e.clientX, y: e.clientY, img };
    };
    cell.oncontextmenu = (e) => showMenu(e.clientX, e.clientY, [
      ['복사', () => run(() => copyImage(img, cell))],
      ['삭제', () => run(async () => {
        await invoke('delete_image', { tab: tab.name, name });
        URL.revokeObjectURL(urls.get(tab.name + '/' + name));
        urls.delete(tab.name + '/' + name);
        await refresh();
      })],
    ]);
    return cell;
  }));
  grid.replaceChildren(...cells);
}

async function run(fn) {
  try {
    await fn();
  } catch (e) {
    toast(String(e), true);
  }
}

// ---------- copy / drag out ----------

// Composites the stored (transparent) image onto the chat background color so
// KakaoTalk cannot add its own white/black backdrop.
function composite(img) {
  const size = settings.size;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = settings.bg;
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  const r = fitBox(img.naturalWidth, img.naturalHeight, size, settings.pad);
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  return c;
}

async function copyImage(img, cell) {
  const c = composite(img);
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  await invoke('copy_image', { width: c.width, height: c.height, rgba: Array.from(data) });
  cell.classList.remove('copied');
  void cell.offsetWidth;
  cell.classList.add('copied');
  toast('복사했어요 · 카톡에서 Ctrl+V');
}

// Dragging a cell out of the window starts a native file drag of the composited
// PNG, which KakaoTalk accepts like a file dropped from Explorer.
const DRAG_THRESHOLD = 6;
let dragFrom = null; // pointer-down position on a cell
let dragged = false; // suppresses the click (copy) that may follow a drag
let draggingOut = false; // our own outgoing drag must not trigger import

addEventListener('pointerdown', () => { dragged = false; draggingOut = false; }, true);
addEventListener('pointerup', () => { dragFrom = null; });
addEventListener('pointermove', (e) => {
  if (!dragFrom || !(e.buttons & 1)) return;
  if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) < DRAG_THRESHOLD) return;
  const { img } = dragFrom;
  dragFrom = null;
  dragged = true;
  draggingOut = true;
  run(async () => {
    const blob = await new Promise((res) => composite(img).toBlob(res, 'image/png'));
    const png = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke('start_drag', { png });
  });
});

// ---------- import ----------

const canvasOf = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

async function processImage(blob) {
  const bmp = await createImageBitmap(blob);
  let c = canvasOf(bmp.width, bmp.height);
  let ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  if (settings.removeBg) {
    const data = ctx.getImageData(0, 0, c.width, c.height);
    if (removeBackground(data, settings.tol)) {
      ctx.putImageData(data, 0, 0);
      const b = alphaBBox(data);
      const t = canvasOf(b.w, b.h);
      t.getContext('2d').drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      c = t;
    }
  }

  const scale = Math.min(1, STORE_MAX / Math.max(c.width, c.height));
  if (scale < 1) {
    const t = canvasOf(Math.max(1, Math.round(c.width * scale)), Math.max(1, Math.round(c.height * scale)));
    ctx = t.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, t.width, t.height);
    c = t;
  }
  const png = await new Promise((res) => c.toBlob(res, 'image/png'));
  return new Uint8Array(await png.arrayBuffer());
}

async function importBlobs(blobs) {
  const images = blobs.filter((b) => b && b.type.startsWith('image/'));
  if (!images.length) return;
  let ok = 0;
  for (const blob of images) {
    try {
      const bytes = await processImage(blob);
      await invoke('save_image', { tab: current, bytes: Array.from(bytes) });
      ok++;
    } catch (e) {
      toast(`${blob.name || '이미지'}: ${e}`, true);
    }
  }
  await refresh();
  if (ok) toast(`${ok}개 추가했어요`);
}

$('btn-add').onclick = () => $('file').click();
$('file').onchange = (e) => { importBlobs([...e.target.files]); e.target.value = ''; };

document.addEventListener('paste', (e) => {
  if (e.target.closest('input')) return;
  const files = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
  if (files.length) { e.preventDefault(); importBlobs(files); }
});

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (draggingOut) return; dragDepth++; $('drop').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (!draggingOut) importBlobs([...e.dataTransfer.files]);
  draggingOut = false;
});

// ---------- pin ----------

async function setPinned(on) {
  await appWindow.setAlwaysOnTop(on);
  settings.pinned = on;
  saveSettings();
  $('btn-pin').classList.toggle('on', on);
  $('btn-pin').title = on ? '고정 해제' : '항상 위에 고정';
}
$('btn-pin').onclick = () => run(() => setPinned(!settings.pinned));

// ---------- settings ----------

// Shows a color without saving it (eyedropper live preview).
function showBg(hex) {
  document.documentElement.style.setProperty('--chat-bg', hex);
  $('set-bg').value = hex;
  $('set-bg-hex').value = hex.toUpperCase();
}

function applyBg(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  settings.bg = hex.toLowerCase();
  saveSettings();
  showBg(settings.bg);
}

function bindNumber(id, key, min, max) {
  const input = $(id);
  input.value = settings[key];
  input.onchange = () => {
    const v = Math.round(Number(input.value));
    if (Number.isFinite(v)) settings[key] = Math.min(max, Math.max(min, v));
    input.value = settings[key];
    saveSettings();
    document.documentElement.style.setProperty('--pad', settings.pad + '%');
  };
}

$('set-bg').oninput = (e) => applyBg(e.target.value);
$('set-bg-hex').onchange = (e) => {
  const v = e.target.value.trim();
  applyBg(v.startsWith('#') ? v : '#' + v);
  e.target.value = settings.bg.toUpperCase();
};
$('btn-bg-default').onclick = () => applyBg(KAKAO_DEFAULT_BG);
let picking = false;
$('btn-eyedropper').onclick = () => {
  if (picking) return;
  picking = true;
  const onMove = new window.__TAURI__.core.Channel();
  onMove.onmessage = showBg;
  toast('색을 찍을 곳(카톡 채팅방 배경)을 클릭하세요 · Esc 취소', false, 60000);
  run(async () => {
    try {
      const hex = await invoke('pick_screen_color', { onMove });
      if (hex) {
        applyBg(hex);
        toast(`배경색을 ${hex.toUpperCase()}로 바꿨어요`);
      } else {
        showBg(settings.bg);
        toast('스포이드를 취소했어요');
      }
    } finally {
      picking = false;
    }
  });
};
bindNumber('set-size', 'size', 32, 1024);
bindNumber('set-pad', 'pad', 0, 40);
bindNumber('set-tol', 'tol', 0, 128);
$('set-remove').checked = settings.removeBg;
$('set-remove').onchange = (e) => { settings.removeBg = e.target.checked; saveSettings(); };

// ---------- theme ----------

const systemDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Native title bar follows too (null = follow the OS).
  appWindow.setTheme(settings.theme === 'system' ? null : settings.theme).catch(() => {});
}
systemDark.addEventListener('change', applyTheme);
$('set-theme').value = settings.theme;
$('set-theme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
applyTheme();

$('btn-dir-apply').onclick = () => run(async () => {
  const dir = await invoke('open_gallery', { dir: $('set-dir').value });
  settings.dir = dir;
  saveSettings();
  $('set-dir').value = dir;
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
  current = '';
  await refresh();
  toast('갤러리 폴더를 바꿨어요');
});
$('btn-dir-open').onclick = () => run(() => invoke('reveal_gallery'));

$('btn-settings').onclick = () => { $('settings').hidden = !$('settings').hidden; };
$('btn-settings-close').onclick = () => { $('settings').hidden = true; };

// ---------- start ----------

(async () => {
  applyBg(settings.bg);
  document.documentElement.style.setProperty('--pad', settings.pad + '%');
  await run(async () => {
    let dir;
    try {
      dir = await invoke('open_gallery', { dir: settings.dir || null });
    } catch (e) {
      toast(`갤러리 폴더를 열 수 없어 기본 폴더를 써요: ${e}`, true);
      dir = await invoke('open_gallery', { dir: null });
    }
    $('set-dir').value = dir;
    if (settings.pinned) await setPinned(true);
    await refresh();
  });
})();
