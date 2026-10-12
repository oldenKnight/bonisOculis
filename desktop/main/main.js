'use strict';
// Electron main entry. Single instance; builds the services; registers the closed IPC list;
// opens the window; shuts down gracefully (stop the player, pause the scan so it resumes).
// No telemetry, no auto-updater, no crash reporter, no remote content (PLAN 6).

var electron = require('electron');
var path = require('path');
var app = electron.app;

var createLog = require('./log.js').createLog;
var createPaths = require('./paths.js').createPaths;
var createStore = require('./store.js').createStore;
var createPin = require('./pin.js').createPin;
var createSettings = require('./settings.js').createSettings;
var i18nMod = require('./i18n.js');
var createLibrary = require('./library.js').createLibrary;
var createSkips = require('./skips.js').createSkips;
var createSupervisor = require('./scanner-supervisor.js').createSupervisor;
var createPlayerService = require('./player-service.js').createPlayerService;
var createPlayer = require('./player-controller.js').createPlayer;
var createThumbs = require('./thumbs.js').createThumbs;
var createHelp = require('./help.js').createHelp;
var createHandlers = require('./handlers.js').createHandlers;
var ipc = require('./ipc.js');
var windowMod = require('./window.js');
var menu = require('./menu.js');
var BO = require('../../shared/skipfile.js');

if (process.env.BONIS_USER_DATA) { app.setPath('userData', process.env.BONIS_USER_DATA); }

var win = null;
var s = null;          // services
var pendingToasts = [];
var quitting = false;

function emit(name, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isLoading()) {
    win.webContents.send(name, payload);
  } else if (name === 'toast' && pendingToasts.length < 10) {
    pendingToasts.push(payload);
  }
}

function hardenSession() {
  var ses = electron.session.defaultSession;
  ses.setPermissionRequestHandler(function (wc, permission, cb) { cb(false); });
  try { ses.setPermissionCheckHandler(function () { return false; }); } catch (e) { /* older API */ }
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, function (details, cb) {
    cb({ cancel: true });
  });
  app.on('web-contents-created', function (e, contents) {
    contents.on('will-attach-webview', function (ev) { ev.preventDefault(); });
    contents.on('will-navigate', function (ev) { ev.preventDefault(); });
    contents.setWindowOpenHandler(function () { return { action: 'deny' }; });
  });
}

function rendererFile() { return 'file://' + path.join(__dirname, '..', 'renderer', 'index.html').replace(/\\/g, '/'); }

function checkSender(event) {
  try {
    var url = event.senderFrame ? event.senderFrame.url : '';
    var expect = rendererFile();
    return decodeURI(url).replace(/[?#].*$/, '').toLowerCase().replace(/^file:\/+/, '') === decodeURI(expect).toLowerCase().replace(/^file:\/+/, '');
  } catch (e) { return false; }
}

function boot() {
  var packaged = app.isPackaged;
  var paths = createPaths({ isPackaged: packaged, resourcesPath: process.resourcesPath, userData: app.getPath('userData') });
  var log = createLog({ dir: paths.logDir(), name: 'bonis', console: !packaged && !process.env.BONIS_QUIET, level: 'info' });
  log.info('starting', app.getVersion(), process.platform);
  var store = createStore({ dir: paths.userData, log: log.child('store') });
  store.on('recovered', function (ev) { emit('toast', { kind: 'warning', key: ev.lost ? 'toast.lostFile' : 'toast.recovered' }); });
  store.on('tampered', function () { emit('toast', { kind: 'warning', key: 'toast.tampered' }); });
  var pin = createPin({ store: store });
  pin.load();
  var settings = createSettings({ store: store });
  var osLang = i18nMod.pickLang(app.getLocale());
  settings.load(osLang);
  var i18n = i18nMod.createI18n(paths.localesDir(), settings.value('lang'));
  var library = createLibrary({ store: store, log: log.child('library'), ffprobe: paths.ffprobe });
  library.load();
  library.onChange(function (items) { emit('library:changed', pin.isLocked() ? null : items); });
  var skips = createSkips({ store: store, library: library, log: log.child('skips') });

  // Re-derive every status from its skip file; a file changed outside the app loses Protected.
  library.list().forEach(function (it) {
    if (it.status === 'queued' || it.status === 'scanning') { return; }
    var r = skips.load(it.id);
    if (r.tampered && r.doc) {
      emit('toast', { kind: 'warning', key: 'toast.skipTampered', params: { title: it.title } });
      library.applyDoc(it.id, r.doc, BO.validate);
      if (library.get(it.id).status === 'protected') { library.setStatus(it.id, 'needsReview', {}); }
    } else if (r.corrupt) {
      library.setStatus(it.id, 'needsAttention', { error: 'skipCorrupt' });
    } else {
      library.applyDoc(it.id, r.doc, BO.validate);
    }
  });

  var supervisor = createSupervisor({
    store: store, library: library, skips: skips, paths: paths, settings: settings, log: log.child('scan'), emit: emit,
    power: electron.powerMonitor
  });
  supervisor.load();
  var player = createPlayerService({
    createPlayer: createPlayer, paths: paths, settings: settings, library: library, skips: skips, supervisor: supervisor,
    log: log.child('player'), emit: emit
  });
  player.recover();
  var thumbs = createThumbs({ paths: paths, library: library, skips: skips });
  var help = createHelp({ paths: paths });

  pin.setLocked(pin.hasPin() && settings.value('lockOnStart'));

  var versions = { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
  s = { paths: paths, log: log, store: store, pin: pin, settings: settings, i18n: i18n, library: library, skips: skips,
    supervisor: supervisor, player: player, thumbs: thumbs, help: help };

  function rebuildMenu() {
    menu.buildMenu({ i18n: i18n, packaged: packaged, onHelp: function () { if (!pin.isLocked()) { emit('app:navigate', { view: 'help' }); } } });
  }

  var handlers = createHandlers({
    electron: electron, getWindow: function () { return win; }, store: store, pin: pin, settings: settings, i18n: i18n,
    library: library, skips: skips, supervisor: supervisor, player: player, thumbs: thumbs, help: help, paths: paths,
    log: log.child('ipc'), emit: emit, versions: versions,
    takeToasts: function () { var t = pendingToasts; pendingToasts = []; return t; },
    onLangChanged: function (lang) { i18n.setLang(lang); rebuildMenu(); }
  });
  ipc.createIpc(handlers, { isLocked: pin.isLocked, log: log.child('ipc'), checkSender: checkSender }).register(electron.ipcMain);

  hardenSession();
  rebuildMenu();
  win = windowMod.createWindow({ paths: paths, settings: settings, packaged: packaged, title: 'bonis oculis', onClosed: function () { win = null; } });
  supervisor.start();
}

function shutdown() {
  if (!s) { app.exit(0); return; }
  var finished = false;
  function done() {
    if (finished) { return; }
    finished = true;
    s.log.info('bye');
    app.exit(0);
  }
  setTimeout(done, 6000);
  s.player.stop(function () { s.supervisor.shutdown(done); });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (win) {
      if (win.isMinimized()) { win.restore(); }
      win.focus();
    }
  });
  app.on('before-quit', function (e) {
    if (quitting) { return; }
    quitting = true;
    e.preventDefault();
    shutdown();
  });
  app.on('window-all-closed', function () { app.quit(); });
  app.whenReady().then(function () {
    try { boot(); } catch (e) {
      try { electron.dialog.showErrorBox('bonis oculis', String(e && e.stack ? e.stack : e)); } catch (e2) { /* headless */ }
      app.exit(1);
    }
  });
}
