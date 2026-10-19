'use strict';
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const list = document.getElementById('list');
const saveAllBtn = document.getElementById('saveAll');
const clearBtn = document.getElementById('clear');
const summary = document.getElementById('summary');
const savedCount = document.getElementById('savedCount');

const autoSaveEl = document.getElementById('autoSave');
const overwriteEl = document.getElementById('overwrite');

const items = []; // { name, blob, found, saved, ui }
let queue = Promise.resolve();
const inExtension = !!(window.chrome && chrome.runtime && chrome.runtime.id);

// ---------- Tuỳ chọn lưu ----------
// keepAiInfo: giữ nhãn "tạo bằng AI" (XMP/IPTC) trong ảnh đã xử lý — bật/tắt ở popup.
const opts = { toolAutoSave: true, toolOverwrite: false, keepAiInfo: false };
function applyOpts() {
  autoSaveEl.checked = opts.toolAutoSave;
  overwriteEl.checked = opts.toolOverwrite;
}
applyOpts();
if (inExtension) {
  chrome.storage.local.get(opts, (s) => { Object.assign(opts, s); applyOpts(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.keepAiInfo) opts.keepAiInfo = !!changes.keepAiInfo.newValue;
  });
}
autoSaveEl.addEventListener('change', () => {
  opts.toolAutoSave = autoSaveEl.checked;
  if (inExtension) chrome.storage.local.set({ toolAutoSave: opts.toolAutoSave });
});
overwriteEl.addEventListener('change', () => {
  opts.toolOverwrite = overwriteEl.checked;
  if (inExtension) chrome.storage.local.set({ toolOverwrite: opts.toolOverwrite });
});

function outName(name, type) {
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type] || '.png';
  const base = name.replace(/\.[^.]+$/, '');
  return opts.toolOverwrite ? base + ext : base + '_xoa-logo' + ext;
}

/*
 * Lưu vào thư mục tải xuống của Chrome, không hỏi vị trí. Đi qua background để
 * giữ đúng tên file và cho phép ghi đè ảnh gốc khi người dùng bật tuỳ chọn.
 */
async function save(item) {
  const url = URL.createObjectURL(item.blob);
  const filename = outName(item.name, item.blob.type);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  let ok = false;
  if (inExtension) {
    try {
      const res = await chrome.runtime.sendMessage({ cmd: 'save-file', url, filename, overwrite: opts.toolOverwrite });
      ok = !!(res && res.ok);
    } catch (e) {
      console.warn(e);
    }
  }
  if (!ok) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  item.saved = true;
  item.ui.chip.textContent = opts.toolOverwrite ? 'Đã xoá logo · đã thay ảnh gốc' : 'Đã xoá logo · đã lưu';
  item.ui.btn.textContent = 'Lưu lại';
  item.ui.btn.className = '';
  refreshBar();
}

function refreshBar() {
  const done = items.filter((i) => i.found);
  const unsaved = done.filter((i) => !i.saved);
  saveAllBtn.disabled = unsaved.length === 0;
  saveAllBtn.textContent = unsaved.length > 1
    ? `Lưu ${unsaved.length} ảnh chưa lưu`
    : 'Lưu ảnh chưa lưu';
  clearBtn.disabled = items.length === 0;
  summary.textContent = items.length
    ? `${done.length}/${items.length} ảnh đã xoá logo`
    : '';
  savedCount.textContent = done.length - unsaved.length;
}

// Vẽ vùng quanh logo, phóng to, để so sánh trước/sau.
function drawZoom(canvas, bmp, box) {
  const size = 240;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, size, size);
}

function zoomBox(W, H, res) {
  if (!res || res.cx === undefined) {
    const s = Math.min(W, H, Math.max(64, Math.round(0.12 * Math.max(W, H))));
    return { x: W - s, y: H - s, w: s, h: s };
  }
  const S = GeminiWM.cornerSize(W, H);
  const cx = W - S + res.cx, cy = H - S + res.cy;
  const half = Math.max(24, res.r * 2.2);
  const x = Math.max(0, Math.min(W - 2 * half, cx - half));
  const y = Math.max(0, Math.min(H - 2 * half, cy - half));
  return { x, y, w: Math.min(W, 2 * half), h: Math.min(H, 2 * half) };
}

