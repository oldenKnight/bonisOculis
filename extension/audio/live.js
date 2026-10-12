/*
 * bonis oculis - live listening, pure parts (BO.live). ES5, no DOM, no Web
 * Audio: the offscreen document feeds it samples, the node unit tests feed it
 * synthetic sine waves, noise, silence and score streams.
 *
 *   downmix(channels)            planar Float32Arrays -> one mono Float32Array
 *   createResampler(in, out)     streaming windowed-sinc resampler (any ratio),
 *                                low-pass at 0.92 x the output Nyquist so a
 *                                48 kHz tab is not aliased into 0-8 kHz
 *   createWindower(opts)         keeps the last 0.96 s at 16 kHz and offers a
 *                                window every 0.48 s of audio (YAMNet's frame)
 *   createHysteresis(opts)       cover / release decisions from mapped scores:
 *                                cover when sex >= 0.5 or gore >= 0.6 on two
 *                                consecutive windows; release at the first
 *                                window 3 s or more after the last window at or
 *                                above half the threshold
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.live) { return; }

  var RATE = 16000;
  var WINDOW = 15360;   /* 0.96 s at 16 kHz */
  var HOP = 7680;       /* 0.48 s at 16 kHz */

  /* ------------------------------------------------------------------ */
  /* downmix                                                             */
  /* ------------------------------------------------------------------ */

  function downmix(channels) {
    var n = channels.length, len, out, i, c, s;
    if (!n) { return new Float32Array(0); }
    len = channels[0].length;
    if (n === 1) { return new Float32Array(channels[0]); }
    out = new Float32Array(len);
    for (i = 0; i < len; i++) {
      s = 0;
      for (c = 0; c < n; c++) { s += channels[c][i]; }
      out[i] = s / n;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* resampler                                                           */
  /* ------------------------------------------------------------------ */

  var PHASES = 256;     /* kernel table resolution per input sample */
  var ZEROS = 8;        /* sinc zero crossings on each side */

  /*
   * Output sample k sits at input position k * step (step = inRate/outRate)
   * and is sum_n x[n] * h(k * step - n), h = Blackman-windowed sinc with
   * cutoff fc (cycles per input sample). The input before the stream start
   * counts as silence; process() returns every output sample whose kernel is
   * fully inside the input seen so far (latency: `half` input samples).
   */
  function createResampler(inRate, outRate) {
    var step = inRate / outRate;
    var fc = 0.5 * Math.min(1, outRate / inRate) * 0.92;
    var half = Math.ceil(ZEROS / (2 * fc));
    var table = new Float32Array(2 * half * PHASES + 2);
    var buf = new Float32Array(4096);
    var bufLen = 0;
    var base = -half;       /* absolute input index of buf[0] */
    var pos = 0;            /* absolute input position of the next output sample */
    var produced = 0;
    var i, x, w;

    for (i = 0; i < table.length; i++) {
      x = i / PHASES - half;
      w = Math.abs(x) >= half ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x / half) + 0.08 * Math.cos(2 * Math.PI * x / half);
      table[i] = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w;
    }
    /* history starts with `half` zeros so the first outputs see silence before t = 0 */
    bufLen = half;

    function kernel(d) {
      var f = (d + half) * PHASES, j = Math.floor(f), a = f - j;
      if (j < 0 || j >= table.length - 1) { return 0; }
      return table[j] + (table[j + 1] - table[j]) * a;
    }

    function append(input) {
      var need = bufLen + input.length, nb;
      if (need > buf.length) {
        nb = new Float32Array(Math.max(need, buf.length * 2));
        nb.set(buf.subarray(0, bufLen));
        buf = nb;
      }
      buf.set(input, bufLen);
      bufLen += input.length;
    }

    function run() {
      var out = [], center, n0, n1, n, s, keep;
      while (true) {
        center = Math.floor(pos);
        n1 = center + half;               /* last input index the kernel needs */
        if (n1 >= base + bufLen) { break; }
        n0 = center - half + 1;
        s = 0;
        for (n = n0; n <= n1; n++) { s += buf[n - base] * kernel(pos - n); }
        out.push(s);
        produced++;
        pos = produced * step;
      }
      /* drop input no future output needs */
      keep = Math.floor(pos) - half + 1 - base;
      if (keep > 0 && keep <= bufLen) {
        buf.copyWithin(0, keep, bufLen);
        bufLen -= keep;
        base += keep;
      }
      return new Float32Array(out);
    }

    function process(input) {
      if (input && input.length) { append(input); }
      return run();
    }

    /* end of stream: pad with silence so the last input samples come out */
    function flush() {
      append(new Float32Array(half + Math.ceil(step) + 1));
      return run();
    }

    return { process: process, flush: flush, half: half, cutoffHz: fc * inRate, inRate: inRate, outRate: outRate };
  }

  /* ------------------------------------------------------------------ */
  /* windower                                                            */
  /* ------------------------------------------------------------------ */

  /* push(samples16k, onWindow(window Float32Array, endTimeSeconds)) */
  function createWindower(opts) {
    var o = opts || {};
    var size = o.window || WINDOW, hop = o.hop || HOP, rate = o.rate || RATE;
    var ring = new Float32Array(size);
    var filled = 0, write = 0, sinceHop = 0, total = 0;

    function snapshot() {
      var w = new Float32Array(size);
      w.set(ring.subarray(write), 0);
      w.set(ring.subarray(0, write), size - write);
      return w;
    }

    function push(samples, onWindow) {
      var i;
      for (i = 0; i < samples.length; i++) {
        ring[write] = samples[i];
        write = write + 1 === size ? 0 : write + 1;
        if (filled < size) { filled++; }
        total++;
        sinceHop++;
        if (filled === size && (total === size || sinceHop >= hop)) {
          sinceHop = 0;
          onWindow(snapshot(), total / rate);
        }
      }
    }

    return { push: push, total: function () { return total; } };
  }

  function rms(samples) {
    var s = 0, i;
    for (i = 0; i < samples.length; i++) { s += samples[i] * samples[i]; }
    return samples.length ? Math.sqrt(s / samples.length) : 0;
  }

  /* ------------------------------------------------------------------ */
  /* hysteresis                                                          */
  /* ------------------------------------------------------------------ */

  var DEFAULTS = { on: { sex: 0.5, gore: 0.6 }, consecutive: 2, releaseSec: 3, releaseRatio: 0.5 };

  /*
   * feed({t, sex, gore, ...}) with t in seconds (increasing) ->
   *   null, or an event {cover: true|false, category, score, t}
   * A category arms after `consecutive` windows in a row at or above its
   * threshold. While covered, any window at or above half a threshold
   * ("still loud") restarts the quiet clock; the release comes at the first
   * window whose time is releaseSec or more after the last loud window.
   * After a release every run counter starts from zero, so covering again
   * needs `consecutive` fresh windows (no flapping on a single loud window).
   */
  function createHysteresis(opts) {
    var o = opts || {};
    var on = o.on || DEFAULTS.on;
    var consecutive = o.consecutive || DEFAULTS.consecutive;
    var releaseSec = typeof o.releaseSec === 'number' ? o.releaseSec : DEFAULTS.releaseSec;
    var ratio = typeof o.releaseRatio === 'number' ? o.releaseRatio : DEFAULTS.releaseRatio;
    var cats = Object.keys(on);
    var runs = {};
    var covered = false, category = null, score = 0, lastLoud = -Infinity, lastT = -Infinity;

    function resetRuns() { cats.forEach(function (c) { runs[c] = 0; }); }
    resetRuns();

    function release(t) {
      var ev = { cover: false, category: category, score: Math.round(score * 1000) / 1000, t: t };
      covered = false;
      category = null;
      score = 0;
      resetRuns();
      return ev;
    }

    function feed(frame) {
      var t = Number(frame.t), i, c, v, best = null, bestRatio = 0, loud = false;
      if (!isFinite(t)) { t = lastT === -Infinity ? 0 : lastT; }
      lastT = t;
      for (i = 0; i < cats.length; i++) {
        c = cats[i];
        v = Number(frame[c]) || 0;
        runs[c] = v >= on[c] ? runs[c] + 1 : 0;
        if (v >= on[c] * ratio) { loud = true; }
        if (runs[c] >= consecutive && v / on[c] > bestRatio) { best = c; bestRatio = v / on[c]; }
      }
      if (!covered) {
        if (!best) { return null; }
        covered = true;
        category = best;
        score = Number(frame[best]) || 0;
        lastLoud = t;
        return { cover: true, category: category, score: Math.round(score * 1000) / 1000, t: t };
      }
      if (loud) {
        lastLoud = t;
        for (i = 0; i < cats.length; i++) { v = Number(frame[cats[i]]) || 0; if (cats[i] === category && v > score) { score = v; } }
        return null;
      }
      if (t - lastLoud >= releaseSec - 1e-9) { return release(t); }
      return null;
    }

    /* No window arrived (e.g. the model is busy); time still passes. */
    function idle(t) {
      if (covered && t - lastLoud >= releaseSec - 1e-9) { return release(t); }
      return null;
    }

    /* Stopping always uncovers. */
    function stop() {
      if (covered) { return release(lastT === -Infinity ? 0 : lastT); }
      resetRuns();
      return null;
    }

    function state() { return { covered: covered, category: category, score: score, lastLoud: lastLoud }; }

    return { feed: feed, idle: idle, stop: stop, state: state, releaseSec: releaseSec, on: on };
  }

  BO.live = {
    RATE: RATE,
    WINDOW: WINDOW,
    HOP: HOP,
    DEFAULTS: DEFAULTS,
    downmix: downmix,
    createResampler: createResampler,
    createWindower: createWindower,
    createHysteresis: createHysteresis,
    rms: rms
  };
}(typeof self !== 'undefined' ? self : this));
