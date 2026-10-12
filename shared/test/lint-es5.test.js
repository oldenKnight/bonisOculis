'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var lint = require('../../tools/lint-es5.js');

function rules(src) { return lint.scanSource(src).map(function (h) { return h.line + ':' + h.rule; }); }

test('lint flags ES2015+ syntax in code', function () {
  assert.deepStrictEqual(rules('var f = (a) => a;'), ['1:arrow function']);
  assert.deepStrictEqual(rules('const a = 1;\nlet b = 2;'), ['1:const', '2:let']);
  assert.deepStrictEqual(rules('var s = `x${y}`;'), ['1:template literal']);
  assert.deepStrictEqual(rules('class A {}\nasync function f() {}'), ['1:class', '2:async']);
  assert.deepStrictEqual(rules('f(...args);\nvar x = a?.b;\nvar y = a ?? b;'), ['1:spread/rest', '2:optional chaining', '3:nullish coalescing']);
});

test('lint ignores strings, comments, regexes and look-alikes', function () {
  assert.deepStrictEqual(rules([
    "var a = 'const x => `y` ...';",
    'var b = "let ?? ?.";',
    '// const class async =>',
    '/* let x = `z` */',
    'var re = /=>|`|\\.\\.\\.|[/]/g;',
    'var c = x ? .5 : 1;',
    'var d = obj.class + obj.let;',
    'var className = 1, constant = 2, letter = 3;',
    'var e = a / b / c;',
    "var f = 'it\\'s => fine';"
  ].join('\n')), []);
});

test('shared/ and tools/ are ES5', function () {
  ['shared', 'tools'].forEach(function (d) {
    var root = path.join(__dirname, '..', '..', d);
    (function walk(p) {
      if (fs.statSync(p).isDirectory()) {
        fs.readdirSync(p).forEach(function (n) { walk(path.join(p, n)); });
      } else if (/\.js$/.test(p)) {
        assert.deepStrictEqual(rules(fs.readFileSync(p, 'utf8')), [], p);
      }
    }(root));
  });
});
