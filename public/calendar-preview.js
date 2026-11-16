const translateCalendarPreview = (message, params = {}) => window.LabI18n?.t(message, params) ?? message.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
const days = [...document.querySelectorAll('a[data-calendar-preview]')];

if (days.length) {
  const popup = document.createElement('div');
  popup.id = 'calendar-day-preview';
  popup.className = 'calendar-preview';
  popup.setAttribute('role', 'region');
  popup.tabIndex = -1;
  popup.hidden = true;
  const content = document.createElement('div');
  content.className = 'calendar-preview-content';
  popup.append(content);
  document.body.append(popup);

  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const viewport = window.visualViewport;
  let activeDay;
  let originalAttributes;
  let dismissedDay;
  let pointerInput = false;
  let showTimer;
  let hideTimer;
  let positionFrame;

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    cancelAnimationFrame(positionFrame);
    if (activeDay) {
      activeDay.classList.remove('calendar-day--preview');
      for (const [name, value] of Object.entries(originalAttributes)) {
        if (value === null) activeDay.removeAttribute(name);
        else activeDay.setAttribute(name, value);
      }
    }
    popup.hidden = true;
    activeDay = undefined;
  }

  function position() {
    if (!activeDay || popup.hidden) return;
    const edge = 12;
    const gap = 11;
    const viewLeft = viewport?.offsetLeft ?? 0;
    const viewTop = viewport?.offsetTop ?? 0;
    const viewWidth = viewport?.width ?? document.documentElement.clientWidth;
    const viewHeight = viewport?.height ?? innerHeight;
    const rect = activeDay.getBoundingClientRect();
    if (rect.bottom < viewTop || rect.top > viewTop + viewHeight || rect.right < viewLeft || rect.left > viewLeft + viewWidth) {
      hide();
      return;
    }

    const below = Math.max(0, viewTop + viewHeight - edge - rect.bottom - gap);
    const above = Math.max(0, rect.top - gap - viewTop - edge);
    const side = below >= Math.min(320, above) ? 'below' : 'above';
    const availableHeight = side === 'below' ? below : above;
    popup.style.setProperty('--calendar-preview-width', Math.max(1, Math.min(380, viewWidth - edge * 2)) + 'px');
    popup.style.setProperty('--calendar-preview-max-height', Math.max(1, Math.min(420, availableHeight) - 2) + 'px');
    const size = popup.getBoundingClientRect();
    const left = Math.max(viewLeft + edge, Math.min(rect.left + (rect.width - size.width) / 2, viewLeft + viewWidth - edge - size.width));
    const top = side === 'below' ? rect.bottom + gap : rect.top - gap - size.height;
    const arrow = Math.max(18, Math.min(rect.left + rect.width / 2 - left, size.width - 18));
    popup.style.setProperty('--calendar-preview-left', left + 'px');
    popup.style.setProperty('--calendar-preview-top', top + 'px');
    popup.style.setProperty('--calendar-preview-arrow', arrow + 'px');
    popup.dataset.side = side;
  }

  function show(day) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (day === dismissedDay) return;
    if (activeDay === day) return;
    const template = document.getElementById(day.dataset.calendarPreview);
    if (!(template instanceof HTMLTemplateElement)) return;
    hide();
    activeDay = day;
    originalAttributes = Object.fromEntries(['aria-controls', 'aria-describedby', 'aria-expanded', 'aria-keyshortcuts'].map(name => [name, day.getAttribute(name)]));
    content.replaceChildren(template.content.cloneNode(true));
    const heading = content.querySelector('.calendar-preview-heading, h2, h3');
    popup.setAttribute('aria-label', heading?.textContent.trim() || translateCalendarPreview('当天事项'));
    day.setAttribute('aria-controls', popup.id);
    day.setAttribute('aria-describedby', [originalAttributes['aria-describedby'], popup.id].filter(Boolean).join(' '));
    day.setAttribute('aria-expanded', 'true');
    day.setAttribute('aria-keyshortcuts', 'ArrowDown');
    day.classList.add('calendar-day--preview');
    popup.hidden = false;
    content.scrollTop = 0;
    position();
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!activeDay) return;
      if (activeDay.matches(':hover') || activeDay === document.activeElement || popup.matches(':hover') || popup.contains(document.activeElement)) return;
      hide();
    }, 150);
  }

  function queuePosition(event) {
    if (!activeDay || (event.target instanceof Node && popup.contains(event.target))) return;
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(position);
  }

  for (const day of days) {
    day.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse' || !finePointer.matches || popup.contains(document.activeElement)) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      showTimer = setTimeout(() => show(day), 110);
    });
    day.addEventListener('pointerleave', () => {
      if (dismissedDay === day) dismissedDay = undefined;
      scheduleHide();
    });
    day.addEventListener('focus', () => {
      if (!pointerInput || finePointer.matches) show(day);
    });
    day.addEventListener('blur', () => {
      if (dismissedDay === day) dismissedDay = undefined;
      scheduleHide();
    });
    day.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      dismissedDay = undefined;
      show(day);
      (content.querySelector('a[href], button:not([disabled])') || popup).focus({ preventScroll: true });
    });
  }

  popup.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  popup.addEventListener('pointerleave', scheduleHide);
  popup.addEventListener('focusin', () => clearTimeout(hideTimer));
  popup.addEventListener('focusout', scheduleHide);
  document.addEventListener('pointerdown', event => {
    pointerInput = true;
    if (activeDay && !popup.contains(event.target) && !activeDay.contains(event.target)) hide();
  }, { passive: true });
  document.addEventListener('keydown', event => {
    pointerInput = false;
    if (event.key !== 'Escape' || !activeDay) return;
    event.preventDefault();
    const day = activeDay;
    const returnFocus = popup.contains(document.activeElement);
    dismissedDay = day;
    hide();
    if (returnFocus) day.focus({ preventScroll: true });
  });
  window.addEventListener('resize', queuePosition);
  window.addEventListener('scroll', queuePosition, { passive: true, capture: true });
  viewport?.addEventListener('resize', queuePosition);
  viewport?.addEventListener('scroll', queuePosition);
}
