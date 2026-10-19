'use strict';
const enabledEl = document.getElementById('enabled');
const allSitesEl = document.getElementById('allSites');
const keepAiInfoEl = document.getElementById('keepAiInfo');
const countEl = document.getElementById('count');
const card = enabledEl.closest('.card');

function render(s) {
  enabledEl.checked = s.enabled;
  allSitesEl.checked = s.allSites;
  keepAiInfoEl.checked = s.keepAiInfo;
  allSitesEl.disabled = !s.enabled;
  card.classList.toggle('off', !s.enabled);
}

chrome.storage.local.get({ enabled: true, allSites: true, keepAiInfo: false, count: 0 }, (s) => {
  render(s);
  countEl.textContent = s.count;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.count) countEl.textContent = changes.count.newValue;
});
enabledEl.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabledEl.checked });
  render({ enabled: enabledEl.checked, allSites: allSitesEl.checked, keepAiInfo: keepAiInfoEl.checked });
});
allSitesEl.addEventListener('change', () => chrome.storage.local.set({ allSites: allSitesEl.checked }));
keepAiInfoEl.addEventListener('change', () => chrome.storage.local.set({ keepAiInfo: keepAiInfoEl.checked }));
// ---------- Nhật ký ----------
const RESULTS = {
  found: ['ok', '✓ Đã xoá logo khi tải xuống'],
  'page-fetch': ['ok', '✓ Đã xoá logo (trong trang)'],
  'page-link': ['ok', '✓ Đã xoá logo (trong trang)'],
  'page-save-dialog': ['ok', '✓ Đã xoá logo (hộp thoại lưu)'],
  page: ['ok', '✓ Đã xoá logo (trong trang)'],
  tool: ['ok', '✓ Đã xoá logo (công cụ)'],
  none: ['', 'Không có logo — giữ nguyên ảnh'],
  unreadable: ['err', '✗ Không đọc được ảnh — hãy F5 trang rồi tải lại'],
  unsupported: ['warn', 'Bỏ qua — nguồn tải không hỗ trợ'],
  off: ['warn', 'Bỏ qua — đang tắt tự động'],
  'other-site': ['warn', 'Bỏ qua — ảnh từ trang khác (đang tắt)'],
  error: ['err', '✗ Lỗi'],
};
const logEl = document.getElementById('log');

function renderLog(entries) {
  logEl.textContent = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Chưa có lượt tải ảnh nào.';
    logEl.append(li);
    return;
  }
  for (const e of entries) {
    const [cls, label] = RESULTS[e.result] || ['', e.result];
    const li = document.createElement('li');
    const row1 = document.createElement('div');
    row1.className = 'row1';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(e.t).toLocaleTimeString('vi-VN', { hour12: false });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = e.name || '(không rõ tên file)';
    name.title = e.name || '';
    row1.append(time, name);
    const res = document.createElement('div');
    res.className = 'res ' + cls;
    res.textContent = label + (e.error ? ': ' + e.error : '');
    if (e.src) {
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = ' · ' + e.src;
      res.append(src);
    }
    li.append(row1, res);
    logEl.append(li);
  }
}

chrome.storage.local.get({ gwmLog: [] }, (s) => renderLog(s.gwmLog));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gwmLog) renderLog(changes.gwmLog.newValue || []);
});
document.getElementById('clearLog').addEventListener('click', () => chrome.storage.local.set({ gwmLog: [] }));

// ---------- Ủng hộ tác giả ----------
const mainView = document.getElementById('main');
const donateView = document.getElementById('donate');
function showDonate(on) {
  mainView.hidden = on;
  donateView.hidden = !on;
  document.body.classList.toggle('donating', on);
}
document.getElementById('openDonate').addEventListener('click', () => showDonate(true));
document.getElementById('closeDonate').addEventListener('click', () => showDonate(false));
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

document.getElementById('openTool').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('tool.html') });
  window.close();
});
