'use strict';
// Minimal application menu: app (macOS), Edit, View, Help. DevTools and reload only in development.

var electron = require('electron');
var Menu = electron.Menu;

// opts: {i18n, packaged, onHelp()}
function buildMenu(opts) {
  var t = opts.i18n.t;
  var isMac = process.platform === 'darwin';
  var template = [];
  if (isMac) {
    template.push({ label: 'bonis oculis', submenu: [
      { role: 'about', label: t('menu.about') }, { type: 'separator' },
      { role: 'hide', label: t('menu.hide') }, { role: 'hideOthers', label: t('menu.hideOthers') }, { role: 'unhide', label: t('menu.showAll') },
      { type: 'separator' }, { role: 'quit', label: t('menu.quit') }
    ] });
  } else {
    template.push({ label: t('menu.file'), submenu: [{ role: 'quit', label: t('menu.quit') }] });
  }
  template.push({ label: t('menu.edit'), submenu: [
    { role: 'undo', label: t('menu.undo') }, { role: 'redo', label: t('menu.redo') }, { type: 'separator' },
    { role: 'cut', label: t('menu.cut') }, { role: 'copy', label: t('menu.copy') }, { role: 'paste', label: t('menu.paste') },
    { role: 'selectAll', label: t('menu.selectAll') }
  ] });
  var view = [
    { role: 'resetZoom', label: t('menu.resetZoom') }, { role: 'zoomIn', label: t('menu.zoomIn') }, { role: 'zoomOut', label: t('menu.zoomOut') },
    { type: 'separator' }, { role: 'togglefullscreen', label: t('menu.fullscreen') }
  ];
  if (!opts.packaged) { view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }); }
  template.push({ label: t('menu.view'), submenu: view });
  template.push({ label: t('menu.help'), role: 'help', submenu: [
    { label: t('menu.openHelp'), accelerator: 'F1', click: function () { if (opts.onHelp) { opts.onHelp(); } } }
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu: buildMenu };
