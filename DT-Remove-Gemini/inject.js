/*
 * Chạy trong "MAIN world" của các trang tạo ảnh của Google (Gemini, Flow, labs.google,
 * AI Studio) — cùng ngữ cảnh với mã của trang.
 *
 * Lớp 1 — fetch (chỉ trên gemini.google.com): nút "Tải xuống" của Gemini lấy ảnh gốc
 *   bằng fetch() rồi tự tạo file tải về. Ta xử lý ảnh ngay trong phản hồi, nên Gemini
 *   nhận được ảnh đã sạch logo và tải về như bình thường (giữ tên file).
 * Lớp 2 — thẻ <a download>: chặn cú click tải cuối cùng, xoá logo rồi mới tải.
 * Lớp 3 — tầng tải xuống (background.js) giữ mọi lượt tải ảnh lại; với blob: URL của
 *   trang (chỉ trang đọc được) nó hỏi sang đây để lấy bản đã xoá logo.
 *
 * Bật/tắt qua thuộc tính data-gwm-enabled trên <html> (do bridge.js đặt).
 */
(() => {
  'use strict';
  if (window.__gwmHooked || !window.GeminiWM) return;
  window.__gwmHooked = true;

  const WM = window.GeminiWM;
  const html = document.documentElement;
  const isEnabled = () => html.getAttribute('data-gwm-enabled') !== '0';
  // Giữ nhãn "tạo bằng AI" (XMP/IPTC) trong ảnh đã xử lý — mặc định tắt.
  const keepMeta = () => html.getAttribute('data-gwm-keepmeta') === '1';

  // Ảnh do Gemini tạo: /gg/, /gg-dl/, /rd-gg/, /rd-gg-dl/, /gg-premium-dl/ ...
  const ASSET_RE = /^https:\/\/[^/]*\.googleusercontent\.com\/(rd-)?gg(-[\w-]+)?\//i;

  const seen = new WeakSet();     // Blob đã xử lý hoặc đã kiểm tra
  const cleaned = new WeakSet();  // Blob do tiện ích tạo ra sau khi đã xoá logo
  const urlBlobs = new Map();     // object URL do trang tạo -> Blob
  const ownUrls = new Set();      // object URL do chính tiện ích tạo để tải bản sạch

  const nativeFetch = window.fetch;
  const nativeCreate = URL.createObjectURL;
  const nativeRevoke = URL.revokeObjectURL;
  const nativeClick = HTMLAnchorElement.prototype.click;
  const nativeDispatch = EventTarget.prototype.dispatchEvent;

  // info: { name, via } — để bridge.js ghi nhật ký.
  function report(info) {
    document.dispatchEvent(new CustomEvent('gwm:removed', { detail: JSON.stringify(info || {}) }));
  }

  async function clean(blob, info) {
    if (!isEnabled() || !(blob instanceof Blob) || seen.has(blob) || blob.size < 1024) return blob;
    seen.add(blob);
    try {
      const { blob: out, result } = await WM.processBlob(blob, { keepMeta: keepMeta() });
      seen.add(out);
      if (result.found) {
        cleaned.add(out);
        report(info);
      }
      return out;
    } catch (e) {
      console.warn('[DT Remove Gemini]', e);
      return blob;
    }
  }

  // ---------- Lớp 1: fetch ----------
  // Trang khác (Flow...) có thể fetch hàng loạt ảnh xem trước — không xử lý ở đây cho nhẹ.
  if (location.hostname === 'gemini.google.com') window.fetch = async function fetch(input, init) {
    const resp = await nativeFetch.apply(this, arguments);
    try {
      if (!isEnabled() || !resp.ok || resp.type === 'opaque') return resp;
      const reqUrl = input instanceof Request ? input.url : String(input);
      const ct = resp.headers.get('content-type') || '';
      const isImage = /^image\/(png|jpe?g|webp)/i.test(ct);
      const isAsset = ASSET_RE.test(reqUrl) || ASSET_RE.test(resp.url);
      if (!isImage && !(isAsset && (!ct || /octet-stream/i.test(ct)))) return resp;

      const blob = await resp.clone().blob();
      const out = await clean(blob, { via: 'page-fetch' });
      if (out === blob) return resp;

      const headers = new Headers(resp.headers);
      headers.set('content-type', out.type);
      headers.delete('content-length');
      const res2 = new Response(out, { status: resp.status, statusText: resp.statusText, headers });
      for (const k of ['url', 'redirected', 'type']) {
        Object.defineProperty(res2, k, { value: resp[k] });
      }
      return res2;
    } catch (e) {
      console.warn('[DT Remove Gemini]', e);
      return resp;
    }
  };

  // ---------- Lớp 2: <a download> ----------
  URL.createObjectURL = function createObjectURL(obj) {
    const u = nativeCreate.apply(this, arguments);
    if (obj instanceof Blob) urlBlobs.set(u, obj);
    return u;
  };
  URL.revokeObjectURL = function revokeObjectURL(u) {
    // Giữ tham chiếu thêm một lúc: trang thường thu hồi URL ngay sau a.click().
    if (urlBlobs.has(u)) setTimeout(() => urlBlobs.delete(u), 120000);
    return nativeRevoke.apply(this, arguments);
  };

  function wantAnchor(a) {
    if (!isEnabled() || !a || a.dataset.gwmPass === '1' || !a.hasAttribute('download')) return false;
    const href = a.href || '';
    return href.startsWith('blob:') || href.startsWith('data:image/') || ASSET_RE.test(href);
  }

  async function handleAnchor(a) {
    const href = a.href;
    const name = a.getAttribute('download') || '';
    const known = urlBlobs.get(href); // lấy ngay, trước khi trang kịp thu hồi URL
    let outUrl = null;
    try {
      const blob = known || (await (await nativeFetch(href)).blob());
      const out = await clean(blob, { name, via: 'page-link' });
      outUrl = nativeCreate.call(URL, out);
      ownUrls.add(outUrl);
    } catch (e) {
      console.warn('[DT Remove Gemini]', e);
    }
    const b = document.createElement('a');
    b.href = outUrl || href;
    b.download = name;
    b.dataset.gwmPass = '1';
    b.style.display = 'none';
    (document.body || html).appendChild(b);
    nativeClick.call(b);
    b.remove();
    if (outUrl) {
      setTimeout(() => {
        nativeRevoke.call(URL, outUrl);
        ownUrls.delete(outUrl);
      }, 60000);
    }
  }

  HTMLAnchorElement.prototype.click = function click() {
    if (wantAnchor(this)) {
      handleAnchor(this);
      return;
    }
    return nativeClick.apply(this, arguments);
  };

  EventTarget.prototype.dispatchEvent = function dispatchEvent(ev) {
    if (ev && ev.type === 'click' && this instanceof HTMLAnchorElement && wantAnchor(this)) {
      handleAnchor(this);
      return false;
    }
    return nativeDispatch.apply(this, arguments);
  };

  window.addEventListener('click', (e) => {
    // composedPath() thấy cả thẻ <a> nằm trong Shadow DOM (dạng open).
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
    if (a && wantAnchor(a)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      handleAnchor(a);
    }
  }, true);

  // ---------- Lớp 2b: lưu qua hộp thoại "Lưu thành" (File System Access API) ----------
  // Trang ghi thẳng file xuống đĩa, không đi qua trình quản lý tải xuống — nên phải
  // gom dữ liệu trang ghi vào, xoá logo rồi mới ghi thật khi trang đóng file.
  const IMG_NAME = /\.(png|jpe?g|webp)$/i;

  function cleaningWritable(real, name) {
    const parts = [];
    let passthrough = false; // trang ghi kiểu nhảy vị trí -> chuyển thẳng, không can thiệp
    async function goPassthrough() {
      if (passthrough) return;
      passthrough = true;
      for (const p of parts) await real.write(p);
      parts.length = 0;
    }
    async function write(data) {
      if (passthrough) return real.write(data);
      if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        parts.push(data);
      } else if (data && data.type === 'write' && data.position == null && data.data != null) {
        parts.push(data.data);
      } else {
        await goPassthrough();
        return real.write(data);
      }
    }
    async function close() {
      if (!passthrough) {
        const ext = (name.match(IMG_NAME) || ['', 'png'])[1].toLowerCase();
        const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const out = await clean(new Blob(parts, { type }), { name, via: 'page-save-dialog' });
        await real.write(out);
      }
      return real.close();
    }
    const ws = new WritableStream({
      write: (chunk) => write(chunk),
      close: () => close(),
      abort: (reason) => real.abort(reason),
    });
    // Giả dáng FileSystemWritableFileStream.
    ws.write = write;
    ws.close = close;
    ws.abort = (reason) => real.abort(reason);
    ws.seek = async (pos) => { await goPassthrough(); return real.seek(pos); };
    ws.truncate = async (size) => { await goPassthrough(); return real.truncate(size); };
    return ws;
  }

  if (typeof window.showSaveFilePicker === 'function') {
    const nativePicker = window.showSaveFilePicker;
    window.showSaveFilePicker = async function showSaveFilePicker() {
      const handle = await nativePicker.apply(this, arguments);
      try {
        if (isEnabled() && IMG_NAME.test(handle.name || '')) {
          const nativeCW = handle.createWritable;
          handle.createWritable = async function createWritable() {
            const real = await nativeCW.apply(this, arguments);
            return isEnabled() ? cleaningWritable(real, handle.name) : real;
          };
        }
      } catch (e) {
        console.warn('[DT Remove Gemini]', e);
      }
      return handle;
    };
  }

  // ---------- Lớp 3: tầng tải xuống hỏi về một blob: URL của trang ----------
  // (background → bridge.js → đây). Trả lại ảnh đã xoá logo dạng base64.
  function blobToBase64(blob) {
    return new Promise((ok, fail) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result).split(',')[1] || '');
      fr.onerror = () => fail(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  document.addEventListener('gwm:req', async (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    if (!req || req.cmd !== 'clean-blob-url') return;
    const reply = (obj) => document.dispatchEvent(new CustomEvent('gwm:res', {
      detail: JSON.stringify(Object.assign({ id: req.id }, obj)),
    }));
    if (ownUrls.has(req.url)) return reply({ status: 'pass' });
    let blob = urlBlobs.get(req.url);
    if (!blob) {
      try { blob = await (await nativeFetch(req.url)).blob(); } catch (err) { return reply({ status: 'unknown' }); }
    }
    // Bản đã được làm sạch ở lớp trong trang: báo "đã xử lý" để không ghi nhật ký trùng.
    if (cleaned.has(blob)) return reply({ status: 'pass' });
    if (seen.has(blob)) return reply({ status: 'none' });
    seen.add(blob);
    try {
      const { blob: out, result } = await WM.processBlob(blob, { keepMeta: keepMeta() });
      seen.add(out);
      if (!result.found) return reply({ status: 'none' });
      reply({ status: 'found', type: out.type, b64: await blobToBase64(out) });
    } catch (err) {
      console.warn('[DT Remove Gemini]', err);
      reply({ status: 'none' });
    }
  });
})();
