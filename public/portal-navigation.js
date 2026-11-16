import HSCollapse from '/vendor/preline-collapse-5.0.0.mjs';

const toggle = document.querySelector('#portal-menu-toggle');
const menu = document.querySelector('#portal-menu');

if (toggle && menu) {
  menu.classList.add('hidden');
  HSCollapse.autoInit();
  toggle.hidden = false;
}
