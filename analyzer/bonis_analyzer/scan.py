"""The `scan` command: stages subtitles -> speech -> frames -> audio -> lm ->
captions -> fusion -> output -> thumbnails, checkpointed in <work> and
resumable. One model set is loaded at a time (models.model_set registry)."""

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
from typing import Any, Callable, Dict, List, Optional, Sequence

import numpy as np

from . import __version__, config, fusion, output
from . import fingerprint as fpmod
from . import models as modelsmod
from .pipeline import checkpoint as ck
from .pipeline import decode, keyframes, pcm, probe, thumbs
from .pipeline.tools import lower_priority
from .profile import Profiler
from .protocol import BadInput, Eta, Interrupted, ModelMissing, Protocol
from .signals import audio as audiosig
from .signals import captions as capsig
from .signals import frames as framesig
from .signals import lm as lmmod
from .signals import speech as speechsig
from .signals import subtitles as subs

log = logging.getLogger("bonis.scan")

KNOWN_STAGES = ("subtitles", "frames", "audio", "speech", "captions")
DEFAULT_STAGES = "subtitles,frames,audio,speech,captions"
CUES_FILE = "subtitles.cues.json"
SPEECH_CUES_FILE = "speech.cues.json"
SPEECH_PARTIAL = "speech.windows.json"
CAPTIONS_PARTIAL = "captions.partial"
LM_PARTIAL = "lm.windows.json"
STAGE_FILES = ("subtitles", "speech", "frames", "audio", "lm", "captions", "fusion")
OTHER_SIGNAL_STAGES = ("frames", "subtitles", "speech", "lm", "audio")


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
    names = [s.strip() for s in (text or DEFAULT_STAGES).split(",") if s.strip()]
    for s in names:
        if s not in KNOWN_STAGES:
            raise BadInput("unknown stage %r" % s)
    if not names:
        raise BadInput("--stages is empty")
    return names


EXTRA_FED_KEYS = ("cuts", "audioClasses", "transcript", "captionsText")


def _per_second(v: Any, n: int, what: str) -> np.ndarray:
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
        raise BadInput("--scores-from: %s must be a list or {segments}" % what)
    return a


