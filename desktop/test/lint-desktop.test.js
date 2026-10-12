'use strict';
// ES5 only in the desktop app, its tests and the fake analyzer (brief 1.4, PLAN 0.7).

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var lint = require('../../tools/lint-es5.js');

test('desktop/ and tools/fake-analyzer.js are ES5', function () {
  var root = path.join(__dirname, '..');
  var files = [path.join(__dirname, '..', '..', 'tools', 'fake-analyzer.js')];
  (function walk(p) {
    if (fs.statSync(p).isDirectory()) {
      if (/node_modules$/.test(p)) { return; }
      fs.readdirSync(p).forEach(function (n) { walk(path.join(p, n)); });
    } else if (/\.js$/.test(p)) { files.push(p); }
  }(root));
  files.forEach(function (f) {
    var hits = lint.scanSource(fs.readFileSync(f, 'utf8')).map(function (x) { return x.line + ':' + x.rule; });
    assert.deepStrictEqual(hits, [], f);
  });
});
