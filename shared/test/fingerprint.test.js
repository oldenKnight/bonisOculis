'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var FP = require('../fingerprint.js');
var F = require('./fixtures.js');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-fp-'));
test.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

function write(name, buf) {
  var p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/* Same byte generator as tools/make-fixtures.js and the Python tests. */
function synth(size, seed) {
  var buf = Buffer.alloc(size), r = new F.Rng(seed), i;
  for (i = 0; i < size; i++) { buf[i] = r.next() & 255; }
  return buf;
}

function oshashP(p) {
  return new Promise(function (resolve, reject) {
    FP.oshash(p, function (err, h) { if (err) { reject(err); } else { resolve(h); } });
  });
}

test('oshash hand-computed small cases', function () {
  var cases = [
    // empty file: size 0, no words
    [Buffer.alloc(0), '0000000000000000'],
    // 16 bytes = words 1 and 2; head and tail are both the whole file: 16 + (1+2) + (1+2) = 22
    [Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]), '0000000000000016'],
    // one all-ones word counted twice wraps: 8 + 2*(2^64-1) mod 2^64 = 6
    [Buffer.from([255, 255, 255, 255, 255, 255, 255, 255]), '0000000000000006'],
    // 7 bytes, zero-padded word 0x0007060504030201 twice + 7
    [Buffer.from([1, 2, 3, 4, 5, 6, 7]), '000e0c0a08060409']
  ];
  var big = Buffer.alloc(131072);
  big[0] = 1;            // first word of the head = 1
  big[131071] = 0x80;    // last word of the tail = 0x8000000000000000
  cases.push([big, '8000000000020001']);  // 0x20000 + 1 + 2^63
  cases.push([Buffer.alloc(200000), '0000000000030d40']);  // zeros: only the size
  return cases.reduce(function (p, c, i) {
    return p.then(function () {
      return oshashP(write('hand' + i, c[0])).then(function (h) { assert.strictEqual(h, c[1], 'case ' + i); });
    });
  }, Promise.resolve());
});

test('fingerprint of synthetic files matches expected/fingerprint.json (shared with Python)', function () {
  var cases = F.json('expected/fingerprint.json');
  assert.ok(cases.length >= 10);
  return cases.reduce(function (p, c) {
    return p.then(function () {
      var buf = synth(c.size, c.seed), file = write('synth-' + c.size, buf);
      return new Promise(function (resolve, reject) {
        FP.fingerprint(file, function (err, fp) {
          if (err) { return reject(err); }
          try {
            assert.deepStrictEqual(fp, { size: c.size, oshash: c.oshash, headSha256: c.headSha256 }, 'size ' + c.size);
            assert.strictEqual(fp.headSha256, crypto.createHash('sha256').update(buf.slice(0, 1048576)).digest('hex'));
            assert.match(fp.oshash, /^[0-9a-f]{16}$/);
            resolve();
          } catch (e) { reject(e); }
        });
      });
    });
  }, Promise.resolve());
});

test('oshash agrees with an independent two-limb implementation', function () {
  var buf = synth(300001, 99), file = write('limb', buf), size = buf.length;
  var lo = size % 4294967296, hi = Math.floor(size / 4294967296);
  function add(b, off) {
    var w = [0, 0, 0, 0, 0, 0, 0, 0], i;
    for (i = 0; i < 8 && off + i < b.length; i++) { w[i] = b[off + i]; }
    lo += w[0] + w[1] * 256 + w[2] * 65536 + w[3] * 16777216;
    hi += w[4] + w[5] * 256 + w[6] * 65536 + w[7] * 16777216 + Math.floor(lo / 4294967296);
    lo = lo % 4294967296;
    hi = hi % 4294967296;
  }
  var i;
  for (i = 0; i < 65536; i += 8) { add(buf, i); }
  for (i = size - 65536; i < size; i += 8) { add(buf, i); }
  function h8(n) { var s = n.toString(16); while (s.length < 8) { s = '0' + s; } return s; }
  return oshashP(file).then(function (h) { assert.strictEqual(h, h8(hi) + h8(lo)); });
});

test('headSha256 hashes the first MiB only', function (t, done) {
  var a = synth(1048576 + 10, 5), b = Buffer.from(a);
  b[1048576 + 3] ^= 0xff;
  FP.headSha256(write('ha', a), function (err, ha) {
    assert.ifError(err);
    FP.headSha256(write('hb', b), function (err2, hb) {
      assert.ifError(err2);
      assert.strictEqual(ha, hb);
      assert.strictEqual(ha, crypto.createHash('sha256').update(a.slice(0, 1048576)).digest('hex'));
      done();
    });
  });
});

test('missing files and directories report an error through the callback', function (t, done) {
  FP.fingerprint(path.join(dir, 'does-not-exist'), function (err) {
    assert.ok(err);
    FP.oshash(dir, function (err2) {
      assert.ok(err2);
      done();
    });
  });
});
