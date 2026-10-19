/*
 * Service worker:
 *  - Chặn ở tầng TẢI XUỐNG của trình duyệt: mọi lượt tải ảnh (dù trang kích hoạt theo
 *    cách nào) được giữ lại trước khi lưu, kiểm tra logo Gemini; có logo thì huỷ lượt
 *    tải gốc và lưu bản đã xoá logo với đúng tên file, không có thì cho tải bình thường.
 *  - Tự chèn script vào các tab Gemini/Flow đang mở khi cài/tải lại tiện ích (không cần F5).
 *  - Lưu file cho trang công cụ, menu chuột phải, đếm số ảnh, nhật ký gần đây.
 */
'use strict';

const MENU_ID = 'gwm-download-clean';
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
// Các trang tạo ảnh có gắn logo Gemini, nơi content script được chèn (khớp manifest).
const AI_ORIGINS = [
  'https://gemini.google.com',
  'https://flow.google.com',
  'https://labs.google',
  'https://aistudio.google.com',
];

chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.local.get({ enabled: true, allSites: true, keepAiInfo: false, count: 0 }, (s) => chrome.storage.local.set(s));
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Tải ảnh đã xoá logo Gemini',
      contexts: ['image'],
      documentUrlPatterns: AI_ORIGINS.map((o) => o + '/*'),
    });
  });
  // Tab đang mở từ trước khi cài/tải lại tiện ích chưa có script — chèn ngay.
  const tabs = await chrome.tabs.query({ url: AI_ORIGINS.map((o) => o + '/*') });
  for (const t of tabs) injectInto(t.id);
});

async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['engine.js', 'inject.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['engine.js', 'bridge.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- Nhật ký gần đây (hiện trong popup) ----------
let logChain = Promise.resolve();
function addLog(entry) {
  logChain = logChain.then(async () => {
    const { gwmLog } = await chrome.storage.local.get({ gwmLog: [] });
    gwmLog.unshift(Object.assign({ t: Date.now() }, entry));
    await chrome.storage.local.set({ gwmLog: gwmLog.slice(0, 20) });
  }).catch(() => {});
}

// ---------- Trang ẩn xử lý ảnh ----------
let creatingOffscreen = null;
async function offscreen(msg) {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) {
    creatingOffscreen = creatingOffscreen || chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Xoá logo khỏi ảnh và tạo liên kết tải về cho bản đã xử lý.',
    }).finally(() => (creatingOffscreen = null));
    await creatingOffscreen;
  }
  return chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
}

// ---------- Nhận diện lượt tải ----------
function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function baseName(p) {
  return (p || '').split(/[\\/]/).pop();
}
function urlOf(item) {
  return item.finalUrl || item.url || '';
}
// Mô tả ngắn nguồn tải cho nhật ký (không lưu toàn bộ URL).
function sourceOf(url) {
  const scheme = (url.match(/^[a-z-]+:/i) || [''])[0];
  try { return scheme + ' ' + new URL(url).origin; } catch (e) { return scheme; }
}

// Origin (trong danh sách AI_ORIGINS) của một URL; với blob: là origin của trang tạo ra nó.
function aiOrigin(url) {
  try {
    const o = new URL(url).origin;
    return AI_ORIGINS.includes(o) ? o : '';
  } catch (e) {
    return '';
  }
}

function isGeminiSource(item) {
  const url = urlOf(item);
  return !!aiOrigin(url) || !!aiOrigin(item.referrer || '') ||
    /(^|\.)googleusercontent\.com$|(^|\.)usercontent\.google\.com$/i.test(hostOf(url));
}

function looksLikeImage(item) {
  const url = urlOf(item);
  if (/^image\/(png|jpe?g|webp)/i.test(item.mime || '')) return true;
  if (/^data:image\/(png|jpe?g|webp)/i.test(url)) return true;
  if (IMAGE_EXT.test(baseName(item.filename))) return true;
  try { if (IMAGE_EXT.test(new URL(url).pathname)) return true; } catch (e) { /* bỏ qua */ }
  // URL ảnh của Gemini thường không có đuôi file.
  return isGeminiSource(item) && (!item.mime || /octet-stream/i.test(item.mime));
}

// Hỏi các tab của trang đã tạo blob: URL. Trả về phản hồi đầu tiên có ích hoặc null.
async function askTabs(tabs, url) {
  for (const t of tabs) {
    let res = null;
    try { res = await chrome.tabs.sendMessage(t.id, { cmd: 'clean-blob-url', url }); } catch (e) { /* chưa có script */ }
    if (res && res.status !== 'unknown') return res;
  }
  return null;
}

/*
 * Lấy bản đã xoá logo cho một lượt tải.
 * Trả về { status: 'found', blobUrl, type } | { status: 'none' | 'unreadable' | 'unsupported' }.
 */
async function cleanFor(item, keepMeta) {
  const url = urlOf(item);
  if (url.startsWith('blob:')) {
    // blob: chỉ đọc được từ chính trang đã tạo ra nó — nhờ tab của trang đó xử lý hộ.
    const origin = aiOrigin(url);
    if (!origin) return { status: 'unsupported' };
    const tabs = await chrome.tabs.query({ url: origin + '/*' });
    let res = await askTabs(tabs, url);
    if (!res) {
      // Tab mở từ trước khi cài tiện ích: chèn script rồi hỏi lại.
      for (const t of tabs) await injectInto(t.id);
      res = await askTabs(tabs, url);
    }
    if (!res) return { status: 'unreadable' };
    if (res.status === 'pass') return { status: 'pass' }; // trang đã tự xoá logo trước đó
    if (res.status !== 'found') return { status: 'none' };
    const made = await offscreen({ cmd: 'blob-url', b64: res.b64, type: res.type });
    return made && made.ok ? Object.assign({ status: 'found' }, made) : { status: 'unreadable' };
  }
  if (!/^(https?|data):/i.test(url)) return { status: 'unsupported' };
  const res = await offscreen({ cmd: 'clean-url', url, keepMeta });
  if (!res || !res.ok) return { status: 'unreadable' };
  return res.found ? Object.assign({ status: 'found' }, res) : { status: 'none' };
}

