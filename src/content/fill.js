/*
 * Injected into the page on demand. Collects fillable form fields with a
 * human-readable label, and writes values back in a way that frameworks
 * (React, Vue, ...) notice.
 */
(function () {
  'use strict';
  if (globalThis.__jevSmartPaste) return;

  const ATTR = 'data-jev-sp-id';
  const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number', 'date', 'month', 'datetime-local', 'time']);
  let undoStack = [];

  const norm = (s) => (s || '').replace(/\s+/g, ' ').replace(/[*＊※]|\(必須\)|（必須）|必須|任意/g, '').trim();

  function isVisible(el) {
    if (el.type === 'hidden' || el.disabled || el.readOnly) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function textOf(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, script, style, option').forEach((n) => n.remove());
    return norm(clone.textContent);
  }

  function labelFor(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length) {
      const t = norm(ids.map((id) => textOf(document.getElementById(id))).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = norm([...el.labels].map(textOf).join(' '));
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));

    // <tr><th>氏名</th><td><input></td></tr>
    const cell = el.closest('td');
    if (cell) {
      const row = cell.parentElement;
      const th = row && row.querySelector('th');
      if (th) return textOf(th);
      if (cell.previousElementSibling) {
        const t = textOf(cell.previousElementSibling);
        if (t) return t;
      }
    }
    // <dt>氏名</dt><dd><input></dd>
    const dd = el.closest('dd');
    if (dd) {
      let dt = dd.previousElementSibling;
      while (dt && dt.tagName !== 'DT') dt = dt.previousElementSibling;
      if (dt) return textOf(dt);
    }
    // Nearest preceding text within a small wrapper (common in div-based forms).
    let node = el;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        const t = textOf(sib);
        if (t && t.length <= 40) return t;
        if (sib.matches('input, select, textarea') || sib.querySelector('input, select, textarea')) break;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return norm(el.placeholder || el.title || el.name || el.id);
  }

  function groupLabel(radio) {
    const fs = radio.closest('fieldset');
    if (fs) {
      const legend = fs.querySelector('legend');
      if (legend) return textOf(legend);
    }
    const group = radio.closest('[role="radiogroup"]');
    if (group && group.getAttribute('aria-label')) return norm(group.getAttribute('aria-label'));
    const cell = radio.closest('td, dd');
    if (cell) {
      const fake = document.createElement('span');
      cell.insertBefore(fake, cell.firstChild);
      const label = labelFor(fake);
      fake.remove();
      if (label) return label;
    }
    return norm(radio.name);
  }

  function collect(opts = {}) {
    const overwrite = !!opts.overwrite;
    const fields = [];
    let n = 0;
    const tag = (el) => {
      const id = `jsp${n++}`;
      el.setAttribute(ATTR, id);
      return id;
    };
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

    const radioGroups = new Map();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (!isVisible(el)) continue;
      if (el.tagName === 'SELECT') {
        if (el.multiple) continue;
        if (!overwrite && el.selectedIndex > 0) continue;
        fields.push({
          id: tag(el),
          kind: 'select',
          inputType: 'select-one',
          label: labelFor(el),
          name: el.name,
          options: [...el.options].map((o) => ({ value: o.value, label: o.textContent.replace(/\s+/g, ' ').trim() })),
        });
        continue;
      }
      const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || '').toLowerCase();
      if (type === 'radio') {
        if (!el.name) continue;
        const key = `${el.form ? [...document.forms].indexOf(el.form) : -1}:${el.name}`;
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(el);
        continue;
      }
      if (type !== 'textarea' && !TEXT_TYPES.has(type)) continue;
      if (!overwrite && el.value) continue;
      fields.push({
        id: tag(el),
        kind: 'text',
        inputType: type || 'text',
        label: labelFor(el),
        name: el.name,
        placeholder: el.placeholder || '',
        autocomplete: el.getAttribute('autocomplete') || '',
      });
    }

    for (const radios of radioGroups.values()) {
      if (!overwrite && radios.some((r) => r.checked)) continue;
      const id = `jsp${n++}`;
      radios.forEach((r, i) => r.setAttribute(ATTR, `${id}:${i}`));
      fields.push({
        id,
        kind: 'radio',
        inputType: 'radio',
        label: groupLabel(radios[0]),
        name: radios[0].name,
        options: radios.map((r, i) => ({ value: String(i), label: labelFor(r) || r.value })),
      });
    }
    return fields;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  }

  function coerce(el, value) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const half = globalThis.JevCandidates ? globalThis.JevCandidates.toHalfWidth(value) : value;
    const d = half.match(/(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/);
    const pad = (x) => String(x).padStart(2, '0');
    if (type === 'date' && d) return `${d[1]}-${pad(d[2])}-${pad(d[3])}`;
    if (type === 'month' && d) return `${d[1]}-${pad(d[2])}`;
    if (type === 'number') return half.replace(/[^\d.\-]/g, '');
    if (type === 'tel') return half.replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'));
    if (type === 'email') return half;
    return value;
  }

  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function highlight(el) {
    const prev = el.style.boxShadow;
    el.style.transition = 'box-shadow .3s';
    el.style.boxShadow = '0 0 0 3px rgba(80, 140, 255, .7)';
    setTimeout(() => (el.style.boxShadow = prev), 1800);
  }

  function apply(fills) {
    undoStack = [];
    let count = 0;
    for (const f of fills) {
      const radios = document.querySelectorAll(`[${ATTR}^="${f.fieldId}:"]`);
      if (radios.length) {
        const target = document.querySelector(`[${ATTR}="${f.fieldId}:${f.value}"]`);
        if (!target) continue;
        const was = [...radios].find((r) => r.checked);
        undoStack.push({ radio: target, was });
        target.click();
        if (!target.checked) target.checked = true;
        fire(target);
        highlight(target);
        count++;
        continue;
      }
      const el = document.querySelector(`[${ATTR}="${f.fieldId}"]`);
      if (!el) continue;
      undoStack.push({ el, was: el.value });
      el.focus();
      setNativeValue(el, el.tagName === 'SELECT' ? f.value : coerce(el, f.value));
      fire(el);
      el.blur();
      highlight(el);
      count++;
    }
    return count;
  }

  function undo() {
    let count = 0;
    for (const u of undoStack.reverse()) {
      if (u.radio) {
        if (u.was) u.was.checked = true;
        else u.radio.checked = false;
        fire(u.radio);
      } else {
        setNativeValue(u.el, u.was);
        fire(u.el);
      }
      count++;
    }
    undoStack = [];
    return count;
  }

  globalThis.__jevSmartPaste = { collect, apply, undo };
})();
