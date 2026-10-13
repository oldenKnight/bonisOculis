'use strict';
// integrity.js: bundled models (models/manifest.json) and binaries (bin/binaries.lock.json) are
// hashed in the background once per app version; a mismatch names the file.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var h = require('./helpers.js');
var createIntegrity = require('../main/integrity.js').createIntegrity;

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

function tree() {
  var res = h.tmpDir('integrity-res');
  fs.mkdirSync(path.join(res, 'models'), { recursive: true });
  fs.mkdirSync(path.join(res, 'bin', 'licenses'), { recursive: true });
  var model = crypto.randomBytes(3 * 1024 * 1024 + 17);
  var cfg = Buffer.from('{"id2label":{"0":"sfw","1":"nsfw"}}');
  var mpv = crypto.randomBytes(4096);
  var lic = Buffer.from('GPL');
  fs.writeFileSync(path.join(res, 'models', 'm.onnx'), model);
  fs.writeFileSync(path.join(res, 'models', 'c.json'), cfg);
  fs.writeFileSync(path.join(res, 'bin', 'mpv'), mpv);
  fs.writeFileSync(path.join(res, 'bin', 'licenses', 'GPL.txt'), lic);
  fs.writeFileSync(path.join(res, 'models', 'manifest.json'), JSON.stringify({ files: [
    { file: 'm.onnx', sha256: sha(model), size: model.length },
    { file: 'c.json', sha256: sha(cfg), size: cfg.length },
    { file: 'not-shipped.onnx', sha256: sha('x'), size: 1 },
    { file: '../escape.onnx', sha256: sha('x'), size: 1 }
  ] }));
  fs.writeFileSync(path.join(res, 'bin', 'binaries.lock.json'), JSON.stringify({ files: {
    mpv: { sha256: sha(mpv), size: mpv.length },
    'licenses/GPL.txt': { sha256: sha(lic), size: lic.length }
  } }));
  return res;
}

test('every bundled file is checked once per version; a changed byte names the file', function (t, done) {
  var res = tree();
  var s = h.stack('integrity');
  var damaged = [];
  var ig = createIntegrity({ resources: res, settings: s.settings, version: '1.0.0', chunkBytes: 64 * 1024, pauseMs: 0, onDamaged: function (r) { damaged.push(r); } });
  assert.strictEqual(ig.targets().length, 5, 'unsafe paths are ignored');
  assert.strictEqual(ig.needed(), true);
  ig.run(false, function (e, r) {
    assert.ifError(e);
    assert.strictEqual(r.checked, 4);
    assert.strictEqual(r.missing, 1, 'listed but not shipped');
    assert.deepStrictEqual(r.damaged, []);
    assert.strictEqual(damaged.length, 0);
    assert.strictEqual(s.settings.value('integrity').version, '1.0.0');
    assert.strictEqual(ig.needed(), false, 'not again for this version');
    ig.run(false, function (e2, r2) {
      assert.strictEqual(r2, null);
      // Flip one byte in the middle of the model and one in the binary (same sizes).
      var mf = path.join(res, 'models', 'm.onnx');
      var b = fs.readFileSync(mf);
      b[2 * 1024 * 1024] ^= 0xff;
      fs.writeFileSync(mf, b);
      fs.writeFileSync(path.join(res, 'bin', 'licenses', 'GPL.txt'), 'GPX');
      var ig2 = createIntegrity({ resources: res, settings: s.settings, version: '1.0.1', chunkBytes: 64 * 1024, pauseMs: 0, onDamaged: function (x) { damaged.push(x); } });
      assert.strictEqual(ig2.needed(), true, 'a new version checks again');
      ig2.run(false, function (e3, r3) {
        assert.deepStrictEqual(r3.damaged, [{ file: 'models/m.onnx', reason: 'mismatch' }, { file: 'bin/licenses/GPL.txt', reason: 'mismatch' }]);
        assert.strictEqual(damaged.length, 1);
        assert.deepStrictEqual(s.settings.value('integrity').damaged, r3.damaged, 'kept in settings for the library banner');
        done();
      });
    });
  });
});
