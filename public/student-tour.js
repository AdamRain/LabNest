const translateStudentTour = (message, params = {}) => window.LabI18n?.t(message, params) ?? message.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
const steps = [
  {
    key: 'weekly',
    title: '先看本周周报',
    description: '在这里查看提交状态和截止时间，打开后可填写周报或申请请假。'
  },
  {
    key: 'calendar',
    title: '查看个人日历',
    description: '查看周报截止、个人安排和顶会截稿时间。'
  },
  {
    key: 'dynamics',
    title: '浏览本周动态',
    description: '从这里查看团队成员分享的本周进展。'
  },
  {
    key: 'profile',
    title: '维护个人信息',
    description: '查看本人档案，更新联系方式、生日和生活照。'
  },
  {
    key: 'guide',
    title: '需要时重看指引',
    description: '从「使用指引」可以重播导览，也可以查阅文字说明。'
  }
];

const dialog = document.querySelector('#student-tour');
if (dialog?.dataset.autostart === 'true' && typeof dialog.showModal === 'function') {
  startTour(dialog);
}

function startTour(dialog) {
  const card = dialog.querySelector('.student-tour-card');
  const spotlight = dialog.querySelector('[data-tour-spotlight]');
  const title = dialog.querySelector('#student-tour-title');
  const description = dialog.querySelector('[data-tour-description]');
  const count = dialog.querySelector('[data-tour-count]');
  const previous = dialog.querySelector('[data-tour-prev]');
  const next = dialog.querySelector('[data-tour-next]');
  const skip = dialog.querySelector('[data-tour-skip]');
  const form = skip?.form;
  if (!card || !spotlight || !title || !description || !count || !previous || !next || !form) return;
  count.id = 'student-tour-count';
  title.setAttribute('aria-describedby', count.id + ' ' + description.id);

  const viewport = window.visualViewport;
  const focusBefore = document.activeElement;
  const scrollBefore = { left: window.scrollX, top: window.scrollY, behavior: 'instant' };
  const persist = dialog.dataset.dismissOnClose === 'true';
  let activeStep = 0;
  let openedMenu;
  let layoutFrame;

  function rendered(element) {
    if (!element) return false;
    const menu = element.closest('.workspace-mobile-menu');
    if (menu && menu !== element && !menu.open) return false;
    const { width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0;
  }

  function currentTarget() {
    const key = steps[activeStep].key;
    const candidates = Array.from(document.querySelectorAll('[data-tour-target="' + key + '"]'));
    const mobileMenu = candidates.map(element => element.closest('.workspace-mobile-menu')).find(rendered);
    if (openedMenu && mobileMenu !== openedMenu) {
      openedMenu.open = false;
      openedMenu = undefined;
    }
    if (mobileMenu && !mobileMenu.open && !candidates.some(rendered)) {
      mobileMenu.open = true;
      openedMenu = mobileMenu;
    }
    return candidates.find(rendered);
  }

  const edge = 12;
  const gap = 15;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function position({ scrollToTarget = false } = {}) {
    const target = currentTarget();
    if (scrollToTarget && target) {
      const rect = target.getBoundingClientRect();
      const windowTop = viewport?.offsetTop ?? 0;
      const windowBottom = windowTop + (viewport?.height ?? dialog.clientHeight);
      const header = document.querySelector('.site-header');
      const headerBottom = header && getComputedStyle(header).position === 'sticky'
        ? header.getBoundingClientRect().bottom : windowTop;
      if (rect.top < Math.max(windowTop + edge, headerBottom + 8) || rect.bottom > windowBottom - edge) {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }
    }

    const viewLeft = viewport?.offsetLeft ?? 0;
    const viewTop = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? dialog.clientWidth;
    const height = viewport?.height ?? dialog.clientHeight;
    const view = {
      left: viewLeft + edge,
      top: viewTop + edge,
      right: viewLeft + width - edge,
      bottom: viewTop + height - edge
    };

    const cardScroll = card.scrollTop;
    dialog.style.setProperty('--tour-card-width', Math.max(1, Math.min(352, width - edge * 2)) + 'px');
    dialog.style.setProperty('--tour-card-height', Math.max(1, height - edge * 2) + 'px');
    const { width: cardWidth, height: fullHeight } = card.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    const spot = targetRect && {
      left: Math.max(viewLeft + 3, targetRect.left - 6),
      top: Math.max(viewTop + 3, targetRect.top - 6),
      right: Math.min(viewLeft + width - 3, targetRect.right + 6),
      bottom: Math.min(viewTop + height - 3, targetRect.bottom + 6)
    };
    const canHighlight = spot && spot.right > spot.left && spot.bottom > spot.top;
    spotlight.hidden = !canHighlight;

    let side = 'center';
    let left = viewLeft + (width - cardWidth) / 2;
    let top = viewTop + (height - fullHeight) / 2;

    if (canHighlight) {
      const spotWidth = spot.right - spot.left;
      const spotHeight = spot.bottom - spot.top;
      for (const [name, value] of Object.entries({ left: spot.left, top: spot.top, width: spotWidth, height: spotHeight })) {
        spotlight.style.setProperty('--tour-spot-' + name, value + 'px');
      }

      const rightRoom = view.right - spot.right - gap;
      const leftRoom = spot.left - gap - view.left;
      const bottomRoom = view.bottom - spot.bottom - gap;
      const topRoom = spot.top - gap - view.top;

      if (rightRoom >= cardWidth || leftRoom >= cardWidth) {
        side = rightRoom >= cardWidth ? 'right' : 'left';
        left = side === 'right' ? spot.right + gap : spot.left - gap - cardWidth;
        top = clamp(spot.top + (spotHeight - fullHeight) / 2, view.top, view.bottom - fullHeight);
      } else if (Math.max(topRoom, bottomRoom) >= 96) {
        side = bottomRoom >= fullHeight || bottomRoom >= topRoom ? 'below' : 'above';
        const availableHeight = side === 'below' ? bottomRoom : topRoom;
        const cardHeight = Math.min(availableHeight, fullHeight);
        dialog.style.setProperty('--tour-card-height', cardHeight + 'px');
        left = clamp(spot.left + (spotWidth - cardWidth) / 2, view.left, view.right - cardWidth);
        top = side === 'below' ? spot.bottom + gap : spot.top - gap - cardHeight;
      }

      if (side === 'left' || side === 'right') {
        const arrowX = side === 'right' ? left - 4 : left + cardWidth + 4;
        const arrowY = clamp(spot.top + spotHeight / 2, top + 19, top + fullHeight - 19);
        dialog.style.setProperty('--tour-arrow-x', arrowX + 'px');
        dialog.style.setProperty('--tour-arrow-y', arrowY + 'px');
      } else if (side !== 'center') {
        const arrowX = clamp(spot.left + spotWidth / 2, left + 19, left + cardWidth - 19);
        const arrowY = side === 'below' ? top - 4 : spot.top - gap + 4;
        dialog.style.setProperty('--tour-arrow-x', arrowX + 'px');
        dialog.style.setProperty('--tour-arrow-y', arrowY + 'px');
      }
    }

    dialog.style.setProperty('--tour-card-left', left + 'px');
    dialog.style.setProperty('--tour-card-top', top + 'px');
    dialog.dataset.tourSide = side;
    dialog.toggleAttribute('data-tour-highlight', Boolean(canHighlight));
    card.scrollTop = cardScroll;
  }

  function queuePosition(event) {
    if (event.target instanceof Node && dialog.contains(event.target)) return;
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => position());
  }

  function renderStep() {
    const step = steps[activeStep];
    count.textContent = translateStudentTour('第 {step} 步，共 {total} 步', { step: activeStep + 1, total: steps.length });
    title.textContent = translateStudentTour(step.title);
    description.textContent = translateStudentTour(step.description);
    previous.hidden = activeStep === 0;
    next.textContent = translateStudentTour(activeStep === steps.length - 1 ? '完成' : '下一步');
    card.scrollTop = 0;
    if (!dialog.open) dialog.showModal();
    position({ scrollToTarget: true });
    title.focus({ preventScroll: true });
  }

  function finish() {
    form.requestSubmit(skip);
  }

  previous.addEventListener('click', () => {
    activeStep -= 1;
    renderStep();
  });
  next.addEventListener('click', () => {
    if (activeStep === steps.length - 1) {
      finish();
      return;
    }
    activeStep += 1;
    renderStep();
  });
  form.addEventListener('submit', event => {
    if (!persist) {
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll('button:not([hidden]):not([disabled])'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === title || document.activeElement === first)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  dialog.addEventListener('close', () => {
    cancelAnimationFrame(layoutFrame);
    window.removeEventListener('resize', queuePosition);
    window.removeEventListener('scroll', queuePosition, true);
    viewport?.removeEventListener('resize', queuePosition);
    viewport?.removeEventListener('scroll', queuePosition);
    if (openedMenu) openedMenu.open = false;
    window.scrollTo(scrollBefore);
    const restoreFocus = focusBefore === document.body ? document.querySelector('#workspace-content') : focusBefore;
    restoreFocus?.focus({ preventScroll: true });
  }, { once: true });

  renderStep();
  window.addEventListener('resize', queuePosition);
  window.addEventListener('scroll', queuePosition, { passive: true, capture: true });
  viewport?.addEventListener('resize', queuePosition);
  viewport?.addEventListener('scroll', queuePosition);

  const url = new URL(window.location.href);
  if (url.searchParams.get('tour') === '1') {
    url.searchParams.delete('tour');
    history.replaceState(history.state, '', url);
  }
}
