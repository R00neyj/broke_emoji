'use strict';

const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const { removeBackground, eraseAt, alphaBBox, fitBox } = window.imaging;

// Imported images are stored at most this large (KakaoTalk emoticon reference size).
const STORE_MAX = 360;
const KAKAO_DEFAULT_BG = '#bacee0';

const DEFAULTS = { bg: KAKAO_DEFAULT_BG, size: 120, pad: 0, fit: 'contain', removeBg: true, tol: 24, dock: false, dockSide: 'right', autostart: false, dir: '', theme: 'system' };
// settings.json next to the exe, injected by the backend before this script runs.
const settings = { ...DEFAULTS, ...parseSettings(window.__SETTINGS__) };
delete settings.pinned; // replaced by dock
delete settings.background; // dock now always keeps the app in the tray
function parseSettings(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
// Persists and tells the other window (gallery ⇄ settings) to re-sync.
const saveSettings = () => invoke('save_settings', { json: JSON.stringify(settings, null, 2) })
  .then(() => window.__TAURI__.event.emit('settings-changed', settings))
  .catch((e) => toast(String(e), true));

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

// Gallery fingerprint as of the last refresh; see the folder watch below.
let stamp = '';

async function refresh() {
  // Stamp before listing so a change landing in between is caught by the next poll.
  stamp = await invoke('gallery_stamp');
  tabs = await invoke('list_tabs');
  if (!tabs.some((t) => t.name === current)) {
    current = '';
    if (selection) endSelection();
  }
  if (selection) {
    const files = new Set(tabs.find((t) => t.name === current).files);
    for (const name of selection) if (!files.has(name)) selection.delete(name);
    renderSelectBar();
  }
  await Promise.all([renderPacks(), renderGrid()]);
}

// Picks up changes made outside the app (files copied in via Explorer, edits,
// new folders) by polling the folder fingerprint; avoids a file-watcher crate.
const WATCH_MS = 1500;
let watching = false;
function watchGallery() {
  setInterval(async () => {
    // Skip while minimized or while a tab name is being edited (refresh would drop the input).
    if (watching || document.hidden || document.querySelector('.pack-input')) return;
    watching = true;
    try {
      if (await invoke('gallery_stamp') === stamp) return;
      // Files may have been overwritten under the same name, so drop cached images.
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
      await refresh();
    } catch {
      stamp = ''; // e.g. a file still being copied; retry on the next tick
    } finally {
      watching = false;
    }
  }, WATCH_MS);
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
    b.onclick = () => { if (selection) endSelection(); current = t.name; refresh(); };
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
    const cell = el('button', 'cell' + (selection?.has(name) ? ' selected' : ''));
    const img = el('img');
    img.src = await imageUrl(tab.name, name);
    img.draggable = false;
    cell.append(img);
    cell.onclick = () => {
      if (dragged) return;
      if (selection) toggleSelected(name, cell);
      else run(() => copyImage(img, cell));
    };
    cell.onpointerdown = (e) => {
      if (e.button !== 0) return;
      if (!selection) dragFrom = { x: e.clientX, y: e.clientY, img };
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (selection) return;
        // Long press: enter multi-select with this cell; swallow the click that follows.
        dragFrom = null;
        dragged = true;
        selection = new Set();
        toggleSelected(name, cell);
      }, LONG_PRESS_MS);
    };
    cell.oncontextmenu = (e) => {
      if (selection) return;
      showMenu(e.clientX, e.clientY, [
        ['복사', () => run(() => copyImage(img, cell))],
        ['자르기', () => openCropper(tab.name, name, img)],
        ['투명 처리 (클릭해서 지우기)', () => openEraser(tab.name, name, img)],
        ['여러 개 선택', () => { selection = new Set(); toggleSelected(name, cell); }],
        ['삭제', () => run(() => deleteImages(tab.name, [name]))],
      ]);
    };
    return cell;
  }));
  grid.replaceChildren(...cells);
}

// ---------- multi-select (long press) ----------

const LONG_PRESS_MS = 450;
let pressTimer;
let selection = null; // Set of file names in the current tab while selecting

addEventListener('pointerup', () => clearTimeout(pressTimer));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && selection) endSelection(); });

function toggleSelected(name, cell) {
  if (selection.has(name)) selection.delete(name);
  else selection.add(name);
  cell.classList.toggle('selected', selection.has(name));
  renderSelectBar();
}

