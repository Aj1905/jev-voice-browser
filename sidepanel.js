import { buildRequest, askJev, toPlan } from './jev.js';

const DEFAULTS = { apiKey: '', model: 'jev-latest', lang: 'ja-JP', minConfidence: 0.35 };
const STOP_WORDS = /^(ストップ|止めて|とめて|停止|終了|やめて|聞かなくていい)/;

const $ = (id) => document.getElementById(id);
const micBtn = $('mic');
let settings = { ...DEFAULTS };
let rec = null;
let wantListening = false;
let queue = Promise.resolve();

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  const { continuous = false, badges = false } = await chrome.storage.local.get(['continuous', 'badges']);
  $('continuous').checked = continuous;
  $('badges').checked = badges;
  $('notice').hidden = !!settings.apiKey;
  if (!settings.apiKey) $('notice').innerHTML = 'TypeSafe の API キーが未設定です。<a href="options.html" target="_blank">設定</a>から入力してください。';
}
chrome.storage.onChanged.addListener(loadSettings);

const setStatus = (t) => { $('status').textContent = t; };

function logEntry(said) {
  const li = document.createElement('li');
  li.innerHTML = '<div class="said"></div><div class="detail"></div><div class="result"></div>';
  li.querySelector('.said').textContent = `「${said}」`;
  $('log').appendChild(li);
  while ($('log').children.length > 50) $('log').firstElementChild.remove();
  return {
    detail: (t) => { li.querySelector('.detail').textContent = t; },
    ok: (t) => { const r = li.querySelector('.result'); r.textContent = t; r.className = 'result ok'; },
    err: (t) => { const r = li.querySelector('.result'); r.textContent = t; r.className = 'result err'; },
  };
}

// ---------- タブとページ ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // 拡張を入れる前から開いていたタブにはコンテンツスクリプトがないので注入して再試行
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function pageState(tab) {
  try {
    const s = await sendToTab(tab.id, { type: 'jev-state' });
    if (s?.ok) return s;
  } catch {}
  // chrome:// や Web ストアなど、拡張が触れないページ
  return { title: tab.title || '', url: tab.url || '', elements: [], hovered: { index: -1, text: '' }, focusedEditable: false, restricted: true };
}

async function act(tab, msg) {
  const r = await sendToTab(tab.id, { type: 'jev-act', ...msg });
  if (!r?.ok) throw new Error(r?.error || 'ページを操作できませんでした');
  return r.result;
}

async function switchTab(tab, delta) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const next = tabs[(tabs.findIndex((t) => t.id === tab.id) + delta + tabs.length) % tabs.length];
  await chrome.tabs.update(next.id, { active: true });
  return `「${next.title}」に切り替えました`;
}

async function execute(plan, tab, state) {
  const needsPage = ['scroll_down', 'scroll_up', 'scroll_top', 'scroll_bottom', 'click', 'type_text', 'find_on_page'];
  if (state.restricted && needsPage.includes(plan.action)) throw new Error('このページは拡張機能から操作できません');
  switch (plan.action) {
    case 'scroll_down': return act(tab, { action: 'scroll', direction: 'down', amount: plan.amount });
    case 'scroll_up': return act(tab, { action: 'scroll', direction: 'up', amount: plan.amount });
    case 'scroll_top': return act(tab, { action: 'scroll', direction: 'top' });
    case 'scroll_bottom': return act(tab, { action: 'scroll', direction: 'bottom' });
    case 'click':
      if (plan.index < 0) throw new Error('どこをクリックするか特定できませんでした(マウスを置くか「番号を表示」で番号を指定してください)');
      return act(tab, { action: 'click', index: plan.index });
    case 'type_text':
      if (!plan.text) throw new Error('入力する文字が聞き取れませんでした(例:「検索欄に〇〇と入力して」)');
      return act(tab, { action: 'type', index: plan.index, text: plan.text, submit: plan.submit });
    case 'find_on_page':
      if (!plan.text) throw new Error('探す言葉が聞き取れませんでした');
      return act(tab, { action: 'find', text: plan.text });
    case 'web_search':
      if (!plan.text) throw new Error('検索する言葉が聞き取れませんでした');
      await chrome.search.query({ text: plan.text, tabId: tab.id });
      return `「${plan.text}」を検索しました`;
    case 'go_back': await chrome.tabs.goBack(tab.id); return '前のページに戻りました';
    case 'go_forward': await chrome.tabs.goForward(tab.id); return '次のページに進みました';
    case 'reload': await chrome.tabs.reload(tab.id); return '再読み込みしました';
    case 'new_tab': await chrome.tabs.create({ windowId: tab.windowId }); return '新しいタブを開きました';
    case 'close_tab': await chrome.tabs.remove(tab.id); return 'タブを閉じました';
    case 'next_tab': return switchTab(tab, 1);
    case 'prev_tab': return switchTab(tab, -1);
    default: throw new Error('ブラウザ操作の指示として解釈できませんでした');
  }
}

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;

