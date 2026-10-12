"""Template notes (en / es) chosen by category and by which signals agree.
Never built from captions or dialogue text (spec/SKIPFILE.md, Notes)."""

from __future__ import annotations

from typing import Sequence

CATEGORY = {
    "en": {"nudity": "Possible nudity", "sex": "Possible sexual activity",
           "implied": "Possible implied intimacy", "kissing": "Possible heavy kissing",
           "gore": "Possible graphic violence or blood", "language": "Strong language",
           "other": "Marked scene"},
    "es": {"nudity": "Posible desnudez", "sex": "Posible actividad sexual",
           "implied": "Posible intimidad sugerida", "kissing": "Posibles besos intensos",
           "gore": "Posible violencia gráfica o sangre", "language": "Lenguaje fuerte",
           "other": "Escena marcada"},
}

SOURCE = {
    "en": {"frames": "picture", "subtitles": "dialogue", "speech": "dialogue", "audio": "sounds",
           "captions": "scene description"},
    "es": {"frames": "imagen", "subtitles": "diálogo", "speech": "diálogo", "audio": "sonidos",
           "captions": "descripción de la escena"},
}

ONE = {
    "en": {"frames": "Seen in the picture.", "subtitles": "Suggested by the dialogue.",
           "speech": "Suggested by the dialogue.", "audio": "Suggested by sounds.",
           "captions": "Suggested by the scene description."},
    "es": {"frames": "Se ve en la imagen.", "subtitles": "Lo sugiere el diálogo.",
           "speech": "Lo sugiere el diálogo.", "audio": "Lo sugieren los sonidos.",
           "captions": "Lo sugiere la descripción de la escena."},
}

PICTURE_AND_DIALOGUE = {"en": "Seen in the picture; the dialogue agrees.",
                        "es": "Se ve en la imagen y el diálogo lo confirma."}
SEVERAL = {"en": "Several signals agree ({list}).", "es": "Varias señales coinciden ({list})."}
WEAK = {"en": "Weak signals; worth a check.", "es": "Señales débiles; conviene revisar."}
IN_DIALOGUE = {"en": "In the dialogue.", "es": "En el diálogo."}

ORDER = ("frames", "subtitles", "speech", "audio", "captions")


def lang_key(lang: str) -> str:
    return "es" if (lang or "").lower().startswith("es") else "en"


def note(category: str, present: Sequence[str], lang: str) -> str:
    """One short, non-graphic sentence for the review screen."""
    k = lang_key(lang)
    head = CATEGORY[k].get(category, CATEGORY[k]["other"])
    sig = [s for s in ORDER if s in present]
    if category == "language":
        return "%s. %s" % (head, IN_DIALOGUE[k])
    # speech duplicates "dialogue" when subtitles are present
    if "subtitles" in sig and "speech" in sig:
        sig.remove("speech")
    if not sig:
        tail = WEAK[k]
    elif len(sig) == 1:
        tail = ONE[k][sig[0]]
    elif set(sig) == {"frames", "subtitles"} or set(sig) == {"frames", "speech"}:
        tail = PICTURE_AND_DIALOGUE[k]
    else:
        tail = SEVERAL[k].format(list=", ".join(SOURCE[k][s] for s in sig))
    return "%s. %s" % (head, tail)
