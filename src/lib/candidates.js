/*
 * Candidate extraction.
 *
 * Jev is a decision model: it never generates text, it only picks among the
 * options we give it. So before asking Jev anything we cut the pasted text
 * into every plausible value a form field could take (lines, "key: value"
 * pairs, delimited parts, emails, phone numbers, postal codes, ...). Jev then
 * chooses, per form field, which of these candidates belongs there.
 */
(function (root) {
  'use strict';

  const PATTERNS = {
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    url: /https?:\/\/[^\s<>"'、。）)]+/g,
    postal: /(?:〒\s?|(?<![\d-]))\d{3}[-－ー‐]\d{4}(?![\d-])/g,
    phone: /(?:\+81[-\s]?|(?<![\d-])0)\d{1,4}[-－ー‐(（)）\s]?\d{1,4}[-－ー‐)）\s]?\d{3,4}(?![\d-])/g,
    date: /\d{4}\s*[年/\-.]\s*\d{1,2}\s*[月/\-.]\s*\d{1,2}\s*日?/g,
  };

  // "氏名：山田太郎", "Email: a@b.c", "【会社名】株式会社〇〇", "■住所 東京都..."
  const KEY_VALUE = [
    /^\s*[■●◆・*\-]?\s*([^:：\t]{1,24}?)\s*[:：]\s*(.+)$/,
    /^\s*[【\[［]([^】\]］]{1,24})[】\]］]\s*(.+)$/,
    /^\s*([^\t]{1,24}?)\t+(.+)$/,
  ];

  const SPLITTERS = /\s*(?:[、,，\/／|｜\t]|\s{2,}|　)\s*/;
  const MAX_LEN = 200;
  const MAX_BLOCK_LEN = 2000;

  function toHalfWidth(s) {
    return s
      .replace(/[０-９Ａ-Ｚａ-ｚ＠．＿＋－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[ー‐―]/g, (c, i, str) => (/\d/.test(str[i - 1] || '') && /\d/.test(str[i + 1] || '') ? '-' : c));
  }

  /** "氏名：山田太郎" -> "山田太郎"; null when the text has no key. */
  function keyValue(s) {
    for (const re of KEY_VALUE) {
      const m = s.match(re);
      if (m && !/^https?$/i.test(m[1].trim())) return m[2];
    }
    return null;
  }

  function clean(s) {
    return s.replace(/\s+/g, ' ').replace(/^[\s"'「『]+|[\s"'」』]+$/g, '').trim();
  }

  /**
   * @param {string} text pasted text
   * @param {{max?: number}} [opts]
   * @returns {{text: string, kind: string}[]} unique candidates, most specific first
   */
  function extractCandidates(text, opts = {}) {
    const max = opts.max || 62;
    const buckets = { pattern: [], value: [], part: [], block: [], line: [] };
    const seen = new Set();

    function add(bucket, value, kind) {
      const v = kind === 'block' ? value.trim() : clean(value);
      if (!v || v.length > (kind === 'block' ? MAX_BLOCK_LEN : MAX_LEN) || seen.has(v)) return;
      seen.add(v);
      buckets[bucket].push({ text: v, kind });
    }

    const src = String(text || '');
    const half = toHalfWidth(src);

    for (const [kind, re] of Object.entries(PATTERNS)) {
      for (const m of half.matchAll(re)) {
        if (kind === 'phone' && /^\d{3}-\d{4}$/.test(m[0])) continue; // that's a postal code
        add('pattern', m[0], kind);
      }
    }

    const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const kv = keyValue(line);
      const value = kv || line;
      if (kv) add('value', kv, 'value');

      // Text left after removing a postal code ("〒100-0001 東京都..." -> "東京都...").
      const withoutPostal = value.replace(PATTERNS.postal, ' ').trim();
      if (withoutPostal && withoutPostal !== value) add('value', withoutPostal, 'value');

      const parts = /^https?:\/\//.test(value) ? [value] : value.split(SPLITTERS).filter(Boolean);
      if (parts.length > 1) for (const p of parts) add('part', keyValue(p) || p, 'part');

      // "営業部 山田 太郎" -> "山田 太郎", "山田太郎", "山田", "太郎", ...
      // (for separate department / family name / given name fields)
      for (const p of parts.length > 1 ? parts : [value]) {
        const words = clean(p).split(/[ 　]+/);
        if (words.length < 2 || words.length > 4 || words.some((w) => w.length > 12 || /\d/.test(w))) continue;
        for (let i = 0; i + 1 < words.length; i++) {
          if (words.length > 2) add('part', `${words[i]} ${words[i + 1]}`, 'part');
          add('part', words[i] + words[i + 1], 'part');
        }
        for (const w of words) add('part', w, 'part');
      }

      add('line', line, 'line');
    }

    // Multi-line candidates (paragraphs, whole text) for free-text fields such as
    // "お問い合わせ内容". Only offered to textareas, see jev.js.
    const paragraphs = src.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter((p) => p.includes('\n'));
    for (const p of paragraphs) add('block', p, 'block');
    if (lines.length > 1) add('block', src, 'block');

    return [...buckets.pattern, ...buckets.value, ...buckets.part, ...buckets.block, ...buckets.line].slice(0, max);
  }

  const api = { extractCandidates, toHalfWidth, PATTERNS };
  root.JevCandidates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