function endSelection() {
  selection = null;
  $('selectbar').hidden = true;
  document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
}

function renderSelectBar() {
  $('selectbar').hidden = false;
  $('sel-count').textContent = `${selection.size}개 선택`;
  $('sel-move').disabled = $('sel-delete').disabled = selection.size === 0;
}

async function deleteImages(tab, names) {
  for (const name of names) {
    await invoke('delete_image', { tab, name });
    URL.revokeObjectURL(urls.get(tab + '/' + name));
    urls.delete(tab + '/' + name);
  }
  await refresh();
}

$('sel-done').onclick = endSelection;
$('sel-all').onclick = () => {
  const tab = tabs.find((t) => t.name === current);
  const all = selection.size === tab.files.length;
  selection = new Set(all ? [] : tab.files);
  document.querySelectorAll('.cell').forEach((c, i) => c.classList.toggle('selected', selection.has(tab.files[i])));
  renderSelectBar();
};
$('sel-delete').onclick = () => run(async () => {
  const names = [...selection];
  await deleteImages(current, names);
  endSelection();
  toast(`${names.length}개 삭제했어요`);
});
$('sel-move').onclick = (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  const targets = tabs.filter((t) => t.name !== current);
  if (!targets.length) { toast('옮길 다른 탭이 없어요. + 로 탭을 먼저 만드세요', true); return; }
  showMenu(r.left, r.top - 8 - targets.length * 32, targets.map((t) => [`→ ${t.name || '기본'}`, () => run(async () => {
    const names = [...selection];
    for (const name of names) {
      await invoke('move_image', { from: current, name, to: t.name });
      URL.revokeObjectURL(urls.get(current + '/' + name));
      urls.delete(current + '/' + name);
    }
    endSelection();
    await refresh();
    toast(`${names.length}개를 '${t.name || '기본'}' 탭으로 옮겼어요`);
  })]));
};

// ---------- crop ----------

// Crop rectangle in source-image pixels; the box on screen is derived from it.
// The box may extend past the image inside a square "frame" of the image's long
// side, so a wide/tall image can be squared without losing anything; the extra
// area stays transparent and is filled with the chat background on copy.
const crop = { tab: '', name: '', img: null, x: 0, y: 0, w: 0, h: 0, scale: 1, ox: 0, oy: 0, frame: null };
const MIN_CROP = 8;

function openCropper(tab, name, img) {
  const iw = img.naturalWidth, ih = img.naturalHeight, side = Math.max(iw, ih);
  const frame = { x: (iw - side) / 2, y: (ih - side) / 2, w: side, h: side };
  Object.assign(crop, { tab, name, img, frame });
  $('crop-img').src = img.src;
  $('cropper').hidden = false;
  // Default: the largest centered square that stays inside the image.
  const inner = Math.min(iw, ih);
  Object.assign(crop, { x: (iw - inner) / 2, y: (ih - inner) / 2, w: inner, h: inner });
  if (!$('crop-square').checked) Object.assign(crop, { x: 0, y: 0, w: iw, h: ih });
  layoutCrop();
}

// Room around the frame so handles on its edge are not clipped by the stage.
const CROP_INSET = 12;

function layoutCrop() {
  const { img, frame } = crop;
  const stage = $('crop-stage').getBoundingClientRect();
  const scale = Math.max(1, Math.min(stage.width, stage.height) - 2 * CROP_INSET) / frame.w;
  // Screen origin of image pixel (0,0), with the frame centered in the stage.
  const ox = (stage.width - frame.w * scale) / 2 - frame.x * scale;
  const oy = (stage.height - frame.h * scale) / 2 - frame.y * scale;
  Object.assign(crop, { scale, ox, oy });
  Object.assign($('crop-img').style, {
    left: ox + 'px', top: oy + 'px',
    width: img.naturalWidth * scale + 'px', height: img.naturalHeight * scale + 'px',
  });
  drawCropBox();
}

