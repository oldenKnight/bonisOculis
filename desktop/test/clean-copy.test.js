'use strict';
// exporters/clean-copy.js on a synthetic testsrc2 video with a 2 s keyframe interval. A side
// panel's brightness encodes the second (16 + 7 * floor(t)), so the test can tell which seconds
// of the source survive in the copy: the result must last exactly the kept seconds (within the
// keyframe snap) and no frame from inside a cut may remain.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var cc = require('../main/exporters/clean-copy.js');

var opts = { skip: h.haveFfmpeg() ? false : 'ffmpeg not installed', timeout: 60000 };
var W = 32, H = 90;

function codedVideo(dir) {
  var file = path.join(dir, 'coded movie.mp4');
  var r = childProcess.spawnSync(h.FFMPEG, ['-v', 'error', '-y', '-filter_complex',
    'testsrc2=s=160x90:r=25:d=30[a];color=c=black:s=' + W + 'x' + H + ':r=25:d=30,geq=lum=\'16+floor(T)*7\':cb=128:cr=128[b];[a][b]hstack=inputs=2[v];sine=f=440:d=30[s]',
    '-map', '[v]', '-map', '[s]', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', file], { stdio: 'ignore' });
  assert.strictEqual(r.status, 0, 'test video');
  return file;
}

function duration(file) {
  var r = childProcess.spawnSync(h.FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout);
}

// Source second of every frame in the file, read from the coded panel.
function secondsIn(file) {
  var r = childProcess.spawnSync(h.FFMPEG, ['-v', 'error', '-i', file, '-vf', 'crop=' + (W - 8) + ':' + (H - 8) + ':164:4,extractplanes=y', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
  var frame = (W - 8) * (H - 8);
  var out = [];
  var i, j, sum;
  for (i = 0; i + frame <= r.stdout.length; i += frame) {
    sum = 0;
    for (j = 0; j < frame; j++) { sum += r.stdout[i + j]; }
    out.push(Math.round((sum / frame - 16) / 7));
  }
  return out;
}

function doc(cuts) {
  return BO.newDoc({
    media: { title: 'Coded', duration: 30, fingerprint: { size: 1, oshash: '0000000000000001' } },
    ranges: cuts.map(function (c, i) { return BO.newRange({ id: 'rcut000' + i, start: c[0], end: c[1], category: 'other', action: c[2] || 'skip', review: 'approved' }); }),
    scan: { status: 'complete' }
  });
}

test('keptSegments snaps inward to keyframes and runs the last part to the end', function () {
  var kfs = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28];
  assert.deepStrictEqual(cc.keptSegments([[5.3, 9.1], [17, 20.5]], 30, kfs), [
    { start: 0, end: 4, toEnd: false }, { start: 10, end: 16, toEnd: false }, { start: 22, end: 30, toEnd: true }
  ]);
  assert.deepStrictEqual(cc.keptSegments([[0, 3]], 30, kfs), [{ start: 4, end: 30, toEnd: true }]);
  assert.deepStrictEqual(cc.keptSegments([[25, 30]], 30, kfs), [{ start: 0, end: 24, toEnd: false }]);
  assert.deepStrictEqual(cc.keptSegments([[4, 5], [4.5, 7]], 30, kfs), [{ start: 0, end: 4, toEnd: false }, { start: 8, end: 30, toEnd: true }], 'overlaps merge');
  assert.deepStrictEqual(cc.keptSegments([[2.5, 3.5]], 30, kfs), [{ start: 0, end: 2, toEnd: false }, { start: 4, end: 30, toEnd: true }]);
});

test('a clean copy keeps exactly the kept seconds and none of the cut ones', opts, function (t, done) {
  var dir = h.tmpDir('clean');
  var src = codedVideo(dir);
  var tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  var progress = [];
  var d = doc([[5.3, 9.1], [17, 20.5, 'mute'], [26, 26.5, 'none']]);
  cc.cleanCopy({ input: src, doc: d, ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, tmpDir: tmp, onProgress: function (p) { progress.push(p); } }, function (err, res) {
    assert.ifError(err);
    assert.strictEqual(path.basename(res.path), 'coded movie (bonis oculis clean).mp4');
    assert.strictEqual(path.dirname(res.path), dir, 'next to the source');
    assert.strictEqual(res.kept, 18, '0-4, 10-16, 22-30');
    var dur = duration(res.path);
    assert.ok(Math.abs(dur - 18) <= 0.25, 'duration ' + dur + ' within keyframe tolerance of 18');
    var secs = secondsIn(res.path);
    var present = {};
    secs.forEach(function (s) { present[s] = (present[s] || 0) + 1; });
    [5, 6, 7, 8, 9, 17, 18, 19, 20].forEach(function (s) { assert.ok(!present[s], 'second ' + s + ' of a cut scene is absent'); });
    [0, 1, 2, 3, 10, 11, 15, 22, 26, 29].forEach(function (s) { assert.ok(present[s] >= 20, 'second ' + s + ' kept'); });
    assert.ok(Math.abs(secs.length - 18 * 25) <= 6, 'frame count ' + secs.length);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], 'temp parts deleted');
    assert.deepStrictEqual(progress[progress.length - 1], { done: 4, total: 4 }, 'progress by parts');
    // A second copy gets a new name, and the AAC switch converts the audio.
    cc.cleanCopy({ input: src, doc: d, ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, tmpDir: tmp, aac: true, outDir: tmp }, function (err2, res2) {
      assert.ifError(err2);
      assert.strictEqual(path.dirname(res2.path), tmp, 'chosen folder');
      var codec = childProcess.spawnSync(h.FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', res2.path], { encoding: 'utf8' }).stdout.trim();
      assert.strictEqual(codec, 'aac');
      done();
    });
  });
});

test('cancel stops the copy and leaves nothing behind', opts, function (t, done) {
  var dir = h.tmpDir('clean-cancel');
  var src = h.testVideo('clean-cancel', 20);
  var copy = path.join(dir, 'movie.mp4');
  fs.copyFileSync(src, copy);
  var tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  var handle = cc.cleanCopy({ input: copy, doc: doc([[3, 5], [8, 9], [12, 13]]), ffmpeg: h.FFMPEG, ffprobe: h.FFPROBE, tmpDir: tmp,
    onProgress: function (p) { if (p.done === 1) { handle.cancel(); } } }, function (err) {
    assert.ok(err);
    assert.strictEqual(err.code, 'cancelled');
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['movie.mp4', 'tmp']);
    done();
  });
});
