/* global importScripts, JevCandidates, JevClient */
importScripts('lib/candidates.js', 'lib/jev.js');

const MENU_ID = 'jev-smart-paste-selection';

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(JevClient.DEFAULTS));
  return { ...JevClient.DEFAULTS, ...stored };
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/lib/candidates.js', 'src/content/fill.js'] });
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res && res.result;
}

/**
 * Fill the forms in a tab from free text.
 * @returns {{filled: number, results: object[]}}
 */
async function smartPaste(tabId, text) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('Jev の API キーが未設定です。設定画面で入力してください。');
  if (!text || !text.trim()) throw new Error('貼り付けるテキストが空です。');

  await inject(tabId);
  const fields = await inPage(tabId, (o) => globalThis.__jevSmartPaste.collect(o), [{ overwrite: !!settings.overwrite }]);
  if (!fields || !fields.length) throw new Error('入力できるフォーム項目が見つかりませんでした。');

  const candidates = JevCandidates.extractCandidates(text, { max: settings.maxOptions - 1 });
  const { questions, plan } = JevClient.buildQuestions(fields, candidates, text, settings);
  if (!Object.keys(questions).length) throw new Error('テキストから入力候補を取り出せませんでした。');

  const answers = await JevClient.callJev(text, questions, settings);
  const { fills, skipped } = JevClient.interpretAnswers(answers, plan, settings);
  const filled = await inPage(tabId, (f) => globalThis.__jevSmartPaste.apply(f), [fills]);

  const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
  const display = (f, value) => {
    if (f.kind === 'select' || f.kind === 'radio') {
      const o = f.options.find((x) => x.value === value);
      return o ? o.label : value;
    }
    return value;
  };
  const results = [
    ...fills.map((r) => ({ label: byId[r.fieldId].label, value: display(byId[r.fieldId], r.value), probability: r.probability, status: 'filled' })),
    ...skipped.map((r) => ({
      label: byId[r.fieldId].label,
      value: r.value ? display(byId[r.fieldId], r.value) : '',
      probability: r.probability,
      status: r.reason,
    })),
  ];
  await chrome.action.setBadgeText({ tabId, text: filled ? String(filled) : '' });
  return { filled, results };
}

async function undo(tabId) {
  await inject(tabId);
  const n = await inPage(tabId, () => globalThis.__jevSmartPaste.undo());
  await chrome.action.setBadgeText({ tabId, text: '' });
  return { undone: n };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: '選択したテキストでフォームを自動入力 (Jev)', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  // selectionText loses line breaks; prefer the live selection when we can read it.
  let text = info.selectionText;
  try {
    const sel = await inPage(tab.id, () => String(getSelection()));
    if (sel && sel.trim()) text = sel;
  } catch (_) {}
  try {
    await smartPaste(tab.id, text);
  } catch (e) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    console.error(e);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg.type === 'smart-paste') return smartPaste(msg.tabId, msg.text);
    if (msg.type === 'undo') return undo(msg.tabId);
    throw new Error(`unknown message ${msg.type}`);
  };
  run().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

// Handles for the e2e test (and the DevTools console).
globalThis.smartPaste = smartPaste;
globalThis.undoSmartPaste = undo;
