const translateTheme = (message, params = {}) => window.LabI18n?.t(message, params) ?? message.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
(() => {
  'use strict';
  const themeKey = 'lab.theme', accentKey = 'lab.accent';
  const root = document.documentElement;
  const validTheme = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  const validAccent = value => ['emerald', 'blue', 'violet', 'rose', 'amber', 'slate'].includes(value) ? value : 'emerald';
  const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
  let preference = 'system', accent = 'emerald', system = null;
  try { preference = validTheme(localStorage.getItem(themeKey)); } catch { /* Selection still works for this tab. */ }
  try { accent = validAccent(localStorage.getItem(accentKey)); } catch { /* Selection still works for this tab. */ }
  try { system = window.matchMedia('(prefers-color-scheme: dark)'); } catch { /* Light is the fallback. */ }

  function apply() {
    const theme = preference === 'system' ? system?.matches ? 'dark' : 'light' : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.dataset.accent = accent;
    root.style.colorScheme = theme;
    document.querySelectorAll('[data-theme-select]').forEach(select => { select.value = preference; });
    document.querySelectorAll('[data-accent-choice]').forEach(choice => { choice.checked = choice.value === accent; });
    document.querySelectorAll('[data-appearance-label]').forEach(label => { label.textContent = translateTheme(labels[preference]); });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#101b22' : '#f4f8f7';
  }

  function positionPanel(control) {
    const panel = control.querySelector('.appearance-panel');
    const trigger = control.querySelector('summary');
    if (!panel || !trigger || !control.open) return;
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    control.style.setProperty('--appearance-shift', '0px');
    control.style.setProperty('--appearance-top', Math.max(0, trigger.getBoundingClientRect().bottom + 10) + 'px');
    const rect = panel.getBoundingClientRect();
    const shift = rect.left < 12 ? 12 - rect.left : rect.right > viewport - 12 ? viewport - 12 - rect.right : 0;
    control.style.setProperty('--appearance-shift', shift + 'px');
  }

  function closePanels(except, restoreFocus = false) {
    let last;
    document.querySelectorAll('[data-appearance-control][open]').forEach(control => {
      if (control === except) return;
      control.open = false;
      last = control;
    });
    if (restoreFocus) last?.querySelector('summary')?.focus();
  }

  // Apply saved preferences in the head before paint, then synchronize the controls.
  apply();
  document.addEventListener('DOMContentLoaded', apply, { once: true });
  document.addEventListener('change', event => {
    if (event.target.matches?.('[data-theme-select]')) {
      preference = validTheme(event.target.value);
      try { localStorage.setItem(themeKey, preference); } catch { /* Keep the choice in this tab. */ }
    } else if (event.target.matches?.('[data-accent-choice]')) {
      if (!event.target.checked) return;
      accent = validAccent(event.target.value);
      try { localStorage.setItem(accentKey, accent); } catch { /* Keep the choice in this tab. */ }
    } else return;
    apply();
  });
  document.addEventListener('toggle', event => {
    const control = event.target;
    if (!control.matches?.('[data-appearance-control]') || !control.open) return;
    closePanels(control);
    positionPanel(control);
  }, true);
  document.addEventListener('click', event => {
    document.querySelectorAll('[data-appearance-control][open]').forEach(control => {
      if (!control.contains(event.target)) control.open = false;
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !document.querySelectorAll('[data-appearance-control][open]').length) return;
    event.preventDefault();
    closePanels(null, true);
  });
  const systemChanged = () => { if (preference === 'system') apply(); };
  if (system?.addEventListener) system.addEventListener('change', systemChanged);
  else system?.addListener?.(systemChanged);
  window.addEventListener('resize', () => document.querySelectorAll('[data-appearance-control][open]').forEach(positionPanel));
  window.addEventListener('storage', event => {
    if (event.key === null) { preference = 'system'; accent = 'emerald'; }
    else if (event.key === themeKey) preference = validTheme(event.newValue);
    else if (event.key === accentKey) accent = validAccent(event.newValue);
    else return;
    apply();
  });
})();