function drawCropBox() {
  const s = crop.scale;
  Object.assign($('crop-box').style, {
    left: crop.ox + crop.x * s + 'px', top: crop.oy + crop.y * s + 'px',
    width: crop.w * s + 'px', height: crop.h * s + 'px',
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Resizes by the dragged handle (`dir`: "n", "se", ...); the opposite edges stay put.
// With the square lock, an edge handle keeps the box centered on the other axis,
// shifting it as needed so it can still grow to the full frame.
function resizeCrop(start, dir, dx, dy) {
  const f = crop.frame, fr = f.x + f.w, fb = f.y + f.h;
  const W = dir.includes('w'), E = dir.includes('e'), N = dir.includes('n'), S = dir.includes('s');
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (W) l = clamp(l + dx, f.x, r - MIN_CROP);
  if (E) r = clamp(r + dx, l + MIN_CROP, fr);
  if (N) t = clamp(t + dy, f.y, b - MIN_CROP);
  if (S) b = clamp(b + dy, t + MIN_CROP, fb);
  if ($('crop-square').checked) {
    const horiz = W || E, vert = N || S;
    // Room from the fixed edges toward the dragged ones.
    const roomX = W ? r - f.x : E ? fr - l : f.w;
    const roomY = N ? b - f.y : S ? fb - t : f.h;
    const want = horiz && vert ? Math.max(r - l, b - t) : horiz ? r - l : b - t;
    const side = clamp(want, MIN_CROP, Math.min(roomX, roomY));
    if (W) l = r - side;
    else if (E) r = l + side;
    else { l = clamp((l + r - side) / 2, f.x, fr - side); r = l + side; }
    if (N) t = b - side;
    else if (S) b = t + side;
    else { t = clamp((t + b - side) / 2, f.y, fb - side); b = t + side; }
  }
  Object.assign(crop, { x: l, y: t, w: r - l, h: b - t });
}

$('crop-box').onpointerdown = (e) => {
  e.preventDefault();
  const box = $('crop-box');
  box.setPointerCapture(e.pointerId);
  const dir = e.target.closest('.crop-handle')?.dataset.dir;
  const start = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y, w: crop.w, h: crop.h };
  const f = crop.frame, right = f.x + f.w, bottom = f.y + f.h;
  box.onpointermove = (m) => {
    const dx = (m.clientX - start.px) / crop.scale, dy = (m.clientY - start.py) / crop.scale;
    if (dir) {
      resizeCrop(start, dir, dx, dy);
    } else {
      crop.x = clamp(start.x + dx, f.x, right - crop.w);
      crop.y = clamp(start.y + dy, f.y, bottom - crop.h);
    }
    drawCropBox();
  };
  box.onpointerup = () => { box.onpointermove = box.onpointerup = null; };
};

$('crop-square').onchange = (e) => {
  if (!e.target.checked) return;
  const side = Math.min(crop.w, crop.h);
  Object.assign(crop, { x: crop.x + (crop.w - side) / 2, y: crop.y + (crop.h - side) / 2, w: side, h: side });
  drawCropBox();
};

addEventListener('resize', () => { if (!$('cropper').hidden) layoutCrop(); });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('cropper').hidden) $('cropper').hidden = true;
  if (!$('eraser').hidden) $('eraser').hidden = true;
});
$('crop-cancel').onclick = () => { $('cropper').hidden = true; };

