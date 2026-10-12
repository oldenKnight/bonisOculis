"""Pure-Python ONNX wire-format fix for merged decoders (no `onnx` package).

ONNX Runtime >= 1.2x rejects a model whose If-branch subgraph returns a value
from the outer scope directly ("Subgraph output (X) is an outer scope value
being returned directly"). The q4f16 Florence-2 merged decoder
(``decoder_model_merged_q4f16.onnx``) trips it: its fp16 conversion renamed the
values the branches compute to ``graph_output_cast_<k>`` (the If node's own
output names, then Cast back to float32 outside) but left the branch outputs
named ``logits`` / ``present.*``, which now only exist in the outer graph
(downstream of the If itself, so the model is really cyclic).

Fix, per branch output k whose name is not produced inside the branch:
1. if the branch does produce the If node's k-th output name, the branch
   output is renamed to it (the intended wiring) and its stale declared type
   (float32 for what is a float16 value) is dropped so ORT infers it;
2. otherwise (a genuine outer-scope pass-through) the remedy ORT suggests:
   ``Identity(X) -> X__bo_id`` inside the branch, output renamed.
If outputs are positional, so nothing else changes.

The model bytes are edited in memory (the shipped file keeps its manifest
sha256); only the few messages on the path to the If node are re-encoded,
every other field (weights included) is copied as an opaque byte slice.
Field numbers are from onnx.proto3 (ModelProto.graph=7; GraphProto.node=1,
initializer=5, input=11, output=12; NodeProto.input=1, output=2, op_type=4,
attribute=5; AttributeProto.g=6, graphs=11; ValueInfoProto.name=1;
TensorProto.name=8).
"""

from __future__ import annotations

from typing import List, Optional, Set, Tuple

Field = Tuple[int, int, bytes]  # (field number, wire type, raw payload: varint bytes or length-delimited body)

SUFFIX = "__bo_id"


def _varint(buf: bytes, i: int) -> Tuple[int, int]:
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7
        if shift > 63:
            raise ValueError("bad varint")


def _enc_varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def parse(buf: bytes) -> List[Field]:
    """Top-level fields of one message (memoryview slices are copied lazily)."""
    mv = memoryview(buf)
    out: List[Field] = []
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            j = i
            _, i = _varint(buf, i)
            out.append((num, wt, bytes(mv[j:i])))
        elif wt == 1:
            out.append((num, wt, bytes(mv[i:i + 8])))
            i += 8
        elif wt == 2:
            ln, i = _varint(buf, i)
            out.append((num, wt, mv[i:i + ln]))  # type: ignore[arg-type]
            i += ln
        elif wt == 5:
            out.append((num, wt, bytes(mv[i:i + 4])))
            i += 4
        else:
            raise ValueError("unsupported wire type %d" % wt)
    if i != n:
        raise ValueError("truncated message")
    return out


def encode(fields: List[Field]) -> bytes:
    parts: List[bytes] = []
    for num, wt, payload in fields:
        parts.append(_enc_varint((num << 3) | wt))
        if wt == 2:
            parts.append(_enc_varint(len(payload)))
        parts.append(bytes(payload) if not isinstance(payload, bytes) else payload)
    return b"".join(parts)


def _strings(fields: List[Field], num: int) -> List[str]:
    return [bytes(p).decode("utf-8") for f, wt, p in fields if f == num and wt == 2]


def _name_of(msg: bytes, num: int) -> Optional[str]:
    for f, wt, p in parse(msg):
        if f == num and wt == 2:
            return bytes(p).decode("utf-8")
    return None


def _str_field(num: int, s: str) -> Field:
    return (num, 2, s.encode("utf-8"))


def fix_graph(graph: bytes, outer: Set[str], parent_outputs: Optional[List[str]] = None) -> Tuple[bytes, int]:
    """Fix nested If branches in ``graph`` (a GraphProto body). ``outer`` holds
    names visible from enclosing scopes; ``parent_outputs`` the output names of
    the node owning this subgraph. Returns (bytes, number of fixes)."""
    fields = parse(graph)
    local: Set[str] = set()
    for f, wt, p in fields:
        if f == 1:  # node outputs
            local.update(_strings(parse(bytes(p)), 2))
        elif f == 5:  # initializer names
            nm = _name_of(bytes(p), 8)
            if nm:
                local.add(nm)
        elif f == 11:  # graph inputs
            nm = _name_of(bytes(p), 1)
            if nm:
                local.add(nm)
    visible = outer | local
    fixes = 0
    new_fields: List[Field] = []
    for f, wt, p in fields:
        if f == 1:
            node = parse(bytes(p))
            node_outputs = _strings(node, 2)
            changed = False
            new_node: List[Field] = []
            for nf, nwt, np_ in node:
                if nf == 5:  # attribute: recurse into graph-valued ones
                    attr = parse(bytes(np_))
                    new_attr: List[Field] = []
                    achanged = False
                    for af, awt, ap in attr:
                        if af in (6, 11) and awt == 2:
                            sub, k = fix_graph(bytes(ap), visible, node_outputs)
                            if k:
                                fixes += k
                                achanged = True
                                new_attr.append((af, awt, sub))
                                continue
                        new_attr.append((af, awt, ap))
                    if achanged:
                        changed = True
                        new_node.append((nf, nwt, encode(new_attr)))
                        continue
                new_node.append((nf, nwt, np_))
            new_fields.append((f, wt, encode(new_node) if changed else p))
        else:
            new_fields.append((f, wt, p))
    if outer:
        # this is a subgraph: outputs that are not produced locally get an Identity
        extra: List[Field] = []
        out_fields: List[Field] = []
        k_out = -1
        for f, wt, p in new_fields:
            if f == 12:
                k_out += 1
                vi = parse(bytes(p))
                nm = None
                for vf, vwt, vp in vi:
                    if vf == 1:
                        nm = bytes(vp).decode("utf-8")
                if nm is not None and nm not in local:
                    want = parent_outputs[k_out] if parent_outputs and k_out < len(parent_outputs) else None
                    if want and want in local:
                        new = want
                        # the declared type is the pre-conversion one (float32 for a float16
                        # value): drop it and let ORT infer the type from the producer
                        vi = [x for x in vi if x[0] != 2]
                    else:
                        new = nm + SUFFIX
                        node = [_str_field(1, nm), _str_field(2, new), _str_field(3, "bo_identity_" + nm),
                                _str_field(4, "Identity")]
                        extra.append((1, 2, encode(node)))
                    vi = [(vf, vwt, new.encode("utf-8")) if vf == 1 else (vf, vwt, vp) for vf, vwt, vp in vi]
                    out_fields.append((f, wt, encode(vi)))
                    fixes += 1
                    continue
            out_fields.append((f, wt, p))
        if extra:
            # nodes first (field order does not matter in protobuf, but keep nodes together)
            last_node = max((i for i, x in enumerate(out_fields) if x[0] == 1), default=-1)
            out_fields = out_fields[:last_node + 1] + extra + out_fields[last_node + 1:]
        new_fields = out_fields
    if not fixes:
        return graph, 0
    return encode(new_fields), fixes


def fix_model(model: bytes) -> Tuple[bytes, int]:
    """Return (possibly rewritten model bytes, number of Identity nodes added)."""
    fields = parse(model)
    total = 0
    out: List[Field] = []
    for f, wt, p in fields:
        if f == 7 and wt == 2:
            g, k = fix_graph(bytes(p), set())
            total += k
            out.append((f, wt, g))
        else:
            out.append((f, wt, p))
    if not total:
        return model, 0
    return encode(out), total
