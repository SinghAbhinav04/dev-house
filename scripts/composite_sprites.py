#!/usr/bin/env python3
"""Composite Cozy People layers into per-agent walk sprite sheets (256×128)."""

from PIL import Image
import os

BASE = "/tmp/cozy-people/Character v.2"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "sprites")
os.makedirs(OUT, exist_ok=True)

# Walk region: top 128px of each 256-wide cell
# 4 rows × 32px = 128px (front, back, left, right)
# 8 frames × 32px = 256px per row
WALK_H = 128
CELL_W = 256


def crop_walk(img, col=0):
    """Crop the walk region (top 128px) from a specific color-variant column."""
    x = col * CELL_W
    return img.crop((x, 0, x + CELL_W, WALK_H))


def load(path):
    return Image.open(os.path.join(BASE, path)).convert("RGBA")


# Agent definitions: layers bottom-to-top
# Hair/eyes/clothes columns are 0-indexed
# From list.txt:
#   Hair:    0=Black 1=Blonde 2=Brown 3=BrownLight 4=Copper 5=Emerald 6=Green 7=Grey 8=Lilac 9=Navy 10=Pink 11=Purple 12=Red 13=Turquoise
#   Clothes: 0=Black 1=Blue 2=BlueLight 3=Brown 4=Green 5=GreenLight 6=Pink 7=Purple 8=Red 9=White/Grey
#   Eyes:    0=Black 1=Blue 2=BlueLight 3=Brown 4=BrownDark 5=BrownLight 6=Green 7=GreenDark 8=GreenLight 9=Grey 10=GreyLight 11=Pink 12=PinkLight 13=Red

agents = {
    "alexis": {
        "char": "characters/char2.png",           # light warm skin
        "eyes": ("eyes/eyes.png", 2),             # blue light
        "shirt": ("clothes/suit.png", 7),          # purple suit jacket
        "pants": ("clothes/pants_suit.png", 7),    # purple suit pants
        "shoes": ("clothes/shoes.png", 0),         # black shoes
        "hair": ("hair/spacebuns.png", 11),        # purple spacebuns
        "acc": [("acc/glasses.png", 0)],           # black glasses
    },
    "brad": {
        "char": "characters/char1.png",            # lightest skin
        "eyes": ("eyes/eyes.png", 3),              # brown eyes
        "shirt": ("clothes/suit.png", 0),           # black suit
        "pants": ("clothes/pants_suit.png", 0),     # black suit pants
        "shoes": ("clothes/shoes.png", 0),          # black shoes
        "hair": ("hair/gentleman.png", 2),          # brown gentleman
        "acc": [("acc/beard.png", 2)],              # brown beard
    },
    "carlos": {
        "char": "characters/char3.png",            # slightly warm skin
        "eyes": ("eyes/eyes.png", 4),              # brown dark
        "shirt": ("clothes/basic.png", 0),          # black basic tee
        "pants": ("clothes/pants.png", 1),          # blue jeans
        "shoes": ("clothes/shoes.png", 0),          # black shoes
        "hair": ("hair/emo.png", 0),                # black emo
        "acc": [],
    },
    "dana": {
        "char": "characters/char5.png",            # medium/tan skin
        "eyes": ("eyes/eyes.png", 6),              # green eyes
        "shirt": ("clothes/overalls.png", 3),       # brown overalls
        "pants": None,                              # overalls cover pants
        "shoes": ("clothes/shoes.png", 3),          # brown shoes
        "hair": ("hair/curly.png", 4),              # copper curly
        "acc": [("acc/earring_emerald.png", 0)],    # emerald earring (single variant)
    },
    "sal": {
        "char": "characters/char7.png",            # dark brown skin
        "eyes": ("eyes/eyes.png", 0),              # black eyes
        "shirt": ("clothes/suit.png", 0),           # black suit
        "pants": ("clothes/pants_suit.png", 0),     # black suit pants
        "shoes": ("clothes/shoes.png", 0),          # black shoes
        "hair": ("hair/buzzcut.png", 0),            # black buzzcut
        "acc": [("acc/glasses_sun.png", 0)],        # black sunglasses
    },
}

for name, layers in agents.items():
    print(f"Compositing {name}...")

    # Start with character base
    char_img = load(layers["char"])
    result = crop_walk(char_img, 0)  # characters are single-variant (256px wide)

    # Eyes
    eyes_file, eyes_col = layers["eyes"]
    eyes_img = load(eyes_file)
    result.paste(crop_walk(eyes_img, eyes_col), (0, 0), crop_walk(eyes_img, eyes_col))

    # Shirt
    shirt_file, shirt_col = layers["shirt"]
    shirt_img = load(shirt_file)
    result.paste(crop_walk(shirt_img, shirt_col), (0, 0), crop_walk(shirt_img, shirt_col))

    # Pants (optional — overalls skip this)
    if layers["pants"]:
        pants_file, pants_col = layers["pants"]
        pants_img = load(pants_file)
        result.paste(crop_walk(pants_img, pants_col), (0, 0), crop_walk(pants_img, pants_col))

    # Shoes
    shoes_file, shoes_col = layers["shoes"]
    shoes_img = load(shoes_file)
    result.paste(crop_walk(shoes_img, shoes_col), (0, 0), crop_walk(shoes_img, shoes_col))

    # Hair
    hair_file, hair_col = layers["hair"]
    hair_img = load(hair_file)
    result.paste(crop_walk(hair_img, hair_col), (0, 0), crop_walk(hair_img, hair_col))

    # Accessories
    for acc_file, acc_col in layers["acc"]:
        acc_img = load(acc_file)
        result.paste(crop_walk(acc_img, acc_col), (0, 0), crop_walk(acc_img, acc_col))

    out_path = os.path.join(OUT, f"{name}.png")
    result.save(out_path)
    print(f"  → {out_path} ({result.size[0]}×{result.size[1]})")

print("\nDone! All 5 agent sprite sheets saved.")
