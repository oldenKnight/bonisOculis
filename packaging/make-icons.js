/*
 * bonis oculis - render the app icons from desktop/renderer/assets/logo-mark.svg.
 *
 *   node packaging/make-icons.js [--chromium /path/to/chrome]
 *
 * docs/DESIGN.md: "The app icon is the mark in #FAF8F4 on a #0B555D rounded square (22% corner
 * radius), 1024 master". Two masters are drawn as SVG from the mark's own path:
 *   - tile: the rounded square fills the canvas (Windows .ico, Linux PNGs)
 *   - mac:  the rounded square is 824/1024 of the canvas, centred, as macOS app icons are
 *           drawn on Apple's grid (otherwise the icon looks oversized in the Dock)
 * Chromium (Playwright, a devDependency) rasterises every size from the vector, so small sizes
 * are rendered, not downscaled. The .ico and .icns containers are written here: both simply
 * hold PNGs (ICO with PNG entries: Windows Vista+; ICNS ic07-ic14/icp4/icp5: macOS 10.7+).
 *
 * Output (committed; regenerate only when the mark changes):
 *   packaging/icons/png/<n>x<n>.png  n = 16 24 32 48 64 128 256 512 1024 (tile)
 *   packaging/icons/mac-1024.png      mac master
 *   packaging/icons/icon.ico          16 24 32 48 64 128 256
 *   packaging/icons/icon.icns         16 32 64 128 256 512 1024
 *
 * ES5, CommonJS. Needs the playwright package and a Chromium (PLAYWRIGHT_BROWSERS_PATH, or
 * --chromium / $BONIS_CHROMIUM for an explicit executable).
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(__dirname, 'icons');
var MARK = path.join(ROOT, 'desktop', 'renderer', 'assets', 'logo-mark.svg');
var TEAL = '#0B555D';
var PAPER = '#FAF8F4';
var PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
var ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/* ICNS element types holding PNG data, by pixel size. */
var ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['icp6', 64], ['ic12', 64], ['ic07', 128],
  ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024]
];

function markPath() {
  var svg = fs.readFileSync(MARK, 'utf8');
  var m = /<path[^>]*\sd="([^"]+)"/.exec(svg);
  if (!m) { throw new Error('no <path d> in ' + MARK); }
  return m[1];
}

/* SVG source of one master. tileFrac = side of the rounded square / canvas. */
function iconSvg(tileFrac) {
  var c = 1024, side = c * tileFrac, off = (c - side) / 2, r = side * 0.22;
  // The eye spans x 1..31 of the 32-unit mark; draw it 66% of the tile wide, centred.
  var markSide = side * 0.66, scale = markSide / 30, mx = off + (side - markSide) / 2 - 1 * scale, my = off + (side - 32 * scale) / 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">' +
    '<rect x="' + off + '" y="' + off + '" width="' + side + '" height="' + side + '" rx="' + r + '" ry="' + r + '" fill="' + TEAL + '"/>' +
    '<path fill="' + PAPER + '" fill-rule="evenodd" transform="translate(' + mx.toFixed(3) + ' ' + my.toFixed(3) + ') scale(' + scale.toFixed(5) + ')" d="' + markPath() + '"/>' +
    '</svg>';
}

function findChromium(argv) {
  var i = argv.indexOf('--chromium'), base, dirs, j, p;
  if (i >= 0) { return argv[i + 1]; }
  if (process.env.BONIS_CHROMIUM) { return process.env.BONIS_CHROMIUM; }
  base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { dirs = fs.readdirSync(base).filter(function (d) { return /^chromium-\d+$/.test(d); }).sort().reverse(); } catch (e) { return null; }
  for (j = 0; j < dirs.length; j++) {
    p = path.join(base, dirs[j], 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) { return p; }
  }
  return null;
}

