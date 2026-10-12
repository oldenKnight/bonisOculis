'use strict';
// `node --test player/test` (package.json) resolves this directory to index.js on Node 22, which
// does not expand directories. Load every *.test.js file here so the npm script runs them all.
var fs = require('fs');
var path = require('path');

fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f); }).sort().forEach(function (f) {
  require(path.join(__dirname, f));
});