function makeCard(file) {
  const card = document.createElement('div');
  card.className = 'card';
  const pair = document.createElement('div');
  pair.className = 'pair';
  const figs = ['Trước', 'Sau'].map((label) => {
    const fig = document.createElement('figure');
    const cv = document.createElement('canvas');
    const cap = document.createElement('figcaption');
    cap.textContent = label;
    fig.append(cv, cap);
    pair.append(fig);
    return cv;
  });
  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = file.name;
  name.title = file.name;
  const row = document.createElement('div');
  row.className = 'row';
  const chip = document.createElement('span');
  chip.className = 'chip busy';
  chip.textContent = 'Đang xử lý…';
  const dims = document.createElement('span');
  dims.className = 'muted';
  row.append(chip, dims);
  const btn = document.createElement('button');
  btn.textContent = 'Tải về';
  btn.disabled = true;
  info.append(name, row, btn);
  card.append(pair, info);
  list.prepend(card);
  return { before: figs[0], after: figs[1], chip, dims, btn };
}

async function handle(file) {
  const ui = makeCard(file);
  try {
    const t0 = performance.now();
    const { blob, result } = await GeminiWM.processBlob(file, {
      keepMeta: opts.keepAiInfo,
      lossy: clipboardImages.has(file) ? true : undefined,
    });
    const ms = Math.round(performance.now() - t0);
    const before = await createImageBitmap(file);
    const after = result.found ? await createImageBitmap(blob) : before;
    const box = zoomBox(before.width, before.height, result.found ? result : null);
    drawZoom(ui.before, before, box);
    drawZoom(ui.after, after, box);
    ui.dims.textContent = `${before.width}×${before.height} · ${ms} ms`;

    const item = { name: file.name, blob, found: !!result.found, saved: false, ui };
    items.push(item);
    if (result.found) {
      ui.chip.className = 'chip ok';
      ui.chip.textContent = 'Đã xoá logo';
      ui.btn.disabled = false;
      ui.btn.textContent = 'Lưu';
      ui.btn.className = 'primary';
      ui.btn.addEventListener('click', () => save(item));
      if (inExtension) {
        chrome.runtime.sendMessage({ cmd: 'removed', name: file.name, via: 'tool' }).catch(() => {});
      }
      if (opts.toolAutoSave) await save(item);
    } else {
      ui.chip.className = 'chip none';
      ui.chip.textContent = result.reason === 'not-image' ? 'Không phải ảnh' : 'Không thấy logo';
      ui.btn.textContent = 'Không cần xử lý';
    }
  } catch (e) {
    console.error(e);
    ui.chip.className = 'chip err';
    ui.chip.textContent = 'Lỗi đọc ảnh';
    ui.btn.textContent = 'Không xử lý được';
  }
  refreshBar();
}

const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);

function addFiles(files) {
  let n = 0;
  for (const f of files) {
    if (!isImageFile(f)) continue;
    queue = queue.then(() => handle(f));
    n++;
  }
  return n;
}

// ---------- Dán ảnh / file / link / đường dẫn (Ctrl+V) ----------
const urlForm = document.getElementById('urlForm');
const urlInput = document.getElementById('urlInput');
const pasteMsg = document.getElementById('pasteMsg');
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

function showMsg(text, kind) {
  pasteMsg.textContent = text;
  pasteMsg.className = 'paste-msg' + (kind ? ' ' + kind : '');
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Ảnh sao chép (chuột phải → Sao chép hình ảnh) được Chrome chuyển thành PNG trong bộ nhớ tạm,
// nhưng nguồn thường là JPG/WebP — xử lý như ảnh nén để sạch viền logo.
const clipboardImages = new WeakSet();

// Ảnh dán từ bộ nhớ tạm thường tên "image.png" — đặt tên dễ nhận ra hơn.
function pastedName(f, i) {
  if (f.name && !/^image\.(png|jpe?g|webp)$/i.test(f.name)) return f;
  const out = new File([f], `anh-dan_${stamp()}${i ? '_' + (i + 1) : ''}${EXT[f.type] || '.png'}`, { type: f.type });
  clipboardImages.add(out);
  return out;
}

// Đường dẫn Windows / file:// → URL file:///
function toFileUrl(text) {
  const p = text.trim().replace(/^"(.*)"$/, '$1');
  if (/^file:\/\//i.test(p)) return p;
  const enc = (s) => s.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  if (/^[a-zA-Z]:[\\/]/.test(p)) return 'file:///' + p[0] + ':' + enc(p.slice(2).replace(/\\/g, '/'));
  if (/^\\\\[^\\]/.test(p)) return 'file:' + enc(p.replace(/\\/g, '/'));
  return null;
}

// fetch() không đọc được file:// — dùng XHR (cần quyền "truy cập URL của tệp").
function readFileUrl(url) {
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'blob';
    x.onload = () => (x.response && x.response.size ? ok(x.response) : fail(new Error('empty')));
    x.onerror = () => fail(new Error('read'));
    x.send();
  });
}

