(() => {
  'use strict';
  const messages = window.LabMessages ?? {};
  const normalized = new Map(Object.entries(messages).map(([key, value]) => [key.replace(/\s+/g, ' ').trim(), value]));
  const locale = () => document.documentElement.lang === 'en' ? 'en' : 'zh-CN';
  const t = (message, params = {}) => {
    const source = String(message ?? '');
    const text = locale() === 'en' ? messages[source] ?? normalized.get(source.replace(/\s+/g, ' ').trim()) ?? source : source;
    return text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
  };
  window.LabI18n = Object.freeze({ t, locale });

  function setupLanguageLinks() {
    // Keep drafts in the form, never in browser storage. Warn before a language
    // navigation discards actual edits, including rich text and staged files.
    const initial = new WeakMap();
    function snapshot(form) {
      return JSON.stringify(Array.from(form.elements).filter(field => field.name && !['submit', 'button', 'reset', 'hidden'].includes(field.type)).map(field => {
        if (field.type === 'file') return [field.name, Array.from(field.files ?? []).map(file => [file.name, file.size, file.lastModified])];
        if (field.type === 'checkbox' || field.type === 'radio') return [field.name, field.value, field.checked];
        if (field.multiple && field.options) return [field.name, Array.from(field.selectedOptions).map(option => option.value)];
        return [field.name, field.value];
      }).concat(Array.from(form.querySelectorAll('[contenteditable="true"]')).map(field => [field.getAttribute('data-rich-input') ?? 'rich-text', field.innerHTML])));
    }
    document.querySelectorAll('form').forEach(form => initial.set(form, snapshot(form)));
    document.addEventListener('click', event => {
      const link = event.target.closest?.('a[data-language-switch]');
      if (!link || event.defaultPrevented) return;
      const destination = new URL(link.href, window.location.href);
      const returnTo = destination.searchParams.get('returnTo');
      if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) {
        const current = new URL(returnTo, window.location.origin);
        current.hash = window.location.hash;
        destination.searchParams.set('returnTo', current.pathname + current.search + current.hash);
        link.href = destination.href;
      }
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const hasChanges = Array.from(document.forms).some(form => initial.has(form) && initial.get(form) !== snapshot(form));
      if (hasChanges && !window.confirm(t('切换语言会重新载入页面，尚未保存的内容可能丢失。是否继续？'))) event.preventDefault();
    });
  }
  // Deferred editors and other DOMContentLoaded handlers may initialize form
  // values. Capture the baseline after that work, without delaying interaction.
  const initialize = () => queueMicrotask(setupLanguageLinks);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
