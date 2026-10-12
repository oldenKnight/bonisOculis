/*
 * bonis oculis - live listening, offscreen document. ES5, callbacks (the
 * vendored ONNX Runtime returns promises; they are turned into callbacks at
 * the two places it is called).
 *
 * One tab at a time:
 *   tab sound (getUserMedia with the stream id the service worker got from
 *   chrome.tabCapture) -> AudioContext
 *        -> gain -> speakers               the tab stays audible; the gain
 *                                          goes to 0 while a scene is covered
 *        -> capture (AudioWorklet, or ScriptProcessor when there is none)
 *           mono blocks -> resampler (16 kHz) -> 0.96 s windows every 0.48 s
 *           -> YAMNet (onnxruntime-web, wasm, one thread)
 *           -> BO.classmap (sex / implied / gore) -> BO.live hysteresis
 *           -> {t: 'liveEvent', cover, category, score} to the service worker
 * At most one inference runs at a time: a window that arrives while the
 * previous one is still being classified is dropped (counted), never queued.
 * A window of digital silence is not classified (its scores are zero).
 * Nothing is stored and nothing leaves the computer: the samples live in
 * memory for one window and are dropped.
 *
 * Test builds only (the test runner marks the manifest's version_name with
 * BO_TEST): 'offTest' classifies an audio file from the local test server
 * (http://127.0.0.1) instead of a tab, and 'offFeed' feeds score windows
 * straight into the hysteresis, so the browser test needs no user gesture.
 */
