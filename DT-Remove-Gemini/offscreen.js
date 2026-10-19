/*
 * Trang ẩn (offscreen document) của tiện ích: tải lại ảnh của một lượt tải xuống,
 * xoá logo và tạo blob URL để background lưu bản sạch. Service worker không tự tạo
 * được blob URL, còn data URL thì bị giới hạn ~2 MB.
 */
'use strict';

const MAX_BYTES = 80 * 1024 * 1024;

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function fetchImage(url) {
  const ctrl = new AbortController();
  const r = await fetch(url, { credentials: 'include', signal: ctrl.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const len = +(r.headers.get('content-length') || 0);
  // Không đọc hết những file không phải ảnh hoặc quá lớn.
  if ((ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) || len > MAX_BYTES) {
    ctrl.abort();
    return null;
  }
  return r.blob();
}

async function clean(blob, keepMeta) {
  const { blob: out, result } = await GeminiWM.processBlob(blob, { keepMeta });
  if (!result.found) return { ok: true, found: false };
  return { ok: true, found: true, blobUrl: URL.createObjectURL(out), type: out.type };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.cmd === 'clean-url') {
    fetchImage(msg.url)
      .then((blob) => (blob ? clean(blob, !!msg.keepMeta) : { ok: true, found: false }))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }
  if (msg.cmd === 'blob-url') {
    sendResponse({ ok: true, blobUrl: URL.createObjectURL(base64ToBlob(msg.b64, msg.type)) });
    return;
  }
  if (msg.cmd === 'revoke') {
    URL.revokeObjectURL(msg.blobUrl);
  }
});
