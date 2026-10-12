"""SRT parser edge cases, lexicon scoring (en / es-MX, SDH cues), shared
fixture parity (spec/fixtures/subtitles/expected), track discovery."""

from __future__ import annotations

import glob
import json
import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _support as S  # noqa: E402

from bonis_analyzer.signals import subtitles as subs  # noqa: E402

REGEN = os.environ.get("BONIS_REGEN_FIXTURES") == "1"


class ParseSrtTest(unittest.TestCase):
    def test_basic(self) -> None:
        cues = subs.parse_srt("1\n00:00:01,000 --> 00:00:02,500\nHello\nworld\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n")
        self.assertEqual(cues, [{"start": 1.0, "end": 2.5, "text": "Hello\nworld"},
                                {"start": 3.0, "end": 4.0, "text": "Bye"}])

    def test_bom_crlf_and_cr(self) -> None:
        t = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r00:00:03,000 --> 00:00:04,000\rThere\r"
        cues = subs.parse_srt(t)
        self.assertEqual([c["text"] for c in cues], ["Hi", "There"])

    def test_bytes_and_cp1252(self) -> None:
        raw = "1\n00:00:01,000 --> 00:00:02,000\n¿Qué pasó, niño?\n".encode("cp1252")
        self.assertEqual(subs.parse_srt(raw)[0]["text"], "¿Qué pasó, niño?")

    def test_missing_blank_lines_and_indices(self) -> None:
        t = ("1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:02,000 --> 00:00:03,000\nTwo\n"
             "00:00:04,000 --> 00:00:05,000\nThree (no index)\n")
        self.assertEqual([c["text"] for c in subs.parse_srt(t)], ["One", "Two", "Three (no index)"])

    def test_numeric_dialogue_kept(self) -> None:
        t = "1\n00:00:01,000 --> 00:00:02,000\nHow many?\n42\n\n2\n00:00:03,000 --> 00:00:04,000\nOk\n"
        self.assertEqual(subs.parse_srt(t)[0]["text"], "How many?\n42")

    def test_tags_entities_and_ass_overrides(self) -> None:
        t = "1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Tom</i> &amp; <font color=\"red\">Jerry</font>\n"
        self.assertEqual(subs.parse_srt(t)[0]["text"], "Tom & Jerry")

    def test_overlap_order_and_bad_times(self) -> None:
        t = ("2\n00:00:05,000 --> 00:00:09,000\nB\n\n1\n00:00:01.5 --> 00:00:06,000\nA\n\n"
             "3\n00:00:12,000 --> 00:00:11,000\nC\n\n4\n00:00:13,000 --> 00:00:14,000\n\n")
        cues = subs.parse_srt(t)
        self.assertEqual([(c["start"], c["end"], c["text"]) for c in cues],
                         [(1.5, 6.0, "A"), (5.0, 9.0, "B"), (12.0, 13.0, "C")])

    def test_garbage(self) -> None:
        self.assertEqual(subs.parse_srt(""), [])
        self.assertEqual(subs.parse_srt("not a subtitle file\n\n\n"), [])


