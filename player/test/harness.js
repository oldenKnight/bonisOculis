'use strict';
// Test harness for the real mpv + bonis.lua + controller stack. Synthetic media only: a 60 s
// colour-bar video generated with ffmpeg into a scratch directory, plus fixture skip files.

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var controller = require('../../desktop/main/player-controller.js');

var MPV = process.env.BONIS_MPV || '/usr/bin/mpv';
var FFMPEG = process.env.BONIS_FFMPEG || '/usr/bin/ffmpeg';
var SCRATCH = process.env.BONIS_TEST_DIR || path.join(os.tmpdir(), 'bonis-oculis-test');
var VIDEO = path.join(SCRATCH, 'bars-60s.mp4');

var counter = 0;

function available() {
  return fs.existsSync(MPV) && fs.existsSync(FFMPEG);
}

function ensureScratch() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return SCRATCH;
}

// 60 s, 320x180, 25 fps colour bars with a 440 Hz tone; keyframe every second.
function ensureVideo() {
  ensureScratch();
  if (fs.existsSync(VIDEO) && fs.statSync(VIDEO).size > 100000) { return VIDEO; }
  var tmp = VIDEO + '.' + process.pid + '.tmp.mp4';
  childProcess.execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
    '-c:a', 'aac', '-shortest', tmp
  ], { stdio: 'ignore' });
  fs.renameSync(tmp, VIDEO);
  return VIDEO;
}

var created = [];

// Every per-test file is named <base>-<pid>-<n>*; all of them are removed when the process exits.
var FFPROBE = process.env.BONIS_FFPROBE || path.join(path.dirname(FFMPEG), 'ffprobe');

function ffmpeg(args) {
  childProcess.execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: 'ignore' });
}

// ffprobe's format.start_time: skip-file time 0 (desktop/main/probe.js convention).
function probeStart(file) {
  var out = childProcess.execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=start_time',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  var v = parseFloat(out);
  return isFinite(v) ? v : 0;
}

function probeDuration(file) {
  var out = childProcess.execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  var v = parseFloat(out);
  return isFinite(v) ? v : 0;
}

function cached(name, build) {
  var p = path.join(SCRATCH, 'fx-' + name);
  if (!fs.existsSync(p)) {
    var tmp = path.join(SCRATCH, 'tmp-' + process.pid + '-' + name);
    build(tmp);
    fs.renameSync(tmp, p);
  }
  return { name: name, file: p, start: probeStart(p), duration: probeDuration(p) };
}

// Board review 3 fixtures:
//   f24.mp4:  24 fps, start 0 (frames at k/24; a range ending at 10.004 ends just after a frame)
//   mid.ts:   MPEG-TS cut mid-GOP (2 s GOP): first shown frame ~1.05 s after format.start_time
//   lead.ts:  MPEG-TS whose audio leads video by 1.5 s
function ensureReview3Fixtures() {
  var base = ensureVideo();
  return {
    f24: cached('f24.mp4', function (out) {
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-bf', '2', '-c:a', 'aac', '-shortest', '-f', 'mp4', out]);
    }),
    mid: cached('mid.ts', function (out) {
      var src = out + '.src.ts';
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-bf', '2', '-c:a', 'aac', '-shortest', '-f', 'mpegts', src]);
      ffmpeg(['-i', src, '-ss', '11.0', '-c', 'copy', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', out]);
      fs.unlinkSync(src);
    }),
    lead: cached('lead.ts', function (out) {
      ffmpeg(['-i', base, '-itsoffset', '1.5', '-i', base, '-map', '1:v', '-map', '0:a', '-c', 'copy',
        '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', out]);
    })
  };
}

// Same colour bars on four timelines (board review 2, N1):
//   mp4-601: MP4 remuxed with -copyts from a TS starting at 601.4 s (edit list; mpv keeps 601.x)
//   mkv-neg: MKV with B-frames + AAC priming, start -0.021 s
//   ts-1.4:  MPEG-TS starting at 1.4 s (mpv rebases it)
//   mp4-0:   the plain MP4, start 0 (control)
function ensureTimelineFixtures() {
  var base = ensureVideo();
  function make(name, build) {
    var p = path.join(SCRATCH, 'timeline-' + name);
    if (!fs.existsSync(p)) {
      var tmp = path.join(SCRATCH, 'tmp-' + process.pid + '-' + name);
      build(tmp);
      fs.renameSync(tmp, p);
    }
    return { name: name, file: p, start: probeStart(p), duration: probeDuration(p) };
  }
  return [
    make('mp4-601.mp4', function (out) {
      var ts = out + '.ts';
      ffmpeg(['-i', base, '-c', 'copy', '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', '601.4', '-f', 'mpegts', ts]);
      ffmpeg(['-copyts', '-i', ts, '-c', 'copy', '-f', 'mp4', out]);
      fs.unlinkSync(ts);
    }),
    make('mkv-neg.mkv', function (out) {
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '25', '-c:a', 'aac', '-shortest', '-f', 'matroska', out]);
    }),
    make('ts-1.4.ts', function (out) {
      ffmpeg(['-i', base, '-c', 'copy', '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', '1.4', '-f', 'mpegts', out]);
    }),
    { name: 'mp4-0', file: base, start: probeStart(base), duration: probeDuration(base) }
  ];
}