(function () {
  'use strict';
  var BO = window.BO;
  var live = BO.live;
  var classmap = BO.classmap;
  var MODEL = 'models/yamnet.onnx';
  var SILENT_RMS = 1e-4;
  var STATUS_MS = 5000;
  var LOG_MAX = 400;

  var session = null;
  var loadMs = 0;           /* runtime + model start-up time */
  var loading = null;       /* callbacks waiting for the model */
  var run = null;
  var log = [];
  var events = [];
  var stats = null;

  /* Offscreen documents get only part of chrome.runtime (no getManifest), so
     the service worker, which checks the manifest, vouches for test builds. */
  function isTestBuild(msg) {
    try {
      if (typeof chrome.runtime.getManifest === 'function') { return /BO_TEST/.test(chrome.runtime.getManifest().version_name || ''); }
    } catch (e) { /* not available here */ }
    return !!(msg && msg.testBuild === true);
  }

  function toWorker(msg) {
    try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) { /* worker restarting */ }
  }

  function newStats() {
    return { windows: 0, classified: 0, silent: 0, dropped: 0, totalMs: 0, maxMs: 0, heardAt: 0, startedAt: Date.now(), engine: 'wasm', capture: '' };
  }

  /* ------------------------------------------------------------------ */
  /* model                                                               */
  /* ------------------------------------------------------------------ */

  function loadModel(cb) {
    var ort = window.ort, t0 = Date.now();
    if (session) { cb(null, session); return; }
    if (loading) { loading.push(cb); return; }
    if (!ort) { cb(new Error('runtime missing')); return; }
    loading = [cb];
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
    ort.env.logLevel = 'error';
    ort.InferenceSession.create(chrome.runtime.getURL(MODEL), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }).then(function (s) {
      var waiting = loading;
      session = s;
      loading = null;
      loadMs = Date.now() - t0;
      waiting.forEach(function (f) { f(null, s); });
    }, function (err) {
      var waiting = loading;
      loading = null;
      waiting.forEach(function (f) { f(err || new Error('model failed')); });
    });
  }

  /* window (Float32Array, 15360 samples at 16 kHz) -> cb(err, 521 scores, ms) */
  function infer(win, cb) {
    var ort = window.ort, feeds = {}, t0 = performance.now();
    feeds[session.inputNames[0]] = new ort.Tensor('float32', win, [win.length]);
    session.run(feeds, [session.outputNames[0]]).then(function (out) {
      cb(null, out[session.outputNames[0]].data, performance.now() - t0);
    }, function (err) { cb(err || new Error('inference failed')); });
  }

  /* ------------------------------------------------------------------ */
  /* decisions                                                           */
  /* ------------------------------------------------------------------ */

  function emit(ev) {
    if (!ev || !run) { return; }
    run.covered = ev.cover;
    events.push(ev);
    if (events.length > LOG_MAX) { events.shift(); }
    if (run.gain) { run.gain.gain.setTargetAtTime(ev.cover && run.mode === 'tab' ? 0 : 1, run.ctx.currentTime, 0.015); }
    toWorker({ t: 'liveEvent', tabId: run.tabId, cover: ev.cover, category: ev.category, score: ev.score, at: ev.t, muteElement: run.mode !== 'tab' });
  }

  function record(frame) {
    log.push(frame);
    if (log.length > LOG_MAX) { log.shift(); }
  }

  function onWindow(win, t) {
    var r = run, level = live.rms(win), frame;
    if (!r || r.stopped) { return; }
    stats.windows++;
    if (level < SILENT_RMS) {
      stats.silent++;
      frame = { t: t, sex: 0, implied: 0, gore: 0, silent: true, rms: level };
      record(frame);
      emit(r.hyst.feed(frame));
      return;
    }
    stats.heardAt = Date.now();
    if (r.busy) {
      stats.dropped++;
      emit(r.hyst.idle(t));
      return;
    }
    r.busy = true;
    infer(win, function (err, scores, ms) {
      var m;
      r.busy = false;
      if (r.stopped) { return; }
      if (err) { ended('liveModelFailed'); return; }
      stats.classified++;
      stats.totalMs += ms;
      if (ms > stats.maxMs) { stats.maxMs = ms; }
      m = classmap.map(scores);
      frame = { t: t, sex: m.sex, implied: m.implied, gore: m.gore, ms: Math.round(ms * 10) / 10, rms: Math.round(level * 1e4) / 1e4, n: scores.length, top: classmap.top(scores, 3) };
      record(frame);
      emit(r.hyst.feed(frame));
    });
  }

  function feedMono(mono) {
    var r = run;
    if (!r || r.stopped) { return; }
    r.windower.push(r.resampler.process(mono), onWindow);
  }

  /* ------------------------------------------------------------------ */
  /* audio graph                                                         */
  /* ------------------------------------------------------------------ */

  function attachCapture(r, source, cb) {
    var ctx = r.ctx, sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    r.sink = sink;
    function scriptProcessor() {
      var sp = ctx.createScriptProcessor(4096, 2, 1);
      sp.onaudioprocess = function (e) {
        var b = e.inputBuffer, ch = [], c;
        for (c = 0; c < b.numberOfChannels; c++) { ch.push(b.getChannelData(c)); }
        feedMono(live.downmix(ch));
      };
      source.connect(sp);
      sp.connect(sink);
      r.capture = sp;
      stats.capture = 'ScriptProcessor';
      cb(null);
    }
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') { scriptProcessor(); return; }
    ctx.audioWorklet.addModule(chrome.runtime.getURL('audio/capture-worklet.js')).then(function () {
      var node;
      if (r.stopped) { cb(new Error('stopped')); return; }
      node = new AudioWorkletNode(ctx, 'bo-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = function (e) { feedMono(e.data); };
      source.connect(node);
      node.connect(sink);
      r.capture = node;
      stats.capture = 'AudioWorklet';
      cb(null);
    }, function () { scriptProcessor(); });
  }

  function begin(opts, makeSource, cb) {
    var r;
    stop();
    stats = newStats();
    log = [];
    events = [];
    r = run = {
      tabId: opts.tabId,
      mode: opts.mode,
      stopped: false,
      busy: false,
      covered: false,
      ctx: new AudioContext(),
      hyst: live.createHysteresis(),
      windower: live.createWindower(),
      stream: null,
      element: null,
      statusTimer: null
    };
    r.resampler = live.createResampler(r.ctx.sampleRate, live.RATE);
    loadModel(function (err) {
      if (r.stopped) { cb({ ok: false, error: 'liveStopped' }); return; }
      if (err) { stop(); cb({ ok: false, error: 'liveModelFailed', detail: String(err && err.message || err) }); return; }
      makeSource(r, function (err2, source) {
        if (r.stopped) { cb({ ok: false, error: 'liveStopped' }); return; }
        if (err2 || !source) { stop(); cb({ ok: false, error: err2 && err2.code ? err2.code : 'liveNoCapture', detail: String(err2 && err2.message || err2) }); return; }
        r.gain = r.ctx.createGain();
        source.connect(r.gain);
        r.gain.connect(r.ctx.destination);
        attachCapture(r, source, function (err3) {
          if (err3) { stop(); cb({ ok: false, error: 'liveNoCapture' }); return; }
          try { r.ctx.resume(); } catch (e) { /* already running */ }
          r.statusTimer = setInterval(function () { toWorker({ t: 'liveStatus', tabId: r.tabId, stats: publicStats() }); }, STATUS_MS);
          cb({ ok: true, capture: stats.capture, rate: r.ctx.sampleRate, loadMs: loadMs });
        });
      });
    });
  }

  function tabSource(streamId) {
    return function (r, cb) {
      navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false }).then(function (stream) {
        var tracks = stream.getAudioTracks();
        r.stream = stream;
        if (!tracks.length) { cb({ code: 'liveNoSound' }); return; }
        tracks[0].addEventListener('ended', function () { ended('liveTabGone'); });
        cb(null, r.ctx.createMediaStreamSource(stream));
      }, function (err) { cb({ code: 'liveNoCapture', message: String(err && err.message || err) }); });
    };
  }

  /* Test builds only: an audio file from the local test server. */
  function fileSource(url) {
    return function (r, cb) {
      var a = new Audio(), done = false;
      function once(err, src) { if (!done) { done = true; cb(err, src); } }
      a.crossOrigin = 'anonymous';
      a.preload = 'auto';
      a.addEventListener('error', function () { once({ code: 'liveNoSound' }); });
      a.addEventListener('canplaythrough', function () {
        var src = r.ctx.createMediaElementSource(a);
        a.play().then(function () { once(null, src); }, function (e) { once({ code: 'liveNoSound', message: String(e) }); });
      });
      a.src = url;
      r.element = a;
    };
  }

  /* every URL this document loaded (tests check that none is remote) */
  function resources() {
    try { return performance.getEntriesByType('resource').map(function (e) { return e.name; }).concat([location.href]); } catch (e) { return []; }
  }

  function publicStats() {
    var s = stats || newStats();
    return {
      windows: s.windows, classified: s.classified, silent: s.silent, dropped: s.dropped,
      avgMs: s.classified ? Math.round(s.totalMs / s.classified * 10) / 10 : 0,
      maxMs: Math.round(s.maxMs * 10) / 10,
      heardAgoMs: s.heardAt ? Date.now() - s.heardAt : -1,
      runningMs: Date.now() - s.startedAt,
      capture: s.capture,
      engine: s.engine
    };
  }

  /* Always uncovers: a covered tab gets its release before anything stops. */
  function stop() {
    var r = run, ev;
    if (!r) { return; }
    r.stopped = true;
    run = null;
    if (r.statusTimer) { clearInterval(r.statusTimer); }
    if (r.feedTimer) { clearTimeout(r.feedTimer); }
    ev = r.hyst.stop();
    if (ev) {
      toWorker({ t: 'liveEvent', tabId: r.tabId, cover: false, category: ev.category, score: ev.score, at: ev.t, muteElement: r.mode !== 'tab' });
    }
    try { if (r.capture && r.capture.port) { r.capture.port.postMessage('stop'); } } catch (e) { /* closed */ }
    try { if (r.capture) { r.capture.disconnect(); } } catch (e) { /* closed */ }
    if (r.element) { try { r.element.pause(); r.element.removeAttribute('src'); r.element.load(); } catch (e) { /* gone */ } }
    if (r.stream) { r.stream.getTracks().forEach(function (tr) { try { tr.stop(); } catch (e) { /* stopped */ } }); }
    try { r.ctx.close(); } catch (e) { /* closed */ }
  }

  function ended(reason) {
    var r = run;
    if (!r) { return; }
    stop();
    toWorker({ t: 'liveEnded', tabId: r.tabId, reason: reason });
  }

  /* ------------------------------------------------------------------ */
  /* fed score windows (test builds)                                     */
  /* ------------------------------------------------------------------ */

  function feedFrames(msg, reply) {
    var frames = msg.frames || [], i = 0, every = Math.max(10, Number(msg.intervalMs) || 100), r;
    stop();
    stats = newStats();
    log = [];
    events = [];
    r = run = { tabId: msg.tabId, mode: 'feed', stopped: false, hyst: live.createHysteresis(), feedTimer: null, ctx: { close: function () {} } };
    function next() {
      var f;
      if (r.stopped) { return; }
      if (i >= frames.length) { r.feedTimer = null; return; }
      f = frames[i];
      f = { t: typeof f.t === 'number' ? f.t : (i + 2) * 0.48, sex: Number(f.sex) || 0, implied: Number(f.implied) || 0, gore: Number(f.gore) || 0, fed: true };
      i++;
      stats.windows++;
      stats.heardAt = Date.now();
      record(f);
      emit(r.hyst.feed(f));
      r.feedTimer = setTimeout(next, every);
    }
    reply({ ok: true, frames: frames.length });
    next();
  }

  /* ------------------------------------------------------------------ */
  /* messages                                                            */
  /* ------------------------------------------------------------------ */

  var LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[^?#]*\.(wav|webm|ogg|mp3|m4a)$/;

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== 'offscreen' || sender.id !== chrome.runtime.id) { return false; }
    switch (msg.t) {
      case 'offStart':
        begin({ tabId: msg.tabId, mode: 'tab' }, tabSource(String(msg.streamId || '')), sendResponse);
        return true;
      case 'offStop':
        stop();
        sendResponse({ ok: true, stats: publicStats() });
        return false;
      case 'offStatus':
        sendResponse({ ok: true, running: !!run, tabId: run ? run.tabId : null, mode: run ? run.mode : null, covered: !!(run && run.covered), stats: publicStats() });
        return false;
      case 'offTest':
        if (!isTestBuild(msg) || !LOCAL.test(String(msg.url || ''))) { sendResponse({ ok: false, error: 'notAllowed' }); return false; }
        begin({ tabId: msg.tabId, mode: 'test' }, fileSource(String(msg.url)), sendResponse);
        return true;
      case 'offFeed':
        if (!isTestBuild(msg)) { sendResponse({ ok: false, error: 'notAllowed' }); return false; }
        feedFrames(msg, sendResponse);
        return false;
      case 'offLog':
        if (!isTestBuild(msg)) { sendResponse({ ok: false, error: 'notAllowed' }); return false; }
        sendResponse({ ok: true, frames: log.slice(), events: events.slice(), resources: resources(), stats: publicStats(), running: !!run, covered: !!(run && run.covered) });
        return false;
      default:
        return false;
    }
  });
}());
