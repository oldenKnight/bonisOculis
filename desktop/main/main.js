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
var createIntegrity = require('./integrity.js').createIntegrity;
var createAccuracy = require('./accuracy.js').createAccuracy;
var createActivity = require('./activity.js').createActivity;
var createHandlers = require('./handlers.js').createHandlers;
var ipc = require('./ipc.js');
var windowMod = require('./window.js');
var menu = require('./menu.js');
var BO = require('../../shared/skipfile.js');

if (process.env.BONIS_USER_DATA) { app.setPath('userData', process.env.BONIS_USER_DATA); }

// No network, ever (brief 4.7; board review A2). Chromium's own background services are switched
// off before the app is ready: component updates, background networking (variations, safe
// browsing lists), DNS prefetch, pings, domain reliability, and the spell-check dictionary
// service (its download bypasses webRequest). desktop/test/no-sockets.test.js runs a whole first
// launch under strace and fails on any IP connect.
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-features', 'SpellcheckService,SpellCheck,AutofillServerCommunication,OptimizationHints,MediaRouter,DialMediaRouteProvider,CertificateTransparencyComponentUpdater,NetworkTimeServiceQuerying');

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
  // The spell checker downloads a dictionary from Google on first use; it is never used here.
  try { ses.setSpellCheckerEnabled(false); } catch (e0) { /* older API */ }
  try { ses.setSpellCheckerLanguages([]); } catch (e1) { /* not on macOS */ }
  ses.setPermissionRequestHandler(function (wc, permission, cb) { cb(false); });
  try { ses.setPermissionCheckHandler(function () { return false; }); } catch (e) { /* older API */ }
  // Everything but the app's own files, inline images and DevTools is cancelled.
  ses.webRequest.onBeforeRequest(function (details, cb) {
    cb({ cancel: !/^(file|data|devtools|chrome-devtools):/i.test(details.url || '') });
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
  hardenSession();
  var packaged = app.isPackaged;
  var paths = createPaths({ isPackaged: packaged, resourcesPath: process.resourcesPath, userData: app.getPath('userData') });
  var log = createLog({ dir: paths.logDir(), name: 'bonis', console: !packaged && !process.env.BONIS_QUIET, level: 'info' });
  log.info('starting', app.getVersion(), process.platform);
  var store = createStore({ dir: paths.userData, log: log.child('store') });
  var activity = createActivity({ dir: paths.userData });
  var library = null;
  var markDamaged = null;
  store.on('recovered', function (ev) {
    var m = /^library\/([0-9a-f]{16})\.bonis\.json$/.exec(ev.file || '');
    if (m) {
      // A scene list: restored from its backup, or damaged beyond repair (fail closed).
      if (ev.lost) { if (markDamaged) { markDamaged(m[1]); } } else {
        var it0 = library && library.get(m[1]);
        emit('toast', { kind: 'warning', key: 'toast.listRestored', params: { title: it0 ? it0.title : '' } });
      }
      return;
    }
    emit('toast', { kind: 'warning', key: ev.lost ? 'toast.lostFile' : 'toast.recovered' });
  });
  store.on('tampered', function () { emit('toast', { kind: 'warning', key: 'toast.tampered' }); });
  var pin = createPin({ store: store });
  pin.load();
  var settings = createSettings({ store: store });
  var osLang = i18nMod.pickLang(app.getLocale());
  settings.load(osLang);
  var i18n = i18nMod.createI18n(paths.localesDir(), settings.value('lang'));
  library = createLibrary({ store: store, log: log.child('library'), ffprobe: paths.ffprobe });
  library.load();
  library.onChange(function (items) { emit('library:changed', pin.isLocked() ? null : items); });
  // Planner decision 1: a list that cannot be read or restored makes the title "Needs attention",
  // never Protected, and says exactly what happened (once).
  markDamaged = function (id) {
    var it = library.get(id);
    if (!it || (it.status === 'needsAttention' && it.error === 'skipCorrupt')) { return; }
    if (it.status === 'queued' || it.status === 'scanning') { return; }
    library.setStatus(id, 'needsAttention', { error: 'skipCorrupt' });
    activity.add('damaged', { id: id, title: it.title });
    emit('toast', { kind: 'error', key: 'toast.listDamaged', params: { title: it.title } });
  };
  var skips = createSkips({ store: store, library: library, log: log.child('skips'), onDamaged: function (id) { markDamaged(id); } });

  // Re-derive every status from its skip file. A list changed outside the app (bad or missing
  // signature) is flagged in the library index and stays "Needs review" until the parent confirms
  // it (skips.js, board review A4); one that cannot be read is damaged (planner decision 1).
  function reconcile() {
    library.list().forEach(function (it) {
      if (it.status === 'queued' || it.status === 'scanning') { return; }
      var r = skips.load(it.id);
      if (r.tampered && r.doc) {
        emit('toast', { kind: 'warning', key: 'toast.skipTampered', params: { title: it.title } });
      } else if (r.corrupt) {
        markDamaged(it.id);
        return;
      }
      library.applyDoc(it.id, r.doc, BO.validate);
    });
  }
  reconcile();

  var supervisor = createSupervisor({
    store: store, library: library, skips: skips, paths: paths, settings: settings, log: log.child('scan'), emit: emit,
    power: electron.powerMonitor
  });
  supervisor.load();
  var player = createPlayerService({
    createPlayer: createPlayer, paths: paths, settings: settings, library: library, skips: skips, supervisor: supervisor,
    activity: activity, t: function (k, p) { return i18n.t(k, p); }, log: log.child('player'), emit: emit
  });
  player.recover();
  var thumbs = createThumbs({ paths: paths, library: library, skips: skips });
  var help = createHelp({ paths: paths });
  var accuracy = createAccuracy({ paths: paths, settings: settings, library: library, skips: skips, log: log.child('accuracy') });

  pin.setLocked(pin.hasPin() && settings.value('lockOnStart') && settings.value('setupDone'));

  var versions = { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
  s = { paths: paths, log: log, store: store, pin: pin, settings: settings, i18n: i18n, library: library, skips: skips,
    supervisor: supervisor, player: player, thumbs: thumbs, help: help };

  function rebuildMenu() {
    menu.buildMenu({ i18n: i18n, packaged: packaged, onHelp: function () { if (!pin.isLocked()) { emit('app:navigate', { view: 'help' }); } } });
  }

  var handlers = createHandlers({
    electron: electron, getWindow: function () { return win; }, store: store, pin: pin, settings: settings, i18n: i18n,
    library: library, skips: skips, supervisor: supervisor, player: player, thumbs: thumbs, help: help, paths: paths,
    accuracy: accuracy, activity: activity, log: log.child('ipc'), emit: emit, versions: versions,
    // The PIN file was lost and the recovery code restored the original key: read everything again
    // with it, and start the scan queue that stayed stopped meanwhile.
    onPinRestored: function () {
      settings.load(osLang);
      i18n.setLang(settings.value('lang'));
      library.load();
      reconcile();
      supervisor.load();
      supervisor.start();
      emit('library:changed', library.list());
    },
    takeToasts: function () { var t = pendingToasts; pendingToasts = []; return t; },
    onLangChanged: function (lang) { i18n.setLang(lang); rebuildMenu(); }
  });
  ipc.createIpc(handlers, { isLocked: pin.isLocked, log: log.child('ipc'), checkSender: checkSender }).register(electron.ipcMain);

  rebuildMenu();
  win = windowMod.createWindow({ paths: paths, settings: settings, packaged: packaged, title: 'bonis oculis', onClosed: function () { win = null; } });
  if (!pin.isLost()) { supervisor.start(); }

  // Bundled models and binaries, hashed once per app version in the background (board review A9).
  // Packaged builds check process.resourcesPath; BONIS_VERIFY_RESOURCES points a dev run or a test
  // at another tree.
  var verifyRoot = process.env.BONIS_VERIFY_RESOURCES || (packaged ? process.resourcesPath : null);
  if (verifyRoot) {
    var integrity = createIntegrity({
      resources: verifyRoot, settings: settings, version: app.getVersion(), log: log.child('integrity'),
      onDamaged: function (res) {
        res.damaged.forEach(function (d) { activity.add('integrity', { file: d.file, detail: d.reason }); });
        emit('toast', { kind: 'error', key: 'toast.integrity', params: { file: res.damaged[0].file, count: res.damaged.length } });
        emit('app:integrity', res);
      }
    });
    s.integrity = integrity;
    setTimeout(function () { integrity.run(false); }, process.env.BONIS_VERIFY_RESOURCES ? 500 : 15000);
  }
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
