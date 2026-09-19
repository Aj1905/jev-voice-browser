// 発話テキスト + ページの状態 → Jev に 1 回問い合わせて、実行する操作を決める。
// Jev はテキストを生成しないので、入力する文字列などはコード側で候補を切り出し、Jev には選ばせるだけにする。

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export const ACTIONS = {
  scroll_down: 'Scroll the page down to see more content (e.g. 「スクロールして」「下へ」「次を見せて」).',
  scroll_up: 'Scroll the page up (e.g. 「上へ」「戻って上を見せて」).',
  scroll_top: 'Jump to the very top of the page (e.g. 「一番上へ」「トップへ」).',
  scroll_bottom: 'Jump to the very bottom of the page (e.g. 「一番下へ」「最後まで」).',
  click: 'Click, press, open, check, or select an element on the page (e.g. 「ここクリックして」「ログインを押して」「3番を開いて」).',
  type_text: 'Type or enter text into an input box on the page (e.g. 「検索欄に猫と入力して」「メールに…と書いて」).',
  web_search: 'Search the web with a search engine for a phrase, without mentioning a box on this page (e.g. 「東京の天気を検索して」「〜を調べて」).',
  find_on_page: 'Find a word within the current page (e.g. 「このページで〜を探して」「ページ内検索」).',
  go_back: 'Go back to the previous page in history (e.g. 「前のページに戻って」「戻る」).',
  go_forward: 'Go forward in history (e.g. 「進んで」「次のページへ進む」).',
  reload: 'Reload the current page (e.g. 「再読み込み」「更新して」).',
  new_tab: 'Open a new empty tab.',
  close_tab: 'Close the current tab (e.g. 「このタブを閉じて」).',
  next_tab: 'Switch to the next tab to the right.',
  prev_tab: 'Switch to the previous tab to the left.',
  none: 'The speech is not a browser command, is unclear, or is only noise/filler.',
};

// 「ここ」「これ」系の指示語
const DEICTIC = /(ここ|これ|この|そこ|それ|そっち|こっち)/;

function normalizeDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 「5番」「5 番目」「番号5」→ 5
export function badgeNumber(utterance) {
  const s = normalizeDigits(utterance);
  const m = s.match(/(\d+)\s*番/) || s.match(/番号\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// 入力・検索する文字列の候補を発話から切り出す。複数あれば Jev に選ばせる。
export function textCandidates(utterance) {
  const s = utterance.trim();
  const out = new Set();
  const add = (t) => {
    t = (t || '').trim().replace(/^[、。,.\s「『"“]+|[、。,.\s」』"”]+$/g, '');
    if (t && t.length <= 200) out.add(t);
  };
  for (const m of s.matchAll(/[「『"“](.+?)[」』"”]/g)) add(m[1]);
  const patterns = [
    /(.+?)(?:と|って)(?:入力|打|書|タイプ|入れ)/,
    /(.+?)を(?:入力|打ち込|書い|入れ)/,
    /(.+?)(?:で|を|について)(?:検索|調べ|ググ|探し|探す)/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    add(m[1]);
    // 「検索欄に東京の天気」→「東京の天気」のように、場所の指定(〜に/〜へ/〜で)を外した候補も作る
    for (const sep of m[1].matchAll(/[にへで]/g)) add(m[1].slice(sep.index + 1));
  }
  return [...out];
}

function elementCriteria(state, pinned) {
  const criteria = {};
  state.elements.forEach((d, i) => { criteria[`e${i + 1}`] = d; });
  if (state.hovered.index >= 0 || state.hovered.text) {
    criteria.here = `The element under the user's mouse pointer — choose this when the user says 「ここ」「これ」「この」 without naming the element. It is: ${state.hovered.text || 'unknown'}`;
  }
  if (pinned != null) {
    criteria[`e${pinned}`] = `${criteria[`e${pinned}`] || ''} (the user said number ${pinned}; its badge shows ${pinned})`;
  }
  criteria.no_target = 'No element on the page is meant, or the needed element is not in this list.';
  return criteria;
}

export function buildRequest(utterance, state, model) {
  const pinned = badgeNumber(utterance);
  const candidates = textCandidates(utterance);
  const questions = {
    action: {
      type: 'choice',
      instructions: 'The user spoke a command (in Japanese) to control their web browser. Which single browser operation does the user want?',
      criteria: ACTIONS,
    },
    scroll_amount: {
      type: 'choice',
      instructions: 'If the user wants to scroll, how far? If no amount is said, answer medium.',
      criteria: {
        small: 'A little (「少し」「ちょっと」).',
        medium: 'About one screen, or no amount mentioned.',
        large: 'A lot (「もっと」「たくさん」「ずっと」「一気に」).',
      },
    },
    submit: {
      type: 'noul',
      instructions: 'After typing text, does the user also want to submit it or press Enter (e.g. 「〜で検索して」「送信して」「エンター」)?',
    },
  };
  if (state.elements.length) {
    questions.target = {
      type: 'choice',
      instructions: 'Which element on the page does the user\'s command refer to (the thing to click or the box to type into)? Match the words the user said against each element description.',
      criteria: elementCriteria(state, pinned),
    };
  }
  if (candidates.length > 1) {
    const criteria = {};
    candidates.forEach((c, i) => { criteria[`t${i}`] = `「${c}」`; });
    questions.text = {
      type: 'choice',
      instructions: 'Exactly which text should be typed or searched for? Pick the candidate that is only the content to enter, without words describing where to put it or what to do.',
      criteria,
    };
  }
  const body = {
    model,
    state: {
      user_command: utterance,
      page_title: state.title,
      element_under_mouse_pointer: state.hovered.text || 'none',
      text_box_is_focused: state.focusedEditable,
    },
    questions,
  };
  return { body, candidates, pinned };
}

export async function askJev(apiKey, body, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if ((res.status === 429 || res.status === 529) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Jev API ${res.status}: ${JSON.stringify(json.detail ?? json).slice(0, 300)}`);
    return json;
  }
}

// Jev の回答 → 実行計画
export function toPlan(answers, { candidates, pinned }, state, utterance) {
  const action = answers.action;
  const plan = {
    action: action.choice,
    confidence: action.confidence,
    amount: answers.scroll_amount?.choice || 'medium',
    submit: (answers.submit?.noul ?? 0) >= 0.5,
    index: -1,
    text: null,
  };

  const target = answers.target;
  if (pinned != null && pinned >= 1 && pinned <= state.elements.length) {
    plan.index = pinned - 1; // 番号指定はコードで確定させる
  } else if (target) {
    if (target.choice === 'here') plan.index = state.hovered.index;
    else if (/^e\d+$/.test(target.choice)) plan.index = Number(target.choice.slice(1)) - 1;
    plan.targetConfidence = target.confidence;
    // 指示語だけでクリックの対象が決め切れないときは、マウス位置の要素を優先
    if (plan.action === 'click' && DEICTIC.test(utterance) && state.hovered.index >= 0 &&
        (target.choice === 'no_target' || target.confidence < 0.5)) {
      plan.index = state.hovered.index;
    }
  }

  if (candidates.length === 1) plan.text = candidates[0];
  else if (candidates.length > 1) plan.text = candidates[Number(answers.text.choice.slice(1))];
  return plan;
}
