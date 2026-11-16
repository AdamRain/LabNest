const translatePortalGallery = (message, params = {}) => window.LabI18n?.t(message, params) ?? message.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
const gallery = document.querySelector('[data-portal-gallery]');

if (gallery) {
  const slides = [...gallery.querySelectorAll('[data-gallery-slide]')];
  const controls = gallery.querySelector('.public-gallery-controls');
  const count = gallery.querySelector('[data-gallery-count]');
  const status = gallery.querySelector('[data-gallery-status]');

  if (controls && count && status) {
    let active = 0;

    function updateStatus() {
      count.textContent = (active + 1) + ' / ' + slides.length;
      const caption = slides[active].querySelector('[data-gallery-caption]').textContent;
      status.textContent = translatePortalGallery('第 {slide} 张，共 {total} 张。', { slide: active + 1, total: slides.length }) + ' ' + caption;
    }

    controls.querySelectorAll('[data-gallery-step]').forEach(button => {
      button.addEventListener('click', () => {
        slides[active].hidden = true;
        active = (active + Number(button.dataset.galleryStep) + slides.length) % slides.length;
        slides[active].hidden = false;
        updateStatus();
      });
    });

    updateStatus();
    controls.hidden = false;
  }
}
