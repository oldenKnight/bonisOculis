'use strict';
// In-app help: loads docs/HELP/<lang>.md (or the licence inventory) and converts a small Markdown
// subset to HTML for the renderer: # ## ### headings (with ids; '## Title {#id}' sets one), paragraphs, - and 1. lists,
// > notes, | tables |, ---, **bold**, `code`, [text](#anchor). Links to anything but an anchor are
// shown as plain text: the help never opens remote content. Everything is HTML-escaped first.

var fs = require('fs');
var path = require('path');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slug(text) {
  var s = String(text).toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'section';
}

function inline(text) {
  var s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
    if (/^#[a-z0-9-]+$/.test(href)) { return '<a href="' + href + '" data-help-anchor="' + href.slice(1) + '">' + label + '</a>'; }
    return '<span class="bo-help__ext">' + label + '</span>';
  });
  return s;
}

function render(md) {
  var lines = String(md).replace(/\r\n/g, '\n').split('\n');
  var html = [];
  var toc = [];
  var para = [];
  var list = null;
  var used = {};
  var title = null;
  var i = 0;

  function flushPara() {
    if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  }
  function flushList() {
    if (list) {
      html.push('<' + list.tag + ' class="bo-help__list"' + (list.start > 1 ? ' start="' + list.start + '"' : '') + '>' + list.items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</' + list.tag + '>');
      list = null;
    }
  }
  function flush() { flushPara(); flushList(); }

  while (i < lines.length) {
    var line = lines[i];
    var m;
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      var level = m[1].length;
      var explicit = /\s*\{#([a-z0-9-]+)\}\s*$/.exec(m[2]);
      if (explicit) { m[2] = m[2].slice(0, explicit.index); }
      var id = explicit ? explicit[1] : slug(m[2]);
      while (used[id]) { id += '-x'; }
      used[id] = true;
      if (level === 1 && title === null) { title = m[2]; i++; continue; }
      if (level > 1) { toc.push({ id: id, text: m[2], level: level }); }
      html.push('<h' + level + ' id="' + id + '" tabindex="-1">' + inline(m[2]) + '</h' + level + '>');
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) { flush(); html.push('<hr>'); i++; continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      var q = [m[1]];
      i++;
      while (i < lines.length && (m = /^>\s?(.*)$/.exec(lines[i]))) { q.push(m[1]); i++; }
      html.push('<div class="bo-notice"><p>' + inline(q.join(' ')) + '</p></div>');
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      var rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      var cells = rows.map(function (r) { return r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); });
      var body = cells.filter(function (c, k) { return !(k === 1 && c.every(function (x) { return /^:?-{2,}:?$/.test(x); })); });
      var head = body.shift() || [];
      html.push('<div class="bo-help__table-wrap"><table class="bo-help__table"><thead><tr>' + head.map(function (c) { return '<th scope="col">' + inline(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
      continue;
    }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      var tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      // A numbered list keeps its first number (steps 3-5 after a heading stay 3-5).
      if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [], start: tag === 'ol' ? parseInt(/\d+/.exec(line)[0], 10) : 1 }; }
      list.items.push(m[1]);
      i++;
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); i++; continue; }
    flushList();
    para.push(line.trim());
    i++;
  }
  flush();
  return { title: title, html: html.join('\n'), toc: toc };
}

function createHelp(options) {
  var o = options || {};
  var paths = o.paths;
  var cache = {};

  // doc: 'help' | 'licenses'
  function get(lang, doc) {
    var file = doc === 'licenses' ? paths.licensesFile() : path.join(paths.helpDir(), (lang === 'es-MX' ? 'es-MX' : 'en-US') + '.md');
    if (cache[file]) { return cache[file]; }
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { html: '', toc: [], missing: true }; }
    cache[file] = render(text);
    return cache[file];
  }

  return { get: get };
}

module.exports = { createHelp: createHelp, render: render, slug: slug };
