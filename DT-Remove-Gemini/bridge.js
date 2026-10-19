/*
 * Chạy trong "isolated world" của các trang AI của Google (Gemini, Flow...):
 *  - chuyển trạng thái bật/tắt từ chrome.storage sang inject.js (thuộc tính trên <html>);
 *  - hiện thông báo nhỏ khi đã xoá logo và báo cho background đếm số ảnh;
 *  - xử lý lệnh "Tải ảnh đã xoá logo Gemini" từ menu chuột phải.
 */
(() => {
  'use strict';
  const html = document.documentElement;

  let keepMeta = false; // giữ nhãn "tạo bằng AI" (XMP/IPTC) trong ảnh đã xử lý
  function applyEnabled(enabled) {
    html.setAttribute('data-gwm-enabled', enabled ? '1' : '0');
  }
  function applyKeepMeta(on) {
    keepMeta = !!on;
    html.setAttribute('data-gwm-keepmeta', keepMeta ? '1' : '0');
  }
  chrome.storage.local.get({ enabled: true, keepAiInfo: false }, (s) => {
    applyEnabled(s.enabled);
    applyKeepMeta(s.keepAiInfo);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) applyEnabled(changes.enabled.newValue);
    if (changes.keepAiInfo) applyKeepMeta(changes.keepAiInfo.newValue);
  });

  // ---------- Thông báo nhỏ ----------
  let toastTimer = 0;
  function toast(text, ok = true) {
    let el = document.getElementById('gwm-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gwm-toast';
      Object.assign(el.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
        padding: '10px 14px', borderRadius: '10px', font: '500 13px/1.3 system-ui, sans-serif',
        color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,.25)', transition: 'opacity .25s',
        pointerEvents: 'none',
      });
      (document.body || html).appendChild(el);
    }
    el.style.background = ok ? '#1a7f37' : '#57606a';
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.opacity = '0'), 2600);
  }

  document.addEventListener('gwm:removed', (e) => {
    let info = {};
    try { info = JSON.parse(e.detail) || {}; } catch (err) { /* bỏ qua */ }
    toast('✓ Đã xoá logo Gemini khỏi ảnh');
    try {
      chrome.runtime.sendMessage({ cmd: 'removed', name: info.name || '', via: info.via || 'page' }).catch(() => {});
    } catch (err) {
      // Bản bridge cũ còn sót sau khi tải lại tiện ích — bỏ qua.
    }
  });

  // ---------- Menu chuột phải ----------
  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function fetchImage(url) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.blob();
    } catch (e) {
      // Bị chặn CORS — nhờ background tải hộ.
    }
    const res = await chrome.runtime.sendMessage({ cmd: 'fetch-bytes', url });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Không tải được ảnh');
    return base64ToBlob(res.b64, res.type);
  }

  function fileNameFor(blob) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `Gemini_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
  }

  const ownUrls = new Set(); // blob URL do bridge tạo để tải bản sạch

  async function downloadClean(url) {
    const blob = await fetchImage(url);
    const { blob: out, result } = await GeminiWM.processBlob(blob, { keepMeta });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    ownUrls.add(a.href);
    a.download = fileNameFor(out);
    a.dataset.gwmPass = '1';
    a.style.display = 'none';
    (document.body || html).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      ownUrls.delete(a.href);
    }, 60000);
    if (result.found) {
      toast('✓ Đã xoá logo Gemini khỏi ảnh');
      chrome.runtime.sendMessage({ cmd: 'removed' }).catch(() => {});
    } else {
      toast('Không thấy logo Gemini — đã tải ảnh gốc', false);
    }
    return { ok: true, found: !!result.found };
  }

  // Hỏi inject.js (MAIN world) về một blob: URL do trang Gemini tạo.
  let reqSeq = 0;
  function askPage(url) {
    return new Promise((resolve) => {
      const id = 'r' + ++reqSeq + '_' + Date.now();
      const timer = setTimeout(() => done({ status: 'unknown' }), 30000);
      function onRes(e) {
        let res;
        try { res = JSON.parse(e.detail); } catch (err) { return; }
        if (res && res.id === id) done(res);
      }
      function done(res) {
        clearTimeout(timer);
        document.removeEventListener('gwm:res', onRes);
        resolve(res);
      }
      document.addEventListener('gwm:res', onRes);
      document.dispatchEvent(new CustomEvent('gwm:req', {
        detail: JSON.stringify({ id, cmd: 'clean-blob-url', url }),
      }));
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.cmd === 'download-clean') {
      downloadClean(msg.url).then(sendResponse, (e) => {
        toast('Không xử lý được ảnh: ' + e.message, false);
        sendResponse({ ok: false, error: String(e && e.message) });
      });
      return true;
    }
    if (msg.cmd === 'clean-blob-url') {
      if (ownUrls.has(msg.url)) {
        sendResponse({ status: 'pass' });
        return;
      }
      askPage(msg.url).then(sendResponse);
      return true;
    }
    if (msg.cmd === 'toast') {
      toast('✓ Đã xoá logo Gemini khỏi ảnh');
    }
  });
})();
