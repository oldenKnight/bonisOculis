'use strict';
// The one app window: 1024x640 minimum, remembered bounds (kept on a visible display), hardened
// webPreferences (PLAN 6): context isolation, sandbox, no Node in the page, no navigation, no
// new windows, DevTools only in development.

var electron = require('electron');
var BrowserWindow = electron.BrowserWindow;
var screen = electron.screen;
var nativeTheme = electron.nativeTheme;

var MIN_W = 1024;
var MIN_H = 640;

function visibleBounds(b) {
  if (!b) { return null; }
  try {
    var area = screen.getDisplayMatching(b).workArea;
    var w = Math.max(MIN_W, Math.min(b.width, area.width));
    var h = Math.max(MIN_H, Math.min(b.height, area.height));
    var x = Math.min(Math.max(b.x, area.x), area.x + area.width - Math.min(w, area.width));
    var y = Math.min(Math.max(b.y, area.y), area.y + area.height - Math.min(h, area.height));
    return { x: x, y: y, width: w, height: h };
  } catch (e) { return null; }
}

function defaultSize() {
  try {
    var area = screen.getPrimaryDisplay().workAreaSize;
    return { width: Math.max(MIN_W, Math.min(1280, area.width)), height: Math.max(MIN_H, Math.min(820, area.height)) };
  } catch (e) { return { width: 1280, height: 820 }; }
}

// opts: {paths, settings, title, packaged, onClosed}
function createWindow(opts) {
  var saved = opts.settings.value('windowBounds');
  var b = visibleBounds(saved) || defaultSize();
  var win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, minWidth: MIN_W, minHeight: MIN_H,
    show: false, title: opts.title || 'bonis oculis',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12110E' : '#FAF8F4',
    autoHideMenuBar: false,
    webPreferences: {
      preload: opts.paths.preload(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !opts.packaged,
      backgroundThrottling: true
    }
  });
  if (saved && saved.maximized) { win.maximize(); }

  var saveTimer = null;
  function saveBounds() {
    if (win.isDestroyed()) { return; }
    var nb = win.isMaximized() || win.isFullScreen() ? (saved || win.getNormalBounds()) : win.getBounds();
    nb = { x: nb.x, y: nb.y, width: nb.width, height: nb.height, maximized: win.isMaximized() };
    opts.settings.set({ windowBounds: nb }, false);
  }
  function later() { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 800); }
  win.on('resize', later);
  win.on('move', later);
  win.on('close', function () { clearTimeout(saveTimer); saveBounds(); });
  win.on('closed', function () { if (opts.onClosed) { opts.onClosed(); } });
  win.once('ready-to-show', function () { win.show(); });

  win.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
  win.webContents.on('will-navigate', function (e) { e.preventDefault(); });
  win.webContents.on('will-redirect', function (e) { e.preventDefault(); });
  win.loadFile(opts.paths.rendererIndex());
  return win;
}

module.exports = { createWindow: createWindow, MIN_W: MIN_W, MIN_H: MIN_H };