class LexiconTest(unittest.TestCase):
    def setUp(self) -> None:
        self.en = subs.get_lexicon("en-US")
        self.es = subs.get_lexicon("es-MX")

    def test_fold(self) -> None:
        self.assertEqual(subs.fold("¿Qué BESO, Niño?"), "que beso nino")
        self.assertEqual(subs.fold("  [Gemidos]  "), "gemidos")

    def test_sdh_cues_en(self) -> None:
        sc = self.en.score_text("[moaning]")
        self.assertAlmostEqual(sc["sex"], 0.85)
        sc = self.en.score_text("[bed creaking]\n[panting]")
        self.assertAlmostEqual(sc["sex"], 1 - 0.3 * 0.6)
        self.assertAlmostEqual(self.en.score_text("[blood splatters]")["gore"], 1 - 0.3 * 0.4)
        self.assertNotIn("sex", self.en.score_text("I was moaning about my job."))  # SDH words only in brackets

    def test_keywords_en_stem_and_whole_word(self) -> None:
        self.assertAlmostEqual(self.en.score_text("They kissed.")["kissing"], 0.45)  # stem
        self.assertAlmostEqual(self.en.score_text("Kissing is fine")["kissing"], 0.45)
        self.assertNotIn("sex", self.en.score_text("Essex is a county."))  # whole word only
        self.assertEqual(self.en.score_text("Pass the salt."), {})

    def test_music_lines_ignored(self) -> None:
        self.assertEqual(self.en.score_text("♪ kiss me, kiss me ♪"), {})
        self.assertAlmostEqual(self.en.score_text("♪ la la ♪\nKiss me")["kissing"], 0.45)

    def test_profanity(self) -> None:
        self.assertAlmostEqual(self.en.score_text("Oh, shit.")["language"], 0.7)
        self.assertNotIn("language", self.en.score_text("He passed the class."))  # "ass" whole word only
        self.assertAlmostEqual(self.es.score_text("No seas pendejo, cabrón.")["language"], 1 - 0.25 * 0.25)

    def test_spanish_accents_and_sdh(self) -> None:
        self.assertAlmostEqual(self.es.score_text("(gemidos)")["sex"], 0.85)
        self.assertAlmostEqual(self.es.score_text("(JADEOS)")["sex"], 0.45)
        self.assertAlmostEqual(self.es.score_text("¡Bésame ya!")["kissing"], 0.45)
        self.assertAlmostEqual(self.es.score_text("Estaba DESNUDA.")["nudity"], 0.6)
        self.assertAlmostEqual(self.es.score_text("(apuñalada)")["gore"], 0.7)

    def test_each_entry_once_per_cue(self) -> None:
        self.assertAlmostEqual(self.en.score_text("kiss kiss kiss")["kissing"], 0.45)

    def test_per_second_arrays(self) -> None:
        cues = [{"start": 1.2, "end": 3.0, "text": "[moaning]"}, {"start": 2.5, "end": 4.1, "text": "[panting]"}]
        a = subs.score_cues(cues, self.en, duration=6.0)
        self.assertEqual(len(a["sex"]), 6)
        self.assertEqual([round(float(x), 3) for x in a["sex"]], [0.0, 0.85, 0.85, 0.4, 0.4, 0.0])
        self.assertEqual(float(a["gore"].sum()), 0.0)

    def test_language_guess(self) -> None:
        es = [{"start": 0, "end": 1, "text": "No sé lo que pasa en la casa, pero es raro"}]
        en = [{"start": 0, "end": 1, "text": "I don't know what is going on in the house"}]
        self.assertEqual(subs.guess_language(es, "en-US"), "es")
        self.assertEqual(subs.guess_language(en, "es-MX"), "en")
        self.assertEqual(subs.guess_language([], "es-MX"), "es")
        self.assertEqual(subs.lang_family("spa"), "es")
        self.assertEqual(subs.lang_family("eng"), "en")
        self.assertEqual(subs.lang_family("fre"), "")


class SharedFixturesTest(unittest.TestCase):
    """spec/fixtures/subtitles/expected/<name>.scores.json are what the JS port asserts too."""

    def test_expected_scores(self) -> None:
        files = sorted(glob.glob(os.path.join(S.SUBS, "*.srt")))
        self.assertGreaterEqual(len(files), 4)
        for p in files:
            got = subs.fixture_scores(p)
            exp_path = os.path.join(S.SUBS, "expected", os.path.basename(p)[:-4] + ".scores.json")
            if REGEN:
                with open(exp_path, "w", encoding="utf-8") as f:
                    json.dump(got, f, ensure_ascii=False, indent=1)
                    f.write("\n")
            with open(exp_path, encoding="utf-8") as f:
                exp = json.load(f)
            self.assertEqual(got, exp, os.path.basename(p))

    def test_fixtures_cover_sdh_both_languages(self) -> None:
        with open(os.path.join(S.SUBS, "expected", "dialogo.es.scores.json"), encoding="utf-8") as f:
            es = json.load(f)
        self.assertEqual(es["lexicon"], "es")
        self.assertGreater(max(es["scores"]["sex"]), 0.8)
        with open(os.path.join(S.SUBS, "expected", "clean.en.scores.json"), encoding="utf-8") as f:
            clean = json.load(f)
        self.assertTrue(all(v == 0 for a in clean["scores"].values() for v in a))


