const tabsEl = document.getElementById('tabs');

const svg = (inner, size = 16) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">${inner}</svg>`;

const HOME_ICON = svg('<path d="M2.5 7.5 8 3l5.5 4.5V13h-4V9.5h-3V13h-4z"/>');
const CLOSE_ICON = svg('<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.3"/>', 12);
const KIND_ICONS = {
  design: svg('<path d="M5.5 2.5v11M10.5 2.5v11M2.5 5.5h11M2.5 10.5h11"/>'),
  board: svg('<path d="M3 3h10v6.5L9.5 13H3z"/><path d="M13 9.5H9.5V13"/>'),
  proto: svg('<path d="M5 3.5v9l7-4.5z"/>'),
  slides: svg('<rect x="2.5" y="3.5" width="11" height="8" rx="1"/><path d="M6 14h4"/>'),
  browser: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M2.5 6h11"/>'),
};

// Tab id -> its DOM, kept across renders so updates only touch what changed
// (no flicker, hover state survives, CSS transitions can run).
const rendered = new Map();
let firstRender = true;

function createTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab';

  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) window.figmux.activate(tab.id);
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) closeTab(tab.id);
  });

  if (tab.home) {
    el.classList.add('home');
    el.innerHTML = HOME_ICON;
    return { el };
  }

  const icon = document.createElement('span');
  icon.className = 'icon';

  const title = document.createElement('span');
  title.className = 'title';

  const close = document.createElement('button');
  close.className = 'close';
  close.setAttribute('aria-label', 'Close tab');
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('mousedown', (e) => e.stopPropagation());
  close.addEventListener('click', () => closeTab(tab.id));

  el.append(icon, title, close);
  return { el, icon, title };
}

function updateTabEl(entry, tab, active) {
  entry.el.classList.toggle('active', active);
  if (tab.home) return;

  if (entry.lastTitle !== tab.title) {
    entry.title.textContent = tab.title;
    entry.el.title = tab.title;
    entry.lastTitle = tab.title;
  }
  // The spinner swaps into the icon slot, so loading never shifts the title.
  const iconKey = tab.loading ? 'loading' : tab.kind;
  if (entry.lastIcon !== iconKey) {
    entry.icon.innerHTML = tab.loading ? '<span class="spinner"></span>' : KIND_ICONS[tab.kind] || KIND_ICONS.browser;
    entry.lastIcon = iconKey;
  }
}

function render({ activeId, maximized, tabs }) {
  document.body.classList.toggle('maximized', maximized);

  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, entry] of rendered) {
    if (!ids.has(id)) {
      entry.el.remove();
      rendered.delete(id);
    }
  }

  let prev = null;
  for (const tab of tabs) {
    let entry = rendered.get(tab.id);
    if (!entry) {
      entry = createTabEl(tab);
      rendered.set(tab.id, entry);
      if (!firstRender) {
        // Grow in from zero width instead of popping in and shoving the neighbours.
        entry.el.classList.add('entering');
        requestAnimationFrame(() => requestAnimationFrame(() => entry.el.classList.remove('entering')));
      }
    }
    updateTabEl(entry, tab, tab.id === activeId);

    const expected = prev ? prev.nextSibling : tabsEl.firstChild;
    if (entry.el !== expected) tabsEl.insertBefore(entry.el, expected);
    prev = entry.el;
  }
  firstRender = false;
}

// Like Chrome: while closing tabs with the mouse, keep the remaining tabs at their current
// width so the next close button lands under the cursor. Widths relax once the mouse leaves.
function closeTab(id) {
  for (const entry of rendered.values()) {
    if (entry.title) entry.el.style.flex = `0 0 ${entry.el.getBoundingClientRect().width}px`;
  }
  tabsEl.classList.add('frozen');
  window.figmux.close(id);
}

tabsEl.addEventListener('mouseleave', () => {
  if (!tabsEl.classList.contains('frozen')) return;
  tabsEl.classList.remove('frozen');
  for (const entry of rendered.values()) entry.el.style.removeProperty('flex');
});

window.figmux.onTabs(render);
document.getElementById('new-tab').addEventListener('click', () => window.figmux.newTab());
document.getElementById('minimize').addEventListener('click', () => window.figmux.minimize());
document.getElementById('maximize').addEventListener('click', () => window.figmux.toggleMaximize());
document.getElementById('close-window').addEventListener('click', () => window.figmux.closeWindow());
