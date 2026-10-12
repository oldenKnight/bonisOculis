/*
 * bonis oculis - media fingerprint (Node only, CommonJS, ES5 syntax).
 *
 *   oshash(filePath, cb(err, hex))       OpenSubtitles hash
 *   headSha256(filePath, cb(err, hex))   SHA-256 of the first 1 MiB
 *   fingerprint(filePath, cb(err, {size, oshash, headSha256}))
 *
 * oshash = (file size + every little-endian uint64 word of the first 64 KiB
 * + every little-endian uint64 word of the last 64 KiB) mod 2^64, printed as
 * 16 lowercase hex characters. Files shorter than 64 KiB: the head and the
 * tail are both the whole file. A trailing partial word (file size not a
 * multiple of 8 with a short file) is zero-padded on the high side. An empty
 * file hashes to "0000000000000000".
 *
 * BigInt is used here and only here (the one ES5 exception allowed by the
 * plan); it is only called, never written as a literal.
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');

var CHUNK = 65536;
var HEAD_BYTES = 1048576;

function readAt(fd, position, length, cb) {
  var buf = Buffer.alloc(length);
  var got = 0;
  function step() {
    if (got >= length) { return cb(null, buf); }
    fs.read(fd, buf, got, length - got, position + got, function (err, n) {
      if (err) { return cb(err); }
      if (n === 0) { return cb(null, buf.slice(0, got)); }
      got += n;
      step();
    });
  }
  step();
}

function withFile(filePath, work, cb) {
  fs.open(filePath, 'r', function (err, fd) {
    if (err) { return cb(err); }
    work(fd, function (err2, result) {
      fs.close(fd, function (err3) {
        if (err2) { return cb(err2); }
        if (err3) { return cb(err3); }
        cb(null, result);
      });
    });
  });
}

var MASK64 = BigInt('0xffffffffffffffff');

function sumWords(buf, acc) {
  var full = buf.length - (buf.length % 8), i, last;
  for (i = 0; i < full; i += 8) {
    acc = (acc + buf.readBigUInt64LE(i)) & MASK64;
  }
  if (full < buf.length) {
    last = Buffer.alloc(8);
    buf.copy(last, 0, full);
    acc = (acc + last.readBigUInt64LE(0)) & MASK64;
  }
  return acc;
}

function hex16(big) {
  var s = big.toString(16);
  while (s.length < 16) { s = '0' + s; }
  return s;
}

/* Hash from a known size plus head and tail buffers (exported for tests). */
function oshashFromBuffers(size, head, tail) {
  var acc = BigInt(size) & MASK64;
  acc = sumWords(head, acc);
  acc = sumWords(tail, acc);
  return hex16(acc);
}

function oshashFd(fd, size, cb) {
  var n = size < CHUNK ? size : CHUNK;
  readAt(fd, 0, n, function (err, head) {
    if (err) { return cb(err); }
    readAt(fd, size - n, n, function (err2, tail) {
      if (err2) { return cb(err2); }
      cb(null, oshashFromBuffers(size, head, tail));
    });
  });
}

function headSha256Fd(fd, size, cb) {
  var n = size < HEAD_BYTES ? size : HEAD_BYTES;
  readAt(fd, 0, n, function (err, buf) {
    if (err) { return cb(err); }
    cb(null, crypto.createHash('sha256').update(buf).digest('hex'));
  });
}

function sizeOf(fd, cb) {
  fs.fstat(fd, function (err, st) {
    if (err) { return cb(err); }
    if (!st.isFile()) { return cb(new Error('not a regular file')); }
    cb(null, st.size);
  });
}

function oshash(filePath, cb) {
  withFile(filePath, function (fd, done) {
    sizeOf(fd, function (err, size) {
      if (err) { return done(err); }
      oshashFd(fd, size, done);
    });
  }, cb);
}

function headSha256(filePath, cb) {
  withFile(filePath, function (fd, done) {
    sizeOf(fd, function (err, size) {
      if (err) { return done(err); }
      headSha256Fd(fd, size, done);
    });
  }, cb);
}

function fingerprint(filePath, cb) {
  withFile(filePath, function (fd, done) {
    sizeOf(fd, function (err, size) {
      if (err) { return done(err); }
      oshashFd(fd, size, function (err2, os) {
        if (err2) { return done(err2); }
        headSha256Fd(fd, size, function (err3, sha) {
          if (err3) { return done(err3); }
          done(null, { size: size, oshash: os, headSha256: sha });
        });
      });
    });
  }, cb);
}

module.exports = {
  oshash: oshash,
  headSha256: headSha256,
  fingerprint: fingerprint,
  oshashFromBuffers: oshashFromBuffers
};
