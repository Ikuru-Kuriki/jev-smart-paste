const $ = (id) => document.getElementById(id);
const DRAFT_KEY = 'popupDraft';

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}
$('open-options').addEventListener('click', openOptions);
$('open-options-2').addEventListener('click', openOptions);

chrome.storage.local.get(['apiKey', DRAFT_KEY]).then((s) => {
  $('no-key').hidden = !!s.apiKey;
  if (s[DRAFT_KEY]) $('text').value = s[DRAFT_KEY];
});
$('text').addEventListener('input', () => chrome.storage.local.set({ [DRAFT_KEY]: $('text').value }));

function setStatus(msg, isError) {
  $('status').textContent = msg;
  $('status').className = isError ? 'error' : '';
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

const REASONS = { none: '該当なし', 'low-confidence': '確信度が低いため未入力', 'no-answer': '回答なし' };

function render(results) {
  const ul = $('results');
  ul.textContent = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.status === 'filled' ? 'filled' : 'skipped';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = r.label || '(ラベルなし)';
    const prob = document.createElement('span');
    prob.className = 'prob';
    prob.textContent = r.probability != null ? `${Math.round(r.probability * 100)}%` : '';
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = r.status === 'filled' ? r.value : `${REASONS[r.status] || r.status}${r.value ? `（候補: ${r.value}）` : ''}`;
    li.append(label, prob, value);
    ul.append(li);
  }
}

$('paste').addEventListener('click', async () => {
  try {
    $('text').value = await navigator.clipboard.readText();
    chrome.storage.local.set({ [DRAFT_KEY]: $('text').value });
  } catch (e) {
    setStatus(`クリップボードを読めませんでした: ${e.message}`, true);
  }
});

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  setStatus('Jev に問い合わせ中…');
  $('results').textContent = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'smart-paste', tabId: await activeTabId(), text: $('text').value });
    if (!res.ok) throw new Error(res.error);
    setStatus(`${res.result.filled} 項目を入力しました。`);
    render(res.result.results);
    $('undo').hidden = !res.result.filled;
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    $('run').disabled = false;
  }
});

$('undo').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'undo', tabId: await activeTabId() });
  if (res.ok) {
    setStatus(`${res.result.undone} 項目を元に戻しました。`);
    $('undo').hidden = true;
  } else setStatus(res.error, true);
});
