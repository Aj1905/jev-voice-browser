// Run with Node's built-in runner. Real content-script listener and request builder;
// synthetic DOM only, with fetch explicitly forbidden. No browser/user data needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.JEV_TEST_ROOT || path.resolve(__dirname, '..');
const secret = 'SYNTHETIC_SECRET_ONLY';
function element({ tag = 'INPUT', type = 'text', value = secret, text = '', attrs = {}, editable = false, nested = false, ancestorEditor = false } = {}) {
  return { tagName: tag, type, value, innerText: text, isContentEditable: editable,
    labels: [], disabled: false, isConnected: true,
    getAttribute: k => attrs[k] || null,
    querySelector: selector => selector === 'img[alt]' ? null : nested ? {} : null,
    closest: () => ancestorEditor ? {} : null,
    contains: other => other === this,
    getBoundingClientRect: () => ({ width: 30, height: 20, top: 0, left: 0, bottom: 20, right: 30 }),
  };
}
function load(items, hover = items[0]) {
  let listener; let hitCalls = 0; const events = {};
  const document = { activeElement: items[0], title: 'Synthetic page',
    getElementById: () => null, querySelectorAll: () => items,
    elementFromPoint: () => hitCalls++ < items.length ? null : hover, documentElement: { scrollHeight: 100 },
    addEventListener: (name, cb) => { events[name] = cb; } };
  const context = vm.createContext({ URL, document, window: {},
    location: { href: 'https://example.invalid/' },
    innerWidth: 800, innerHeight: 600, scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    setTimeout: cb => { cb(); return 1; }, clearTimeout() {}, addEventListener() {},
    chrome: { runtime: { onMessage: { addListener: cb => { listener = cb; } } } },
    fetch() { throw new Error('Network forbidden'); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'jev.js'), 'utf8').replace(/^export /gm, ''), context);
  events.mousemove({ clientX: 10, clientY: 10 });
  let state; listener({ type: 'jev-state' }, {}, response => { state = response; });
  assert.equal(state.ok, true);
  const request = context.buildRequest('スクロールして', state, 'synthetic');
  return { state, request, context };
}
for (const [name, config] of [
  ['password with label', { type: 'password', attrs: { 'aria-label': 'Password' } }],
  ['unlabelled password fallback', { type: 'password' }],
  ['revealed password', { type: 'text', attrs: { autocomplete: 'current-password' } }],
  ['new password', { attrs: { autocomplete: 'new-password' } }],
  ['OTP', { attrs: { autocomplete: 'one-time-code' } }],
  ['card', { attrs: { autocomplete: 'cc-number' } }],
  ['ordinary text', {}],
  ['textarea', { tag: 'TEXTAREA', text: secret }],
  ['contenteditable', { tag: 'DIV', editable: true, text: secret }],
  ['custom textbox', { tag: 'DIV', attrs: { role: 'textbox' }, text: secret }],
  ['parent wrapping editor', { tag: 'DIV', text: secret, nested: true }],
  ['select selected content', { tag: 'SELECT', text: secret }],
]) test(name + ' does not enter page state or outbound request', () => {
  const { state, request } = load([element(config)]);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(JSON.stringify(request.body).includes(secret), false);
});
test('hover fallback outside collected elements does not expose editor text', () => {
  const { state, request } = load([], element({ tag: 'SPAN', text: secret, ancestorEditor: true }));
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(JSON.stringify(request.body).includes(secret), false);
});
test('associated wrapping label cannot reintroduce an editor value', () => {
  const input = element(); input.labels = [element({ tag: 'LABEL', nested: true, text: secret })];
  assert.equal(JSON.stringify(load([input]).request.body).includes(secret), false);
});
test('field value getter is never read while collecting context', () => {
  const input = element({ type: 'password' });
  Object.defineProperty(input, 'value', { get() { throw new Error('Field values must not be read'); } });
  assert.equal(load([input]).state.ok, true);
});
test('static labels, element numbers and focused editing remain available', () => {
  const input = element({ attrs: { 'aria-label': 'Search' } });
  const button = element({ tag: 'BUTTON', text: 'Submit', value: '' });
  const { state, context } = load([input, button]);
  assert.match(state.elements[0], /Search/); assert.match(state.elements[1], /Submit/);
  assert.equal(state.focusedEditable, true);
  const req = context.buildRequest('2番をクリック', state, 'synthetic');
  assert.equal(req.pinned, 2); assert.match(req.body.questions.target.criteria.e2, /Submit/);
});
