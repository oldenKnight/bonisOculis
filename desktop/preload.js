'use strict';
// The only bridge between the page and the app (PLAN 2.1, 6). Exposes exactly two functions:
//   window.bo.invoke(channel, payload, cb)   -> cb({ok, error, data}) ; main validates everything
//   window.bo.on(event, fn)                  -> main events from a closed list, plus the local
//                                               'files:dropped' event (paths of dropped or chosen
//                                               files, which the sandboxed page cannot read).
// Runs sandboxed: only the 'electron' module is available here.

var electron = require('electron');
var contextBridge = electron.contextBridge;
var ipcRenderer = electron.ipcRenderer;
var webUtils = electron.webUtils;

// Keep in step with desktop/main/ipc.js EVENTS (a test checks it).
var EVENTS = ['scan:progress', 'player:event', 'library:changed', 'toast', 'app:locked', 'app:navigate', 'export:progress', 'settings:changed', 'app:integrity'];
var LOCAL_EVENTS = ['files:dropped'];
var listeners = {};

function deliver(name, payload) {
  var fns = listeners[name] || [];
  var i;
  for (i = 0; i < fns.length; i++) {
    try { fns[i](payload); } catch (e) { /* a page listener failed; keep going */ }
  }
}

EVENTS.forEach(function (name) {
  ipcRenderer.on(name, function (event, payload) { deliver(name, payload); });
});

function pathsOf(fileList) {
  var out = [];
  var i, p;
  for (i = 0; fileList && i < fileList.length; i++) {
    try { p = webUtils.getPathForFile(fileList[i]); } catch (e) { p = ''; }
    if (p) { out.push(p); }
  }
  return out;
}

window.addEventListener('dragover', function (e) { e.preventDefault(); }, true);
window.addEventListener('drop', function (e) {
  e.preventDefault();
  var paths = pathsOf(e.dataTransfer && e.dataTransfer.files);
  if (paths.length) { deliver('files:dropped', paths); }
}, true);
document.addEventListener('change', function (e) {
  var t = e.target;
  if (t && t.tagName === 'INPUT' && t.type === 'file') {
    var paths = pathsOf(t.files);
    try { t.value = ''; } catch (e2) { /* read-only */ }
    if (paths.length) { deliver('files:dropped', paths); }
  }
}, true);

contextBridge.exposeInMainWorld('bo', {
  invoke: function (channel, payload, cb) {
    var done = typeof cb === 'function' ? cb : function () {};
    if (typeof channel !== 'string' || !/^[a-z]+:[a-zA-Z]+$/.test(channel)) { done({ ok: false, error: 'badChannel', data: null }); return; }
    ipcRenderer.invoke(channel, payload === undefined ? {} : payload).then(function (res) {
      done(res && typeof res === 'object' ? res : { ok: false, error: 'internal', data: null });
    }, function () {
      done({ ok: false, error: 'ipc', data: null });
    });
  },
  on: function (name, fn) {
    if ((EVENTS.indexOf(name) < 0 && LOCAL_EVENTS.indexOf(name) < 0) || typeof fn !== 'function') { return false; }
    (listeners[name] = listeners[name] || []).push(fn);
    return true;
  }
});
