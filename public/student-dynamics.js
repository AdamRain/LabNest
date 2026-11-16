const translateStudentDynamics = (message, params = {}) => window.LabI18n?.t(message, params) ?? message.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
const publicationForms = [...document.querySelectorAll('[data-publication-form]')];

publicationForms.forEach(form => {
  const checkbox = form.querySelector('[data-publication-toggle]');
  if (!checkbox || typeof form.requestSubmit !== 'function') return;
  const summary = form.querySelector('textarea[name="summary"]');
  const error = form.querySelector('[data-publication-error]');
  const status = form.querySelector('[data-publication-status]');
  let pending = false;
  let selected = checkbox.checked;

  const syncRequired = () => { if (summary) summary.required = checkbox.checked; };
  const showError = message => {
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  };
  const summaryReady = () => {
    if (!checkbox.checked || !summary || summary.value.trim()) return true;
    showError(translateStudentDynamics('请先填写动态摘要，再勾选发布。'));
    summary.focus();
    return false;
  };

  syncRequired();
  form.addEventListener('submit', event => {
    if (pending || !summaryReady()) {
      event.preventDefault();
      return;
    }
    pending = true;
    selected = checkbox.checked;
    form.setAttribute('aria-busy', 'true');
    if (status) status.textContent = translateStudentDynamics('正在保存…');
    showError('');
  });
  checkbox.addEventListener('change', () => {
    if (pending) {
      checkbox.checked = selected;
      syncRequired();
      return;
    }
    syncRequired();
    showError('');
    if (!summaryReady()) {
      checkbox.checked = selected;
      syncRequired();
      return;
    }
    form.requestSubmit();
    if (!pending) {
      checkbox.checked = selected;
      syncRequired();
    }
  });
  summary?.addEventListener('input', () => showError(''));
  form.querySelectorAll('[data-publication-save]').forEach(button => { button.hidden = true; });
});

const feedSelector = 'aside[data-student-dynamics-feed]';
const hasFeed = Boolean(document.querySelector(feedSelector));

if (hasFeed) {
  let inFlight = false;
  let paused = false;
  let controller = null;

  const refreshFeed = async () => {
    const current = document.querySelector(feedSelector);
    if (inFlight || document.hidden || !current || current.matches(':focus-within')) return;
    inFlight = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000);
    try {
      const response = await fetch('/student/dynamics/feed', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal
      });
      if (response.redirected || response.status === 401 || response.status === 403) {
        window.location.reload();
        return;
      }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) return;
      const documentFragment = new DOMParser().parseFromString(await response.text(), 'text/html');
      const replacement = documentFragment.querySelector(feedSelector);
      const active = document.querySelector(feedSelector);
      if (!replacement || !active || document.hidden || active.matches(':focus-within')) return;
      const pauseControl = active.querySelector('.dynamics-pause');
      if (pauseControl) paused = pauseControl.checked;
      if (replacement.outerHTML === active.outerHTML) return;
      const nextPauseControl = replacement.querySelector('.dynamics-pause');
      if (nextPauseControl) nextPauseControl.checked = paused;
      active.replaceWith(replacement);
    } catch {
      // Keep the current feed during a temporary network failure.
    } finally {
      clearTimeout(timeout);
      controller = null;
      inFlight = false;
    }
  };

  const timer = setInterval(refreshFeed, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshFeed();
  });
  window.addEventListener('focus', refreshFeed);
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    controller?.abort();
  });
}

if (hasFeed || publicationForms.length) {
  window.addEventListener('pageshow', event => {
    if (event.persisted) window.location.reload();
  });
}
