document.querySelectorAll('[data-password-toggle]').forEach(button => {
  const password = document.getElementById(button.getAttribute('aria-controls'));
  if (!(password instanceof HTMLInputElement) || password.type !== 'password') return;
  const showIcon = button.querySelector('[data-password-icon="show"]');
  const hideIcon = button.querySelector('[data-password-icon="hide"]');
  button.hidden = false;
  password.closest('.password-field')?.classList.add('has-password-toggle');
  button.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    const label = show ? '隐藏密码' : '显示密码';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.setAttribute('aria-pressed', String(show));
    if (showIcon) showIcon.toggleAttribute('hidden', show);
    if (hideIcon) hideIcon.toggleAttribute('hidden', !show);
  });
});

const backgroundToggle = document.querySelector('[data-background-toggle]');
const backgroundLayer = document.getElementById('login-ambient');
if (backgroundToggle && backgroundLayer && typeof backgroundLayer.animate === 'function') {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const label = backgroundToggle.querySelector('[data-background-label]');
  const pauseIcon = backgroundToggle.querySelector('[data-background-icon="pause"]');
  const playIcon = backgroundToggle.querySelector('[data-background-icon="play"]');
  const activeAnimations = new Set();
  let requestedMotion = !preference.matches;

  const random = (min, max) => min + Math.random() * (max - min);
  const shuffle = values => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random(0, index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  const transform = point => `translate(calc(${point.x}vw - 50%), calc(${point.y}vh - 50%)) scale(${point.scale})`;
  const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
  const color = hue => {
    const saturation = random(75, 85);
    const lightness = random(65, 72);
    return `radial-gradient(circle, hsl(${hue} ${saturation}% ${lightness}% / .6), hsl(${hue} ${saturation}% ${lightness}% / .32) 36%, transparent 68%)`;
  };
  const pointInZone = zone => ({
    x: (zone % 3) * (100 / 3) + random(5, (100 / 3) - 5),
    y: Math.floor(zone / 3) * (100 / 3) + random(5, (100 / 3) - 5),
    scale: random(.85, 1.18)
  });

  function nextPoint(state, from = state.point) {
    if (state.firstMove) {
      state.firstMove = false;
      const zone = (from.y < 50 ? 6 : 0) + (from.x < 50 ? 2 : 0);
      state.zones = state.zones.filter(value => value !== zone);
      return pointInZone(zone);
    }
    if (state.zones.length === 0) state.zones = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const farIndex = state.zones.findIndex(zone => distance(from, {
      x: (zone % 3 + .5) * (100 / 3), y: (Math.floor(zone / 3) + .5) * (100 / 3)
    }) >= 35);
    const [zone] = state.zones.splice(farIndex === -1 ? 0 : farIndex, 1);
    const candidates = Array.from({ length: 4 }, () => pointInZone(zone));
    return candidates.reduce((best, point) => distance(from, point) > distance(from, best) ? point : best);
  }

  // Reuse the same bounded tangent on both sides of each waypoint.
  function curveHandle(previous, point, next) {
    const outgoingLength = distance(point, next);
    let x = (next.x - point.x) / outgoingLength;
    let y = (next.y - point.y) / outgoingLength;
    if (previous) {
      const incomingLength = distance(previous, point);
      const incoming = { x: (point.x - previous.x) / incomingLength, y: (point.y - previous.y) / incomingLength };
      const turn = Math.sign(incoming.x * y - incoming.y * x) || 1;
      x += incoming.x;
      y += incoming.y;
      if (Math.hypot(x, y) < .05) {
        x = -incoming.y * turn;
        y = incoming.x * turn;
      }
    }
    const magnitude = Math.hypot(x, y);
    x /= magnitude;
    y /= magnitude;
    const length = Math.min(
      distance(point, next) * .24,
      previous ? distance(previous, point) * .24 : Infinity,
      Math.abs(x) > .0001 ? Math.min(point.x - 3, 97 - point.x) / Math.abs(x) * .9 : Infinity,
      Math.abs(y) > .0001 ? Math.min(point.y - 3, 97 - point.y) / Math.abs(y) * .9 : Infinity
    );
    return { x: x * length, y: y * length };
  }

  function movementFrames(state) {
    const from = state.point;
    const to = state.target;
    const first = { x: from.x + state.handle.x, y: from.y + state.handle.y };
    const second = { x: to.x - state.targetHandle.x, y: to.y - state.targetHandle.y };
    const viewport = Math.max(window.innerWidth, window.innerHeight);
    const weight = { x: window.innerWidth / viewport, y: window.innerHeight / viewport };
    const samples = [...new Set([
      ...Array.from({ length: 65 }, (_, index) => index / 64),
      .0005, .002, .006, .994, .998, .9995
    ])].sort((first, second) => first - second);
    let length = 0;
    let previous = from;
    const frames = samples.map(t => {
      const u = 1 - t;
      const point = {
        x: u ** 3 * from.x + 3 * u ** 2 * t * first.x + 3 * u * t ** 2 * second.x + t ** 3 * to.x,
        y: u ** 3 * from.y + 3 * u ** 2 * t * first.y + 3 * u * t ** 2 * second.y + t ** 3 * to.y,
        scale: from.scale + (to.scale - from.scale) * t * t * (3 - 2 * t)
      };
      length += Math.hypot((point.x - previous.x) * weight.x, (point.y - previous.y) * weight.y);
      previous = point;
      return { transform: transform(point), offset: length };
    });
    frames.forEach(frame => { frame.offset /= length; });
    return { frames, duration: length / state.speed * 1000 };
  }

  const syncPlayback = () => {
    const playing = requestedMotion && !document.hidden;
    for (const animation of activeAnimations) {
      if (animation.playState === 'finished') continue;
      if (playing && animation.playState !== 'running') animation.play();
      if (!playing && animation.playState !== 'paused') animation.pause();
    }
  };

  function startMovement(state, startTime) {
    const { frames, duration } = movementFrames(state);
    const animation = state.orb.animate(frames, { duration, fill: 'both', easing: 'linear' });
    if (typeof startTime === 'number' && requestedMotion && !document.hidden) animation.startTime = startTime;
    activeAnimations.add(animation);
    syncPlayback();
    animation.finished.then(() => {
      const continuationTime = animation.startTime === null ? undefined : animation.startTime + duration;
      state.point = state.target;
      state.handle = state.targetHandle;
      state.target = state.after;
      state.after = nextPoint(state, state.target);
      state.targetHandle = curveHandle(state.point, state.target, state.after);
      state.orb.style.transform = transform(state.point);
      activeAnimations.delete(animation);
      animation.cancel();
      startMovement(state, continuationTime);
    }).catch(() => { activeAnimations.delete(animation); });
  }

  function startColor(state) {
    const nextHue = (state.hue + random(65, 200)) % 360;
    const outgoing = state.layers[0];
    const incoming = state.layers[1];
    incoming.style.background = color(nextHue);
    const timing = { duration: random(3500, 5500), fill: 'both' };
    const segment = [
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, easing: 'linear' }),
      incoming.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, easing: 'linear' })
    ];
    segment.forEach(animation => activeAnimations.add(animation));
    syncPlayback();

    Promise.all(segment.map(animation => animation.finished)).then(() => {
      state.hue = nextHue;
      outgoing.style.opacity = '0';
      incoming.style.opacity = '1';
      segment.forEach(animation => { activeAnimations.delete(animation); animation.cancel(); });
      state.layers = [incoming, outgoing];
      startColor(state);
    }).catch(() => {
      segment.forEach(animation => { activeAnimations.delete(animation); animation.cancel(); });
    });
  }

  const initialHue = random(0, 360);
  const quadrants = shuffle([0, 1, 2, 3]);
  const glows = quadrants.map((quadrant, index) => {
    const orb = document.createElement('div');
    orb.className = 'login-rainbow-orb';
    const layers = Array.from({ length: 2 }, (_, layerIndex) => {
      const layer = document.createElement('span');
      layer.className = 'login-rainbow-color';
      layer.style.opacity = layerIndex === 0 ? '1' : '0';
      orb.append(layer);
      return layer;
    });
    const hue = (initialHue + index * 90 + random(-12, 12) + 360) % 360;
    const point = {
      x: (quadrant % 2) * 50 + random(5, 45),
      y: Math.floor(quadrant / 2) * 50 + random(5, 45),
      scale: random(.9, 1.1)
    };
    layers[0].style.background = color(hue);
    orb.style.transform = transform(point);
    backgroundLayer.append(orb);
    return { orb, layers, hue, point, speed: random(16, 22), firstMove: true,
      zones: shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]) };
  });
  backgroundLayer.classList.add('is-ready');

  const setBackgroundMotion = playing => {
    requestedMotion = playing;
    document.body.dataset.backgroundMotion = playing ? 'running' : 'paused';
    backgroundToggle.setAttribute('aria-pressed', String(playing));
    backgroundToggle.setAttribute('aria-label', playing ? '暂停背景动效' : '播放背景动效');
    label.textContent = playing ? '暂停动效' : '播放动效';
    pauseIcon.toggleAttribute('hidden', !playing);
    playIcon.toggleAttribute('hidden', playing);
    syncPlayback();
  };
  setBackgroundMotion(requestedMotion);
  backgroundToggle.hidden = false;
  backgroundToggle.addEventListener('click', () => {
    setBackgroundMotion(document.body.dataset.backgroundMotion !== 'running');
  });
  preference.addEventListener('change', event => setBackgroundMotion(!event.matches));
  const updateVisibility = () => {
    document.body.classList.toggle('login-page-hidden', document.hidden);
    syncPlayback();
  };
  updateVisibility();
  document.addEventListener('visibilitychange', updateVisibility);
  glows.forEach(state => {
    state.target = nextPoint(state);
    state.after = nextPoint(state, state.target);
    state.handle = curveHandle(null, state.point, state.target);
    state.targetHandle = curveHandle(state.point, state.target, state.after);
    startMovement(state);
    startColor(state);
  });
}
