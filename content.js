// ページ側: 画面上の操作可能な要素を集めて番号を振り、サイドパネルからの操作命令を実行する。
(() => {
  if (window.__jevVoiceLoaded) return;
  window.__jevVoiceLoaded = true;

  const MAX_ELEMENTS = 150;
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
    '[role=radio]', '[role=switch]', '[role=option]', '[role=combobox]', '[role=textbox]',
    '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]', '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // 「ここ」= マウスが最後に 250ms 以上止まっていた位置。
  // サイドパネルのボタンへマウスを動かす途中の位置を拾わないようにするため。
  let pointer = { x: -1, y: -1 };
  let restTimer = null;
  document.addEventListener('mousemove', (e) => {
    clearTimeout(restTimer);
    const x = e.clientX, y = e.clientY;
    restTimer = setTimeout(() => { pointer = { x, y }; }, 250);
  }, { passive: true, capture: true });

  let elements = [];
  let badgeLayer = null;
  let badgesOn = false;

  const clip = (s, n = 80) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    // 他の要素に隠れていないか(中心点で判定。自分・子孫・祖先なら可)
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(cx, cy);
    return !hit || hit === el || el.contains(hit) || hit.contains(el);
  }

  // Never collect existing field contents, including revealed passwords, OTPs,
  // card details and text editors. Containers can include an editor's text too.
  function labelText(el) {
    if (!el) return '';
    if (el.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"]')) return '';
    if (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
        ['textbox', 'searchbox'].includes(el.getAttribute?.('role'))) return '';
    if (el.querySelector?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"]')) return '';
    return el.innerText || '';
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') &&
      labelText(document.getElementById(el.getAttribute('aria-labelledby')));
    if (aria) return clip(aria);
    if (el.labels && el.labels[0]) return clip(labelText(el.labels[0]));
    const text = labelText(el);
    if (text && text.trim()) return clip(text);
    const alt = el.querySelector?.('img[alt]')?.getAttribute('alt');
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || alt ||
      el.getAttribute('name') || '');
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (tag === 'a') return 'リンク';
    if (tag === 'button' || role === 'button') return 'ボタン';
    if (tag === 'select' || role === 'combobox') return 'プルダウン';
    if (tag === 'textarea' || el.isContentEditable || role === 'textbox' || role === 'searchbox') return '入力欄';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t === 'checkbox' ? 'チェックボックス' : 'ラジオボタン';
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'ボタン';
      return t === 'search' ? '検索欄' : '入力欄';
    }
    if (role === 'tab') return 'タブ';
    if (role === 'menuitem') return 'メニュー項目';
    if (role) return role;
    return tag;
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color']
      .includes((el.type || 'text').toLowerCase());
  }

  function describe(el) {
    const kind = kindOf(el);
    let d = `${kind}「${labelOf(el)}」`;
    if (el.tagName === 'A' && el.href) {
      try { const u = new URL(el.href); d += ` → ${u.host}${clip(u.pathname, 40)}`; } catch {}
    }
    if (el === document.activeElement) d += ' [フォーカス中]';
    return d;
  }

  function collect() {
    const seen = new Set();
    const list = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (list.length >= MAX_ELEMENTS) break;
      if (seen.has(el) || el.disabled) continue;
      // 操作可能要素の中に入れ子になった操作可能要素は外側だけ採る
      if ([...seen].some((p) => p.contains(el) && p.tagName !== 'BODY' && labelOf(p))) continue;
      if (!isVisible(el)) continue;
      seen.add(el);
      list.push(el);
    }
    elements = list;
    return list;
  }

  function hoveredIndex() {
    if (pointer.x < 0) return { index: -1, text: '' };
    const hit = document.elementFromPoint(pointer.x, pointer.y);
    if (!hit) return { index: -1, text: '' };
    const i = elements.findIndex((el) => el === hit || el.contains(hit));
    return { index: i, text: i >= 0 ? describe(elements[i]) : clip(labelOf(hit) || kindOf(hit), 60) };
  }

  // ---------- 番号バッジ ----------
  function drawBadges() {
    removeBadges();
    badgeLayer = document.createElement('div');
    badgeLayer.id = '__jev_badges';
    Object.assign(badgeLayer.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647',
    });
    elements.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.textContent = String(i + 1);
      Object.assign(b.style, {
        position: 'absolute', left: `${Math.max(0, r.left - 4)}px`, top: `${Math.max(0, r.top - 8)}px`,
        font: 'bold 11px/1 system-ui, sans-serif', color: '#fff', background: '#d9480f',
        padding: '2px 4px', borderRadius: '4px', boxShadow: '0 1px 2px rgba(0,0,0,.4)',
      });
      badgeLayer.appendChild(b);
    });
    document.documentElement.appendChild(badgeLayer);
  }
  function removeBadges() { badgeLayer?.remove(); badgeLayer = null; }

  let redrawTimer = null;
  const scheduleRedraw = () => {
    if (!badgesOn) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { collect(); drawBadges(); }, 200);
  };
  addEventListener('scroll', scheduleRedraw, { passive: true, capture: true });
  addEventListener('resize', scheduleRedraw, { passive: true });

  // ---------- 操作 ----------
  function flash(el) {
    const r = el.getBoundingClientRect();
    const f = document.createElement('div');
    Object.assign(f.style, {
      position: 'fixed', left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`,
      height: `${r.height + 6}px`, border: '3px solid #d9480f', borderRadius: '6px',
      pointerEvents: 'none', zIndex: '2147483647', transition: 'opacity .6s',
    });
    document.documentElement.appendChild(f);
    setTimeout(() => { f.style.opacity = '0'; }, 400);
    setTimeout(() => f.remove(), 1000);
  }

  function scrollTarget() {
    // マウス位置(なければ画面中央)から親をたどって、縦にスクロールできる要素を探す
    const x = pointer.x >= 0 ? pointer.x : innerWidth / 2;
    const y = pointer.y >= 0 ? pointer.y : innerHeight / 2;
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function doScroll(direction, amount) {
    const target = scrollTarget();
    const view = target === document.scrollingElement ? innerHeight : target.clientHeight;
    const factor = { small: 0.3, medium: 0.8, large: 2.0 }[amount] ?? 0.8;
    if (direction === 'top') target.scrollTo({ top: 0, behavior: 'smooth' });
    else if (direction === 'bottom') target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    else target.scrollBy({ top: (direction === 'up' ? -1 : 1) * view * factor, behavior: 'smooth' });
    return `${direction} にスクロールしました`;
  }

  function doClick(el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    flash(el);
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return `${describe(el)} をクリックしました`;
  }

  function setValue(el, text) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      return;
    }
    // React などが値の変更を検知できるよう、ネイティブの setter を通して input イベントを出す
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notCanceled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    // 合成キーイベントではフォーム送信が起きないので自前で送信する
    if (notCanceled && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  }

  function fallbackInput() {
    if (isEditable(document.activeElement)) return document.activeElement;
    return elements.find(isEditable) || null;
  }

  function doType(el, text, submit) {
    el = el && isEditable(el) ? el : fallbackInput();
    if (!el) throw new Error('入力欄が見つかりません');
    el.scrollIntoView({ block: 'nearest' });
    flash(el);
    setValue(el, text);
    if (submit) pressEnter(el);
    return `${describe(el)} に「${text}」を入力しました${submit ? '(送信)' : ''}`;
  }

  function doFind(text) {
    const found = window.find(text, false, false, true, false, false, false);
    return found ? `「${text}」を見つけました` : `「${text}」は見つかりませんでした`;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.type) {
        case 'jev-state': {
          collect();
          if (badgesOn) drawBadges();
          const active = document.activeElement;
          sendResponse({
            ok: true,
            title: document.title,
            url: location.href,
            elements: elements.map(describe),
            hovered: hoveredIndex(),
            focusedEditable: isEditable(active),
            scroll: {
              atTop: scrollY <= 0,
              atBottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 2,
            },
          });
          break;
        }
        case 'jev-badges':
          badgesOn = !!msg.on;
          if (badgesOn) { collect(); drawBadges(); } else removeBadges();
          sendResponse({ ok: true });
          break;
        case 'jev-act': {
          const el = msg.index >= 0 ? elements[msg.index] : null;
          let result;
          if (msg.action === 'scroll') result = doScroll(msg.direction, msg.amount);
          else if (msg.action === 'click') {
            if (!el || !el.isConnected) throw new Error('クリックする要素が見つかりません');
            result = doClick(el);
          } else if (msg.action === 'type') result = doType(el, msg.text, msg.submit);
          else if (msg.action === 'find') result = doFind(msg.text);
          else throw new Error(`未知の操作: ${msg.action}`);
          sendResponse({ ok: true, result });
          break;
        }
        default:
          return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
    return false;
  });
})();
