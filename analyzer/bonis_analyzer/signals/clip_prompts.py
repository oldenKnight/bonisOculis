"""CLIP zero-shot prompt sets (plain descriptive sentences, never explicit).

tools/make-clip-prompts.py encodes these with the CLIP text model at build
time and writes analyzer/models/clip_prompts.npz; the text encoder is not
shipped. Group "safe" holds counter-prompts that absorb probability mass
for ordinary scenes. Group "nudity" backs up the nudity classifier (ledger
D22: NudeNet's body-part detector was dropped); the frames scorer uses
max(classifier, CLIP_NUDITY_WEIGHT x this group). Its safe counterparts
(swimwear, shirtless sport, bathrobes) sit in "safe". Change a prompt ->
rerun the tool and commit the npz.
"""

from __future__ import annotations

PROMPTS = {
    "sex": [
        "a movie still of two people having sex in bed",
        "a film scene of a couple making love under the sheets",
        "a sex scene from a movie",
        "a couple in an intimate sexual embrace without clothes",
        "two lovers moving together in bed in a romantic film",
        "an erotic scene from an adult drama",
        "a couple in bed in a passionate love scene",
        "a steamy love scene in a movie",
        "a man and a woman in a sexual situation",
        "a passionate intimate scene on a bed",
    ],
    "kissing": [
        "a couple kissing passionately in a movie",
        "two people in a long romantic kiss",
        "a close-up of a couple kissing on the lips",
        "a passionate kiss between two lovers",
        "two people making out on a couch",
        "a couple kissing against a wall",
        "a romantic kiss scene in a film",
        "two people kissing in the rain",
    ],
    "implied": [
        "a couple lying in bed together under the sheets after spending the night",
        "two people undressing each other in a bedroom",
        "a woman in a bedroom wearing only a sheet",
        "a man and a woman waking up in bed together",
        "clothes scattered on a bedroom floor",
        "a seductive person in lingerie in a bedroom",
        "a couple falling onto a bed while embracing",
        "a person taking off their shirt in a dim bedroom",
        "a couple in a bathtub together",
        "a shirtless couple embracing in bed",
    ],
    "gore": [
        "a bloody wound in a horror movie",
        "a person covered in blood",
        "a gory scene with blood splattered on the wall",
        "a severed limb in a horror film",
        "a graphic injury with a lot of blood",
        "a dead body lying in a pool of blood",
        "a violent stabbing scene with blood",
        "a gruesome corpse in a horror movie",
        "a close-up of a deep bleeding cut",
        "blood spraying in a violent fight scene",
        "a zombie with a torn bloody face",
        "a surgical scene with open flesh and blood",
    ],
    "nudity": [
        "a movie still of a naked person",
        "a nude woman in a film scene",
        "a nude man in a film scene",
        "a topless woman with bare breasts in a movie",
        "a person taking a shower with no clothes on",
        "a naked person bathing in a bathtub",
        "a person undressing and taking off all of their clothes",
        "an unclothed person lying on a bed",
        "a naked person seen from behind",
        "people without any clothes on at a nude beach",
    ],
    "safe": [
        "people talking at a dinner table",
        "a family sitting on a couch watching television",
        "two people having a conversation in an office",
        "a landscape with mountains and a lake",
        "a city street with cars and pedestrians",
        "a person cooking in a kitchen",
        "children playing in a park",
        "a soccer match in a stadium",
        "a basketball game",
        "a car chase on a highway",
        "an action scene with an explosion and no blood",
        "two people fighting with swords without blood",
        "a person walking on the beach",
        "a cartoon animation scene",
        "a classroom with students and a teacher",
        "people dancing at a party",
        "a person reading a book in a library",
        "a dog running in a field",
        "a close-up of a person's face talking",
        "a spaceship flying in outer space",
        "a forest at night",
        "a colourful test pattern",
        "a plain black screen",
        "text titles on a screen",
        "a hug between a parent and a child",
        "a couple holding hands while walking",
        "people swimming at a public pool in swimsuits",
        "a doctor talking to a patient in a hospital",
        "a shirtless man working out at a gym",
        "people in swimsuits on a sunny beach",
        "a person wearing a bathrobe in a bathroom",
    ],
}

GROUPS = ["sex", "kissing", "implied", "gore", "nudity", "safe"]
