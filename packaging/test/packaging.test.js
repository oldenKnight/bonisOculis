'use strict';
// M9a packaging tools: icon containers, archive readers, path safety, pins.
//   node --test packaging/test

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..', '..');
var lib = require('../lib/fetchlib.js');
var icons = require('../make-icons.js');
var fb = require('../../tools/fetch-binaries.js');
var fm = require('../../tools/fetch-models.js');

function pngAt(buf, off) { return icons.pngSize(buf.subarray(off)); }

test('icon.ico: ICONDIR, one PNG entry per size, offsets and lengths consistent', function () {
  var ico = fs.readFileSync(path.join(ROOT, 'packaging', 'icons', 'icon.ico'));
  assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'type 1 = icon');
  var n = ico.readUInt16LE(4), end = 6 + 16 * n, i, w, len, off, s;
  assert.deepStrictEqual(n, icons.ICO_SIZES.length);
  for (i = 0; i < n; i++) {
    w = ico.readUInt8(6 + 16 * i) || 256;
    assert.strictEqual(ico.readUInt16LE(10 + 16 * i), 1, 'planes');
    assert.strictEqual(ico.readUInt16LE(12 + 16 * i), 32, 'bpp');
    len = ico.readUInt32LE(14 + 16 * i);
    off = ico.readUInt32LE(18 + 16 * i);
    assert.strictEqual(off, end, 'entries are contiguous');
    s = pngAt(ico, off);
    assert.deepStrictEqual([s.w, s.h], [w, w]);
    assert.strictEqual(w, icons.ICO_SIZES[i]);
    end = off + len;
  }
  assert.strictEqual(end, ico.length, 'no trailing bytes');
});

test('icon.icns: magic, total length, PNG elements of the right sizes', function () {
  var b = fs.readFileSync(path.join(ROOT, 'packaging', 'icons', 'icon.icns'));
  assert.strictEqual(b.toString('ascii', 0, 4), 'icns');
  assert.strictEqual(b.readUInt32BE(4), b.length);
  var off = 8, seen = [], type, len, s, want = {};
  icons.ICNS_TYPES.forEach(function (t) { want[t[0]] = t[1]; });
  while (off < b.length) {
    type = b.toString('ascii', off, off + 4);
    len = b.readUInt32BE(off + 4);
    assert.ok(len > 8 && off + len <= b.length, type + ' length');
    s = pngAt(b, off + 8);
    assert.deepStrictEqual([s.w, s.h], [want[type], want[type]], type);
    seen.push(type);
    off += len;
  }
  assert.deepStrictEqual(seen, icons.ICNS_TYPES.map(function (t) { return t[0]; }));
});

test('icon PNGs exist for every size, are RGBA, and the mac master has a transparent margin', function () {
  [16, 24, 32, 48, 64, 128, 256, 512, 1024].forEach(function (n) {
    var b = fs.readFileSync(path.join(ROOT, 'packaging', 'icons', 'png', n + 'x' + n + '.png'));
    var s = icons.pngSize(b);
    assert.deepStrictEqual([s.w, s.h], [n, n]);
    assert.strictEqual(b[25], 6, n + ': colour type 6 (RGBA)');
  });
  var mac = fs.readFileSync(path.join(ROOT, 'packaging', 'icons', 'mac-1024.png'));
  assert.strictEqual(icons.pngSize(mac).w, 1024);
  assert.strictEqual(mac[25], 6);
});

test('buildIco / buildIcns round-trip tiny PNGs', function () {
  var png = fs.readFileSync(path.join(ROOT, 'packaging', 'icons', 'png', '16x16.png'));
  var ico = icons.buildIco([png]);
  assert.strictEqual(ico.readUInt16LE(4), 1);
  assert.strictEqual(ico.readUInt32LE(18), 22);
  var icns = icons.buildIcns([{ type: 'icp4', png: png }]);
  assert.strictEqual(icns.readUInt32BE(4), 8 + 8 + png.length);
});

test('safeRelative rejects traversal, absolute and Windows paths', function () {
  ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a\0b', '', '..'].forEach(function (n) {
    assert.strictEqual(lib.safeRelative(n), null, JSON.stringify(n));
  });
  assert.strictEqual(lib.safeRelative('a/./b/'), 'a/b');
  assert.throws(function () { lib.inside('/tmp/base', '../x'); });
});

