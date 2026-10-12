"""The `scan` command: stages subtitles -> frames -> lm -> fusion -> output
-> thumbnails, checkpointed in <work> and resumable."""

from __future__ import annotations

import gc
import hashlib
import json
import logging
import math
import os
import signal
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from . import __version__, config, fusion, output
from . import fingerprint as fpmod
from . import models as modelsmod
from .pipeline import checkpoint as ck
from .pipeline import decode, probe, thumbs
from .pipeline.tools import lower_priority
from .protocol import BadInput, Eta, Interrupted, ModelMissing, Protocol
from .signals import frames as framesig
from .signals import lm as lmmod
from .signals import subtitles as subs

log = logging.getLogger("bonis.scan")

KNOWN_STAGES = ("subtitles", "frames", "audio", "speech", "captions")
IMPLEMENTED = ("subtitles", "frames")
CUES_FILE = "subtitles.cues.json"
LM_PARTIAL = "lm.windows.json"
STAGE_FILES = ("subtitles", "frames", "lm", "fusion")


def iso_now() -> str:
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


# --------------------------------------------------------------------------
# argument helpers
# --------------------------------------------------------------------------


def parse_levels(text: Optional[str]) -> Dict[str, str]:
    levels = dict(config.DEFAULT_LEVELS)
    if not text:
        return levels
    try:
        obj = json.loads(text)
    except ValueError as e:
        raise BadInput("--levels is not valid JSON") from e
    if isinstance(obj, str) and obj in config.PRESETS:
        obj = config.PRESETS[obj]
    if not isinstance(obj, dict):
        raise BadInput("--levels must be a JSON object")
    for k, v in obj.items():
        if k not in config.CATEGORIES or v not in config.LEVELS:
            raise BadInput("--levels: bad entry %r: %r" % (k, v))
        levels[k] = v
    return levels


def parse_stages(text: Optional[str], proto: Protocol) -> List[str]:
    names = [s.strip() for s in (text or "subtitles,frames").split(",") if s.strip()]
    for s in names:
        if s not in KNOWN_STAGES:
            raise BadInput("unknown stage %r" % s)
    if not names:
        raise BadInput("--stages is empty")
    return names


