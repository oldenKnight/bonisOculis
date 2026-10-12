'use strict';
// Where things live. Development runs from the repository with system binaries on PATH; packaged
// builds (M9) carry ffmpeg, ffprobe, mpv and the analyzer under process.resourcesPath.
// Environment overrides (BONIS_FFMPEG, BONIS_FFPROBE, BONIS_MPV, BONIS_ANALYZER) exist for tests
// and for developers; they are read once, here.

var path = require('path');
var fs = require('fs');

var EXE = process.platform === 'win32' ? '.exe' : '';

function firstExisting(list) {
  var i;
  for (i = 0; i < list.length; i++) {
    try { if (list[i] && fs.statSync(list[i]).isFile()) { return list[i]; } } catch (e) { /* next */ }
  }
  return null;
}

function parseAnalyzerEnv(text) {
  if (!text) { return null; }
  try {
    var v = JSON.parse(text);
    if (v && typeof v.cmd === 'string') {
      return { cmd: v.cmd, args: Array.isArray(v.args) ? v.args.map(String) : [], cwd: typeof v.cwd === 'string' ? v.cwd : null };
    }
  } catch (e) { /* not JSON: a plain executable path */ }
  return { cmd: String(text), args: [], cwd: null };
}

// opts: { isPackaged, resourcesPath, userData, env }
function createPaths(opts) {
  var o = opts || {};
  var env = o.env || process.env;
  var repoRoot = path.join(__dirname, '..', '..');
  var res = o.resourcesPath || process.resourcesPath || repoRoot;
  var packaged = !!o.isPackaged;
  var userData = o.userData || path.join(repoRoot, '.userdata');

  function bin(name, envName) {
    if (env[envName]) { return env[envName]; }
    if (packaged) { return path.join(res, 'bin', name + EXE); }
    return firstExisting(['/usr/bin/' + name, '/usr/local/bin/' + name, '/opt/homebrew/bin/' + name]) || name;
  }

  function defaultAnalyzer() {
    var fromEnv = parseAnalyzerEnv(env.BONIS_ANALYZER);
    if (fromEnv) { return fromEnv; }
    if (packaged) {
      return { cmd: path.join(res, 'analyzer', 'bonis-analyzer' + EXE), args: [], cwd: null };
    }
    return { cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'bonis_analyzer.cli'], cwd: path.join(repoRoot, 'analyzer') };
  }

  return {
    packaged: packaged,
    repoRoot: repoRoot,
    userData: userData,
    ffmpeg: function () { return bin('ffmpeg', 'BONIS_FFMPEG'); },
    ffprobe: function () { return bin('ffprobe', 'BONIS_FFPROBE'); },
    mpv: function () { return bin('mpv', 'BONIS_MPV'); },
    playerScript: function () { return packaged ? path.join(res, 'player', 'bonis.lua') : path.join(repoRoot, 'player', 'bonis.lua'); },
    helpDir: function () { return packaged ? path.join(res, 'help') : path.join(repoRoot, 'docs', 'HELP'); },
    licensesFile: function () { return packaged ? path.join(res, 'help', 'LICENSES.md') : path.join(repoRoot, 'docs', 'LICENSES.md'); },
    localesDir: function () { return path.join(__dirname, '..', 'locales'); },
    rendererIndex: function () { return path.join(__dirname, '..', 'renderer', 'index.html'); },
    preload: function () { return path.join(__dirname, '..', 'preload.js'); },
    // settings.analyzerCommand wins over the default; it is {cmd, args[], cwd?}.
    analyzer: function (setting) {
      if (setting && typeof setting.cmd === 'string' && setting.cmd) {
        return { cmd: setting.cmd, args: Array.isArray(setting.args) ? setting.args.map(String) : [], cwd: setting.cwd || null };
      }
      return defaultAnalyzer();
    },
    workDir: function (oshash) { return path.join(userData, 'work', oshash); },
    playDir: function () { return path.join(userData, 'play'); },
    tmpDir: function () { return path.join(userData, 'tmp'); },
    logDir: function () { return path.join(userData, 'logs'); },
    playerOptions: function () {
      return { vo: env.BONIS_PLAYER_VO || null, ao: env.BONIS_PLAYER_AO || null };
    }
  };
}

module.exports = { createPaths: createPaths, parseAnalyzerEnv: parseAnalyzerEnv };