async function croppedPng() {
  const x = Math.round(crop.x), y = Math.round(crop.y);
  const w = Math.max(1, Math.round(crop.w)), h = Math.max(1, Math.round(crop.h));
  const c = canvasOf(w, h);
  // Areas of the box outside the image stay transparent.
  c.getContext('2d').drawImage(crop.img, -x, -y);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

$('crop-new').onclick = () => run(async () => {
  await invoke('save_image', { tab: crop.tab, bytes: await croppedPng() });
  $('cropper').hidden = true;
  await refresh();
  toast('잘라서 새 이미지로 저장했어요');
});
$('crop-overwrite').onclick = () => run(async () => {
  await invoke('replace_image', { tab: crop.tab, name: crop.name, bytes: await croppedPng() });
  const key = crop.tab + '/' + crop.name;
  URL.revokeObjectURL(urls.get(key));
  urls.delete(key);
  $('cropper').hidden = true;
  await refresh();
  toast('잘라서 덮어썼어요');
});

// ---------- magic-wand erase ----------

// Clicked areas become transparent (e.g. the inside of a letter "ㅇ", which the
// automatic removal keeps on white backgrounds to protect eyes and teeth).
// Previewed on the chat background, like the gallery.
const eraser = { tab: '', name: '', data: null, undo: [] };

function openEraser(tab, name, img) {
  const c = $('erase-canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.style.background = settings.bg;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  Object.assign(eraser, { tab, name, data: ctx.getImageData(0, 0, c.width, c.height), undo: [] });
  $('erase-undo').disabled = true;
  $('eraser').hidden = false;
  layoutEraser();
}

function layoutEraser() {
  const c = $('erase-canvas');
  const stage = $('erase-stage').getBoundingClientRect();
  const s = Math.min(stage.width / c.width, stage.height / c.height);
  Object.assign(c.style, {
    width: c.width * s + 'px', height: c.height * s + 'px',
    left: (stage.width - c.width * s) / 2 + 'px', top: (stage.height - c.height * s) / 2 + 'px',
  });
}

addEventListener('resize', () => { if (!$('eraser').hidden) layoutEraser(); });

$('erase-canvas').onclick = (e) => {
  const c = e.currentTarget, r = c.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) * c.width / r.width);
  const y = Math.floor((e.clientY - r.top) * c.height / r.height);
  const before = new Uint8ClampedArray(eraser.data.data);
  if (!eraseAt(eraser.data, x, y, settings.tol)) return;
  eraser.undo.push(before);
  $('erase-undo').disabled = false;
  c.getContext('2d').putImageData(eraser.data, 0, 0);
};

$('erase-undo').onclick = () => {
  const prev = eraser.undo.pop();
  if (!prev) return;
  eraser.data.data.set(prev);
  $('erase-canvas').getContext('2d').putImageData(eraser.data, 0, 0);
  $('erase-undo').disabled = !eraser.undo.length;
};

$('erase-cancel').onclick = () => { $('eraser').hidden = true; };

async function erasedPng() {
  const blob = await new Promise((res) => $('erase-canvas').toBlob(res, 'image/png'));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

$('erase-new').onclick = () => run(async () => {
  await invoke('save_image', { tab: eraser.tab, bytes: await erasedPng() });
  $('eraser').hidden = true;
  await refresh();
  toast('새 이미지로 저장했어요');
});
$('erase-overwrite').onclick = () => run(async () => {
  await invoke('replace_image', { tab: eraser.tab, name: eraser.name, bytes: await erasedPng() });
  const key = eraser.tab + '/' + eraser.name;
  URL.revokeObjectURL(urls.get(key));
  urls.delete(key);
  $('eraser').hidden = true;
  await refresh();
  toast('투명 처리해서 덮어썼어요');
});

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
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  // "original": paste at the stored image's own size, no canvas or scaling.
  if (settings.fit === 'original') {
    c.width = w;
    c.height = h;
    ctx.fillStyle = settings.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    return c;
  }
  const size = settings.size;
  c.width = c.height = size;
  ctx.fillStyle = settings.bg;
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  const cover = settings.fit === 'cover';
  const r = fitBox(w, h, size, settings.pad, cover);
  if (cover) {
    ctx.beginPath();
    ctx.rect(r.clip.x, r.clip.y, r.clip.w, r.clip.h);
    ctx.clip();
  }
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
  clearTimeout(pressTimer);
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
  const keepOriginalSize = settings.fit === 'original';
  const bmp = await createImageBitmap(blob);
  let c = canvasOf(bmp.width, bmp.height);
  let ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  if (settings.removeBg) {
    const data = ctx.getImageData(0, 0, c.width, c.height);
    if (removeBackground(data, settings.tol)) {
      ctx.putImageData(data, 0, 0);
      if (!keepOriginalSize) {
        const b = alphaBBox(data);
        const t = canvasOf(b.w, b.h);
        t.getContext('2d').drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
        c = t;
      }
    }
  }

  const scale = keepOriginalSize ? 1 : Math.min(1, STORE_MAX / Math.max(c.width, c.height));
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

// ---------- dock beside the KakaoTalk chat room ----------

async function setDock(on) {
  await invoke('set_dock', { on, left: settings.dockSide === 'left' });
  settings.dock = on;
  showDock();
}
function showDock() {
  $('btn-dock').classList.toggle('on', settings.dock);
  $('btn-dock').title = settings.dock ? '카톡 채팅방에서 떼기' : '카톡 채팅방 옆에 붙이기';
}
$('btn-dock').onclick = () => run(async () => {
  await setDock(!settings.dock);
  saveSettings();
});

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
  markPreset();
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

// KakaoTalk's built-in chat background colors (채팅방 설정 → 배경화면 → 색상).
const KAKAO_BG_PRESETS = [
  '#bacee0', '#677bac', '#9dcdb8', '#51a5a0', '#9bb157',
  '#f8cd59', '#f99460', '#f68181', '#f7a2bd', '#5b4d49',
  '#d3d5d0', '#525252', '#404372', '#10374a', '#818b9c',
];
$('bg-presets').replaceChildren(...KAKAO_BG_PRESETS.map((hex) => {
  const b = el('button', 'preset');
  b.type = 'button';
  b.title = hex.toUpperCase();
  b.style.background = hex;
  b.dataset.hex = hex;
  b.onclick = () => applyBg(hex);
  return b;
}));
function markPreset() {
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.hex === settings.bg));
}
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
$('set-fit').value = settings.fit;
$('set-fit').onchange = (e) => { settings.fit = e.target.value; saveSettings(); applyFit(); };
// Gallery preview mirrors what gets copied; "original" previews like contain.
// Size and padding do not apply to "original".
function applyFit() {
  const original = settings.fit === 'original';
  document.documentElement.style.setProperty('--fit', original ? 'contain' : settings.fit);
  $('set-size').disabled = $('set-pad').disabled = original;
}
applyFit();

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
$('set-dock-side').onchange = (e) => { settings.dockSide = e.target.value; saveSettings(); };
$('set-autostart').onchange = (e) => { settings.autostart = e.target.checked; saveSettings(); };