function uniqueName(base) {
  counter += 1;
  var p = path.join(SCRATCH, base + '-' + process.pid + '-' + counter);
  created.push(p);
  return p;
}

process.on('exit', function () {
  var names;
  try { names = fs.readdirSync(SCRATCH); } catch (e) { return; }
  created.forEach(function (p) {
    var base = path.basename(p);
    names.forEach(function (n) {
      if (n === base || n.indexOf(base + '.') === 0) {
        try { fs.rmSync(path.join(SCRATCH, n), { recursive: true, force: true }); } catch (e2) { /* ignore */ }
      }
    });
  });
});

function range(id, start, end, action, extra) {
  var r = {
    id: id, start: start, end: end, category: 'nudity', confidence: 0.9,
    action: action, source: 'auto', review: 'pending'
  };
  var k;
  for (k in (extra || {})) { if (Object.prototype.hasOwnProperty.call(extra, k)) { r[k] = extra[k]; } }
  return r;
}

function skipDoc(ranges, opts) {
  var o = opts || {};
  var media = {
    title: 'Colour bars', duration: 60,
    fingerprint: { size: 1, oshash: '0000000000000001' }
  };
  if (o.offset !== undefined) { media.offset = o.offset; }
  return {
    format: 'bonis-oculis-skip', version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    created: '2026-10-12T00:00:00Z', modified: '2026-10-12T00:00:00Z',
    generator: { app: 'bonis-oculis-test', appVersion: '0.0.0' },
    media: media,
    scan: { status: o.scanStatus || 'complete' },
    ranges: ranges
  };
}

function writeSkip(base, ranges, opts) {
  ensureScratch();
  var p = uniqueName(base) + '.bonis.json';
  fs.writeFileSync(p, JSON.stringify(skipDoc(ranges, opts), null, 2));
  return p;
}

function writeRaw(base, text) {
  ensureScratch();
  var p = uniqueName(base) + '.bonis.json';
  fs.writeFileSync(p, text);
  return p;
}

// The standard fixture: skip 10-15, hide 20-25, mute 30-33, blur 40-43, rejected skip 45-50.
function standardRanges() {
  return [
    range('rskip0001', 10, 15, 'skip'),
    range('rhide0001', 20, 25, 'hide'),
    range('rmute0001', 30, 33, 'mute', { category: 'language' }),
    range('rblur0001', 40, 43, 'blur'),
    range('rrejected1', 45, 50, 'skip', { review: 'rejected' }),
    range('rnone00001', 52, 54, 'none')
  ];
}

