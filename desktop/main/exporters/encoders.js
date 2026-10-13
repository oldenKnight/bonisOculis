'use strict';
// Video encoder choice for the clean copy (LEDGER D24). Probed once per session and per ffmpeg:
//  1. `ffmpeg -hide_banner -encoders` says which encoders this build has.
//  2. A 1-second dry run (testsrc 320x180 -> -f null) proves the encoder works on THIS machine
//     (a build can list h264_nvenc on a computer without an NVIDIA card). 10-bit sources get their
//     own dry run with a 10-bit test picture, so a chip that cannot take 10-bit input falls back.
//  Order: macOS h264_videotoolbox (hevc_videotoolbox first when the source is HEVC and the parent
//  chose "keep HEVC"); Windows h264_qsv -> h264_nvenc -> h264_amf; then libx264 veryfast crf 20,
//  which every shipped build has (verified 2026-10-13: gyan.dev 9.0.2 essentials README lists
//  libx264, h264_qsv, h264_nvenc, h264_amf, aac; Martin Riedl 9.0.2 arm64 + amd64 codecs.txt
//  list libx264, h264_videotoolbox, hevc_videotoolbox, aac).
//  Also probed here: how this ffmpeg reads a filtergraph from a file. FFmpeg 7+ uses
//  `-/filter_complex <file>`; 6.x only knows `-filter_complex_script <file>` (removed later).
// Never throws; callbacks only. ES5.

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var DRY_RUN_MS = 20000;

var cache = { lists: {}, works: {}, script: {} };

function noop() {}

// Runs bin with args; cb(err, code, stdout, stderr). Kills it after ms (if given).
function run(bin, args, ms, cb) {
  var out = '';
  var err = '';
  var done = false;
  var timer = null;
  var proc;
  function finish(e, code) {
    if (done) { return; }
    done = true;
    if (timer) { clearTimeout(timer); }
    cb(e, code, out, err);
  }
  try {
    proc = childProcess.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) { finish(e, -1); return null; }
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', function (d) { if (out.length < 1048576) { out += d; } });
  proc.stderr.on('data', function (d) { if (err.length < 8192) { err += d; } });
  proc.on('error', function (e) { finish(e, -1); });
  proc.on('close', function (code) { finish(null, code); });
  if (ms) {
    timer = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (e) { /* gone */ }
      finish(new Error('timeout'), -1);
    }, ms);
  }
  return proc;
}

// Pure. Encoder names from `ffmpeg -encoders` output.
function parseEncoders(text) {
  var names = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m && m[1] !== '=') { names[m[1]] = true; }
  });
  return names;
}

// cb(err, {name: true})
function listEncoders(ffmpeg, cb) {
  if (cache.lists[ffmpeg]) { cb(null, cache.lists[ffmpeg]); return; }
  run(ffmpeg, ['-hide_banner', '-encoders'], DRY_RUN_MS, function (e, code, out) {
    if (e || code !== 0) { cb(e || new Error('ffmpeg exit ' + code)); return; }
    cache.lists[ffmpeg] = parseEncoders(out);
    cb(null, cache.lists[ffmpeg]);
  });
}

// Pure. Order of hardware encoders to try. platform: process.platform.
function candidates(platform, wantHevc) {
  if (platform === 'darwin') { return wantHevc ? ['hevc_videotoolbox', 'h264_videotoolbox'] : ['h264_videotoolbox']; }
  if (platform === 'win32') { return ['h264_qsv', 'h264_nvenc', 'h264_amf']; }
  return [];
}

// Pure. Target bitrate for hardware encoders (they have no portable constant-quality mode):
// 0.1 bit per pixel per frame, 1-40 Mbit/s. 1080p24 -> ~5 Mbit/s, 720p24 -> ~2.2 Mbit/s.
function bitrate(width, height, fps) {
  var b = (width || 1280) * (height || 720) * (fps > 0 && fps < 200 ? fps : 25) * 0.1;
  return Math.round(Math.min(40e6, Math.max(1e6, b)));
}

