let controlSequence = 0;
const accents = [
  ['emerald', '翡翠绿'], ['blue', '海洋蓝'], ['violet', '鸢尾紫'],
  ['rose', '玫瑰粉'], ['amber', '琥珀橙'], ['slate', '石墨灰']
];

export function themeHead() {
  return '<script src="/theme.js"></script><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/appearance-controls.css"><link rel="stylesheet" href="/accent.css"><link rel="stylesheet" href="/glass.css">';
}

export function themeControl() {
  const group = 'appearance-accent-' + (++controlSequence);
  return `<details class="appearance-control" data-appearance-control>
    <summary class="appearance-trigger" aria-label="外观设置">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M10 3a7 7 0 0 1 0 14V3Z" fill="currentColor"/></svg>
      <span>外观</span><span class="appearance-current" data-appearance-label>跟随系统</span>
      <span class="appearance-current-dot" aria-hidden="true"></span>
      <svg class="appearance-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <div class="appearance-panel" aria-label="外观选项">
      <div class="appearance-panel-heading"><strong>外观设置</strong><span>随时换个颜色</span></div>
      <label class="appearance-theme-field"><span>明暗模式</span>
        <select class="appearance-theme-select" data-theme-select aria-label="界面外观">
          <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
        </select>
      </label>
      <fieldset class="appearance-colors"><legend>主题色</legend>
        <div class="appearance-swatches">${accents.map(([value, label]) => `<label class="appearance-swatch" data-color="${value}">
          <input type="radio" name="${group}" value="${value}" data-accent-choice${value === 'emerald' ? ' checked' : ''}>
          <span class="appearance-swatch-dot" aria-hidden="true"></span><span>${label}</span>
          <svg class="appearance-swatch-check" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </label>`).join('')}</div>
      </fieldset>
      <p class="appearance-note">会记住这台浏览器的选择。</p>
    </div>
  </details>`;
}
