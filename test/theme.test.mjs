import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { themeControl, themeHead } from '../src/theme-ui.mjs';

const script = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
const accents = ['emerald', 'blue', 'violet', 'rose', 'amber', 'slate'];

function fixture({ saved = null, accentSaved = null, dark = false, blockedStorage = false, missingMedia = false } = {}) {
  const root = { dataset: {}, style: {}, clientWidth: 390 };
  const controls = [], choices = [], labels = [], panels = [];
  const documentEvents = new Map(), windowEvents = new Map(), mediaEvents = new Map();
  const meta = { content: '#f4f8f7' };
  const media = { matches: dark, addEventListener: (name, callback) => mediaEvents.set(name, callback) };
  const storage = new Map();
  if (saved !== null) storage.set('lab.theme', saved);
  if (accentSaved !== null) storage.set('lab.accent', accentSaved);
  const document = { documentElement: root,
    querySelectorAll: selector => ({ '[data-theme-select]': controls, '[data-accent-choice]': choices,
      '[data-appearance-label]': labels, '[data-appearance-control][open]': panels.filter(panel => panel.open) })[selector] ?? [],
    querySelector: () => meta, addEventListener: (name, callback) => documentEvents.set(name, callback) };
  const window = { innerWidth: 390, matchMedia: missingMedia ? undefined : () => media,
    addEventListener: (name, callback) => windowEvents.set(name, callback) };
  const localStorage = {
    getItem(key) { if (blockedStorage) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, value) { if (blockedStorage) throw new Error('Storage unavailable'); storage.set(key, value); }
  };
  runInNewContext(script, { document, window, localStorage });
  return {
    root, meta, storage, controls, choices, labels,
    mount() {
      controls.push({ value: '', matches: selector => selector === '[data-theme-select]' }); labels.push({ textContent: '' });
      for (const value of accents) choices.push({ value, checked: false, matches: selector => selector === '[data-accent-choice]' });
      documentEvents.get('DOMContentLoaded')(); return controls[0];
    },
    choose(value) { const target = controls[0]; target.value = value; documentEvents.get('change')({ target }); },
    chooseAccent(value) {
      const target = choices.find(choice => choice.value === value) ?? { value, checked: true, matches: selector => selector === '[data-accent-choice]' };
      target.checked = true; documentEvents.get('change')({ target });
    },
    system(value) { media.matches = value; mediaEvents.get('change')?.(); },
    external(key, newValue) {
      if (key === null) storage.clear(); else if (newValue === null) storage.delete(key); else storage.set(key, newValue);
      windowEvents.get('storage')({ key, newValue });
    },
    panel(rect = { left: -40, right: 248 }) {
      const style = { setProperty(name, value) { this[name] = value; } };
      const summary = { focused: false, focus() { this.focused = true; }, getBoundingClientRect: () => ({ bottom: 64 }) };
      const bounds = () => { const shift = parseFloat(style['--appearance-shift']) || 0; return { left: rect.left + shift, right: rect.right + shift }; };
      const panel = { getBoundingClientRect: bounds };
      const control = { open: false, style, summary, matches: selector => selector === '[data-appearance-control]',
        querySelector: selector => selector === 'summary' ? summary : selector === '.appearance-panel' ? panel : null,
        contains: target => target === control || target.owner === control };
      panels.push(control);
      return { control, rect, bounds, open() { control.open = true; documentEvents.get('toggle')({ target: control }); } };
    },
    resize(width) { root.clientWidth = width; window.innerWidth = width; windowEvents.get('resize')(); },
    click(target) { documentEvents.get('click')({ target }); },
    key(key) {
      let prevented = false; documentEvents.get('keydown')({ key, preventDefault() { prevented = true; } }); return prevented;
    }
  };
}

test('首屏立即跟随系统，随后出现的控件同步选择；系统外观改变时实时更新', () => {
  const app = fixture({ dark: true });
  assert.equal(app.root.dataset.theme, 'dark'); assert.equal(app.root.style.colorScheme, 'dark');
  assert.equal(app.root.dataset.themePreference, 'system'); assert.equal(app.mount().value, 'system');
  assert.equal(app.labels[0].textContent, '跟随系统');
  app.system(false); assert.equal(app.root.dataset.theme, 'light'); assert.equal(app.meta.content, '#f4f8f7');
});

test('手动明暗选择会记住，系统变化不覆盖选择，重新进入页面仍保留', () => {
  const app = fixture(); app.mount(); app.choose('dark');
  assert.equal(app.root.dataset.theme, 'dark'); assert.equal(app.storage.get('lab.theme'), 'dark');
  assert.equal(app.labels[0].textContent, '深色');
  app.system(true); app.system(false); assert.equal(app.root.dataset.theme, 'dark');
  const next = fixture({ saved: app.storage.get('lab.theme') }); assert.equal(next.root.dataset.theme, 'dark'); assert.equal(next.mount().value, 'dark');
});

