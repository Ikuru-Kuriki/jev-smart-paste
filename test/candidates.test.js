const test = require('node:test');
const assert = require('node:assert');
const { extractCandidates } = require('../src/lib/candidates.js');

const SIGNATURE = `株式会社サンプル
営業部 山田 太郎
〒100-0001 東京都千代田区千代田1-1
TEL: 03-1234-5678
Email：taro.yamada@example.co.jp
https://example.co.jp`;

const texts = (s) => extractCandidates(s).map((c) => c.text);

test('pulls structured values out by pattern', () => {
  const c = extractCandidates(SIGNATURE);
  const kinds = Object.fromEntries(c.filter((x) => x.kind !== 'value' && x.kind !== 'part' && x.kind !== 'line').map((x) => [x.kind, x.text]));
  assert.strictEqual(kinds.email, 'taro.yamada@example.co.jp');
  assert.strictEqual(kinds.phone, '03-1234-5678');
  assert.strictEqual(kinds.postal, '〒100-0001');
  assert.strictEqual(kinds.url, 'https://example.co.jp');
});

test('splits key/value lines, postal-prefixed addresses and names', () => {
  const t = texts(SIGNATURE);
  for (const v of ['東京都千代田区千代田1-1', '山田 太郎', '山田太郎', '山田', '太郎', '株式会社サンプル', '営業部']) {
    assert.ok(t.includes(v), `missing ${v}: ${JSON.stringify(t)}`);
  }
});

test('handles brackets, full-width digits and delimiters', () => {
  const t = texts('【会社名】テスト商事\n電話番号：０９０－１１１１－２２２２\n希望日 2026年10月5日、10月6日');
  assert.ok(t.includes('テスト商事'));
  assert.ok(t.includes('090-1111-2222'), JSON.stringify(t));
  assert.ok(t.includes('2026年10月5日'));
  assert.ok(t.includes('10月6日'));
});

test('dedupes and caps the number of candidates', () => {
  const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  assert.strictEqual(extractCandidates(many, { max: 10 }).length, 10);
  assert.strictEqual(extractCandidates('a\na\na').filter((c) => c.kind !== 'block').length, 1);
});

test('empty input yields nothing', () => {
  assert.deepStrictEqual(extractCandidates(''), []);
  assert.deepStrictEqual(extractCandidates(null), []);
});

test('offers multi-line blocks without collapsing line breaks', () => {
  const text = '山田です。\n\nお見積もりをお願いします。\n納期は来月希望です。';
  const blocks = extractCandidates(text).filter((c) => c.kind === 'block').map((c) => c.text);
  assert.deepStrictEqual(blocks, ['お見積もりをお願いします。\n納期は来月希望です。', text]);
});
