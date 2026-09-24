const { app, BaseWindow, WebContentsView, Menu, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const HOME_URL = 'https://www.figma.com/files/recent';
const TAB_BAR_HEIGHT = 38;
const MAX_CLOSED_TABS = 20;

// Editor URLs: /design/<key>, /board/<key> (FigJam), /proto/<key>, ...
const FILE_PATH_RE = /^\/(design|file|board|proto|slides|deck|site|make|buzz)\/([A-Za-z0-9]+)/;

// Keep our config out of ~/.config/Figma so it never collides with anything else.
// FIGMUX_PROFILE points a dev run at a throwaway profile so it doesn't hand off to the installed app.
app.setPath('userData', process.env.FIGMUX_PROFILE || path.join(app.getPath('appData'), 'figmux'));
const STATE_FILE = path.join(app.getPath('userData'), 'state.json');

// Figma is a WebGL app; don't let Chromium's GPU blocklist push it onto software rendering.
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// Look like plain Chrome so Figma (and Google sign-in) treat us as a supported browser.
const CHROME_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'notifications',
  'media',
  'local-network-access', // lets figma.com reach the font agent on localhost
]);

// Tweaks to Figma's own UI where it duplicates what figmux provides.
// The Home tab replaces "Back to files"; it sits alone in a menu group, so hiding the
// group also removes the divider under it.
const FIGMA_CSS = `
  li[role="none"]:has(> [role="group"] > [data-onboarding-key="back-to-files"]:only-child),
  [data-onboarding-key="back-to-files"] { display: none !important; }
`;

function parseFigmaUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (u.hostname !== 'figma.com' && !u.hostname.endsWith('.figma.com')) return null;
    return u;
  } catch {
    return null;
  }
}

function fileKeyOf(url) {
  const u = parseFigmaUrl(url);
  const m = u && u.pathname.match(FILE_PATH_RE);
  return m ? m[2] : null;
}

const KINDS = { design: 'design', file: 'design', board: 'board', proto: 'proto', slides: 'slides', deck: 'slides' };

function kindOf(url) {
  const u = parseFigmaUrl(url);
  const m = u && u.pathname.match(FILE_PATH_RE);
  return m ? KINDS[m[1]] || 'design' : 'browser';
}

// /design/<key>/My-File-Name → "My File Name", so a tab has a name before Figma sets the page title.
function titleFromUrl(url) {
  const u = parseFigmaUrl(url);
  const slug = u && u.pathname.split('/')[3];
  if (!slug) return null;
  try {
    return decodeURIComponent(slug).replace(/-/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

function isSignInUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const u = new URL(url);
    if (u.hostname === 'accounts.google.com') return true;
    return !!parseFigmaUrl(url) && /sso|login|oauth|auth/i.test(u.pathname);
  } catch {
    return false;
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let win;
let tabBar;
let figmaSession;
let tabs = [];
let activeId = null;
let nextId = 1;
const closedTabs = [];

function getTab(id) {
  return tabs.find((t) => t.id === id);
}

function activeTab() {
  return getTab(activeId);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  tabBar.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });
  for (const tab of tabs) {
    tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) });
  }
}

function sendTabs() {
  if (!tabBar || tabBar.webContents.isDestroyed()) return;
  tabBar.webContents.send('tabs', {
    activeId,
    maximized: win.isMaximized() || win.isFullScreen(),
    tabs: tabs.map((t) => ({ id: t.id, title: t.title, home: t.home, loading: t.loading, kind: kindOf(t.url) })),
  });
  const tab = activeTab();
  win.setTitle(tab && !tab.home ? `${tab.title} – Figma` : 'Figma');
  scheduleSave();
}

function createTab(url, { home = false, title, activate = true, lazy = false, index } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      session: figmaSession,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor('#2c2c2c');
  view.setVisible(false);

  title = home ? 'Home' : title || titleFromUrl(url) || (fileKeyOf(url) ? 'Untitled' : 'New tab');
  const tab = { id: nextId++, view, url, title, home, loading: false, loaded: false };
  if (index === undefined) tabs.push(tab);
  else tabs.splice(index, 0, tab);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => handleWindowOpen(target));
  wc.on('before-input-event', handleShortcut);
  wc.on('will-navigate', (event) => {
    // Opening a file from Home puts it in its own tab instead of replacing Home.
    if (tab.home && fileKeyOf(event.url)) {
      event.preventDefault();
      openUrl(event.url);
    }
  });
  wc.on('did-navigate-in-page', (_event, target, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = target;
    // Same as above, for client-side routing inside the file browser.
    if (tab.home && fileKeyOf(target)) {
      openUrl(target);
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else wc.loadURL(HOME_URL);
    }
    scheduleSave();
  });
  wc.on('did-navigate', (_event, target) => {
    tab.url = target;
    scheduleSave();
  });
  wc.on('page-title-updated', (_event, pageTitle) => {
    if (tab.home) return;
    // Figma shows a bare "Figma" title while a file boots; keep the name we already have.
    const title = pageTitle.replace(/\s+[–|-]\s+Figma$/, '').trim();
    if (!title || title === 'Figma' || title === tab.title) return;
    tab.title = title;
    sendTabs();
  });
  // Only a main-frame document load counts as loading: Figma keeps subframes and
  // requests busy long after the page is usable, so did-stop-loading fires very late.
  wc.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument || tab.loading) return;
    tab.loading = true;
    sendTabs();
  });
  const doneLoading = () => {
    if (!tab.loading) return;
    tab.loading = false;
    sendTabs();
  };
  wc.on('dom-ready', () => {
    if (parseFigmaUrl(wc.getURL())) wc.insertCSS(FIGMA_CSS);
    doneLoading();
  });
  wc.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => isMainFrame && doneLoading());

  if (!lazy) loadTab(tab);
  layout();
  if (activate) activateTab(tab.id);
  else sendTabs();
  return tab;
}

