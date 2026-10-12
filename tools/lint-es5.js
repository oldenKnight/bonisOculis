/*
 * bonis oculis - ES5 syntax guard.
 *
 *   node tools/lint-es5.js [dir|file ...]   default: shared desktop player
 *
 * Scans .js files for ES2015+ syntax outside strings, comments and regular
 * expression literals: arrow functions, const, let, template literals,
 * class, async, spread/rest, optional chaining and nullish coalescing.
 * Prints "file:line:col  rule  source" for each hit and exits 1 if any.
 * Tokenizer-light: strings, comments, regexes and template literals are
 * blanked (newlines kept) before the rules run on what is left.
 * Vendored third-party code (any path with a `vendor` folder) is exempt.
 * ES5, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var RULES = [
  { name: 'arrow function', re: /=>/g },
  { name: 'const', re: /(^|[^.\w$])const(?=\s)/g },
  { name: 'let', re: /(^|[^.\w$])let(?=\s)/g },
  { name: 'class', re: /(^|[^.\w$])class(?=\s)/g },
  { name: 'async', re: /(^|[^.\w$])async(?=\s)/g },
  { name: 'spread/rest', re: /\.\.\./g },
  { name: 'optional chaining', re: /\?\.(?![0-9])/g },
  { name: 'nullish coalescing', re: /\?\?/g }
];

var REGEX_PREFIX = '(,=:[!&|?{};+-*%<>~^';
var REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof'];

function blank(ch) { return ch === '\n' ? '\n' : ' '; }

/* Previous significant code character / word, to tell a regex from a division. */
function regexAllowed(out) {
  var i = out.length - 1, word = '';
  while (i >= 0 && /\s/.test(out[i])) { i--; }
  if (i < 0) { return true; }
  if (REGEX_PREFIX.indexOf(out[i]) >= 0) { return true; }
  while (i >= 0 && /[\w$]/.test(out[i])) { word = out[i] + word; i--; }
  return REGEX_KEYWORDS.indexOf(word) >= 0;
}

/*
 * Returns { code: text with non-code blanked, templates: [offsets of `] }.
 */
function strip(src) {
  var out = [], i = 0, n = src.length, ch, next, quote, inClass, templates = [];
  while (i < n) {
    ch = src.charAt(i);
    next = src.charAt(i + 1);
    if (ch === '/' && next === '/') {
      while (i < n && src.charAt(i) !== '\n') { out.push(' '); i++; }
    } else if (ch === '/' && next === '*') {
      out.push(' ', ' '); i += 2;
      while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) { out.push(blank(src.charAt(i))); i++; }
      if (i < n) { out.push(' ', ' '); i += 2; }
    } else if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      if (quote === '`') { templates.push(i); }
      out.push(quote === '`' ? '`' : ' '); i++;
      while (i < n) {
        ch = src.charAt(i);
        if (ch === '\\') { out.push(' ', blank(src.charAt(i + 1))); i += 2; continue; }
        if (ch === quote || (ch === '\n' && quote !== '`')) { break; }
        out.push(blank(ch)); i++;
      }
      if (i < n && src.charAt(i) === quote) { out.push(' '); i++; }
    } else if (ch === '/' && regexAllowed(out)) {
      out.push(' '); i++;
      inClass = false;
      while (i < n && src.charAt(i) !== '\n') {
        ch = src.charAt(i);
        if (ch === '\\') { out.push(' ', ' '); i += 2; continue; }
        if (ch === '[') { inClass = true; } else if (ch === ']') { inClass = false; } else if (ch === '/' && !inClass) { break; }
        out.push(' '); i++;
      }
      if (i < n && src.charAt(i) === '/') { out.push(' '); i++; }
    } else {
      out.push(ch); i++;
    }
  }
  return { code: out.join(''), templates: templates };
}

function lineCol(src, offset) {
  var line = 1, col = 1, i;
  for (i = 0; i < offset; i++) {
    if (src.charAt(i) === '\n') { line++; col = 1; } else { col++; }
  }
  return { line: line, col: col };
}

/* scanSource(text) -> [{line, col, rule}] sorted by position. */
function scanSource(src) {
  var res = strip(src), hits = [], r, m, at, i, lc;
  for (i = 0; i < res.templates.length; i++) {
    lc = lineCol(src, res.templates[i]);
    hits.push({ line: lc.line, col: lc.col, rule: 'template literal', at: res.templates[i] });
  }
  for (r = 0; r < RULES.length; r++) {
    RULES[r].re.lastIndex = 0;
    while ((m = RULES[r].re.exec(res.code)) !== null) {
      at = m.index + (m[1] ? m[1].length : 0);
      lc = lineCol(src, at);
      hits.push({ line: lc.line, col: lc.col, rule: RULES[r].name, at: at });
      if (m[0].length === 0) { RULES[r].re.lastIndex++; }
    }
  }
  hits.sort(function (a, b) { return a.at - b.at; });
  return hits.map(function (h) { return { line: h.line, col: h.col, rule: h.rule }; });
}

/* Third-party files copied verbatim (e.g. extension/vendor/) are not ours to lint. */
function isVendor(file) { return file.split(path.sep).join('/').split('/').indexOf('vendor') >= 0; }

function listJs(target, acc) {
  var st, names, i;
  try { st = fs.statSync(target); } catch (e) { return acc; }
  if (st.isFile()) {
    if (/\.js$/.test(target) && !isVendor(target)) { acc.push(target); }
    return acc;
  }
  if (!st.isDirectory()) { return acc; }
  names = fs.readdirSync(target).sort();
  for (i = 0; i < names.length; i++) {
    if (names[i] === 'node_modules' || names[i] === 'vendor' || names[i].charAt(0) === '.') { continue; }
    listJs(path.join(target, names[i]), acc);
  }
  return acc;
}

function main(argv) {
  var root = path.join(__dirname, '..');
  var targets = argv.length ? argv : ['shared', 'desktop', 'player'];
  var files = [], i, j, src, hits, lines, total = 0;
  for (i = 0; i < targets.length; i++) { listJs(path.resolve(root, targets[i]), files); }
  for (i = 0; i < files.length; i++) {
    src = fs.readFileSync(files[i], 'utf8');
    hits = scanSource(src);
    if (!hits.length) { continue; }
    lines = src.split('\n');
    for (j = 0; j < hits.length; j++) {
      process.stdout.write(path.relative(root, files[i]) + ':' + hits[j].line + ':' + hits[j].col + '  ' +
        hits[j].rule + '  ' + lines[hits[j].line - 1].trim().slice(0, 100) + '\n');
    }
    total += hits.length;
  }
  if (total) {
    process.stdout.write(total + ' ES2015+ construct(s) in ' + files.length + ' file(s) scanned\n');
    return 1;
  }
  process.stdout.write('es5 ok: ' + files.length + ' file(s)\n');
  return 0;
}

module.exports = { scanSource: scanSource, strip: strip, isVendor: isVendor };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