async function handleCommand(utterance) {
  utterance = utterance.trim();
  if (!utterance) return;
  if (STOP_WORDS.test(utterance)) { stopListening(); setStatus('停止しました'); return; }
  const log = logEntry(utterance);
  if (!settings.apiKey) { log.err('API キーが未設定です'); return; }

  micBtn.classList.add('busy');
  setStatus('Jev に問い合わせ中…');
  try {
    const tab = await activeTab();
    const state = await pageState(tab);
    const req = buildRequest(utterance, state, settings.model);
    const t0 = performance.now();
    const res = await askJev(settings.apiKey, req.body);
    const ms = Math.round(performance.now() - t0);
    const plan = toPlan(res.answers, req, state, utterance);

    const target = plan.index >= 0 ? ` / 対象 ${plan.index + 1}: ${state.elements[plan.index]}` : '';
    const text = plan.text ? ` / 文字「${plan.text}」${plan.submit ? '+送信' : ''}` : '';
    log.detail(`${plan.action} (確信度 ${pct(plan.confidence)})${target}${text} — ${ms}ms`);

    if (plan.action !== 'none' && plan.confidence < settings.minConfidence) {
      const top = Object.entries(res.answers.action.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k} ${pct(v)}`).join(', ');
      throw new Error(`確信度が低いため実行しませんでした(${top})。言い方を変えてもう一度どうぞ`);
    }
    log.ok(await execute(plan, tab, state));
  } catch (e) {
    log.err(String(e.message || e));
  } finally {
    micBtn.classList.remove('busy');
    setStatus(wantListening ? '聞いています…' : '待機中');
  }
}

// 発話は順番に処理する(前の操作が終わる前に次を実行しない)
const enqueue = (text) => { queue = queue.then(() => handleCommand(text)); };

// ---------- 音声認識 ----------
function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus('このブラウザは音声認識に対応していません'); return; }
  wantListening = true;
  const self = rec = new SR();
  rec.lang = settings.lang;
  rec.interimResults = true;
  rec.continuous = $('continuous').checked;
  rec.onstart = () => { micBtn.classList.add('listening'); setStatus('聞いています…'); };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) enqueue(r[0].transcript);
      else interim += r[0].transcript;
    }
    $('interim').textContent = interim;
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      wantListening = false;
      setStatus('マイクの許可が必要です');
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      setStatus(`音声認識エラー: ${e.error}`);
    }
  };
  rec.onend = () => {
    if (self !== rec) return; // 設定変更で作り直した古い認識器の終了は無視
    $('interim').textContent = '';
    // 聞き続けるモードでは、無音で切れても自動で再開する
    if (wantListening && $('continuous').checked) { setTimeout(() => { try { if (wantListening) rec.start(); } catch {} }, 150); return; }
    wantListening = false;
    micBtn.classList.remove('listening');
    setStatus('待機中');
  };
  rec.start();
}

function stopListening() {
  wantListening = false;
  rec?.abort();
  micBtn.classList.remove('listening');
}

const toggleListening = () => (wantListening ? stopListening() : startListening());

micBtn.addEventListener('click', toggleListening);
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'toggle-listening') toggleListening(); });

$('continuous').addEventListener('change', (e) => {
  chrome.storage.local.set({ continuous: e.target.checked });
  if (wantListening) { stopListening(); startListening(); }
});

$('textForm').addEventListener('submit', (e) => {
  e.preventDefault();
  enqueue($('textInput').value);
  $('textInput').value = '';
});

// ---------- 番号バッジ ----------
async function syncBadges() {
  const tab = await activeTab();
  if (tab) sendToTab(tab.id, { type: 'jev-badges', on: $('badges').checked }).catch(() => {});
}
$('badges').addEventListener('change', (e) => { chrome.storage.local.set({ badges: e.target.checked }); syncBadges(); });
chrome.tabs.onActivated.addListener(syncBadges);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') syncBadges(); });

loadSettings().then(syncBadges);