// Pure. ffmpeg output arguments for one encoder. v: {width, height, fps, tenBit}
function videoArgs(name, v) {
  var o = v || {};
  var br = String(bitrate(o.width, o.height, o.fps));
  var gop = String(Math.max(12, Math.round((o.fps > 0 && o.fps < 200 ? o.fps : 25) * 4)));
  switch (name) {
    case 'h264_videotoolbox': return ['-c:v', name, '-b:v', br, '-g', gop, '-pix_fmt', 'yuv420p'];
    case 'hevc_videotoolbox': return ['-c:v', name, '-b:v', String(Math.round(br * 0.7)), '-g', gop, '-pix_fmt', o.tenBit ? 'p010le' : 'yuv420p'];
    case 'h264_qsv': return ['-c:v', name, '-preset', 'veryfast', '-b:v', br, '-g', gop, '-pix_fmt', 'nv12'];
    case 'h264_nvenc': return ['-c:v', name, '-preset', 'p4', '-b:v', br, '-g', gop, '-pix_fmt', 'yuv420p'];
    case 'h264_amf': return ['-c:v', name, '-quality', 'speed', '-b:v', br, '-g', gop, '-pix_fmt', 'nv12'];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', gop, '-pix_fmt', 'yuv420p'];
  }
}

function describe(name, tenBit) {
  return {
    name: name,
    hw: name !== 'libx264',
    codec: /^hevc/.test(name) ? 'hevc' : 'h264',
    // Everything but a 10-bit HEVC encode is 8-bit: HDR / 10-bit sources are converted.
    tenBitOut: name === 'hevc_videotoolbox' && !!tenBit,
    args: function (v) { return videoArgs(name, v); }
  };
}

// cb(ok) for a 1 s encode of a test picture.
function dryRun(ffmpeg, name, tenBit, cb) {
  var key = ffmpeg + '|' + name + '|' + (tenBit ? 10 : 8);
  if (key in cache.works) { cb(cache.works[key]); return; }
  var args = ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=25:d=1'];
  if (tenBit) { args.push('-vf', 'format=yuv420p10le'); }
  args = args.concat(videoArgs(name, { width: 320, height: 180, fps: 25, tenBit: tenBit }), ['-f', 'null', '-']);
  run(ffmpeg, args, DRY_RUN_MS, function (e, code) {
    cache.works[key] = !e && code === 0;
    cb(cache.works[key]);
  });
}

// cb(err, encoder) where encoder = {name, hw, codec, tenBitOut, args(v)}.
// opts: {platform?, wantHevc?, tenBit?, candidates? (tests: override the hardware list)}
function pick(ffmpeg, opts, cb) {
  var o = opts || {};
  var done = typeof cb === 'function' ? cb : noop;
  var list = o.candidates || candidates(o.platform || process.platform, !!o.wantHevc);
  listEncoders(ffmpeg, function (err, have) {
    if (err) { done(err); return; }
    var i = 0;
    function next() {
      if (i >= list.length) {
        if (!have.libx264) { done(new Error('noEncoder')); return; }
        dryRun(ffmpeg, 'libx264', false, function (ok) { if (ok) { done(null, describe('libx264', o.tenBit)); } else { done(new Error('noEncoder')); } });
        return;
      }
      var name = list[i++];
      if (!have[name]) { next(); return; }
      dryRun(ffmpeg, name, !!o.tenBit, function (ok) { if (ok) { done(null, describe(name, o.tenBit)); } else { next(); } });
    }
    next();
  });
}

// cb(err, function (file) -> [args]) : how this ffmpeg loads a filtergraph from a file.
function scriptOption(ffmpeg, tmpDir, cb) {
  if (cache.script[ffmpeg]) { cb(null, cache.script[ffmpeg]); return; }
  var file = path.join(tmpDir, 'probe-graph-' + process.pid + '.txt');
  try { fs.writeFileSync(file, '[0:v]null[v]'); } catch (e) { cb(e); return; }
  var flavours = [
    function (f) { return ['-/filter_complex', f]; },
    function (f) { return ['-filter_complex_script', f]; }
  ];
  var i = 0;
  function next() {
    if (i >= flavours.length) { try { fs.unlinkSync(file); } catch (e) { /* gone */ } cb(new Error('noFilterScript')); return; }
    var f = flavours[i++];
    run(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.04'].concat(f(file), ['-map', '[v]', '-f', 'null', '-']), DRY_RUN_MS, function (e, code) {
      if (!e && code === 0) {
        try { fs.unlinkSync(file); } catch (e2) { /* gone */ }
        cache.script[ffmpeg] = f;
        cb(null, f);
        return;
      }
      next();
    });
  }
  next();
}

function resetCache() { cache = { lists: {}, works: {}, script: {} }; }

module.exports = {
  pick: pick, scriptOption: scriptOption, listEncoders: listEncoders, parseEncoders: parseEncoders,
  candidates: candidates, videoArgs: videoArgs, bitrate: bitrate, run: run, resetCache: resetCache
};
