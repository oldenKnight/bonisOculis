/*
 * bonis oculis - fetch the extension's vendored runtime and model.
 *
 *   node tools/fetch-vendor.js              download what is missing or wrong
 *   node tools/fetch-vendor.js --check      verify only (no network); exit 1 on a mismatch
 *   node tools/fetch-vendor.js --from DIR   take files from DIR (same basename) when their
 *                                           sha256 matches, e.g. the analyzer's models folder
 *
 * Every file is pinned by sha256 and size; a download that does not match is
 * thrown away. The files are committed under extension/vendor/ and
 * extension/models/, so the extension never fetches anything at runtime.
 * Set of files (kept minimal: the wasm-only ONNX Runtime build, single
 * threaded at runtime, no WebGPU/WebGL/JSEP):
 *   onnxruntime-web 1.22.0 (MIT): ort.wasm.min.js, ort-wasm-simd-threaded.mjs
 *     (loaded by ort.wasm.min.js), ort-wasm-simd-threaded.wasm, and its licence
 *   YAMNet ONNX (Apache-2.0), same file and hash as analyzer/models/manifest.json,
 *     and the Apache-2.0 licence text
 * Honours HTTPS_PROXY / NO_PROXY (CONNECT tunnel). ES5, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');
var ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

var FILES = [
  { dest: 'extension/vendor/ort.wasm.min.js', url: ORT + 'ort.wasm.min.js', size: 48327, sha256: '65e09376df69107e881b5c34d2d37aed333a366b6d941073ec518168e269b87d', license: 'MIT' },
  { dest: 'extension/vendor/ort-wasm-simd-threaded.mjs', url: ORT + 'ort-wasm-simd-threaded.mjs', size: 20856, sha256: '30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8', license: 'MIT' },
  { dest: 'extension/vendor/ort-wasm-simd-threaded.wasm', url: ORT + 'ort-wasm-simd-threaded.wasm', size: 11210254, sha256: '71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4', license: 'MIT' },
  { dest: 'extension/vendor/LICENSE-onnxruntime-web.txt', url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.22.0/LICENSE', size: 1073, sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c', license: 'MIT' },
  { dest: 'extension/models/yamnet.onnx', url: 'https://huggingface.co/andrelgomes/yamnet-onnx/resolve/main/yamnet.onnx', size: 16093603, sha256: '1510041dce24a2e9e84ec546807ac408ae496da6d1ed41bc3ccba649623f8e19', license: 'Apache-2.0' },
  { dest: 'extension/models/LICENSE-yamnet-Apache-2.0.txt', url: 'https://www.apache.org/licenses/LICENSE-2.0.txt', size: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', license: 'Apache-2.0' }
];

function log(s) { process.stdout.write(s + '\n'); }

function sha256File(file) {
  var h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20), n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function matches(file, f) {
  try { return fs.statSync(file).size === f.size && sha256File(file) === f.sha256; } catch (e) { return false; }
}

function noProxy(host) {
  var list = String(process.env.NO_PROXY || process.env.no_proxy || '').split(',');
  return list.some(function (p) {
    p = p.trim().replace(/^\*?\./, '');
    return p && (host === p || host.slice(-(p.length + 1)) === '.' + p);
  });
}

/* GET url -> cb(err, response stream); follows redirects, tunnels through HTTPS_PROXY. */
function get(url, cb, hops) {
  var u = new URL(url), proxy = process.env.HTTPS_PROXY || process.env.https_proxy, p, req;
  if ((hops || 0) > 5) { cb(new Error('too many redirects')); return; }
  function onResponse(res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      get(new URL(res.headers.location, url).toString(), cb, (hops || 0) + 1);
      return;
    }
    if (res.statusCode !== 200) { res.resume(); cb(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
    cb(null, res);
  }
  if (!proxy || noProxy(u.hostname)) {
    https.get(url, onResponse).on('error', cb);
    return;
  }
  p = new URL(proxy);
  req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: u.hostname + ':443', headers: { Host: u.hostname + ':443' } });
  req.on('connect', function (res, socket) {
    if (res.statusCode !== 200) { socket.destroy(); cb(new Error('proxy refused ' + u.hostname + ' (' + res.statusCode + ')')); return; }
    https.get({ host: u.hostname, path: u.pathname + u.search, socket: socket, servername: u.hostname, agent: false }, onResponse).on('error', cb);
  });
  req.on('error', cb);
  req.end();
}

function download(f, cb) {
  var dest = path.join(ROOT, f.dest), part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  get(f.url, function (err, res) {
    var out, h = crypto.createHash('sha256'), size = 0;
    if (err) { cb(err); return; }
    out = fs.createWriteStream(part);
    res.on('data', function (d) { h.update(d); size += d.length; });
    res.pipe(out);
    out.on('finish', function () {
      var sum = h.digest('hex');
      if (sum !== f.sha256 || size !== f.size) {
        fs.unlinkSync(part);
        cb(new Error(f.dest + ': got sha256 ' + sum + ' (' + size + ' bytes), expected ' + f.sha256 + ' (' + f.size + ')'));
        return;
      }
      fs.renameSync(part, dest);
      cb(null);
    });
    out.on('error', cb);
  });
}

function main(argv) {
  var check = argv.indexOf('--check') >= 0, fromAt = argv.indexOf('--from'), from = fromAt >= 0 ? argv[fromAt + 1] : null, bad = 0;
  (function next(i) {
    var f, dest, local;
    if (i >= FILES.length) {
      log(bad ? bad + ' file(s) missing or wrong' : 'vendor ok: ' + FILES.length + ' file(s)');
      process.exitCode = bad ? 1 : 0;
      return;
    }
    f = FILES[i];
    dest = path.join(ROOT, f.dest);
    if (matches(dest, f)) { log('ok        ' + f.dest); next(i + 1); return; }
    if (check) { log('MISMATCH  ' + f.dest); bad++; next(i + 1); return; }
    local = from ? path.resolve(from, path.basename(f.dest)) : null;
    if (local && matches(local, f)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(local, dest);
      log('copied    ' + f.dest + ' from ' + local);
      next(i + 1);
      return;
    }
    log('fetching  ' + f.url);
    download(f, function (err) {
      if (err) { log('FAILED    ' + f.dest + ': ' + err.message); bad++; } else { log('ok        ' + f.dest); }
      next(i + 1);
    });
  }(0));
}

module.exports = { FILES: FILES, sha256File: sha256File };

if (require.main === module) { main(process.argv.slice(2)); }