function tarHeader(name, size, flag) {
  var h = Buffer.alloc(512), sum = 0, i;
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(('00000000000' + size.toString(8)).slice(-11) + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(flag, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  for (i = 0; i < 512; i++) { sum += h[i]; }
  h.write(('000000' + sum.toString(8)).slice(-6) + '\0 ', 148);
  return h;
}

function tarOf(entries) {
  var parts = [];
  entries.forEach(function (e) {
    var data = Buffer.from(e.data || '');
    parts.push(tarHeader(e.name, data.length, e.flag || '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  });
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test('readTar reads ustar files, dirs, symlinks and pax long names', function () {
  var long = 'p/' + new Array(60).join('long') + '.bin';
  var pax = '30 path=' + long + '\n';
  pax = (pax.length + 1 + 1) + pax.slice(pax.indexOf(' '));
  var t = lib.readTar(tarOf([
    { name: 'dir/', flag: '5' },
    { name: 'dir/a.txt', data: 'hello' },
    { name: 'link', flag: '2' },
    { name: 'PaxHeader', flag: 'x', data: pax },
    { name: 'short', data: 'x' }
  ]));
  assert.deepStrictEqual(t.map(function (e) { return [e.name, e.type]; }), [['dir/', 'dir'], ['dir/a.txt', 'file'], ['link', 'symlink'], [long, 'file']]);
  assert.strictEqual(t[1].data.toString(), 'hello');
});

function zipOf(entries) {
  var locals = [], central = [], off = 0;
  entries.forEach(function (e) {
    var data = Buffer.from(e.data), comp = zlib.deflateRawSync(data), name = Buffer.from(e.name), crc = lib.crc32(data);
    var lh = Buffer.alloc(30), ch = Buffer.alloc(46);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode || 33188) << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  });
  var cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

test('readZip / zipData: deflate members with CRC check', function () {
  var z = zipOf([{ name: 'bin/ffmpeg', data: 'ffmpeg bytes' }, { name: 'x/', data: '' }]);
  var list = lib.readZip(z);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(lib.zipData(z, list[0]).toString(), 'ffmpeg bytes');
  assert.ok(list[1].isDir);
  z[40] ^= 0xFF; // corrupt compressed data of the first member
  assert.throws(function () { lib.zipData(z, lib.readZip(z)[0]); });
});

test('fetch-binaries extraction refuses traversal, symlinks and duplicate destinations', function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-fb-'));
  var tgz = path.join(tmp, 'a.tar.gz'), zip = path.join(tmp, 'a.zip');
  function table(targets, archives) { return { archives: archives, targets: { t: targets }, scripts: {} }; }
  function run(t, files) {
    var stage = path.join(tmp, 'stage' + Math.random().toString(16).slice(2));
    fs.mkdirSync(stage);
    fb.extractTarget(t, 't', files, stage, {});
    return stage;
  }
  try {
    fs.writeFileSync(tgz, zlib.gzipSync(tarOf([{ name: 'app/ok.txt', data: 'ok' }, { name: 'app/../../evil', data: 'x' }])));
    assert.throws(function () {
      run(table([{ destDir: 'x', archive: 'a', prefix: 'app/' }], { a: { format: 'tar.gz', file: 'a.tar.gz' } }), { a: tgz });
    }, /unsafe member/);
    fs.writeFileSync(tgz, zlib.gzipSync(tarOf([{ name: 'app/ok.txt', data: 'ok' }, { name: 'app/l', flag: '2' }])));
    assert.throws(function () {
      run(table([{ destDir: 'x', archive: 'a', prefix: 'app/' }], { a: { format: 'tar.gz', file: 'a.tar.gz' } }), { a: tgz });
    }, /refusing symlink/);
    fs.writeFileSync(tgz, zlib.gzipSync(tarOf([{ name: 'app/ok.txt', data: 'ok' }])));
    var st = run(table([{ destDir: 'x', archive: 'a', prefix: 'app/' }], { a: { format: 'tar.gz', file: 'a.tar.gz' } }), { a: tgz });
    assert.strictEqual(fs.readFileSync(path.join(st, 'x', 'ok.txt'), 'utf8'), 'ok');
    // zip member names never become paths: '../evil.dll' is flattened to a basename, and
    // a destination outside the target is refused
    fs.writeFileSync(zip, zipOf([{ name: 'R/whisper.dll', data: 'w' }, { name: '../ggml.dll', data: 'g' }]));
    st = run(table([{ destDir: '.', archive: 'z', match: '\\.dll$', flatten: true }], { z: { format: 'zip', file: 'a.zip' } }), { z: zip });
    assert.deepStrictEqual(fs.readdirSync(st).sort(), ['ggml.dll', 'whisper.dll']);
    assert.throws(function () {
      run(table([{ dest: '../out.dll', archive: 'z', member: 'R/whisper.dll' }], { z: { format: 'zip', file: 'a.zip' } }), { z: zip });
    }, /unsafe destination/);
    assert.throws(function () {
      run(table([{ dest: 'a.dll', archive: 'z', member: 'R/whisper.dll' }, { dest: 'a.dll', archive: 'z', member: 'R/whisper.dll' }], { z: { format: 'zip', file: 'a.zip' } }), { z: zip });
    }, /two entries write/);
  } finally { lib.rmrf(tmp); }
});

test('binaries.json: every target entry names a known archive/script/build; pins are hex or PIN_ON_FIRST_FETCH', function () {
  var t = fb.loadTable();
  Object.keys(t.archives).forEach(function (id) {
    var a = t.archives[id];
    assert.ok(/^https:\/\//.test(a.url), id + ' https');
    assert.ok(/^[0-9a-f]{64}$/.test(a.sha256) || a.sha256 === lib.PIN, id + ' sha256');
    assert.strictEqual(lib.safeRelative(a.file), a.file);
    assert.ok(['7z', 'zip', 'tar.gz', 'file'].indexOf(a.format) >= 0, id + ' format');
  });
  Object.keys(t.targets).forEach(function (k) {
    t.targets[k].forEach(function (e) {
      assert.ok((e.archive && t.archives[e.archive]) || (e.script && t.scripts[e.script]) || (e.build && t.builds[e.build]), k + ' ' + JSON.stringify(e));
      if (e.dest) { assert.strictEqual(lib.safeRelative(e.dest), e.dest); }
    });
    ['mpv', 'ffmpeg', 'ffprobe', 'whisper-cli'].forEach(function (n) {
      var exe = n + (k.indexOf('win32') === 0 ? '.exe' : '');
      assert.ok(t.targets[k].some(function (e) { return e.dest === exe; }), k + ' has ' + exe);
    });
  });
});

test('fetch-models: shipped list = manifest minus build-only and the NudeNet tarball, plus 320n and committed files', function () {
  var names = fm.shipped().map(function (f) { return f.file; });
  assert.ok(names.indexOf('nudenet-320n.onnx') >= 0);
  assert.ok(names.indexOf('nudenet-3.4.2.tar.gz') < 0);
  assert.ok(names.indexOf('clip-vit-b32-text_quantized.onnx') < 0);
  assert.ok(names.indexOf('clip_prompts.npz') >= 0);
  fm.shipped().forEach(function (f) { assert.ok(/^[0-9a-f]{64}$/.test(f.sha256), f.file); });
});

test('verify-bundle forbidden-word rule: strings and code count, comments and locale keys do not', function () {
  var vb = require('../../tools/verify-bundle.js');
  assert.deepStrictEqual(vb.forbiddenHits('a.js', '// no telemetry here\n/* sentry */\nvar k = t(\'privacy.never.telemetry\');'), []);
  assert.strictEqual(vb.forbiddenHits('a.js', 'var u = "https://api.example.com";').length, 1);
  assert.strictEqual(vb.forbiddenHits('a.js', 'window.analytics.track(1);').length, 1);
  assert.deepStrictEqual(vb.forbiddenHits('l.json', '{"privacy.never.telemetry": "Sends usage data."}'), []);
  assert.strictEqual(vb.forbiddenHits('l.json', '{"k": "see api.example.com"}').length, 1);
  assert.deepStrictEqual(vb.forbiddenHits('p.lua', '-- telemetry free\nlocal x = 1'), []);
  assert.strictEqual(vb.stripJsComments('var a = "//x"; // c').indexOf('"//x"'), 8);
});
