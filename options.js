const DEFAULTS = { apiKey: '', model: 'jev-latest', lang: 'ja-JP', minConfidence: 0.35 };
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t; };

function ensureModelOption(name) {
  if (![...$('model').options].some((o) => o.value === name)) $('model').add(new Option(name, name));
}

chrome.storage.local.get(Object.keys(DEFAULTS)).then((s) => {
  s = { ...DEFAULTS, ...s };
  $('apiKey').value = s.apiKey;
  ensureModelOption(s.model);
  $('model').value = s.model;
  $('lang').value = s.lang;
  $('minConfidence').value = s.minConfidence;
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    lang: $('lang').value,
    minConfidence: Math.min(1, Math.max(0, Number($('minConfidence').value) || 0)),
  });
  msg('保存しました');
});

$('test').addEventListener('click', async () => {
  msg('確認中…');
  try {
    const res = await fetch('https://api.typesafe.ai/v1/models', {
      headers: { Authorization: `Bearer ${$('apiKey').value.trim()}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    const current = $('model').value;
    for (const m of json.models || []) ensureModelOption(m.name);
    $('model').value = current;
    msg(`接続 OK。使えるモデル: ${(json.models || []).map((m) => m.name).join(', ')}`);
  } catch (e) {
    msg(`接続に失敗しました: ${e.message}`);
  }
});

$('mic').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') }));
