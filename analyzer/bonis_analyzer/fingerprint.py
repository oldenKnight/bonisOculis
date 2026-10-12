"""bonis oculis media fingerprint: Python port of shared/fingerprint.js.

oshash = (file size + every little-endian uint64 word of the first 64 KiB
+ every little-endian uint64 word of the last 64 KiB) mod 2^64, as 16
lowercase hex characters (the OpenSubtitles hash). Files shorter than 64 KiB:
head and tail are both the whole file; a trailing partial word is
zero-padded on the high side; an empty file hashes to "0000000000000000".

head_sha256 = SHA-256 of the first 1 MiB (the whole file when shorter).
Standard library only.
"""

from __future__ import annotations

import hashlib
import os
import stat
from typing import BinaryIO, TypedDict

CHUNK = 65536
HEAD_BYTES = 1048576
MASK64 = 0xFFFFFFFFFFFFFFFF


class Fingerprint(TypedDict):
    size: int
    oshash: str
    headSha256: str


def _sum_words(buf: bytes, acc: int) -> int:
    full = len(buf) - len(buf) % 8
    for i in range(0, full, 8):
        acc = (acc + int.from_bytes(buf[i:i + 8], "little")) & MASK64
    if full < len(buf):
        acc = (acc + int.from_bytes(buf[full:].ljust(8, b"\0"), "little")) & MASK64
    return acc


def oshash_from_buffers(size: int, head: bytes, tail: bytes) -> str:
    """Hash from a known size plus the head and tail buffers."""
    acc = size & MASK64
    acc = _sum_words(head, acc)
    acc = _sum_words(tail, acc)
    return "%016x" % acc


def _read_at(f: BinaryIO, position: int, length: int) -> bytes:
    f.seek(position)
    out = b""
    while len(out) < length:
        chunk = f.read(length - len(out))
        if not chunk:
            break
        out += chunk
    return out


def _size_of(f: BinaryIO) -> int:
    st = os.fstat(f.fileno())
    if not stat.S_ISREG(st.st_mode):
        raise OSError("not a regular file")
    return st.st_size


def _oshash_file(f: BinaryIO, size: int) -> str:
    n = min(size, CHUNK)
    return oshash_from_buffers(size, _read_at(f, 0, n), _read_at(f, size - n, n))


def _head_sha256_file(f: BinaryIO, size: int) -> str:
    return hashlib.sha256(_read_at(f, 0, min(size, HEAD_BYTES))).hexdigest()


def oshash(path: str | os.PathLike[str]) -> str:
    with open(path, "rb") as f:
        return _oshash_file(f, _size_of(f))


def head_sha256(path: str | os.PathLike[str]) -> str:
    with open(path, "rb") as f:
        return _head_sha256_file(f, _size_of(f))


def fingerprint(path: str | os.PathLike[str]) -> Fingerprint:
    with open(path, "rb") as f:
        size = _size_of(f)
        return {"size": size, "oshash": _oshash_file(f, size), "headSha256": _head_sha256_file(f, size)}


__all__ = ["oshash", "head_sha256", "fingerprint", "oshash_from_buffers", "Fingerprint"]
