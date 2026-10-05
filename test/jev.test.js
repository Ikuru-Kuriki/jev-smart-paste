const test = require('node:test');
const assert = require('node:assert');
const { extractCandidates } = require('../src/lib/candidates.js');
const { buildQuestions, callJev, interpretAnswers, NONE } = require('../src/lib/jev.js');

const TEXT = '山田 太郎\nメール: taro@example.com\n電話: 03-1234-5678\n東京都';
const FIELDS = [
  { id: 'a', kind: 'text', inputType: 'text', label: 'お名前' },
  { id: 'b', kind: 'text', inputType: 'email', label: 'メールアドレス' },
  { id: 'c', kind: 'select', inputType: 'select-one', label: '都道府県', options: [{ value: '', label: '選択してください' }, { value: '13', label: '東京都' }, { value: '27', label: '大阪府' }] },
];

test('builds one choice question per field with a none option', () => {
  const { questions, plan } = buildQuestions(FIELDS, extractCandidates(TEXT), TEXT);
  assert.deepStrictEqual(Object.keys(questions), ['f0', 'f1', 'f2']);
  for (const q of Object.values(questions)) {
    assert.strictEqual(q.type, 'choice');
    assert.ok(NONE in q.criteria);
  }
  // email field only gets email-looking candidates
  assert.deepStrictEqual(Object.values(questions.f1.criteria).slice(0, -1), ['taro@example.com']);
  // select placeholder dropped, option values kept in the plan
  assert.deepStrictEqual(questions.f2.criteria, { o0: '東京都', o1: '大阪府', none: questions.f2.criteria.none });
  assert.deepStrictEqual(plan.f2, { fieldId: 'c', values: { o0: '13', o1: '27' } });
  assert.match(questions.f0.instructions, /「お名前」/);
});

test('respects the per-question option limit', () => {
  const text = Array.from({ length: 100 }, (_, i) => `値${i}`).join('\n');
  const { questions } = buildQuestions([FIELDS[0]], extractCandidates(text, { max: 200 }), text, { maxOptions: 10 });
  assert.strictEqual(Object.keys(questions.f0.criteria).length, 10);
});

test('callJev batches questions and sends the documented request shape', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'choice', choice: 'none', probabilities: { none: 1 } }]));
    return { ok: true, json: async () => ({ answers }) };
  };
  const questions = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`f${i}`, { type: 'choice', instructions: 'x', criteria: { none: 'n' } }]));
  const answers = await callJev('state', questions, { apiKey: 'k', questionsPerRequest: 32 }, fakeFetch);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(Object.keys(answers).length, 70);
  assert.strictEqual(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer k');
  assert.strictEqual(calls[0].body.model, 'jev-latest');
  assert.strictEqual(calls[0].body.state, 'state');
});

test('callJev surfaces API errors', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(callJev('s', { f0: {} }, { apiKey: 'x' }, fakeFetch), /401: bad key/);
});

test('interpretAnswers applies none and the confidence threshold', () => {
  const plan = {
    f0: { fieldId: 'a', values: { c0: '山田 太郎' } },
    f1: { fieldId: 'b', values: { c0: 'taro@example.com' } },
    f2: { fieldId: 'c', values: { o0: '13' } },
    f3: { fieldId: 'd', values: { c0: 'x' } },
  };
  const answers = {
    f0: { choice: 'c0', probabilities: { c0: 0.9, none: 0.1 } },
    f1: { choice: 'c0', probabilities: { c0: 0.4, none: 0.6 } },
    f2: { choice: 'none', probabilities: { o0: 0.2, none: 0.8 } },
  };
  const { fills, skipped } = interpretAnswers(answers, plan, { threshold: 0.5 });
  assert.deepStrictEqual(fills, [{ fieldId: 'a', value: '山田 太郎', probability: 0.9 }]);
  assert.deepStrictEqual(skipped.map((s) => [s.fieldId, s.reason]), [['b', 'low-confidence'], ['c', 'none'], ['d', 'no-answer']]);
});

test('blocks are only offered to textareas', () => {
  const text = 'a\nb';
  const c = extractCandidates(text);
  const { questions } = buildQuestions(
    [{ id: 'x', kind: 'text', inputType: 'text', label: 'X' }, { id: 'y', kind: 'text', inputType: 'textarea', label: 'Y' }],
    c,
    text,
  );
  assert.ok(!Object.values(questions.f0.criteria).includes('a\nb'));
  assert.ok(Object.values(questions.f1.criteria).includes('a\nb'));
});