$('btn-dir-apply').onclick = () => run(async () => {
  const dir = await invoke('open_gallery', { dir: $('set-dir').value });
  settings.dir = dir;
  saveSettings();
  $('set-dir').value = dir;
  // The gallery window reloads on the settings-changed event.
  toast('갤러리 폴더를 바꿨어요');
});
$('btn-dir-open').onclick = () => run(() => invoke('reveal_gallery'));

// ---------- settings window ----------

// The same page runs in a separate "settings" window (window.__MODE__ set by the
// backend). Both windows share settings.json and sync through this event.
const SETTINGS_MODE = window.__MODE__ === 'settings';
const { listen } = window.__TAURI__.event;

function syncFromSettings() {
  showBg(settings.bg);
  markPreset();
  document.documentElement.style.setProperty('--pad', settings.pad + '%');
  for (const k of ['size', 'pad', 'tol']) $('set-' + k).value = settings[k];
  $('set-remove').checked = settings.removeBg;
  $('set-fit').value = settings.fit;
  $('set-theme').value = settings.theme;
  $('set-dock-side').value = settings.dockSide;
  $('set-autostart').checked = settings.autostart;
  applyFit();
  applyTheme();
}

listen('settings-changed', ({ payload }) => {
  const dirChanged = payload.dir !== settings.dir;
  const dockChanged = payload.dock !== settings.dock || payload.dockSide !== settings.dockSide;
  const autostartChanged = payload.autostart !== settings.autostart;
  Object.assign(settings, payload);
  syncFromSettings();
  if (SETTINGS_MODE) return;
  if (dockChanged) run(() => setDock(settings.dock));
  if (autostartChanged) run(() => invoke('set_autostart', { on: settings.autostart }));
  if (dirChanged) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
    current = '';
    run(refresh);
  }
});

$('btn-settings').onclick = () => run(() => invoke('open_settings'));

// ---------- start ----------

(async () => {
  syncFromSettings();
  if (SETTINGS_MODE) {
    document.body.classList.add('settings-mode');
    $('settings').hidden = false;
    $('set-dir').value = settings.dir || 'gallery';
    return;
  }
  await run(async () => {
    let dir;
    try {
      dir = await invoke('open_gallery', { dir: settings.dir || null });
    } catch (e) {
      toast(`갤러리 폴더를 열 수 없어 기본 폴더를 써요: ${e}`, true);
      dir = await invoke('open_gallery', { dir: null });
    }
    $('set-dir').value = dir;
    // Always: it also shows a window that was started hidden by autostart.
    await setDock(settings.dock);
    // Rewrites the Run entry so a moved exe keeps starting.
    if (settings.autostart) await invoke('set_autostart', { on: true });
    await refresh();
  });
  watchGallery();
})();