// ---------- Báo kết quả ----------
async function announce() {
  const { count } = await chrome.storage.local.get({ count: 0 });
  await chrome.storage.local.set({ count: count + 1 });
  chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
  chrome.action.setBadgeText({ text: '✓' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && aiOrigin(tab.url || '')) {
    chrome.tabs.sendMessage(tab.id, { cmd: 'toast' }).catch(() => {});
  }
}

// ---------- Lưu file do tiện ích tạo ----------
const revokeAfter = new Map(); // id lượt tải bản sạch -> blob URL (offscreen) cần thu hồi
const wanted = new Map();      // blob URL -> { filename, conflictAction }

function saveOwn(url, filename, conflictAction) {
  // Khi có listener onDeterminingFilename, Chrome bỏ qua `filename` truyền vào
  // downloads.download(), nên phải đặt lại tên trong listener — nhớ trước ở đây.
  wanted.set(url, { filename, conflictAction });
  return chrome.downloads.download({ url, filename, conflictAction, saveAs: false });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const w = wanted.get(item.url);
    if (!w) return;
    wanted.delete(item.url);
    suggest(w);
    return;
  }
  if (!looksLikeImage(item)) return;
  // Trả về true: trình duyệt chờ tới khi gọi suggest(), file gốc chưa được lưu.
  handleDownload(item, suggest);
  return true;
});

async function handleDownload(item, suggest) {
  const name = baseName(item.filename);
  const src = sourceOf(urlOf(item));
  try {
    const s = await chrome.storage.local.get({ enabled: true, allSites: true, keepAiInfo: false });
    if (!s.enabled) {
      addLog({ name, src, result: 'off' });
    } else if (!s.allSites && !isGeminiSource(item)) {
      addLog({ name, src, result: 'other-site' });
    } else {
      const res = await cleanFor(item, s.keepAiInfo);
      if (res.status === 'found') {
        await chrome.downloads.cancel(item.id);
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[res.type] || '.png';
        const id = await saveOwn(res.blobUrl, name || 'Gemini_Generated_Image' + ext, 'uniquify');
        revokeAfter.set(id, res.blobUrl);
        chrome.downloads.erase({ id: item.id }).catch(() => {});
        announce();
      }
      if (res.status !== 'pass') addLog({ name, src, result: res.status });
    }
  } catch (e) {
    console.warn('[DT Remove Gemini]', e);
    addLog({ name, src, result: 'error', error: String(e && e.message) });
  }
  try { suggest(); } catch (e) { /* lượt tải đã bị huỷ */ }
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state && delta.state.current;
  if (!revokeAfter.has(delta.id) || (state !== 'complete' && state !== 'interrupted')) return;
  offscreen({ cmd: 'revoke', blobUrl: revokeAfter.get(delta.id) }).catch(() => {});
  revokeAfter.delete(delta.id);
});

// ---------- Menu chuột phải ----------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  const msg = { cmd: 'download-clean', url: info.srcUrl };
  const opts = { frameId: info.frameId || 0 };
  try {
    await chrome.tabs.sendMessage(tab.id, msg, opts);
  } catch (e) {
    // Tab mở từ trước khi cài tiện ích: chèn script rồi thử lại; không được thì tải thường
    // (lượt tải vẫn được lọc ở tầng tải xuống).
    if (await injectInto(tab.id)) {
      try { await chrome.tabs.sendMessage(tab.id, msg, opts); return; } catch (e2) { /* bỏ qua */ }
    }
    chrome.downloads.download({ url: info.srcUrl });
  }
});

// ---------- Tin nhắn từ trang ----------
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const ownPage = (sender) => sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  if (msg.cmd === 'removed') {
    // Trang (Gemini/Flow...) hoặc trang công cụ đã tự xoá logo.
    chrome.storage.local.get({ count: 0 }, (s) => chrome.storage.local.set({ count: s.count + 1 }));
    const src = sender.url && !ownPage(sender) ? new URL(sender.url).origin : '';
    addLog({ name: msg.name || '', src, result: msg.via || 'page' });
    return;
  }
  if (msg.cmd === 'save-file') {
    // Trang công cụ lưu ảnh đã xoá logo vào thư mục tải xuống, không hỏi vị trí.
    if (!ownPage(sender)) return;
    saveOwn(msg.url, msg.filename, msg.overwrite ? 'overwrite' : 'uniquify')
      .then((id) => sendResponse({ ok: true, id }), (e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }
  if (msg.cmd === 'fetch-bytes') {
    // Chỉ tải hộ ảnh (https) cho menu chuột phải trên các trang AI được hỗ trợ.
    if (!aiOrigin(sender.url || '') || !/^https:\/\//i.test(msg.url || '')) {
      sendResponse({ ok: false, error: 'URL không được hỗ trợ' });
      return;
    }
    fetch(msg.url)
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const type = (r.headers.get('content-type') || 'image/png').split(';')[0];
        sendResponse({ ok: true, type, b64: toBase64(await r.arrayBuffer()) });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }
});
