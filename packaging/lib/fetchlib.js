/*
 * bonis oculis - build-time helpers shared by tools/fetch-binaries.js, tools/fetch-models.js
 * and tools/verify-bundle.js. Never shipped in the app (electron-builder.yml `files` does not
 * include packaging/), never required by desktop/ or shared/.
 *
 *   sha256File, download (HTTPS_PROXY aware, redirects, sha256 + size check before rename),
 *   readZip / zipData (stored + deflate, CRC checked), readTar (ustar + pax + GNU long names),
 *   safeRelative (archive member names: no absolute paths, no '..', no backslashes),
 *   extract7z (external 7z / 7za / 7zz; 7-Zip is preinstalled on GitHub's Windows runners),
 *   isCI, PIN.
 *
 * ES5, CommonJS, Node >= 20, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var zlib = require('zlib');
var childProcess = require('child_process');

var PIN = 'PIN_ON_FIRST_FETCH';

function log(s) { process.stdout.write(s + '\n'); }

function isCI() {
  var v = String(process.env.CI || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function sha256File(file) {
  var h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20), n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function sha256Buffer(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

/* true when file exists with this size (if given) and sha256. */
function fileMatches(file, sha256, size) {
  var st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) { return false; }
  if (typeof size === 'number' && st.size !== size) { return false; }
  return sha256File(file) === sha256;
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
  if (u.protocol !== 'https:') { cb(new Error('refusing a non-HTTPS URL: ' + url)); return; }
  if ((hops || 0) > 8) { cb(new Error('too many redirects for ' + url)); return; }
  function onResponse(res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      get(new URL(res.headers.location, url).toString(), cb, (hops || 0) + 1);
      return;
    }
    if (res.statusCode !== 200) { res.resume(); cb(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
    cb(null, res);
  }
  var headers = { 'User-Agent': 'bonis-oculis-build/1 (+tools/fetch)' };
  if (!proxy || noProxy(u.hostname)) {
    https.get({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: headers }, onResponse).on('error', cb);
    return;
  }
  p = new URL(proxy);
  req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: u.hostname + ':' + (u.port || 443), headers: { Host: u.hostname + ':' + (u.port || 443) } });
  req.on('connect', function (res, socket) {
    if (res.statusCode !== 200) { socket.destroy(); cb(new Error('proxy refused ' + u.hostname + ' (' + res.statusCode + ')')); return; }
    https.get({ host: u.hostname, path: u.pathname + u.search, socket: socket, servername: u.hostname, agent: false, headers: headers }, onResponse).on('error', cb);
  });
  req.on('error', cb);
  req.end();
}

/*
 * download(url, dest, expect, cb(err, {sha256, size}))
 * expect = {sha256, size} -> the file is renamed into place only when both match; with
 * expect.sha256 === PIN (or no expect) it is kept and the caller decides (fetch-binaries
 * refuses that in CI). Partial files never survive.
 */
function download(url, dest, expect, cb) {
  var part = dest + '.part', attempt = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  function tryOnce() {
    attempt++;
    get(url, function (err, res) {
      var out, h = crypto.createHash('sha256'), size = 0, failed = false;
      if (err) { retry(err); return; }
      out = fs.createWriteStream(part);
      res.on('data', function (d) { h.update(d); size += d.length; });
      res.on('error', function (e) { failed = true; out.destroy(); retry(e); });
      res.pipe(out);
      out.on('error', function (e) { if (!failed) { failed = true; retry(e); } });
      out.on('finish', function () {
        var sum;
        if (failed) { return; }
        sum = h.digest('hex');
        if (expect && expect.sha256 && expect.sha256 !== PIN &&
            (sum !== expect.sha256 || (typeof expect.size === 'number' && size !== expect.size))) {
          try { fs.unlinkSync(part); } catch (e1) { /* gone */ }
          cb(new Error(path.basename(dest) + ': got sha256 ' + sum + ' (' + size + ' bytes), expected ' +
            expect.sha256 + (typeof expect.size === 'number' ? ' (' + expect.size + ')' : '')));
          return;
        }
        fs.renameSync(part, dest);
        cb(null, { sha256: sum, size: size });
      });
    });
  }
  function retry(err) {
    try { fs.unlinkSync(part); } catch (e) { /* none */ }
    if (attempt < 3) { log('  retry ' + attempt + ' after: ' + err.message); setTimeout(tryOnce, 1500 * attempt); return; }
    cb(err);
  }
  tryOnce();
}

