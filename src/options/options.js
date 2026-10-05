/* global JevClient */
const FIELDS = ['apiKey', 'threshold', 'overwrite', 'endpoint', 'model'];
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(FIELDS).then((stored) => {
  const s = { ...JevClient.DEFAULTS, ...stored };
  for (const k of FIELDS) {
    if ($(k).type === 'checkbox') $(k).checked = !!s[k];
    else $(k).value = s[k];
  }
});

$('save').addEventListener('click', async () => {
  const endpoint = $('endpoint').value.trim() || JevClient.DEFAULTS.endpoint;
  try {
    const origin = `${new URL(endpoint).origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`${origin} へのアクセスが許可されませんでした`);
    }
    const threshold = Math.min(1, Math.max(0, Number($('threshold').value) || 0));
    await chrome.storage.local.set({
      apiKey: $('apiKey').value.trim(),
      threshold,
      overwrite: $('overwrite').checked,
      endpoint,
      model: $('model').value.trim() || JevClient.DEFAULTS.model,
    });
    $('status').textContent = '保存しました。';
    $('status').className = '';
  } catch (e) {
    $('status').textContent = e.message;
    $('status').className = 'error';
  }
});
