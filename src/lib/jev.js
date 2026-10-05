/*
 * Turns form fields + candidates into Jev "choice" questions, calls the
 * System One endpoint, and turns the answers back into fill instructions.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKey: '',
    threshold: 0.5,
    overwrite: false,
    maxOptions: 64, // gateway limit per choice question
    questionsPerRequest: 32, // gateway limit per request
  };

  const NONE = 'none';

  const TYPE_FILTERS = {
    email: (c) => c.kind === 'email',
    tel: (c) => c.kind === 'phone',
    url: (c) => c.kind === 'url',
    postal: (c) => c.kind === 'postal',
    date: (c) => c.kind === 'date',
  };

  function fieldKindHint(field) {
    const ac = (field.autocomplete || '').toLowerCase();
    if (field.inputType === 'email' || /email/.test(ac)) return 'email';
    if (field.inputType === 'tel' || /tel/.test(ac)) return 'tel';
    if (field.inputType === 'url' || ac === 'url') return 'url';
    if (field.inputType === 'date') return 'date';
    if (/postal-code/.test(ac) || /郵便番号|postal|zip/i.test(field.label || '')) return 'postal';
    return null;
  }

  function describeField(field) {
    const bits = [];
    if (field.inputType && !['text', 'textarea', 'select-one'].includes(field.inputType)) bits.push(`type=${field.inputType}`);
    if (field.autocomplete && field.autocomplete !== 'on' && field.autocomplete !== 'off') bits.push(`autocomplete=${field.autocomplete}`);
    if (field.placeholder && field.placeholder !== field.label) bits.push(`placeholder="${field.placeholder}"`);
    if (field.name) bits.push(`name=${field.name}`);
    return `「${field.label || field.name || '(no label)'}」${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }

  /** Candidates offered for one text-like field. */
  function candidatesFor(field, candidates, maxOptions) {
    const hint = fieldKindHint(field);
    const filter = hint && TYPE_FILTERS[hint];
    let list = field.inputType === 'textarea' ? candidates : candidates.filter((c) => c.kind !== 'block');
    if (filter) {
      const narrowed = list.filter(filter);
      if (narrowed.length) list = narrowed;
    }
    return list.slice(0, maxOptions - 1);
  }

  /** Options offered for a select / radio group (only ones that appear relevant if too many). */
  function optionsFor(field, text, maxOptions) {
    let opts = (field.options || []).filter((o) => o.label && o.value !== '');
    if (opts.length > maxOptions - 1) {
      const hay = String(text || '');
      const mentioned = opts.filter((o) => hay.includes(o.label));
      opts = (mentioned.length ? mentioned : opts).slice(0, maxOptions - 1);
    }
    return opts;
  }

  /**
   * @param {object[]} fields from the content script
   * @param {{text:string, kind:string}[]} candidates
   * @param {string} text the pasted text
   * @returns {{questions: object, plan: object}} plan maps question id -> {fieldId, values: {key: value}}
   */
  function buildQuestions(fields, candidates, text, settings = {}) {
    const maxOptions = settings.maxOptions || DEFAULTS.maxOptions;
    const questions = {};
    const plan = {};

    fields.forEach((field, i) => {
      const qid = `f${i}`;
      const criteria = {};
      const values = {};

      if (field.kind === 'select' || field.kind === 'radio') {
        optionsFor(field, text, maxOptions).forEach((o, j) => {
          criteria[`o${j}`] = o.label;
          values[`o${j}`] = o.value;
        });
      } else {
        candidatesFor(field, candidates, maxOptions).forEach((c, j) => {
          criteria[`c${j}`] = c.text;
          values[`c${j}`] = c.text;
        });
      }
      if (!Object.keys(criteria).length) return;
      criteria[NONE] = 'The text contains no information for this field';

      questions[qid] = {
        type: 'choice',
        instructions:
          `A user pasted the text in the state and wants it entered into a web form. ` +
          `Which option is the exact value to enter into the form field ${describeField(field)}? ` +
          `Choose "${NONE}" if the text has no information for this field.`,
        criteria,
      };
      plan[qid] = { fieldId: field.id, values };
    });

    return { questions, plan };
  }

  function chunk(obj, size) {
    const entries = Object.entries(obj);
    const out = [];
    for (let i = 0; i < entries.length; i += size) out.push(Object.fromEntries(entries.slice(i, i + size)));
    return out;
  }

  async function callJev(text, questions, settings, fetchImpl) {
    const s = { ...DEFAULTS, ...settings };
    const doFetch = fetchImpl || root.fetch.bind(root);
    const batches = chunk(questions, s.questionsPerRequest);
    const results = await Promise.all(
      batches.map(async (qs) => {
        const res = await doFetch(s.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
          body: JSON.stringify({ model: s.model, state: text, questions: qs }),
        });
        if (!res.ok) {
          let detail = '';
          try {
            detail = await res.text();
          } catch (_) {}
          throw new Error(`Jev API error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
        }
        return res.json();
      }),
    );
    const answers = {};
    for (const r of results) Object.assign(answers, (r && r.answers) || {});
    return answers;
  }

  /** @returns {{fills: {fieldId, value, probability}[], skipped: {fieldId, reason, probability?}[]}} */
  function interpretAnswers(answers, plan, settings = {}) {
    const threshold = settings.threshold != null ? Number(settings.threshold) : DEFAULTS.threshold;
    const fills = [];
    const skipped = [];
    for (const [qid, p] of Object.entries(plan)) {
      const a = answers[qid];
      if (!a || !a.choice) {
        skipped.push({ fieldId: p.fieldId, reason: 'no-answer' });
        continue;
      }
      const probability = a.probabilities && a.probabilities[a.choice] != null ? a.probabilities[a.choice] : a.confidence;
      if (a.choice === NONE || !(a.choice in p.values)) {
        skipped.push({ fieldId: p.fieldId, reason: 'none', probability });
      } else if (probability != null && probability < threshold) {
        skipped.push({ fieldId: p.fieldId, reason: 'low-confidence', probability, value: p.values[a.choice] });
      } else {
        fills.push({ fieldId: p.fieldId, value: p.values[a.choice], probability });
      }
    }
    return { fills, skipped };
  }

  const api = { DEFAULTS, NONE, buildQuestions, callJev, interpretAnswers, fieldKindHint, chunk };
  root.JevClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