test('主题色在首屏读取，切换明暗和重新进入页面均保留，控件同步选中色', () => {
  const app = fixture({ saved: 'dark', accentSaved: 'violet' });
  assert.equal(app.root.dataset.accent, 'violet'); app.mount(); assert.equal(app.choices.find(choice => choice.checked).value, 'violet');
  app.chooseAccent('blue'); assert.equal(app.storage.get('lab.accent'), 'blue'); assert.equal(app.root.dataset.theme, 'dark');
  app.choose('light'); assert.equal(app.root.dataset.accent, 'blue'); assert.equal(app.choices.filter(choice => choice.checked).length, 1);
  const next = fixture({ saved: app.storage.get('lab.theme'), accentSaved: app.storage.get('lab.accent') });
  assert.equal(next.root.dataset.theme, 'light'); assert.equal(next.root.dataset.accent, 'blue');
});

test('其他标签页的明暗和颜色独立同步，清除存储或无效值回退，不接受任意颜色输入', () => {
  const app = fixture({ saved: 'light', accentSaved: 'rose', dark: true }); const control = app.mount();
  app.external('another.setting', 'dark'); assert.equal(app.root.dataset.theme, 'light'); assert.equal(app.root.dataset.accent, 'rose');
  app.external('lab.theme', 'dark'); assert.equal(control.value, 'dark'); assert.equal(app.root.dataset.accent, 'rose');
  app.external('lab.accent', 'amber'); assert.equal(app.root.dataset.accent, 'amber'); assert.equal(app.root.dataset.theme, 'dark');
  app.external('lab.accent', 'url(javascript:unsafe)'); assert.equal(app.root.dataset.accent, 'emerald');
  app.chooseAccent('#ffffff'); assert.equal(app.root.dataset.accent, 'emerald');
  app.external('lab.theme', 'invalid'); assert.equal(control.value, 'system');
  app.chooseAccent('slate'); app.external(null, null); assert.equal(app.root.dataset.themePreference, 'system'); assert.equal(app.root.dataset.accent, 'emerald');
});

test('浏览器禁用存储时仍可改变外观；不支持系统查询或无效旧设置时安全回退', () => {
  const app = fixture({ blockedStorage: true, dark: true }); app.mount();
  assert.equal(app.root.dataset.theme, 'dark'); app.choose('light'); assert.equal(app.root.dataset.theme, 'light');
  app.chooseAccent('violet'); assert.equal(app.root.dataset.accent, 'violet');
  app.choose('system'); assert.equal(app.root.dataset.theme, 'dark'); assert.equal(app.root.dataset.accent, 'violet');
  const invalid = fixture({ saved: 'invalid', accentSaved: 'invalid', missingMedia: true });
  assert.equal(invalid.root.dataset.theme, 'light'); assert.equal(invalid.root.dataset.accent, 'emerald');
});

test('面板内部操作保持展开，外部点击关闭；Escape关闭并将焦点还给触发器', () => {
  const app = fixture(); app.mount(); const first = app.panel(), second = app.panel();
  first.open(); app.click({ owner: first.control }); assert.equal(first.control.open, true);
  app.chooseAccent('blue'); assert.equal(first.control.open, true);
  second.open(); assert.equal(first.control.open, false); assert.equal(second.control.open, true);
  assert.equal(app.key('ArrowRight'), false); assert.equal(second.control.open, true);
  assert.equal(app.key('Escape'), true); assert.equal(second.control.open, false); assert.equal(second.control.summary.focused, true);
  assert.equal(app.root.dataset.accent, 'blue'); assert.equal(app.key('Escape'), false);
  first.open(); app.click({}); assert.equal(first.control.open, false);
});

test('窄屏展开和窗口变化后，面板重新测量并留在视口内，重复调整不会累积偏移', () => {
  const app = fixture(); app.mount(); const panel = app.panel(); panel.open();
  const inside = width => { const bounds = panel.bounds(); assert.ok(bounds.left >= 12); assert.ok(bounds.right <= width - 12); };
  inside(390);
  Object.assign(panel.rect, { left: 200, right: 488 }); app.resize(390); inside(390);
  app.resize(390); inside(390);
  Object.assign(panel.rect, { left: 16, right: 304 }); app.resize(320); inside(320);
  Object.assign(panel.rect, { left: 600, right: 888 }); app.resize(1000); inside(1000);
});

test('主题控件使用原生明暗选择与六种有名称的单选项，各控件分组不冲突', () => {
  const first = themeControl(), second = themeControl();
  assert.match(first, /<details class="appearance-control" data-appearance-control>/);
  assert.match(first, /<summary[^>]+aria-label="外观设置"/); assert.match(first, /data-theme-select aria-label="界面外观"/);
  assert.equal((first.match(/type="radio"/g) ?? []).length, 6); assert.equal((first.match(/data-accent-choice/g) ?? []).length, 6);
  for (const name of ['翡翠绿', '海洋蓝', '鸢尾紫', '玫瑰粉', '琥珀橙', '石墨灰']) assert.ok(first.includes(name));
  assert.notEqual(first.match(/name="([^"]+)"/)[1], second.match(/name="([^"]+)"/)[1]);
  const head = themeHead(); assert.match(head, /theme\.css.*appearance-controls\.css.*accent\.css.*glass\.css/);
});