function loadTab(tab) {
  if (tab.loaded) return;
  tab.loaded = true;
  tab.view.webContents.loadURL(tab.url);
}

function activateTab(id) {
  const tab = getTab(id);
  if (!tab) return;
  activeId = id;
  loadTab(tab);
  for (const t of tabs) t.view.setVisible(t.id === id);
  tab.view.webContents.focus();
  sendTabs();
}

function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  const tab = tabs[index];
  if (!tab || tab.home) return;

  closedTabs.push({ url: tab.url, title: tab.title, index });
  if (closedTabs.length > MAX_CLOSED_TABS) closedTabs.shift();

  tabs.splice(index, 1);
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();

  if (activeId === id) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activateTab(next.id);
  } else {
    sendTabs();
  }
}

function reopenClosedTab() {
  const closed = closedTabs.pop();
  if (!closed) return;
  const index = Math.max(1, Math.min(closed.index, tabs.length));
  createTab(closed.url, { title: closed.title, index });
}

// Opens a Figma URL: focuses the tab that already has this file, otherwise opens a new tab.
function openUrl(url) {
  const key = fileKeyOf(url);
  const existing = key && tabs.find((t) => !t.home && fileKeyOf(t.url) === key);
  if (existing) {
    activateTab(existing.id);
    return;
  }
  createTab(url);
}

function handleWindowOpen(url) {
  if (fileKeyOf(url)) {
    openUrl(url);
    return { action: 'deny' };
  }
  // SSO flows (e.g. "Continue with Google") need a real popup that shares our session.
  if (isSignInUrl(url)) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true },
    };
  }
  if (parseFigmaUrl(url)) {
    createTab(url);
    return { action: 'deny' };
  }
  shell.openExternal(url);
  return { action: 'deny' };
}

function cycleTab(delta) {
  const index = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  activateTab(next.id);
}

function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  const ctrl = input.control && !input.alt && !input.meta;
  const tab = activeTab();
  let handled = true;

  if (ctrl && !input.shift && key === 't') createTab(HOME_URL);
  else if (ctrl && !input.shift && key === 'w') closeTab(activeId);
  else if (ctrl && input.shift && key === 't') reopenClosedTab();
  else if (ctrl && key === 'tab') cycleTab(input.shift ? -1 : 1);
  else if (ctrl && !input.shift && key === 'pagedown') cycleTab(1);
  else if (ctrl && !input.shift && key === 'pageup') cycleTab(-1);
  else if (ctrl && !input.shift && /^Digit[1-9]$/.test(input.code)) {
    const n = Number(input.code.slice(5));
    const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (target) activateTab(target.id);
  } else if (key === 'f5' && tab) {
    if (input.control || input.shift) tab.view.webContents.reloadIgnoringCache();
    else tab.view.webContents.reload();
  } else if (key === 'f11') win.setFullScreen(!win.isFullScreen());
  else if (key === 'f12' && tab) tab.view.webContents.toggleDevTools();
  else handled = false;

  if (handled) event.preventDefault();
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 1000);
}

function saveState() {
  clearTimeout(saveTimer);
  if (!win || win.isDestroyed()) return;
  const state = {
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    tabs: tabs.filter((t) => !t.home).map((t) => ({ url: t.url, title: t.title })),
    activeIndex: tabs.findIndex((t) => t.id === activeId),
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('figmux: failed to save state', err);
  }
}

function figmaUrlsFromArgv(argv) {
  return argv.filter((arg) => parseFigmaUrl(arg));
}

function createWindow() {
  const state = loadState();
  const bounds = state.bounds || { width: 1400, height: 900 };

  win = new BaseWindow({
    ...bounds,
    minWidth: 600,
    minHeight: 400,
    title: 'Figma',
    frame: false,
    backgroundColor: '#2c2c2c',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });
  if (state.maximized) win.maximize();

  tabBar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'tabbar', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  tabBar.setBackgroundColor('#2c2c2c');
  tabBar.webContents.on('before-input-event', handleShortcut);
  tabBar.webContents.on('did-finish-load', sendTabs);
  tabBar.webContents.loadFile(path.join(__dirname, 'tabbar', 'index.html'));
  win.contentView.addChildView(tabBar);

  const home = createTab(HOME_URL, { home: true, activate: false });
  for (const saved of state.tabs || []) {
    if (parseFigmaUrl(saved.url)) createTab(saved.url, { title: saved.title, activate: false, lazy: true });
  }
  activateTab((tabs[state.activeIndex] || home).id);

  for (const url of figmaUrlsFromArgv(process.argv)) openUrl(url);

  win.on('resize', layout);
  win.on('maximize', sendTabs);
  win.on('unmaximize', sendTabs);
  win.on('enter-full-screen', sendTabs);
  win.on('leave-full-screen', sendTabs);
  win.on('resized', scheduleSave);
  win.on('moved', scheduleSave);
  win.on('close', saveState);
  win.on('closed', () => {
    win = null;
    app.quit();
  });
  layout();
}

ipcMain.on('tab:activate', (_e, id) => activateTab(id));
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('tab:new', () => createTab(HOME_URL));
ipcMain.on('window:minimize', () => win.minimize());
ipcMain.on('window:toggle-maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('window:close', () => win.close());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    for (const url of figmaUrlsFromArgv(argv)) openUrl(url);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    figmaSession = session.fromPartition('persist:figma');
    figmaSession.setUserAgent(CHROME_UA);
    figmaSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    figmaSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    createWindow();
  });
}
