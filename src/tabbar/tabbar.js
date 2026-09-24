const tabsEl = document.getElementById('tabs');

const svg = (inner, size = 16) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">${inner}</svg>`;

const HOME_ICON = svg('<path d="M2.5 7.5 8 3l5.5 4.5V13h-4V9.5h-3V13h-4z"/>');
const CLOSE_ICON = svg('<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.3"/>', 12);

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
    if (e.button === 1) window.figmux.close(tab.id);
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
  close.addEventListener('click', () => window.figmux.close(tab.id));

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
    entry.icon.innerHTML = tab.loading ? '<span class="spinner"></span>' : FILE_ICONS[tab.kind] || HOME_ICON;
    entry.lastIcon = iconKey;
  }
}

// Closing tabs stay in the DOM while they animate out; ordering ignores them so they
// shrink in place instead of being pushed past their neighbours.
function skipLeaving(node) {
  while (node && node.classList.contains('leaving')) node = node.nextSibling;
  return node;
}

function render({ activeId, maximized, tabs }) {
  document.body.classList.toggle('maximized', maximized);

  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, entry] of rendered) {
    if (!ids.has(id)) {
      // Shrink to nothing so the remaining tabs widen smoothly into the space.
      rendered.delete(id);
      entry.el.classList.add('leaving');
      setTimeout(() => entry.el.remove(), 200);
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
      }
    }
    updateTabEl(entry, tab, tab.id === activeId);

    const expected = skipLeaving(prev ? prev.nextSibling : tabsEl.firstChild);
    if (entry.el !== expected) tabsEl.insertBefore(entry.el, expected);
    prev = entry.el;
  }
  firstRender = false;

  // Lay out the new tabs at zero width, then release them so they transition open.
  const entering = tabsEl.querySelectorAll('.entering');
  if (entering.length) {
    void tabsEl.offsetWidth;
    for (const el of entering) el.classList.remove('entering');
  }
}

window.figmux.onTabs(render);
document.getElementById('new-tab').addEventListener('click', () => window.figmux.newTab());
document.getElementById('minimize').addEventListener('click', () => window.figmux.minimize());
document.getElementById('maximize').addEventListener('click', () => window.figmux.toggleMaximize());
document.getElementById('close-window').addEventListener('click', () => window.figmux.closeWindow());