def load_scores_from(path: str, n: int) -> Dict[str, Any]:
    """Test hook. JSON: {"signals": {signal: {category: [per-second] | {"segments": [[start, end, score], ...]}}},
    "cuts": [seconds, ...] (optional, added to the decoded cuts),
    "audioClasses": {AudioSet display name: [per-second] | {segments}} (optional: fed YAMNet class scores),
    "transcript": [[start, end, text], ...] (optional: what the fake speech engine "hears"),
    "captionsText": [[start, end, caption], ...] (optional: fake scene descriptions by media time)}.
    A bare {signal: {...}} object is accepted too."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise BadInput("--scores-from: cannot read %s" % path) from e
    sigs = raw.get("signals", raw) if isinstance(raw, dict) else None
    if not isinstance(sigs, dict):
        raise BadInput("--scores-from: expected an object")
    wrapped = isinstance(raw, dict) and isinstance(raw.get("signals"), dict)
    out: Dict[str, Dict[str, np.ndarray]] = {}
    for s, per in sigs.items():
        if s in EXTRA_FED_KEYS:
            continue
        if s not in config.SIGNALS or not isinstance(per, dict):
            raise BadInput("--scores-from: unknown signal %r" % s)
        out[s] = {}
        for c, v in per.items():
            if c not in config.CATEGORIES:
                raise BadInput("--scores-from: unknown category %r" % c)
            out[s][c] = _per_second(v, n, "%s.%s" % (s, c))
    src = raw if isinstance(raw, dict) else {}
    cuts = src.get("cuts") if wrapped else None
    classes: Dict[str, np.ndarray] = {}
    if isinstance(src.get("audioClasses"), dict):
        for cls, v in src["audioClasses"].items():
            classes[str(cls)] = _per_second(v, n, "audioClasses.%s" % cls)
    transcript = []
    for item in src.get("transcript") or []:
        if not (isinstance(item, list) and len(item) == 3):
            raise BadInput("--scores-from: transcript entries are [start, end, text]")
        transcript.append({"start": float(item[0]), "end": float(item[1]), "text": str(item[2])})
    caps = []
    for item in src.get("captionsText") or []:
        if not (isinstance(item, list) and len(item) == 3):
            raise BadInput("--scores-from: captionsText entries are [start, end, caption]")
        caps.append((float(item[0]), float(item[1]), str(item[2])))
    return {"signals": out, "cuts": [float(c) for c in cuts] if isinstance(cuts, list) else [],
            "audioClasses": classes, "transcript": transcript, "captionsText": caps}


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------


class Scan:
    """One scan. The *_factory arguments are test hooks (in-process tests):
    each returns a stand-in for that stage's model (FakeLM, FedAudioScorer,
    FakeSTT, FakeCaptioner, ...)."""

    def __init__(self, args: Any, proto: Protocol, lm_factory: Optional[Callable[[], Any]] = None,
                 audio_factory: Optional[Callable[[], Any]] = None,
                 stt_factory: Optional[Callable[[], Any]] = None,
                 captioner_factory: Optional[Callable[[], Any]] = None,
                 profiler: Optional[Profiler] = None) -> None:
        self.a = args
        self.proto = proto
        self.lm_factory = lm_factory
        self.audio_factory = audio_factory
        self.stt_factory = stt_factory
        self.captioner_factory = captioner_factory
        self.profiler = profiler or Profiler(bool(getattr(args, "profile", False)))
        self.started = iso_now()
        self.device = "cpu"
        self.stage_meta: Dict[str, Dict[str, Any]] = {}

    # helpers -----------------------------------------------------------------
    def warn(self, msg: str) -> None:
        log.warning(msg)
        self.proto.warn(msg)

    def _stage_begin(self, name: str, **extra: Any) -> float:
        self.profiler.begin(name)
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
        self.profiler.end(name)

    def _skip(self, name: str, t0: Optional[float], detail: str, warn: Optional[str] = None) -> None:
        if warn:
            self.warn(warn)
        self.ckpt.set_stage(name, "skipped", detail=detail, noArrays=True)
        self.stage_meta[name] = {"status": "skipped", "detail": detail}
        self._stage_end(name, "skipped", t0)

    def _unit_delay(self) -> float:
        """Test hook: seconds to sleep per audio chunk / speech window / shot (fed scans only)."""
        if self.fed is None:
            return 0.0
        return float(os.environ.get("BONIS_TEST_UNIT_DELAY", "0") or 0)

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
        self.lang = a.lang or "es-MX"
        # speech language: --lang when the user gave it, else whisper's auto-detection
        explicit = getattr(a, "lang_explicit", True) and bool(a.lang)
        self.speech_lang = speechsig.lang_code(self.lang) if explicit else "auto"
        self.force_speech = bool(getattr(a, "force_speech", False))
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
        key = {"oshash": self.fp["oshash"], "size": self.fp["size"], "lang": self.lang, "analyzer": __version__,
               "modelSet": config.MODEL_SET, "scoresFrom": fed_hash, "forceSpeech": self.force_speech}
        self.ckpt = ck.Checkpoint(a.work)
        if self.ckpt.open(key, restart=bool(a.restart)):
            log.info("resuming previous scan in work dir")
        self.pauser = ck.Pauser(self.ckpt, self.proto)
        self.models_dir = modelsmod.models_dir(getattr(a, "models", None))

        kw, cues = self.stage_subtitles() if "subtitles" in self.stages else (None, [])
        sp_kw, sp_cues = self.stage_speech(kw is not None) if "speech" in self.stages else (None, [])
        frame_arrays, cuts = self.stage_frames() if "frames" in self.stages else (None, [])
        if "audio" in self.stages:
            self.stage_audio()
        if kw is not None:
            self.stage_lm("subtitles", kw, frame_arrays, cues)
        elif sp_kw is not None:
            self.stage_lm("speech", sp_kw, frame_arrays, sp_cues)
        if "captions" in self.stages:
            self.stage_captions(cuts if "frames" in self.stages else None)

        # fusion -------------------------------------------------------------
        t0 = self._stage_begin("fusion")
        signals, _ = fusion.assemble_signals(self._stage_arrays(), self.n)
        if self.fed:
            for s, per in self.fed["signals"].items():
                signals[s] = dict(per)
            cuts = sorted(set(cuts) | set(self.fed["cuts"]))
        ranges = fusion.fuse(signals, cuts, self.duration, self.levels, self.lang)
        comb = {c: fusion.fused_score(signals, c, self.n).astype(np.float32) for c in config.CATEGORIES}
        self.ckpt.save_arrays("fusion", comb)
        self._stage_end("fusion", "done", t0)
        self.stage_meta["fusion"] = {"status": "done", "progress": 1.0, "seconds": self.ckpt.stage("fusion").get("seconds")}

        # output ------------------------------------------------------------
        self.profiler.begin("output")
        stages_doc = self._stages_doc()
        complete = ("frames" in self.stages and stages_doc.get("frames", {}).get("status") == "done"
                    and stages_doc.get("subtitles", {}).get("status") in ("done", "skipped")
                    and all(stages_doc.get(s, {}).get("status") in ("done", "skipped")
                            for s in ("audio", "speech", "captions") if s in self.stages))
        doc = output.build_doc(self.media, self.fp, cuts, ranges, self.lang, self.levels, stages_doc,
                               "complete" if complete else "partial", self.proto.warnings, self.started,
                               iso_now(), self.device)
        final = output.write_skipfile(a.out, doc)
        if "frames" in self.stages:
            thumbs.make_thumbs(self.media["path"], self.ckpt.work, output.thumb_ranges(final), self.duration)
        self.ckpt.set_stage("output", "done", noArrays=True)
        self.ckpt.cleanup_after_done(STAGE_FILES)
        self.profiler.end("output")
        return os.path.abspath(a.out)

    def _stage_arrays(self, only: Sequence[str] = STAGE_FILES) -> Dict[str, Optional[Dict[str, np.ndarray]]]:
        """Results of the stages that ran in this scan (done, with arrays)."""
        lm_src = self.ckpt.stage("lm").get("source", "subtitles") if self.ckpt.is_done("lm") else None
        out: Dict[str, Optional[Dict[str, np.ndarray]]] = {}
        for name in only:
            if name in ("fusion",):
                continue
            if name == "lm":
                if lm_src is None or lm_src not in self.stages:
                    continue
            elif name not in self.stages:
                continue
            st = self.ckpt.state["stages"].get(name) or {}
            if st.get("status") != "done" or not self.ckpt.has_arrays(name):
                continue
            out[name] = self.ckpt.load_arrays(name)
        return out

    def _stages_doc(self) -> Dict[str, Dict[str, Any]]:
        out = {}
        lm = self.ckpt.state["stages"].get("lm")
        for name in ("subtitles", "speech", "frames", "audio", "captions"):
            if name not in self.stages:
                continue
            st = dict(self.ckpt.stage(name))
            st.update(self.stage_meta.get(name, {}))
            if lm and lm.get("source", "subtitles") == name:
                # the dialogue LM is folded into the stage whose cues it read
                st["seconds"] = float(st.get("seconds") or 0) + float(lm.get("seconds") or 0)
                if lm.get("status") == "done":
                    lm_name = os.path.splitext(config.LM_FILE)[0]
                    st["model"] = "keywords+" + lm_name if name == "subtitles" else "%s+%s" % (st.get("model"), lm_name)
            out[name] = st
        for name, meta in self.stage_meta.items():
            out.setdefault(name, meta)
        return out

    # subtitles ------------------------------------------------------------------
    def _cues(self) -> List[Dict[str, Any]]:
        cues = self.ckpt.read_json(CUES_FILE)
        if isinstance(cues, list):
            return cues
        cues, _ = subs.load_best(self.media, self.media["path"], self.lang)
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
        cues, cand = subs.load_best(self.media, self.media["path"], self.lang, self.warn)
        if not cues:
            # with the speech stage requested, speech-to-text takes over (it warns if it cannot)
            msg = None if "speech" in self.stages else "No readable subtitles were found; dialogue was not checked."
            self._skip(name, t0, "No readable subtitles.", msg)
            return None, []
        lang = lang_tag = subs.lang_family((cand or {}).get("language") or "")
        if not lang:
            lang = subs.guess_language(cues, self.lang)
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
        modelsmod.register(name, getattr(models["scorer"], "__class__").__name__)
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
            self.profiler.count("framesProcessed", len(batch))
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
            modelsmod.release(name)
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
    def _make_lm(self, quiet: bool = False) -> Any:
        if self.lm_factory is not None:
            return self.lm_factory()
        if self.fed is not None:
            return None
        if not lmmod.available():
            if not quiet:
                self.warn("The dialogue model is not installed; dialogue was checked with keywords only.")
            return None
        path = os.path.join(self.models_dir, config.LM_FILE)
        if not os.path.isfile(path):
            if not quiet:
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

    def stage_lm(self, source: str, kw: Dict[str, np.ndarray], frame_arrays: Optional[Dict[str, np.ndarray]],
                 cues: List[Dict[str, Any]]) -> Optional[Dict[str, np.ndarray]]:
        """Dialogue LM over the cues of ``source`` ("subtitles", or "speech"
        when the dialogue came from speech-to-text)."""
        name = "lm"
        if self.ckpt.is_done(name):
            self.proto.stage(name, self.ckpt.stage(name)["status"])
            return self.ckpt.load_arrays(name) if self.ckpt.stage(name)["status"] == "done" else None
        if not cues:
            if source == "subtitles":
                cues = self._cues()
            else:
                got = self.ckpt.read_json(SPEECH_CUES_FILE)
                cues = got if isinstance(got, list) else []
        t0 = self._stage_begin(name)
        self.ckpt.set_stage(name, source=source)
        lm = None
        try:
            lm = self._make_lm()
            if lm is None:
                self.ckpt.set_stage(name, "skipped", noArrays=True)
                self._stage_end(name, "skipped", t0)
                return None
            modelsmod.register(name, type(lm).__name__)
            lex = subs.get_lexicon(self.ckpt.stage(source).get("lexicon", self.lang))
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
                self.profiler.count("lm")
                if (j + 1) % 10 == 0:
                    self.ckpt.write_json(LM_PARTIAL, {str(k): v for k, v in scores.items()})
                p = (j + 1) / max(1, len(sel))
                self.proto.progress(name, p, eta(p))
            if failed:
                self.warn("The dialogue model could not read %d parts of the film." % failed)
            arrays: Dict[str, Any] = dict(lmmod.spread(starts, scores, self.n))
            arrays["source"] = np.array(source)
            self.ckpt.save_arrays(name, arrays)
            self._stage_end(name, "done", t0, detail="%d of %d windows" % (len(sel), len(starts)), source=source)
            return arrays
        finally:
            if lm is not None:
                lm.close()
                modelsmod.release(name)
            del lm
            gc.collect()

    # speech ------------------------------------------------------------------------------
    def _stt(self) -> Any:
        if self.stt_factory is not None:
            return self.stt_factory()
        if self.fed is not None:
            fake = speechsig.FakeSTT(self.fed["transcript"])
            fake.name = "scores-from"
            return fake
        exe = getattr(self.a, "whisper_cli", None)
        if exe:
            os.environ.setdefault(config.WHISPER_CLI_ENV, exe)
        return speechsig.make_stt(self.models_dir, self.threads, self.ckpt.work, self.warn)

    def stage_speech(self, have_subtitles: bool) -> Any:
        """Speech-to-text when no subtitles were found (or --force-speech).
        Its cues feed the subtitle scorer (lexicon now, the LM stage later)."""
        name = "speech"
        if self.ckpt.is_done(name):
            st = self.ckpt.stage(name)
            self.proto.stage(name, st["status"])
            if st["status"] != "done":
                return None, []
            cues = [] if self.ckpt.is_done("lm") else (self.ckpt.read_json(SPEECH_CUES_FILE) or [])
            return self.ckpt.load_arrays(name), cues
        t0 = self._stage_begin(name)
        if have_subtitles and not self.force_speech:
            self._skip(name, t0, "Subtitles were found.")
            return None, []
        if not self.media.get("audio"):
            self._skip(name, t0, "No sound track.", "This movie has no sound track; dialogue was not checked.")
            return None, []
        stt = self._stt()
        if stt is None:
            self._skip(name, t0, "Speech recognition unavailable.")
            return None, []
        engine = getattr(stt, "name", "stt")
        model = os.path.splitext(config.WHISPER_FILE)[0] if engine in ("whisper.cpp", "whisper-cli") else engine
        starts = speechsig.window_starts(self.duration)
        nw = len(starts)
        partial = self.ckpt.read_json(SPEECH_PARTIAL) or {}
        k0 = 0
        while str(k0) in partial and k0 < nw:
            k0 += 1
        rate = config.AUDIO_RATE
        ov = int(round(config.SPEECH_OVERLAP * rate))
        delay = self._unit_delay()
        eta = Eta(k0 / max(1, nw))
        reader = None
        modelsmod.register(name, getattr(stt, "name", "stt"))
        try:
            if k0 < nw:
                reader = pcm.PcmReader(self.media["path"], start_at=starts[k0], threads=self.threads)
                tail = np.zeros(0, dtype=np.float32)
                for k in range(k0, nw):
                    self.pauser.check()
                    if k == k0:
                        x = reader.read(config.SPEECH_WINDOW)
                    else:
                        x = np.concatenate([tail, reader.read(config.SPEECH_WINDOW - config.SPEECH_OVERLAP)])
                    if x.size == 0:
                        partial[str(k)] = []
                    else:
                        segs = stt.transcribe(x, self.speech_lang, t0=starts[k])
                        partial[str(k)] = speechsig.to_cues(k, nw, starts[k], segs, self.duration)
                    self.ckpt.write_json(SPEECH_PARTIAL, partial)  # checkpoint per window
                    self.ckpt.set_stage(name, progress=round((k + 1) / nw, 4), save=True)
                    self.profiler.count("speech")
                    tail = x[-ov:] if x.size else tail
                    if delay:
                        time.sleep(delay)
                    p = (k + 1) / nw
                    self.proto.progress(name, p, eta(p))
                    if x.size == 0:
                        break
        except pcm.PcmError as e:
            log.warning("speech: %s", e)
            self._skip(name, t0, "The sound track could not be read.",
                       "The sound track could not be read; dialogue was not checked.")
            return None, []
        finally:
            if reader is not None:
                reader.close()
            stt.close()
            del stt
            modelsmod.release(name)
        cues = sorted((c for k in range(nw) for c in partial.get(str(k), [])), key=lambda c: (c["start"], c["end"]))
        lang = subs.lang_family(self.speech_lang) if self.speech_lang != "auto" else subs.guess_language(cues, self.lang)
        lex = subs.get_lexicon(lang)
        arrays = subs.score_cues(cues, lex, self.duration)
        self.ckpt.write_json(SPEECH_CUES_FILE, cues)
        self.ckpt.save_arrays(name, arrays)
        self._stage_end(name, "done", t0, detail="%d windows, %d cues" % (nw, len(cues)), model=model,
                        lexicon=lex.language)
        return self.ckpt.load_arrays(name), cues

    # audio ---------------------------------------------------------------------------------
    def _audio_scorer(self) -> Any:
        if self.audio_factory is not None:
            return self.audio_factory()
        if self.fed is not None:
            names = audiosig.load_class_names(audiosig.class_map_path(self.models_dir))
            return audiosig.FedAudioScorer(self.fed["audioClasses"], names)
        make, used = modelsmod.session_factory(self.threads, self.a.device, self.warn)
        try:
            return audiosig.YamnetScorer(self.models_dir, make)
        except ModelMissing as e:
            log.warning("%s", e)
            return None

    def stage_audio(self) -> Optional[Dict[str, np.ndarray]]:
        """YAMNet over 10 s chunks (+1 s overlap); checkpoint every 60 s of audio."""
        name = "audio"
        n = self.n
        if self.ckpt.is_done(name):
            st = self.ckpt.stage(name)
            self.proto.stage(name, st["status"])
            return self.ckpt.load_arrays(name) if st["status"] == "done" else None
        st = self.ckpt.stage(name)
        cats = audiosig.AUDIO_CATEGORIES
        prev = self.ckpt.load_arrays(name) if st.get("resumeAt") else None
        resume_at = float(st.get("resumeAt") or 0.0)
        if prev is None or any(len(prev.get(c, [])) != n for c in cats):
            prev, resume_at = None, 0.0
        arrays = {c: (prev[c].astype(np.float32) if prev is not None else np.zeros(n, np.float32)) for c in cats}
        t0 = self._stage_begin(name, resumeAt=resume_at)
        if not self.media.get("audio"):
            self._skip(name, t0, "No sound track.", "This movie has no sound track; sounds were not checked.")
            return None
        scorer = self._audio_scorer()
        if scorer is None:
            self._skip(name, t0, "Sound model missing.", "The sound model is missing; sounds were not checked.")
            return None
        cols = audiosig.category_columns(scorer.names)
        model = getattr(scorer, "name", "audio")
        rate = config.AUDIO_RATE
        ov_s = min(config.AUDIO_OVERLAP, resume_at)
        delay = self._unit_delay()
        eta = Eta(resume_at / max(1.0, self.duration))
        state = {"t": resume_at, "chunks": 0, "first": None}
        reader = None

        def flush() -> None:
            self.ckpt.save_arrays(name, arrays)
            self.ckpt.set_stage(name, "running", resumeAt=round(state["t"], 3),
                                progress=round(min(1.0, state["t"] / max(1.0, self.duration)), 4))

        modelsmod.register(name, getattr(scorer, "name", "audio"))
        self.pauser.on_pause = flush
        try:
            reader = pcm.PcmReader(self.media["path"], start_at=resume_at - ov_s, threads=self.threads)
            tail = reader.read(ov_s) if ov_s > 0 else np.zeros(0, dtype=np.float32)
            keep = int(round(config.AUDIO_OVERLAP * rate))
            while True:
                self.pauser.check()
                x_new = reader.read(config.AUDIO_CHUNK)
                if x_new.size == 0:
                    break
                x = np.concatenate([tail, x_new]) if tail.size else x_new
                start = state["t"] - tail.size / float(rate)
                if state["first"] is None:
                    state["first"] = round(state["t"], 3)
                per = audiosig.frame_categories(scorer.score(x, start), cols)
                audiosig.accumulate(arrays, per, start, limit=start + x.size / float(rate))
                tail = x[-keep:]
                state["t"] += x_new.size / float(rate)
                state["chunks"] += 1
                self.profiler.count("audioChunks")
                if delay:
                    time.sleep(delay)
                if state["chunks"] % config.AUDIO_CHECKPOINT_CHUNKS == 0:
                    flush()
                p = min(1.0, state["t"] / max(1.0, self.duration))
                self.proto.progress(name, p, eta(p))
                if reader.eof:
                    break
        except pcm.PcmError as e:
            log.warning("audio: %s", e)
            self._skip(name, t0, "The sound track could not be read.",
                       "The sound track could not be read; sounds were not checked.")
            return None
        finally:
            self.pauser.on_pause = None
            if reader is not None:
                reader.close()
            scorer.close()
            del scorer
            modelsmod.release(name)
        self.ckpt.save_arrays(name, arrays)
        self.ckpt.stage(name)["chunksThisRun"] = state["chunks"]
        self.ckpt.stage(name)["firstChunkThisRun"] = state["first"]
        self._stage_end(name, "done", t0, model=model, detail="%d chunks this run" % state["chunks"])
        return arrays

    # captions -------------------------------------------------------------------------------
    def _captioner(self) -> Any:
        if self.captioner_factory is not None:
            return self.captioner_factory()
        if self.fed is not None:
            return capsig.FakeCaptioner(self.fed["captionsText"])
        make, used = modelsmod.session_factory(self.threads, self.a.device, self.warn, arena=False)
        try:
            return capsig.FlorenceCaptioner(self.models_dir, make)
        except ModelMissing as e:
            log.warning("%s", e)
            return None

    def _lm_possible(self) -> bool:
        if self.lm_factory is not None:
            return True
        if self.fed is not None:
            return False
        return lmmod.available() and os.path.isfile(os.path.join(self.models_dir, config.LM_FILE))

    def _other_signal(self) -> np.ndarray:
        """Per-second max of every other signal (visual categories) for the caption budget."""
        signals, _ = fusion.assemble_signals(self._stage_arrays(OTHER_SIGNAL_STAGES), self.n)
        if self.fed:
            for s, per in self.fed["signals"].items():
                if s != "captions":
                    signals[s] = dict(per)
        out = np.zeros(self.n, dtype=np.float32)
        for s, per in signals.items():
            if s == "captions":
                continue
            for c, a in per.items():
                if c in config.VISUAL_CATEGORIES:
                    np.maximum(out, fusion.fit(a, self.n).astype(np.float32), out=out)
        return out

    def stage_captions(self, cuts: Optional[List[float]]) -> Optional[Dict[str, np.ndarray]]:
        """Florence-2 caption of one keyframe per shot (budgeted) -> lexicon
        scores; then, with Florence released, the LM rates the captions that
        mention people. Caption text is never written anywhere."""
        name = "captions"
        if self.ckpt.is_done(name):
            st = self.ckpt.stage(name)
            self.proto.stage(name, st["status"])
            return self.ckpt.load_arrays(name) if st["status"] == "done" else None
        t0 = self._stage_begin(name)
        shots = capsig.shots_from_cuts(cuts, self.duration, config.CAPTION_MAX_SHOT, config.CAPTION_NO_CUTS_STEP)
        m = len(shots)
        if m == 0:
            self._skip(name, t0, "No shots.")
            return None
        sel = capsig.select_shots(capsig.shot_priority(shots, self._other_signal()), config.CAPTION_MAX_SHOTS,
                                  config.CAPTION_PRIORITY)
        cats = capsig.CAPTION_CATEGORIES
        starts = np.asarray([a for a, _ in shots], dtype=np.float64)
        part = self.ckpt.load_arrays(CAPTIONS_PARTIAL)
        if part is None or part.get("shot_start") is None or len(part["shot_start"]) != m \
                or not np.allclose(part["shot_start"], starts):
            part = {"shot_start": starts, "done": np.zeros(m, np.uint8), "lex": np.zeros((m, len(cats)), np.float32),
                    "people": np.zeros(m, np.uint8), "lmdone": np.zeros(m, np.uint8),
                    "lm": np.zeros((m, len(cats)), np.float32)}
        lm_possible = self._lm_possible()
        need = [i for i in sel if not part["done"][i] or (lm_possible and part["people"][i] and not part["lmdone"][i])]
        lex = subs.get_lexicon("en")  # Florence-2 describes in English
        texts: Dict[int, str] = {}  # in memory only, for the LM pass below
        delay = self._unit_delay()
        eta = Eta(0.0)
        share = 0.9 if lm_possible else 1.0

        def save_partial() -> None:
            self.ckpt.save_arrays(CAPTIONS_PARTIAL, part)

        model = self.ckpt.stage(name).get("engine") or (capsig.FlorenceCaptioner.name if self.fed is None else "scores-from")
        if need:
            cap = self._captioner()
            if cap is None:
                self._skip(name, t0, "Scene description model missing.",
                           "The scene description model is missing; scenes were not described.")
                return None
            model = getattr(cap, "name", "captioner")
            self.ckpt.set_stage(name, engine=model)
            modelsmod.register(name, getattr(cap, "name", "captioner"))
            self.pauser.on_pause = save_partial
            try:
                for j, i in enumerate(need):
                    self.pauser.check()
                    a, b = shots[i]
                    t = min((a + b) / 2.0, max(0.0, self.duration - 0.05))
                    img = keyframes.grab(self.media["path"], t, threads=self.threads)
                    text = cap.caption(img, t) if img is not None else ""
                    sc = capsig.lexicon_scores(text, lex)
                    part["lex"][i] = [sc[c] for c in cats]
                    part["people"][i] = 1 if capsig.mentions_people(text) else 0
                    part["done"][i] = 1
                    if lm_possible and part["people"][i] and not part["lmdone"][i]:
                        texts[i] = text
                    del text
                    self.profiler.count("shotsCaptioned")
                    if delay:
                        time.sleep(delay)
                    if (j + 1) % config.CAPTION_CHECKPOINT_SHOTS == 0:
                        save_partial()
                    p = share * (j + 1) / len(need)
                    self.proto.progress(name, p, eta(p))
                save_partial()
            finally:
                self.pauser.on_pause = None
                cap.close()
                del cap
                modelsmod.release(name)
        if texts:
            lm = self._make_lm(quiet=True)
            if lm is not None:
                modelsmod.register("captions-lm", type(lm).__name__)
                try:
                    order = sorted(texts)
                    for j, i in enumerate(order):
                        self.pauser.check()
                        try:
                            sc = lm.score_caption(texts.pop(i))
                        except Exception as e:  # noqa: BLE001
                            log.warning("caption LM failed: %s", e)
                            sc = {}
                        part["lm"][i] = [float(sc.get(c, 0.0)) for c in cats]
                        part["lmdone"][i] = 1
                        self.profiler.count("captionLm")
                        if (j + 1) % config.CAPTION_CHECKPOINT_SHOTS == 0:
                            save_partial()
                        p = share + (1 - share) * (j + 1) / len(order)
                        self.proto.progress(name, p, eta(p))
                finally:
                    lm.close()
                    del lm
                    modelsmod.release("captions-lm")
            texts.clear()
        shot_scores = np.maximum(part["lex"], config.CAPTION_LM_WEIGHT * part["lm"]).astype(np.float32)
        done_idx = [i for i in range(m) if part["done"][i]]
        arrays: Dict[str, Any] = dict(capsig.spread(shots, {i: dict(zip(cats, map(float, shot_scores[i])))
                                                            for i in done_idx}, self.n))
        arrays["shot_start"] = starts
        arrays["shot_end"] = np.asarray([b for _, b in shots], dtype=np.float64)
        arrays["shot_scores"] = shot_scores
        arrays["captioned"] = part["done"].astype(np.uint8)
        self.ckpt.save_arrays(name, arrays)
        p = os.path.join(self.ckpt.work, CAPTIONS_PARTIAL + ".npz")
        if os.path.exists(p):
            os.remove(p)
        self._stage_end(name, "done", t0, model=model,
                        detail="%d of %d shots described" % (len(done_idx), m))
        return arrays


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