/* Archive member names: relative, forward slashes, no '..', no drive letters, no NUL. */
function safeRelative(name) {
  var parts, out = [], i;
  if (typeof name !== 'string' || !name || name.indexOf('\0') >= 0 || name.indexOf('\\') >= 0) { return null; }
  if (name.charAt(0) === '/' || /^[a-zA-Z]:/.test(name)) { return null; }
  parts = name.split('/');
  for (i = 0; i < parts.length; i++) {
    if (parts[i] === '' || parts[i] === '.') { continue; }
    if (parts[i] === '..') { return null; }
    out.push(parts[i]);
  }
  return out.length ? out.join('/') : null;
}

/* Join base + rel and prove the result stays inside base. */
function inside(base, rel) {
  var b = path.resolve(base), p = path.resolve(b, rel);
  if (p !== b && p.indexOf(b + path.sep) !== 0) { throw new Error('path escapes ' + base + ': ' + rel); }
  return p;
}

/* ---------- zip ---------- */

var crcTable = null;
function crc32(buf) {
  var c, i, n, k;
  if (typeof zlib.crc32 === 'function') { return zlib.crc32(buf) >>> 0; }
  if (!crcTable) {
    crcTable = [];
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      crcTable[n] = c >>> 0;
    }
  }
  c = 0xFFFFFFFF;
  for (i = 0; i < buf.length; i++) { c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* readZip(buffer) -> [{name, method, csize, usize, crc, offset, isDir, mode}] from the central directory. */
function readZip(buf) {
  var eocd = -1, i, n, off, entries = [], nameLen, extraLen, commentLen, e, ext;
  for (i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { throw new Error('not a zip file (no end of central directory)'); }
  n = buf.readUInt16LE(eocd + 10);
  off = buf.readUInt32LE(eocd + 16);
  if (off === 0xFFFFFFFF || n === 0xFFFF) { throw new Error('zip64 archives are not supported'); }
  for (i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) { throw new Error('bad zip central directory'); }
    nameLen = buf.readUInt16LE(off + 28);
    extraLen = buf.readUInt16LE(off + 30);
    commentLen = buf.readUInt16LE(off + 32);
    ext = buf.readUInt32LE(off + 38);
    e = {
      method: buf.readUInt16LE(off + 10),
      crc: buf.readUInt32LE(off + 16),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      offset: buf.readUInt32LE(off + 42),
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      mode: (ext >>> 16) & 0xFFFF
    };
    e.isDir = /\/$/.test(e.name);
    e.isLink = (e.mode & 0xF000) === 0xA000;
    entries.push(e);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* zipData(buffer, entry) -> Buffer of the member, CRC verified. */
function zipData(buf, e) {
  var lh = e.offset, start, raw, data;
  if (buf.readUInt32LE(lh) !== 0x04034b50) { throw new Error('bad zip local header for ' + e.name); }
  start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) { data = raw; } else if (e.method === 8) { data = zlib.inflateRawSync(raw); } else {
    throw new Error('unsupported zip method ' + e.method + ' for ' + e.name);
  }
  if (data.length !== e.usize || crc32(data) !== e.crc) { throw new Error('zip member corrupt: ' + e.name); }
  return data;
}

/* ---------- tar ---------- */

function tarString(b, start, len) {
  var s = b.toString('utf8', start, start + len), z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

function tarNumber(b, start, len) {
  var s = tarString(b, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/*
 * readTar(buffer) -> [{name, type, size, mode, data}] (data is a view into buffer).
 * type: 'file', 'dir', 'symlink', 'hardlink' or 'other'. Handles ustar prefix, pax 'path'
 * records and GNU long names.
 */
function readTar(buf) {
  var off = 0, out = [], longName = null, paxPath = null, hdr, name, size, flag, prefix, body, m, type;
  while (off + 512 <= buf.length) {
    hdr = buf.subarray(off, off + 512);
    if (hdr.every(function (x) { return x === 0; })) { break; }
    name = tarString(hdr, 0, 100);
    size = tarNumber(hdr, 124, 12);
    flag = String.fromCharCode(hdr[156] || 48);
    prefix = tarString(hdr, 345, 155);
    if (tarString(hdr, 257, 6).indexOf('ustar') === 0 && prefix) { name = prefix + '/' + name; }
    body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (flag === 'L') { longName = tarString(body, 0, body.length); continue; }
    if (flag === 'x') {
      m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (flag === 'g') { continue; }
    if (paxPath) { name = paxPath; } else if (longName) { name = longName; }
    paxPath = null; longName = null;
    if (flag === '0' || flag === '\0' || flag === '7') { type = 'file'; } else if (flag === '5') { type = 'dir'; } else if (flag === '2') { type = 'symlink'; } else if (flag === '1') { type = 'hardlink'; } else { type = 'other'; }
    out.push({ name: name, type: type, size: size, mode: tarNumber(hdr, 100, 8), data: body });
  }
  return out;
}

function readTarGz(file) { return readTar(zlib.gunzipSync(fs.readFileSync(file))); }

/* ---------- 7z (external) ---------- */

function find7z() {
  var names = process.platform === 'win32' ? ['7z.exe', '7za.exe', '7zz.exe'] : ['7z', '7za', '7zz'];
  var dirs = String(process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'win32') { dirs.push('C:\\Program Files\\7-Zip'); }
  var i, j, p;
  for (i = 0; i < names.length; i++) {
    for (j = 0; j < dirs.length; j++) {
      if (!dirs[j]) { continue; }
      p = path.join(dirs[j], names[i]);
      try { if (fs.statSync(p).isFile()) { return p; } } catch (e) { /* next */ }
    }
  }
  return null;
}

/* extract7z(archive, members[], intoDir) -> extracts only those members (full paths kept). */
function extract7z(archive, members, intoDir) {
  var exe = find7z(), r;
  if (!exe) { throw new Error('7-Zip (7z, 7za or 7zz) is needed to unpack ' + path.basename(archive) + '; install p7zip / 7-Zip'); }
  fs.mkdirSync(intoDir, { recursive: true });
  r = childProcess.spawnSync(exe, ['x', '-y', '-bd', '-o' + intoDir, archive].concat(members), { encoding: 'utf8' });
  if (r.status !== 0) { throw new Error('7z failed (' + r.status + '): ' + (r.stderr || r.stdout || '').slice(-400)); }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* gone */ } }

/* Recursive file list (relative, forward slashes). */
function walkFiles(dir, base, out) {
  var list = out || [];
  var root = base || dir;
  fs.readdirSync(dir).forEach(function (n) {
    var f = path.join(dir, n), st = fs.lstatSync(f);
    if (st.isDirectory()) { walkFiles(f, root, list); } else { list.push(path.relative(root, f).split(path.sep).join('/')); }
  });
  return list;
}

module.exports = {
  PIN: PIN,
  log: log,
  isCI: isCI,
  sha256File: sha256File,
  sha256Buffer: sha256Buffer,
  fileMatches: fileMatches,
  get: get,
  download: download,
  safeRelative: safeRelative,
  inside: inside,
  crc32: crc32,
  readZip: readZip,
  zipData: zipData,
  readTar: readTar,
  readTarGz: readTarGz,
  find7z: find7z,
  extract7z: extract7z,
  rmrf: rmrf,
  walkFiles: walkFiles
};
