import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const messages = JSON.parse(readFileSync(new URL('../src/locales/en-client.json', import.meta.url), 'utf8'));

async function fixture({ language = 'en', initializeEditor = false } = {}) {
  const listeners = new Map(), confirmations = [];
  let accepted = false;
  const title = { name: 'plan', type: 'textarea', value: 'Original plan' };
  const file = { name: 'attachments', type: 'file', files: [] };
  const csrf = { name: 'csrf', type: 'hidden', value: 'original-token' };
  const rich = { innerHTML: '<p>Original plan</p>', getAttribute: () => '' };
  const form = { elements: [title, file, csrf], querySelectorAll: () => [rich] };
  const document = {
    documentElement: { lang: language }, readyState: 'loading', forms: [form],
    querySelectorAll: selector => selector === 'form' ? [form] : [],
    addEventListener(name, callback) { const handlers = listeners.get(name) ?? []; handlers.push(callback); listeners.set(name, handlers); }
  };
  const window = {
    LabMessages: messages,
    location: { href: 'https://lab.example/student/weekly?week=2026-11-16#weekly-plan', origin: 'https://lab.example', hash: '#weekly-plan' },
    confirm(message) { confirmations.push(message); return accepted; }
  };
  const link = {
    href: 'https://lab.example/language?lang=zh-CN&returnTo=%2Fstudent%2Fweekly%3Fweek%3D2026-11-16',
    closest: selector => selector === 'a[data-language-switch]' ? link : null
  };
  const context = { document, window, URL, queueMicrotask };
  vm.runInNewContext(script, context);
  function dispatch(name, event = {}) { for (const callback of listeners.get(name) ?? []) callback(event); }
  dispatch('DOMContentLoaded');
  if (initializeEditor) {
    // A deferred editor or a later DOMContentLoaded handler initializes the rich
    // field in this same turn. It is the baseline, not an unsaved user edit.
    rich.innerHTML = '<p>Initialized editor</p>';
    title.value = 'Initialized editor';
  }
  await Promise.resolve();
  function click(extra = {}) {
    const event = { target: link, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    dispatch('click', event);
    return event;
  }
  return { title, file, csrf, rich, form, window, document, link, confirmations, dispatch, click, accept: value => { accepted = value; } };
}

test('程序化粘贴图片或格式按钮修改也会提醒；取消切换保留草稿和附件', async () => {
  const f = await fixture();
  // The existing rich editor inserts pasted images and assigns FileList without
  // emitting an input/change event. The guard must still detect both changes.
  f.rich.innerHTML += '<figure><img src="blob:local-preview"></figure>';
  f.file.files = [{ name: 'pasted-image.png', size: 1234, lastModified: 42 }];
  const event = f.click();
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0], /Unsaved changes/);
  assert.match(f.rich.innerHTML, /blob:local-preview/);
  assert.equal(f.file.files[0].name, 'pasted-image.png');
  // A toolbar command may also modify only the rich DOM, with no input event.
  f.file.files = []; f.rich.innerHTML = '<p><strong>Original plan</strong></p>';
  assert.equal(f.click().defaultPrevented, true);
  assert.equal(f.confirmations.length, 2);
});

test('表单提交被编辑器阻止后，语言切换仍保护未保存修改', async () => {
  const f = await fixture();
  f.title.value = 'A plan that failed editor validation';
  f.dispatch('input', { target: { closest: () => f.form } });
  f.dispatch('submit', { target: f.form, defaultPrevented: true });
  assert.equal(f.click().defaultPrevented, true);
  assert.equal(f.confirmations.length, 1);
});

test('语言链接保留原页面查询和定位；确认后允许跳转，快捷键新标签页不打断当前编辑', async () => {
  const f = await fixture();
  f.title.value = 'Changed plan'; f.accept(true);
  assert.equal(f.click().defaultPrevented, false);
  const destination = new URL(f.link.href);
  assert.equal(destination.pathname, '/language');
  assert.equal(destination.searchParams.get('lang'), 'zh-CN');
  assert.equal(destination.searchParams.get('returnTo'), '/student/weekly?week=2026-11-16#weekly-plan');
  assert.equal(f.confirmations.length, 1);
  f.accept(false);
  assert.equal(f.click({ ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.confirmations.length, 1);
});

test('编辑器初始化、外观设置和隐藏令牌变化不误报；恢复原始值后不提醒', async () => {
  const f = await fixture({ initializeEditor: true });
  assert.equal(f.click().defaultPrevented, false);
  assert.equal(f.confirmations.length, 0);
  f.dispatch('change', { target: { value: 'dark', closest: () => null } });
  f.csrf.value = 'refreshed-token';
  assert.equal(f.click().defaultPrevented, false);
  f.title.value = 'Changed'; assert.equal(f.click().defaultPrevented, true);
  f.title.value = 'Initialized editor';
  assert.equal(f.click().defaultPrevented, false);
  assert.equal(f.confirmations.length, 1);
});

test('客户端中英文格式化切换覆盖动态标签，用户原文保持原样', async () => {
  const f = await fixture();
  assert.equal(f.window.LabI18n.t('显示密码'), 'Show password');
  assert.equal(f.window.LabI18n.t('第 {step} 步，共 {total} 步', { step: 2, total: 5 }), 'Step 2 of 5');
  assert.equal(f.window.LabI18n.t('用户原文：论文计划'), '用户原文：论文计划');
  f.document.documentElement.lang = 'zh-CN';
  assert.equal(f.window.LabI18n.locale(), 'zh-CN');
  assert.equal(f.window.LabI18n.t('第 {step} 步，共 {total} 步', { step: 2, total: 5 }), '第 2 步，共 5 步');
});