def load_scores_from(path: str, n: int) -> Dict[str, Any]:
    """Test hook. JSON: {"signals": {signal: {category: [per-second] | {"segments": [[s, e, v], ...]}}},
    "cuts": [seconds, ...] (optional, added to the decoded cuts)}. A bare
    {signal: {...}} object is accepted too."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise BadInput("--scores-from: cannot read %s" % path) from e
    sigs = raw.get("signals", raw) if isinstance(raw, dict) else None
    if not isinstance(sigs, dict):
        raise BadInput("--scores-from: expected an object")
    out: Dict[str, Dict[str, np.ndarray]] = {}
    for s, per in sigs.items():
        if s == "cuts":
            continue
        if s not in config.SIGNALS or not isinstance(per, dict):
            raise BadInput("--scores-from: unknown signal %r" % s)
        out[s] = {}
        for c, v in per.items():
            if c not in config.CATEGORIES:
                raise BadInput("--scores-from: unknown category %r" % c)
            a = np.zeros(n, dtype=np.float32)
            if isinstance(v, list):
                m = min(n, len(v))
                a[:m] = np.clip(np.asarray(v[:m], dtype=np.float32), 0, 1)
            elif isinstance(v, dict) and isinstance(v.get("segments"), list):
                for seg in v["segments"]:
                    s0, e0, val = float(seg[0]), float(seg[1]), float(seg[2])
                    lo, hi = max(0, int(math.floor(s0))), min(n, max(int(math.ceil(e0)), int(math.floor(s0)) + 1))
                    if hi > lo:
                        a[lo:hi] = np.maximum(a[lo:hi], min(1.0, max(0.0, val)))
            else:
                raise BadInput("--scores-from: %s.%s must be a list or {segments}" % (s, c))
            out[s][c] = a
    cuts = raw.get("cuts") if isinstance(raw, dict) and isinstance(raw.get("signals"), dict) else None
    return {"signals": out, "cuts": [float(c) for c in cuts] if isinstance(cuts, list) else []}


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------


class Scan:
    def __init__(self, args: Any, proto: Protocol, lm_factory: Optional[Callable[[], Any]] = None) -> None:
        self.a = args
        self.proto = proto
        self.lm_factory = lm_factory
        self.started = iso_now()
        self.device = "cpu"
        self.stage_meta: Dict[str, Dict[str, Any]] = {}

    # helpers -----------------------------------------------------------------
    def warn(self, msg: str) -> None:
        log.warning(msg)
        self.proto.warn(msg)

    def _stage_begin(self, name: str, **extra: Any) -> float:
        self.proto.stage(name, "running", **extra)
        self.ckpt.set_stage(name, "running", **{k: v for k, v in extra.items() if k in ("resumeAt",)})
        return time.monotonic()

    def _stage_end(self, name: str, status: str, t0: Optional[float], **fields: Any) -> None:
        st = self.ckpt.stage(name)
        secs = float(st.get("seconds") or 0.0) + (time.monotonic() - t0 if t0 else 0.0)
        self.ckpt.set_stage(name, status, progress=1.0 if status == "done" else st.get("progress", 0.0),
                            seconds=round(secs, 2), resumeAt=None, **fields)
        if status == "done":
            self.proto.progress(name, 1.0, 0, force=True)
        self.proto.stage(name, status)

    # main ---------------------------------------------------------------------
    def run(self) -> str:
        a = self.a
        if getattr(a, "priority", "low") == "low":
            lower_priority()
        if not a.input or not os.path.isfile(a.input):
            raise BadInput("input file not found")
        if not a.out:
            raise BadInput("--out is required")
        if not a.work:
            raise BadInput("--work is required")
        self.levels = parse_levels(a.levels)
        self.stages = parse_stages(a.stages, self.proto)
        self.threads = max(1, int(a.threads or 1))
        self.media = probe.probe(a.input)
        self.fp = dict(fpmod.fingerprint(a.input))
        self.n = fusion.seconds_count(self.media["duration"])
        self.duration = float(self.media["duration"]) or float(self.n)
        self.fed = None
        fed_hash = None
        if a.scores_from:
            self.fed = load_scores_from(a.scores_from, self.n)
            with open(a.scores_from, "rb") as f:
                fed_hash = hashlib.sha256(f.read()).hexdigest()[:16]
        key = {"oshash": self.fp["oshash"], "size": self.fp["size"], "lang": a.lang, "analyzer": __version__,
               "modelSet": config.MODEL_SET, "scoresFrom": fed_hash}
        self.ckpt = ck.Checkpoint(a.work)
        if self.ckpt.open(key, restart=bool(a.restart)):
            log.info("resuming previous scan in work dir")
        self.pauser = ck.Pauser(self.ckpt, self.proto)
        self.models_dir = modelsmod.models_dir(getattr(a, "models", None))
        for s in self.stages:
            if s not in IMPLEMENTED:
                self.stage_meta[s] = {"status": "skipped", "detail": "Not available in this version."}
                self.proto.stage(s, "skipped")

        kw, cues = self.stage_subtitles() if "subtitles" in self.stages else (None, [])
        frame_arrays, cuts = self.stage_frames() if "frames" in self.stages else (None, [])
        lm_arrays = self.stage_lm(kw, frame_arrays, cues) if kw is not None else None

        # fusion -------------------------------------------------------------
        t0 = self._stage_begin("fusion")
        signals: Dict[str, Dict[str, Any]] = {}
        if frame_arrays is not None:
            signals["frames"] = {c: frame_arrays[c] for c in config.VISUAL_CATEGORIES if c in frame_arrays}
        if kw is not None:
            sub = {c: np.asarray(kw[c], dtype=np.float32) for c in config.CATEGORIES if c in kw}
            if lm_arrays is not None:
                for c in config.LM_CATEGORIES:
                    if c in lm_arrays:
                        sub[c] = np.maximum(sub.get(c, np.zeros(self.n, np.float32)),
                                            config.LM_WEIGHT * lm_arrays[c]).astype(np.float32)
            signals["subtitles"] = sub
        if self.fed:
            for s, per in self.fed["signals"].items():
                signals[s] = dict(per)
            cuts = sorted(set(cuts) | set(self.fed["cuts"]))
        ranges = fusion.fuse(signals, cuts, self.duration, self.levels, a.lang)
        comb = {c: fusion.combine(signals, c, self.n).astype(np.float32) for c in config.CATEGORIES}
        self.ckpt.save_arrays("fusion", comb)
        self._stage_end("fusion", "done", t0)
        self.stage_meta["fusion"] = {"status": "done", "progress": 1.0, "seconds": self.ckpt.stage("fusion").get("seconds")}

        # output ------------------------------------------------------------
        stages_doc = self._stages_doc()
        complete = ("frames" in self.stages and stages_doc.get("frames", {}).get("status") == "done"
                    and stages_doc.get("subtitles", {}).get("status") in ("done", "skipped"))
        doc = output.build_doc(self.media, self.fp, cuts, ranges, a.lang, self.levels, stages_doc,
                               "complete" if complete else "partial", self.proto.warnings, self.started,
                               iso_now(), self.device)
        final = output.write_skipfile(a.out, doc)
        if "frames" in self.stages:
            thumbs.make_thumbs(self.media["path"], self.ckpt.work, output.thumb_ranges(final), self.duration)
        self.ckpt.set_stage("output", "done", noArrays=True)
        self.ckpt.cleanup_after_done(STAGE_FILES)
        return os.path.abspath(a.out)

    def _stages_doc(self) -> Dict[str, Dict[str, Any]]:
        out = {}
        for name in ("subtitles", "frames"):
            if name not in self.stages:
                continue
            st = dict(self.ckpt.stage(name))
            st.update(self.stage_meta.get(name, {}))
            if name == "subtitles":
                lm = self.ckpt.state["stages"].get("lm")
                if lm:
                    st["seconds"] = float(st.get("seconds") or 0) + float(lm.get("seconds") or 0)
                    if lm.get("status") == "done":
                        st["model"] = "keywords+" + os.path.splitext(config.LM_FILE)[0]
            out[name] = st
        for name, meta in self.stage_meta.items():
            out.setdefault(name, meta)
        return out

    # subtitles ------------------------------------------------------------------
    def _cues(self) -> List[Dict[str, Any]]:
        cues = self.ckpt.read_json(CUES_FILE)
        if isinstance(cues, list):
            return cues
        cues, _ = subs.load_best(self.media, self.media["path"], self.a.lang)
        return cues

    def stage_subtitles(self) -> Any:
        name = "subtitles"
        if self.ckpt.is_done(name):
            st = self.ckpt.stage(name)
            self.proto.stage(name, st["status"])
            if st["status"] == "skipped":
                return None, []
            cues = [] if self.ckpt.is_done("lm") else self._cues()
            return self.ckpt.load_arrays(name), cues
        t0 = self._stage_begin(name)
        self.proto.progress(name, 0.0, force=True)
        cues, cand = subs.load_best(self.media, self.media["path"], self.a.lang, self.warn)
        if not cues:
            self.warn("No readable subtitles were found; dialogue was not checked.")
            self.ckpt.set_stage(name, "skipped", detail="No readable subtitles.", noArrays=True)
            self.stage_meta[name] = {"status": "skipped", "detail": "No readable subtitles."}
            self._stage_end(name, "skipped", t0)
            return None, []
        lang = lang_tag = subs.lang_family((cand or {}).get("language") or "")
        if not lang:
            lang = subs.guess_language(cues, self.a.lang)
        lex = subs.get_lexicon(lang)
        arrays = subs.score_cues(cues, lex, self.duration)
        self.ckpt.write_json(CUES_FILE, cues)
        self.ckpt.save_arrays(name, arrays)
        detail = "%s subtitles (%s), %d cues" % ((cand or {}).get("kind", "?"), lang_tag or lang + "?", len(cues))
        self._stage_end(name, "done", t0, detail=detail, model="keywords-" + lex.language, lexicon=lex.language)
        return self.ckpt.load_arrays(name), cues

    # frames ------------------------------------------------------------------------
    def _frame_scorer(self) -> Any:
        if self.fed is not None:
            return framesig.FedFrameScorer(self.fed["signals"].get("frames", {}))
        make, used = modelsmod.session_factory(self.threads, self.a.device, self.warn)
        self.device = used
        return framesig.ModelFrameScorer(self.models_dir, make)

    def stage_frames(self) -> Any:
        name = "frames"
        n = self.n
        if self.ckpt.is_done(name):
            arr = self.ckpt.load_arrays(name) or {}
            self.proto.stage(name, "done")
            self.device = self.ckpt.stage(name).get("device", self.device)
            return arr, [float(c) for c in arr.get("cuts", [])]
        st = self.ckpt.stage(name)
        prev = self.ckpt.load_arrays(name) if st.get("resumeAt") else None
        resume_at = float(st.get("resumeAt") or 0.0)
        if prev is None or any(len(prev.get(c, [])) != n for c in config.VISUAL_CATEGORIES):
            prev, resume_at = None, 0.0
        arrays = {c: (prev[c].astype(np.float32) if prev is not None else np.zeros(n, np.float32))
                  for c in config.VISUAL_CATEGORIES}
        cuts: List[float] = [float(c) for c in (prev or {}).get("cuts", []) if float(c) < resume_at]
        models = {"scorer": self._frame_scorer()}  # dropped in finally (one stage, one model set)
        t0 = self._stage_begin(name, resumeAt=resume_at)
        if resume_at > 0:
            log.info("frames: resuming at %.0f s", resume_at)
        delay = float(os.environ.get("BONIS_TEST_FRAME_DELAY", "0") or 0) if self.fed is not None else 0.0
        v = self.media["video"]
        dec = decode.Decoder(self.media["path"], v["width"], v["height"],
                             start_at=max(0.0, resume_at - config.RESUME_PREROLL) if resume_at > 0 else 0.0,
                             skip_before=resume_at, threads=self.threads,
                             hwaccel=os.environ.get("BONIS_NO_HWACCEL") != "1")
        eta = Eta(resume_at / max(1, n))
        batch: List[Any] = []
        state = {"done_until": resume_at, "next_flush": resume_at + config.CHECKPOINT_EVERY, "first": None,
                 "count": 0}

        def score_pending() -> None:
            if not batch:
                return
            res = models["scorer"].score_batch(batch)
            for (t, _), sc in zip(batch, res):
                i = int(round(t))
                if 0 <= i < n:
                    for c, val in sc.items():
                        if c in arrays:
                            arrays[c][i] = max(0.0, min(1.0, float(val)))
                state["done_until"] = max(state["done_until"], t + 1.0)
            state["count"] += len(batch)
            batch.clear()

        def flush() -> None:
            score_pending()
            ru = min(float(n), state["done_until"])
            allc = sorted(set(cuts) | set(dec.sorted_cuts()))
            save = dict(arrays)
            save["cuts"] = np.asarray([c for c in allc if c < ru], dtype=np.float64)
            self.ckpt.save_arrays(name, save)
            p = ru / max(1, n)
            self.ckpt.set_stage(name, "running", resumeAt=ru, progress=round(p, 4), device=self.device)

        self.pauser.on_pause = flush
        try:
            for t, fr in dec:
                self.pauser.check()
                if state["first"] is None:
                    state["first"] = t
                    log.info("frames: first frame at %.1f s", t)
                if delay:
                    time.sleep(delay)
                batch.append((t, fr))
                if len(batch) >= config.FRAME_BATCH:
                    score_pending()
                if t + 1.0 >= state["next_flush"]:
                    flush()
                    state["next_flush"] += config.CHECKPOINT_EVERY
                p = (t + 1.0) / max(1, n)
                self.proto.progress(name, p, eta(p))
            score_pending()
        finally:
            self.pauser.on_pause = None
            dec.close()
            models["scorer"].close()
            models["scorer"] = None
            gc.collect()
        allc = sorted(set(cuts) | set(dec.sorted_cuts()))
        final_cuts: List[float] = []
        for c in allc:
            if not final_cuts or c - final_cuts[-1] > config.CUT_DEDUPE:
                final_cuts.append(c)
        save = dict(arrays)
        save["cuts"] = np.asarray(final_cuts, dtype=np.float64)
        self.ckpt.save_arrays(name, save)
        model = "scores-from" if self.fed is not None else "nudenet-320n+clip-vit-b32-int8"
        self.ckpt.stage(name)["framesThisRun"] = state["count"]
        self.ckpt.stage(name)["firstFrameThisRun"] = state["first"]
        self._stage_end(name, "done", t0, model=model, device=self.device,
                        detail="%d scene cuts" % len(final_cuts))
        log.info("frames: %d frames this run, first at %s", state["count"], state["first"])
        return arrays, final_cuts

    # lm --------------------------------------------------------------------------------
    def _make_lm(self) -> Any:
        if self.lm_factory is not None:
            return self.lm_factory()
        if self.fed is not None:
            return None
        if not lmmod.available():
            self.warn("The dialogue model is not installed; dialogue was checked with keywords only.")
            return None
        path = os.path.join(self.models_dir, config.LM_FILE)
        if not os.path.isfile(path):
            self.warn("The dialogue model file is missing; dialogue was checked with keywords only.")
            return None
        gpu = False
        if (self.a.device or "auto") != "cpu":
            try:
                import llama_cpp  # noqa: PLC0415

                gpu = bool(llama_cpp.llama_supports_gpu_offload())
            except Exception:  # noqa: BLE001
                gpu = False
        return lmmod.LlamaLM(path, threads=self.threads, gpu=gpu)

    def stage_lm(self, kw: Dict[str, np.ndarray], frame_arrays: Optional[Dict[str, np.ndarray]],
                 cues: List[Dict[str, Any]]) -> Optional[Dict[str, np.ndarray]]:
        name = "lm"
        if self.ckpt.is_done(name):
            self.proto.stage(name, self.ckpt.stage(name)["status"])
            return self.ckpt.load_arrays(name) if self.ckpt.stage(name)["status"] == "done" else None
        if not cues:
            cues = self._cues()
        t0 = self._stage_begin(name)
        lm = None
        try:
            lm = self._make_lm()
            if lm is None:
                self.ckpt.set_stage(name, "skipped", noArrays=True)
                self._stage_end(name, "skipped", t0)
                return None
            lex = subs.get_lexicon(self.ckpt.stage("subtitles").get("lexicon", self.a.lang))
            starts = lmmod.window_starts(self.duration)
            texts: Dict[int, str] = {}
            index = {s: i for i, s in enumerate(starts)}

            def has_text(s: float) -> bool:
                i = index[s]
                if i not in texts:
                    texts[i] = subs.window_texts(cues, lex, s, config.LM_WINDOW, config.LM_MAX_CHARS)
                return bool(texts[i])

            sel = lmmod.select_windows(starts, kw, frame_arrays, self.n, has_text)
            done = self.ckpt.read_json(LM_PARTIAL) or {}
            scores: Dict[int, Dict[str, float]] = {int(k): v for k, v in done.items()}
            eta = Eta(len(scores) / max(1, len(sel)))
            failed = 0
            for j, i in enumerate(sel):
                if i in scores:
                    continue
                self.pauser.check()
                try:
                    scores[i] = lm.score(texts[i])
                except Exception as e:  # noqa: BLE001 - one bad window must not stop the scan
                    failed += 1
                    log.warning("lm window failed: %s", e)
                    scores[i] = {}
                if (j + 1) % 10 == 0:
                    self.ckpt.write_json(LM_PARTIAL, {str(k): v for k, v in scores.items()})
                p = (j + 1) / max(1, len(sel))
                self.proto.progress(name, p, eta(p))
            if failed:
                self.warn("The dialogue model could not read %d parts of the film." % failed)
            arrays = lmmod.spread(starts, scores, self.n)
            self.ckpt.save_arrays(name, arrays)
            self._stage_end(name, "done", t0, detail="%d of %d windows" % (len(sel), len(starts)))
            return arrays
        finally:
            if lm is not None:
                lm.close()
            del lm
            gc.collect()


def install_signal_handlers() -> None:
    def handler(signum: int, frame: Any) -> None:  # noqa: ARG001
        raise Interrupted("scan interrupted (signal %d); it will resume from the checkpoint" % signum)

    for name in ("SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass


__all__ = ["Scan", "parse_levels", "parse_stages", "load_scores_from", "install_signal_handlers", "ModelMissing"]
