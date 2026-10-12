'use strict';
var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var childProcess = require('child_process');

test('committed fixtures equal the generator output (deterministic)', function () {
  var out = childProcess.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'make-fixtures.js'), '--check'],
    { encoding: 'utf8' });
  assert.match(out, /fixtures up to date/);
});