// A controller wired for tests plus a recorder of everything it emits. Each time-pos sample
// carries a snapshot of the watched properties at that moment.
function startRecorder(extra) {
  var e = extra || {};
  var player = controller.createPlayer({
    mpvPath: MPV,
    vo: 'null',
    ao: 'null',
    timeposHz: e.timeposHz || 1000,
    observe: ['mute', 'vf', 'user-data/bonis', 'user-data/bonis-osd'].concat(e.observe || []),
    extraArgs: ['--really-quiet', '--speed=' + (e.speed || 4)].concat(e.extraArgs || [])
  });
  var rec = {
    player: player, events: [], samples: [], transitions: [], osd: [],
    state: { mute: null, vf: null, bonis: null },
    waiters: []
  };
  function check() {
    var i;
    for (i = rec.waiters.length - 1; i >= 0; i--) {
      var w = rec.waiters[i];
      var hit = false;
      try { hit = w.pred(rec); } catch (err) { hit = false; }
      if (hit) {
        rec.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(rec);
      }
    }
  }
  ['ready', 'mark', 'panic', 'skipped', 'timepos', 'ended', 'crashed', 'error'].forEach(function (name) {
    player.on(name, function (payload) {
      rec.events.push({ name: name, data: payload, at: Date.now() });
      check();
    });
  });
  player.on('property', function (p) {
    if (p.name === 'mute') { rec.state.mute = p.data; }
    if (p.name === 'vf') { rec.state.vf = p.data; }
    if (p.name === 'user-data/bonis-osd' && p.data && p.data.text) { rec.osd.push(p.data.text); }
    if (p.name === 'user-data/bonis') {
      rec.state.bonis = p.data;
      if (p.data) {
        var tr = {};
        Object.keys(p.data).forEach(function (k) { tr[k] = p.data[k]; });
        tr.wall = Date.now();
        rec.transitions.push(tr);
      }
    }
    // Samples start once every watched property has reported its initial value.
    if (p.name === 'time-pos' && typeof p.data === 'number' && rec.state.mute !== null &&
        rec.state.vf !== null && rec.state.bonis !== null) {
      var b = rec.state.bonis || {};
      rec.samples.push({
        t: p.data, mute: rec.state.mute, vf: rec.state.vf,
        black: !!b.black, blur: !!b.blur, panic: !!b.panic, at: Date.now()
      });
    }
    check();
  });
  rec.waitFor = function (pred, ms, label) {
    return new Promise(function (resolve, reject) {
      var w = { pred: pred, resolve: resolve };
      w.timer = setTimeout(function () {
        var idx = rec.waiters.indexOf(w);
        if (idx >= 0) { rec.waiters.splice(idx, 1); }
        reject(new Error('timeout waiting for ' + (label || 'condition') + '; last t=' +
          (rec.samples.length ? rec.samples[rec.samples.length - 1].t : 'none') +
          ' events=' + rec.events.filter(function (ev) { return ev.name !== 'timepos'; })
            .map(function (ev) { return ev.name; }).join(',')));
      }, ms || 10000);
      rec.waiters.push(w);
      check();
    });
  };
  rec.waitTime = function (t, ms) {
    return rec.waitFor(function (r) {
      return r.samples.length > 0 && r.samples[r.samples.length - 1].t >= t;
    }, ms, 'time-pos >= ' + t);
  };
  rec.waitEvent = function (name, ms, filter) {
    return rec.waitFor(function (r) {
      return r.events.some(function (ev) { return ev.name === name && (!filter || filter(ev.data)); });
    }, ms, 'event ' + name);
  };
  rec.eventsOf = function (name) {
    return rec.events.filter(function (ev) { return ev.name === name; }).map(function (ev) { return ev.data; });
  };
  rec.play = function (media, skip, options) {
    return new Promise(function (resolve, reject) {
      player.play(media, skip, options || {}, function (err) {
        if (err) { reject(err); } else { resolve(rec); }
      });
    });
  };
  rec.cmd = function (args) {
    return new Promise(function (resolve, reject) {
      player.command(args, function (err, data) { if (err) { reject(err); } else { resolve(data); } });
    });
  };
  rec.stop = function () {
    return new Promise(function (resolve) { player.stop(function () { resolve(); }); });
  };
  // Waits for a sample, recorded after index `from`, that satisfies pred.
  rec.waitSampleAfter = function (from, pred, ms, label) {
    return rec.waitFor(function (r) { return r.samples.slice(from).some(pred); }, ms, label);
  };
  // Script-side truth: the user-data/bonis state in force at playback position t (each change
  // carries the position at which it took effect, so IPC delivery lag does not matter).
  rec.stateAt = function (t) {
    var i;
    var found = null;
    for (i = 0; i < rec.transitions.length; i++) {
      // a change published before playback started has no position: it is in force from the start
      var at = typeof rec.transitions[i].at === 'number' ? rec.transitions[i].at : -Infinity;
      if (at <= t) { found = rec.transitions[i]; }
    }
    return found;
  };
  rec.between = function (lo, hi) {
    return rec.samples.filter(function (s) { return s.t >= lo && s.t < hi; });
  };
  return rec;
}

function readLines(file) {
  if (!fs.existsSync(file)) { return []; }
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

module.exports = {
  MPV: MPV,
  FFMPEG: FFMPEG,
  SCRATCH: SCRATCH,
  available: available,
  ensureVideo: ensureVideo,
  ensureTimelineFixtures: ensureTimelineFixtures,
  ensureReview3Fixtures: ensureReview3Fixtures,
  probeDuration: probeDuration,
  probeStart: probeStart,
  uniqueName: uniqueName,
  range: range,
  skipDoc: skipDoc,
  writeSkip: writeSkip,
  writeRaw: writeRaw,
  standardRanges: standardRanges,
  startRecorder: startRecorder,
  readLines: readLines,
  delay: delay
};
