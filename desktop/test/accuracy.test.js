'use strict';
// accuracy.js: runs `evaluate` through the analyzer command (here tools/fake-analyzer.js, whose
// evaluate is a port of bonis_analyzer/evaluate.py), keeps the JSON report and the markdown, and
// stores the last result in library.json. When the Python analyzer is importable, its evaluate
// must give the same report.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var createAccuracy = require('../main/accuracy.js').createAccuracy;

var ITEM = { id: 'eeeeeeeeeeeeeeee', path: '/m/e.mkv', filename: 'e.mkv', title: 'Echo', size: 50, oshash: 'eeeeeeeeeeeeeeee', status: 'notScanned', duration: 120 };
var ROOT = path.join(__dirname, '..', '..');

function doc(ranges, fp) {
  return BO.newDoc({
    media: { title: 'Echo', duration: 120, fingerprint: fp || { size: 50, oshash: ITEM.oshash } },
    ranges: ranges.map(function (r, i) {
      return BO.newRange({ id: 'racc0000' + i, start: r[0], end: r[1], category: r[2], source: r[3] || 'auto', review: r[4] || 'pending', confidence: 0.9, action: r[5] || 'skip' });
    }),
    scan: { status: 'complete' }
  });
}

// Prediction: nudity 10-20 (truth 12-22), a false alarm 60-65, a rejected kissing 80-90.
var PRED = [[10, 20, 'nudity'], [60, 65, 'gore'], [80, 90, 'kissing', 'auto', 'rejected']];
// Truth: nudity 12-22, kissing 80-90 (we rejected it: a miss), language 100-101 (missed).
var TRUTH = [[12, 22, 'nudity', 'manual', 'approved'], [80, 90, 'kissing', 'manual', 'approved'], [100, 101, 'language', 'manual', 'approved', 'mute']];

function setup(name, extra) {
  var s = h.stack(name, { settings: { analyzerCommand: h.fakeAnalyzer(extra) } });
  s.store.writeEnvelope('library.json', { version: 1, items: [JSON.parse(JSON.stringify(ITEM))] });
  s.library.load();
  s.acc = createAccuracy({ paths: s.paths, settings: s.settings, library: s.library, skips: s.skips });
  return s;
}

function truthFile(s, fp) {
  var f = path.join(s.dir, 'hand marked.bonis.json');
  fs.writeFileSync(f, JSON.stringify(doc(TRUTH, fp)));
  return f;
}

test('evaluate runs through the analyzer command and the result is stored per title', function (t, done) {
  var s = setup('acc-run');
  assert.ok(s.skips.replace(ITEM.id, doc(PRED), false).ok);
  s.acc.run(ITEM.id, truthFile(s), function (err, res) {
    assert.ifError(err);
    var c = res.report.categories;
    assert.deepStrictEqual(Object.keys(c), ['nudity', 'kissing', 'gore', 'language', 'all']);
    assert.strictEqual(c.nudity.truePositiveSeconds, 8);
    assert.strictEqual(c.nudity.precision, 0.8);
    assert.strictEqual(c.nudity.recall, 0.8);
    assert.strictEqual(c.nudity.secondsMissed, 2);
    assert.strictEqual(c.nudity.secondsFalselyFlagged, 2);
    assert.strictEqual(c.kissing.recall, 0, 'the rejected scene counts as missed');
    assert.strictEqual(c.kissing.precision, null, 'nothing flagged: no precision');
    assert.strictEqual(c.gore.secondsFalselyFlagged, 5);
    assert.strictEqual(c.language.secondsMissed, 1);
    assert.strictEqual(c.all.truthSeconds, 21);
    assert.strictEqual(c.all.rangeHitRate, 0.3333);
    assert.strictEqual(res.report.tolerance, 3);
    assert.strictEqual(res.sameCopy, true);
    assert.strictEqual(res.truthName, 'hand marked.bonis.json');
    assert.match(res.markdown, /^\| category \| precision \| recall \| F1 \|/);
    assert.match(res.markdown, /\| nudity \| 0\.800 \| 0\.800 \| 0\.800 \|/);
    assert.deepStrictEqual(s.library.get(ITEM.id).accuracy, res, 'kept in library.json');
    assert.deepStrictEqual(fs.readdirSync(s.paths.tmpDir()), [], 'temporary copies removed');
    done();
  });
});

test('refuses what it cannot compare and reports a failed analyzer plainly', function (t, done) {
  var s = setup('acc-errors');
  var tf = truthFile(s, { size: 1, oshash: '0123456789abcdef' });
  s.acc.run(ITEM.id, tf, function (err) {
    assert.strictEqual(err, 'noSkip', 'nothing scanned yet');
    s.skips.replace(ITEM.id, doc(PRED), false);
    var bad = path.join(s.dir, 'bad.json');
    fs.writeFileSync(bad, '{"format":"x"}');
    s.acc.run(ITEM.id, bad, function (err2) {
      assert.strictEqual(err2, 'invalidSkip');
      s.acc.run(ITEM.id, tf, function (err3, res) {
        assert.ifError(err3);
        assert.strictEqual(res.sameCopy, false, 'made for another copy: the screen warns');
        var s2 = setup('acc-fail', ['--fail-code', '5']);
        s2.skips.replace(ITEM.id, doc(PRED), false);
        s2.acc.run(ITEM.id, truthFile(s2), function (err4) {
          assert.strictEqual(err4, 'evalFailed');
          assert.strictEqual(s2.library.get(ITEM.id).accuracy, undefined);
          done();
        });
      });
    });
  });
});

var py = childProcess.spawnSync('python3', ['-c', 'import bonis_analyzer.evaluate'], { cwd: path.join(ROOT, 'analyzer') });
test('the fake evaluate matches the Python analyzer on the shared fixtures', { skip: py.status === 0 ? false : 'Python analyzer not importable' }, function () {
  var dir = h.tmpDir('acc-parity');
  var pairs = [['full', 'reviewed'], ['reviewed', 'full'], ['overlap', 'offset-positive'], ['movie-3h', 'full'], ['edl-edges', 'minimal']];
  pairs.forEach(function (pair) {
    var tr = path.join(ROOT, 'spec', 'fixtures', 'valid', pair[0] + '.bonis.json');
    var pr = path.join(ROOT, 'spec', 'fixtures', 'valid', pair[1] + '.bonis.json');
    var js = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fake-analyzer.js'), 'evaluate', '--truth', tr, '--pred', pr, '--out', path.join(dir, 'js.json')], { encoding: 'utf8' });
    var p = childProcess.spawnSync('python3', ['-m', 'bonis_analyzer.cli', 'evaluate', '--truth', tr, '--pred', pr, '--out', path.join(dir, 'py.json')], { encoding: 'utf8', cwd: path.join(ROOT, 'analyzer') });
    assert.strictEqual(js.status, 0);
    assert.strictEqual(p.status, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'js.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(dir, 'py.json'), 'utf8')), pair.join(' vs '));
    assert.strictEqual(js.stdout, p.stdout, 'same markdown for ' + pair.join(' vs '));
  });
});
