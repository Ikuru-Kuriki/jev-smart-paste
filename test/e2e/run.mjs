// End-to-end test: loads the unpacked extension into Chromium, serves a sample
// form and a mock Jev endpoint, and checks the form gets filled.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const TEXT = `株式会社サンプル
営業部 山田 太郎
〒100-0001 東京都千代田区千代田1-1
TEL: 03-1234-5678
Email：taro.yamada@example.co.jp
製品の見積もりをお願いしたいです。2026年10月20日 以降で打ち合わせ希望。`;

// What a well-behaved model would answer, keyed by the field label.
const EXPECTED = {
  会社名: '株式会社サンプル',
  'お名前（姓）': '山田',
  'お名前（名）': '太郎',
  メールアドレス: 'taro.yamada@example.co.jp',
  電話番号: '03-1234-5678',
  郵便番号: '〒100-0001',
  都道府県: '東京都',
  住所: '東京都千代田区千代田1-1',
  お問い合わせ種別: '製品について',
  希望日: '2026年10月20日',
  お問い合わせ内容: '製品の見積もりをお願いしたいです。2026年10月20日 以降で打ち合わせ希望。',
};

const requests = [];
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url === '/form.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(fs.readFileSync(path.join(here, 'form.html')));
  }
  if (req.url === '/v1/systemone' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, body: r });
      const answers = {};
      for (const [qid, q] of Object.entries(r.questions)) {
        const label = (q.instructions.match(/「(.*?)」/) || [])[1];
        const want = EXPECTED[label];
        const choice = Object.keys(q.criteria).find((k) => q.criteria[k] === want) || 'none';
        const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === choice ? 0.9 : 0.1 / (Object.keys(q.criteria).length - 1)]));
        answers[qid] = { type: 'choice', choice, probabilities, confidence: 0.8 };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-mock', answers }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Copy the extension and grant it host access so the test can script the page
// without the activeTab user gesture.
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sp-ext-'));
for (const f of ['manifest.json', 'src']) fs.cpSync(path.join(root, f), path.join(extDir, f), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sp-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium', // full Chromium: the headless shell cannot load extensions
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

let failed = false;
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate((endpoint) => chrome.storage.local.set({ apiKey: 'test-key', endpoint }), `${base}/v1/systemone`);

  const page = await context.newPage();
  await page.goto(`${base}/form.html`);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/form.html`);

  const result = await sw.evaluate(([id, text]) => globalThis.smartPaste(id, text), [tabId, TEXT]);
  console.log(JSON.stringify(result, null, 2));

  const values = await page.evaluate(() => {
    const f = document.forms[0];
    return Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, v]));
  });
  console.log(values);

  assert.deepStrictEqual(values, {
    company: '株式会社サンプル',
    last: '山田',
    first: '太郎',
    mail: 'taro.yamada@example.co.jp',
    tel: '03-1234-5678',
    zip: '〒100-0001',
    pref: '13',
    addr: '東京都千代田区千代田1-1',
    kind: 'sales',
    date: '2026-10-20',
    fax: '',
    dept: '既存の値',
    token: 'x',
    body: EXPECTED['お問い合わせ内容'],
  });
  assert.strictEqual(result.filled, 11);
  assert.ok((await page.evaluate(() => window.inputEvents)) >= 10, 'input events were dispatched');

  assert.ok(requests.length >= 1);
  assert.strictEqual(requests[0].auth, 'Bearer test-key');
  assert.strictEqual(requests[0].body.state, TEXT);
  const labels = requests.flatMap((r) => Object.values(r.body.questions).map((q) => q.instructions.match(/「(.*?)」/)[1]));
  assert.ok(!labels.includes('部署'), 'pre-filled field is not asked about');
  assert.ok(labels.includes('FAX'));

  const { undone } = await sw.evaluate((id) => globalThis.undoSmartPaste(id), tabId);
  assert.strictEqual(undone, 11);
  const afterUndo = await page.evaluate(() => Object.fromEntries([...new FormData(document.forms[0])]));
  assert.deepStrictEqual(afterUndo, { company: '', last: '', first: '', mail: '', tel: '', zip: '', pref: '', addr: '', date: '', fax: '', dept: '既存の値', token: 'x', body: '' });
  // Extension pages load cleanly.
  const extId = new URL(sw.url()).host;
  for (const pagePath of ['src/popup/popup.html', 'src/options/options.html']) {
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`chrome-extension://${extId}/${pagePath}`);
    await p.waitForTimeout(300);
    assert.deepStrictEqual(errors, [], pagePath);
    if (pagePath.includes('options')) assert.strictEqual(await p.inputValue('#model'), 'jev-latest');
    else await p.screenshot({ path: path.join(os.tmpdir(), 'jev-sp-popup.png') });
  }

  console.log('E2E OK');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await context.close();
  server.close();
}
process.exit(failed ? 1 : 0);