/* PNG IHDR -> {w, h}; throws when not a PNG. */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') { throw new Error('not a PNG'); }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/* ICO: ICONDIR + ICONDIRENTRY[n] + PNG blobs. */
function buildIco(pngs) {
  var n = pngs.length, head = Buffer.alloc(6 + 16 * n), offset = head.length, i, s;
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(n, 4);
  for (i = 0; i < n; i++) {
    s = pngSize(pngs[i]);
    head.writeUInt8(s.w >= 256 ? 0 : s.w, 6 + 16 * i);
    head.writeUInt8(s.h >= 256 ? 0 : s.h, 7 + 16 * i);
    head.writeUInt8(0, 8 + 16 * i);
    head.writeUInt8(0, 9 + 16 * i);
    head.writeUInt16LE(1, 10 + 16 * i);
    head.writeUInt16LE(32, 12 + 16 * i);
    head.writeUInt32LE(pngs[i].length, 14 + 16 * i);
    head.writeUInt32LE(offset, 18 + 16 * i);
    offset += pngs[i].length;
  }
  return Buffer.concat([head].concat(pngs));
}

/* ICNS: 'icns' + total length, then (type, length incl. 8, PNG) elements. */
function buildIcns(elements) {
  var parts = [], total = 8;
  elements.forEach(function (e) {
    var h = Buffer.alloc(8);
    h.write(e.type, 0, 4, 'ascii');
    h.writeUInt32BE(e.png.length + 8, 4);
    parts.push(h, e.png);
    total += e.png.length + 8;
  });
  var head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head].concat(parts));
}

function render(argv, cb) {
  var playwright = require('playwright');
  var exe = findChromium(argv), tile = iconSvg(1), mac = iconSvg(824 / 1024), out = { tile: {}, mac: {} };
  var opts = { headless: true };
  if (exe) { opts.executablePath = exe; }
  playwright.chromium.launch(opts).then(function (browser) {
    return browser.newPage().then(function (page) {
      var jobs = [];
      PNG_SIZES.forEach(function (n) { jobs.push(['tile', tile, n]); jobs.push(['mac', mac, n]); });
      function one(i) {
        var j;
        if (i >= jobs.length) { return browser.close(); }
        j = jobs[i];
        return page.setViewportSize({ width: j[2], height: j[2] }).then(function () {
          return page.setContent('<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:' + j[2] + 'px;height:' + j[2] + 'px}</style></head><body><img src="data:image/svg+xml;base64,' + Buffer.from(j[1]).toString('base64') + '"></body></html>');
        }).then(function () {
          return page.waitForFunction(function () { var im = document.querySelector('img'); return im && im.complete && im.naturalWidth > 0; });
        }).then(function () {
          return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: j[2], height: j[2] } });
        }).then(function (png) {
          out[j[0]][j[2]] = png;
          return one(i + 1);
        });
      }
      return one(0);
    });
  }).then(function () { cb(null, out); }, function (err) { cb(err); });
}

function main(argv) {
  render(argv, function (err, out) {
    if (err) { process.stderr.write('make-icons: ' + (err && err.message) + '\n'); process.exitCode = 1; return; }
    fs.mkdirSync(path.join(OUT, 'png'), { recursive: true });
    PNG_SIZES.forEach(function (n) { fs.writeFileSync(path.join(OUT, 'png', n + 'x' + n + '.png'), out.tile[n]); });
    fs.writeFileSync(path.join(OUT, 'mac-1024.png'), out.mac[1024]);
    fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(ICO_SIZES.map(function (n) { return out.tile[n]; })));
    fs.writeFileSync(path.join(OUT, 'icon.icns'), buildIcns(ICNS_TYPES.map(function (t) { return { type: t[0], png: out.mac[t[1]] }; })));
    process.stdout.write('icons written to ' + path.relative(ROOT, OUT) + '\n');
  });
}

module.exports = { buildIco: buildIco, buildIcns: buildIcns, pngSize: pngSize, iconSvg: iconSvg, ICO_SIZES: ICO_SIZES, ICNS_TYPES: ICNS_TYPES };

if (require.main === module) { main(process.argv.slice(2)); }
