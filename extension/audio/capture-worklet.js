/*
 * bonis oculis - AudioWorklet processor for live listening. ES5 syntax (the
 * processor class is built with Reflect.construct instead of `class`).
 * Downmixes the input to mono and posts it to the offscreen document in
 * blocks of 2048 samples at the context's own rate. It does not change the
 * sound and has no audible output (its output stays silent).
 */
'use strict';

var BLOCK = 2048;

function BoCapture() {
  var self = Reflect.construct(AudioWorkletProcessor, [], BoCapture);
  self.buf = new Float32Array(BLOCK);
  self.n = 0;
  self.stopped = false;
  self.port.onmessage = function (e) { if (e.data === 'stop') { self.stopped = true; } };
  return self;
}
BoCapture.prototype = Object.create(AudioWorkletProcessor.prototype);
BoCapture.prototype.constructor = BoCapture;
Object.setPrototypeOf(BoCapture, AudioWorkletProcessor);

BoCapture.prototype.process = function (inputs) {
  var input = inputs[0], ch, len, i, c, s;
  if (this.stopped) { return false; }
  if (!input || !input.length) { return true; }
  ch = input.length;
  len = input[0].length;
  for (i = 0; i < len; i++) {
    s = 0;
    for (c = 0; c < ch; c++) { s += input[c][i]; }
    this.buf[this.n++] = s / ch;
    if (this.n === BLOCK) {
      this.port.postMessage(this.buf, [this.buf.buffer]);
      this.buf = new Float32Array(BLOCK);
      this.n = 0;
    }
  }
  return true;
};

registerProcessor('bo-capture', BoCapture);