function fileAccessHint() {
  return new Promise((ok) => {
    const ext = window.chrome && chrome.extension;
    if (!ext || !ext.isAllowedFileSchemeAccess) return ok('Không đọc được file từ đường dẫn này.');
    ext.isAllowedFileSchemeAccess((allowed) => ok(allowed
      ? 'Không đọc được file — kiểm tra lại đường dẫn.'
      : 'Chưa cho phép đọc file trên máy: vào chrome://extensions → DT Remove Gemini → Chi tiết → bật “Cho phép truy cập vào URL của tệp”. Hoặc copy file (Ctrl+C) rồi dán vào đây.'));
  });
}

// Link xem file Google Drive → link tải trực tiếp.
function driveDirect(u) {
  const m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : u;
}

function nameFromHeaders(r) {
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : '';
}

function nameFromUrl(u, type) {
  let base = '';
  try { base = decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch (e) { /* bỏ qua */ }
  base = base.replace(/[\\/:*?"<>|=]+/g, '-').slice(0, 80);
  if (/\.(png|jpe?g|webp)$/i.test(base)) return base;
  return (base && base.length <= 40 ? base : 'anh-tu-link_' + stamp()) + (EXT[type] || '.png');
}

// Tải ảnh từ link. Nếu link là trang web, lấy ảnh đại diện (og:image) của trang.
async function fetchImageUrl(u) {
  const r = await fetch(driveDirect(u), { credentials: 'include' });
  if (!r.ok) throw new Error(`Không tải được link (lỗi ${r.status}).`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    const html = await r.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (!m) throw new Error('Link này là trang web, không phải ảnh. Hãy mở ảnh, chuột phải → Sao chép địa chỉ hình ảnh.');
    const img = new URL(m[1].replace(/&amp;/g, '&'), r.url).href;
    const r2 = await fetch(img, { credentials: 'include' });
    if (!r2.ok) throw new Error(`Không tải được ảnh của trang (lỗi ${r2.status}).`);
    const blob = await r2.blob();
    return { blob, name: nameFromHeaders(r2) || nameFromUrl(img, blob.type) };
  }
  const blob = await r.blob();
  return { blob, name: nameFromHeaders(r) || nameFromUrl(r.url || u, blob.type) };
}

// Mỗi dòng: link http(s), data:image, đường dẫn Windows hoặc file://. Trả về { added, err }.
async function addFromText(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  let added = 0, lastErr = '';
  for (const line of lines) {
    try {
      const fileUrl = toFileUrl(line);
      let blob, name;
      if (fileUrl) {
        try { blob = await readFileUrl(fileUrl); } catch (e) { throw new Error(await fileAccessHint()); }
        name = decodeURIComponent(fileUrl.split('/').pop());
      } else if (/^data:image\//i.test(line)) {
        blob = await (await fetch(line)).blob();
        name = `anh-dan_${stamp()}${EXT[blob.type] || '.png'}`;
      } else if (/^https?:\/\//i.test(line)) {
        showMsg('Đang tải ảnh từ link…');
        ({ blob, name } = await fetchImageUrl(line));
      } else {
        continue;
      }
      // Kiểu ảnh do engine tự nhận từ nội dung file, không dựa vào phần mở rộng.
      const f = new File([blob], name, { type: blob.type || 'application/octet-stream' });
      queue = queue.then(() => handle(f));
      added++;
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { added, err: lastErr };
}

function report(added, err) {
  if (added && err) showMsg(`Đã thêm ${added} ảnh. ${err}`, 'err');
  else if (added) showMsg(`Đã thêm ${added} ảnh.`, 'ok');
  else showMsg(err || 'Không thấy ảnh, link ảnh hay đường dẫn file trong nội dung vừa dán.', 'err');
}

const looksLikeSource = (text) => text.split(/\r?\n/).some((s) => {
  s = s.trim().replace(/^"(.*)"$/, '$1');
  return /^(https?:\/\/|data:image\/)/i.test(s) || !!toFileUrl(s);
});

// Ảnh kéo từ trang web khác sang thường là link (text/uri-list) hoặc thẻ <img>.
function textFromTransfer(dt) {
  const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((s) => s && !s.startsWith('#')).join('\n');
  if (uri) return uri;
  const html = dt.getData('text/html');
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1].replace(/&amp;/g, '&');
  return dt.getData('text/plain') || '';
}

/*
 * Dán (Ctrl+V) chỉ đưa nội dung vào chỗ chờ: ảnh vào khay bên dưới ô nhập, link / đường dẫn
 * vào ô nhập. Bấm "Xoá logo" (hoặc Enter trong ô nhập) thì mới xử lý.
 */
const tray = document.getElementById('tray');
const runBtn = document.getElementById('runBtn');
const pending = []; // { file, url }

function renderTray() {
  tray.textContent = '';
  tray.hidden = pending.length === 0;
  for (const p of pending) {
    const el = document.createElement('div');
    el.className = 'pending';
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = p.file.name;
    name.title = p.file.name;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Bỏ ảnh này';
    del.addEventListener('click', () => {
      pending.splice(pending.indexOf(p), 1);
      URL.revokeObjectURL(p.url);
      renderTray();
    });
    el.append(img, name, del);
    tray.append(el);
  }
  runBtn.textContent = pending.length ? `Xoá logo (${pending.length} ảnh)` : 'Xoá logo';
}

function fitInput() {
  urlInput.style.height = '';
  urlInput.style.height = Math.min(urlInput.scrollHeight + 2, 128) + 'px';
}
urlInput.addEventListener('input', fitInput);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    urlForm.requestSubmit();
  }
});

const WAIT_HINT = 'bấm “Xoá logo” để chạy.';

document.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  // 1) File copy từ thư mục (Ctrl+C trong File Explorer) hoặc ảnh đã sao chép / ảnh chụp màn hình
  let files = [...dt.files].filter(isImageFile);
  if (!files.length) {
    files = [...dt.items].filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile()).filter(Boolean);
  }
  if (files.length) {
    e.preventDefault();
    for (const f of files.map(pastedName)) pending.push({ file: f, url: URL.createObjectURL(f) });
    renderTray();
    showMsg(`Đã dán ${files.length} ảnh vào hàng chờ, ${WAIT_HINT}`, 'ok');
    return;
  }
  // 2) Link ảnh / đường dẫn file / thẻ <img> trong nội dung HTML → vào ô nhập
  const text = textFromTransfer(dt).trim();
  if (!text) return;
  const ok = looksLikeSource(text);
  if (e.target === urlInput && dt.getData('text/plain')) {
    // Dán thẳng vào ô nhập: để trình duyệt chèn như bình thường.
    setTimeout(fitInput);
    if (ok) showMsg(`Đã dán vào ô, ${WAIT_HINT}`, 'ok');
    return;
  }
  e.preventDefault();
  if (!ok) return showMsg('Nội dung vừa dán không phải ảnh, link ảnh hay đường dẫn file.', 'err');
  const cur = urlInput.value.replace(/\s+$/, '');
  urlInput.value = cur ? cur + '\n' + text : text;
  fitInput();
  urlInput.focus();
  showMsg(`Đã dán vào ô bên dưới, ${WAIT_HINT}`, 'ok');
});

urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = urlInput.value.trim();
  const files = pending.splice(0).map((p) => (URL.revokeObjectURL(p.url), p.file));
  renderTray();
  if (!text && !files.length) {
    return showMsg('Dán ảnh (Ctrl+V), link ảnh hoặc đường dẫn file vào trước, rồi bấm “Xoá logo”.', 'err');
  }
  let added = files.length ? addFiles(files) : 0;
  let err = '';
  if (text) {
    const r = await addFromText(text);
    added += r.added;
    err = r.err;
    if (r.added) {
      urlInput.value = '';
      fitInput();
    }
  }
  report(added, err);
});

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});
['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
['dragleave', 'drop'].forEach((t) =>
  drop.addEventListener(t, () => drop.classList.remove('over')));
function onDrop(e) {
  e.preventDefault();
  if (addFiles(e.dataTransfer.files)) return;
  const text = textFromTransfer(e.dataTransfer).trim();
  if (text) addFromText(text).then((r) => report(r.added, r.err));
}
drop.addEventListener('drop', onDrop);
// Cho phép thả ảnh ở bất kỳ đâu trên trang.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (e.target !== drop && !drop.contains(e.target)) onDrop(e);
  else e.preventDefault();
});

saveAllBtn.addEventListener('click', async () => {
  for (const item of items.filter((i) => i.found && !i.saved)) {
    await save(item);
    await new Promise((r) => setTimeout(r, 250));
  }
});
clearBtn.addEventListener('click', () => {
  items.length = 0;
  list.textContent = '';
  refreshBar();
});

// Ảnh sạch được lưu vào thư mục tải xuống của Chrome — mở thư mục đó.
document.getElementById('openFolder').addEventListener('click', () => {
  if (inExtension && chrome.downloads && chrome.downloads.showDefaultFolder) chrome.downloads.showDefaultFolder();
  else document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
});

// ---------- Ủng hộ tác giả: nút sao chép ----------
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Đã chép ✓';
    } catch (e) {
      btn.textContent = 'Không chép được';
    }
    setTimeout(() => (btn.textContent = 'Sao chép'), 1500);
  });
}