@unittest.skipUnless(S.HAVE_FFMPEG, "ffmpeg not available")
class DiscoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dir = os.path.join(S.tmp_root(), "disc")
        os.makedirs(cls.dir, exist_ok=True)
        v = os.path.join(cls.dir, "clip.mp4")
        S.ffmpeg("-f", "lavfi", "-i", "color=c=gray:size=64x36:rate=5:duration=12", "-c:v", "libx264",
                 "-preset", "ultrafast", v)
        en = os.path.join(cls.dir, "en.srt")
        es = os.path.join(cls.dir, "es.srt")
        with open(en, "w", encoding="utf-8") as f:
            f.write("1\n00:00:01,000 --> 00:00:03,000\n[moaning]\n")
        with open(es, "w", encoding="utf-8") as f:
            f.write("1\n00:00:02,000 --> 00:00:04,000\n(gemidos)\n")
        cls.mkv = os.path.join(cls.dir, "movie.mkv")
        S.ffmpeg("-i", v, "-i", en, "-i", es, "-map", "0", "-map", "1", "-map", "2", "-c:v", "copy", "-c:s", "srt",
                 "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=spa", cls.mkv)
        os.remove(en)
        os.remove(es)

    def test_embedded_choice_by_language(self) -> None:
        from bonis_analyzer.pipeline import probe

        m = probe.probe(self.mkv)
        self.assertEqual([s["language"] for s in m["subtitles"]], ["eng", "spa"])
        cues, cand = subs.load_best(m, self.mkv, "es-MX")
        self.assertEqual(cand["kind"], "embedded")
        self.assertEqual(cand["subIndex"], 1)
        self.assertEqual(cues[0]["text"], "(gemidos)")
        cues, cand = subs.load_best(m, self.mkv, "en-US")
        self.assertEqual(cues[0]["text"], "[moaning]")

    def test_sidecars(self) -> None:
        from bonis_analyzer.pipeline import probe

        d = os.path.join(self.dir, "side")
        os.makedirs(d, exist_ok=True)
        v = os.path.join(d, "Film (2001).mp4")
        shutil.copy(os.path.join(self.dir, "clip.mp4"), v)
        with open(os.path.join(d, "Film (2001).es-MX.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:01,000 --> 00:00:02,000\n¡Bésame!\n")
        with open(os.path.join(d, "Film (2001).vtt"), "w", encoding="utf-8") as f:
            f.write("WEBVTT\n\n00:00:03.000 --> 00:00:04.000\n[kissing]\n")
        with open(os.path.join(d, "Other film.srt"), "w", encoding="utf-8") as f:
            f.write("1\n00:00:01,000 --> 00:00:02,000\nnot ours\n")
        found = subs.find_sidecars(v)
        self.assertEqual(sorted(os.path.basename(c["path"]) for c in found),
                         ["Film (2001).es-MX.srt", "Film (2001).vtt"])
        m = probe.probe(v)
        cues, cand = subs.load_best(m, v, "es-MX")
        self.assertEqual((cand["language"], cues[0]["text"]), ("es", "¡Bésame!"))
        cues, cand = subs.load_best(m, v, "en-US")  # unknown-language sidecar ranks next, converted by ffmpeg
        self.assertEqual(cand["ext"], ".vtt")
        self.assertEqual(cues[0]["text"], "[kissing]")


if __name__ == "__main__":
    unittest.main()
