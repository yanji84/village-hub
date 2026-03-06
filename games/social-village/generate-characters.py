#!/usr/bin/env python3
"""
Generate characters.png sprite sheet for the social village observer.

Uses Gemini 3 Pro Image (Nano Banana Pro) to generate individual part rows,
then composites them into the final 384x736 sprite sheet.

Usage:
  source /root/openclaw-cloud/.env
  python3 generate-characters.py

The script generates parts in batches (one row at a time) and composites
them into the final sheet. Each row is 384x32 (12 cells of 32x32).

API returns large images (~1024px+) which get downscaled to exact pixel
art dimensions using NEAREST neighbor sampling.

Cost estimate: 23 API calls × $0.134/image = ~$3.08 total
"""

import os
import sys
import io
import time
from pathlib import Path

from google import genai
from google.genai import types
from PIL import Image

# --- Config ---
API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    print("Error: GEMINI_API_KEY not set. Run: source /root/openclaw-cloud/.env")
    sys.exit(1)

MODEL = "gemini-3-pro-image-preview"
OUTPUT_DIR = Path(__file__).parent / "assets"
PARTS_DIR = OUTPUT_DIR / "char_parts"  # intermediate row images
OUTPUT_FILE = OUTPUT_DIR / "characters.png"
SHEET_W = 384  # 12 cols × 32px
SHEET_H = 736  # 23 rows × 32px
CELL = 32

# Column labels for prompts
POSE_COLS = "idle-f0, idle-f1, walk-f0, walk-f1, talk-f0, talk-f1, think-f0, think-f1, sit-f0, sit-f1, wave-f0, wave-f1"

client = genai.Client(api_key=API_KEY)

# --- Shared prompt preamble ---
PREAMBLE = (
    "You are a pixel art sprite sheet artist creating a CHARACTER PARTS sprite strip "
    "for an RPG village game. The strip has 12 cells arranged left-to-right. "
    "Each cell is a square. The 12 columns represent 6 poses × 2 animation frames: "
    f"{POSE_COLS}. "
    "Art style: clean retro pixel art, 2-4 shades per material, NO anti-aliasing, "
    "NO gradients, NO smoothing. Front-facing characters, light from top-left. "
    "Use a SOLID BRIGHT GREEN (#00ff00) background so it can be chroma-keyed later. "
    "DO NOT use green anywhere on the character parts themselves."
)


def extract_image(response):
    """Extract PIL Image from a Gemini API response."""
    for part in response.candidates[0].content.parts:
        if hasattr(part, "inline_data") and part.inline_data and part.inline_data.data:
            data = part.inline_data.data
            if isinstance(data, str):
                import base64
                data = base64.b64decode(data)
            return Image.open(io.BytesIO(data))
    return None


def chromakey_to_alpha(img):
    """Replace bright green (#00ff00) background with transparency."""
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            # Generous green screen detection
            if g > 180 and r < 100 and b < 100:
                pixels[x, y] = (0, 0, 0, 0)
    return img


def generate_row(prompt, filename, retries=2):
    """Generate a single row image via Gemini API, with retry."""
    full_prompt = f"{PREAMBLE}\n\n{prompt}"

    for attempt in range(retries + 1):
        try:
            print(f"  [{filename}] Calling API (attempt {attempt + 1})...")
            response = client.models.generate_content(
                model=MODEL,
                contents=full_prompt,
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                ),
            )

            img = extract_image(response)
            if not img:
                print(f"  [{filename}] No image in response")
                continue

            print(f"  [{filename}] Got {img.size[0]}x{img.size[1]} ({img.mode})")

            # Resize to exact strip dimensions (nearest neighbor for pixel art)
            img = img.resize((SHEET_W, CELL), Image.NEAREST)

            # Chroma key green background to alpha
            img = chromakey_to_alpha(img)

            # Save intermediate
            img.save(PARTS_DIR / filename)
            return img

        except Exception as e:
            print(f"  [{filename}] Error: {e}")
            if attempt < retries:
                time.sleep(2)

    print(f"  [{filename}] FAILED after {retries + 1} attempts")
    return None


def generate_sheet():
    """Generate all rows and composite into final sheet."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    PARTS_DIR.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))

    # --- Row definitions: (row_index, filename, prompt) ---
    rows = [
        # Body base (rows 0-2): 3 body types, gray-scale, tinted with skin tone at runtime
        (0, "body_slim.png",
         "SLIM BODY TYPE. Draw a GRAY-SCALE (#808080 base, #909090 highlight, #707070 shadow) "
         "character body — slim/thin proportions. Head is 8px round, thin neck, narrow torso "
         "(10px wide), thin arms at sides, thin legs. "
         "Poses: idle=standing still, walk=legs spread+arms swing, talk=one arm raised gesturing, "
         "think=hand on chin, sit=seated legs forward, wave=arm raised high. "
         "Frames alternate: f0 base, f1 slight bounce (1px shift). GRAY ONLY, no colors."),

        (1, "body_average.png",
         "AVERAGE BODY TYPE. Same as slim but wider: torso 12px, proportionally thicker limbs "
         "and slightly larger head. GRAY-SCALE (#808080 base). Same 6 poses × 2 frames."),

        (2, "body_stocky.png",
         "STOCKY BODY TYPE. Broad/heavy: torso 14px wide, shorter legs, wide shoulders, "
         "larger round head. GRAY-SCALE (#808080 base). Same 6 poses × 2 frames."),

        # Hair (rows 3-8): gray-scale, tinted at runtime
        (3, "hair_short.png",
         "SHORT HAIR only (no face/body). Gray-scale (#808080). Short cropped hair ~3px tall, "
         "sits on top and sides of where a 12px-wide head would be. Each cell shows the hair "
         "positioned for that pose's head location. Transparent everywhere except hair pixels."),

        (4, "hair_medium.png",
         "MEDIUM HAIR only. Gray-scale. Comes to ear level (~6px below head top). Side-parted. "
         "Transparent everywhere except hair. Same head positions per pose."),

        (5, "hair_messy.png",
         "MESSY/WILD HAIR only. Gray-scale. Uneven spikes in different directions, ~5px tall. "
         "Some strands stick out asymmetrically. Transparent background."),

        (6, "hair_long.png",
         "LONG HAIR only. Gray-scale. Straight hair flowing past shoulders (~10px below head top). "
         "Frames face on both sides. Transparent background."),

        (7, "hair_ponytail.png",
         "PONYTAIL HAIR only. Gray-scale. Short on top, gathered ponytail extending to one side. "
         "~4px on top + 6px ponytail. Transparent background."),

        (8, "hair_spiky.png",
         "SPIKY HAIR only. Gray-scale. Dramatic tall spikes ~7px high, 3-4 distinct points. "
         "Anime-inspired upward style. Transparent background."),

        # Outfit tops (rows 9-13): gray-scale, tinted at runtime
        (9, "top_tee.png",
         "T-SHIRT overlay only. Gray-scale. Basic short-sleeve tee covering torso area. "
         "Round neckline. Transparent gaps at neck, hands, and below waist. "
         "Must match body pose positions per column."),

        (10, "top_collared.png",
         "COLLARED SHIRT overlay. Gray-scale. Like tee but with collar points (2px triangles "
         "at neckline). Slightly longer sleeves. Same pose positions."),

        (11, "top_vest.png",
         "VEST overlay. Gray-scale. Sleeveless open-front vest over lighter inner area. "
         "V-neckline. Arms show through (transparent sleeves). Same pose positions."),

        (12, "top_jacket.png",
         "JACKET overlay. Gray-scale. Full-sleeved jacket with lapels/collar. "
         "1px button dots down center front. Wider than torso. Same pose positions."),

        (13, "top_apron.png",
         "APRON overlay. Gray-scale. Front-covering apron with neck strap and side ties. "
         "Extends to below waist. Same pose positions."),

        # Outfit bottoms (rows 14-16)
        (14, "bottom_pants.png",
         "LONG PANTS overlay only. Gray-scale. Cover legs from waist to ankles. "
         "Center seam visible. Match leg positions for each pose."),

        (15, "bottom_shorts.png",
         "SHORTS overlay only. Gray-scale. Cover upper legs only (half-length). "
         "Lower legs remain transparent."),

        (16, "bottom_skirt.png",
         "SKIRT overlay only. Gray-scale. A-line shape from waist. Covers upper legs. "
         "Slightly flared bottom. In sit pose, drapes differently."),

        # Shoes (rows 17-19)
        (17, "shoes_boots.png",
         "BOOTS overlay only. Gray-scale. Chunky boots covering feet + lower ankles. "
         "Visible darker sole at bottom. Match foot positions per pose."),

        (18, "shoes_sneakers.png",
         "SNEAKERS overlay only. Gray-scale. Low-cut casual shoes. "
         "Lighter toe area, tiny lace details. Smaller than boots."),

        (19, "shoes_sandals.png",
         "SANDALS overlay only. Gray-scale. Minimal strappy footwear. "
         "Partly open — some foot skin would show through transparent gaps."),

        # Faces (row 20): actual colors
        (20, "faces.png",
         "FACES — use ACTUAL COLORS, NOT gray-scale! "
         "Cols 0-1: ROUND EYES — large white circles with #1a1a2e pupils, 1px white highlight. "
         "Cols 2-3: NARROW EYES — half-closed cool look. "
         "Cols 4-5: BIG EYES — extra large innocent style. "
         "Cols 6-7: SLEEPY EYES — droopy relaxed. "
         "Cols 8: NEUTRAL mouth (thin #c08080 line). "
         "Col 9: SMIRK mouth (asymmetric #c06060). "
         "Col 10: GENTLE SMILE (small curve #c06060). "
         "Col 11: SERIOUS mouth (flat #c08080 line). "
         "Use skin #f0c8a0 for face area. Only facial features — no head shape/outline."),

        # Accessories (row 21): gray-scale
        (21, "accessories.png",
         "ACCESSORIES — gray-scale (#808080). Each uses 2 columns: "
         "Cols 0-1: GLASSES — thin rectangular frames at eye level. "
         "Cols 2-3: HAT — small cap/beret on head top. "
         "Cols 4-5: SCARF — wrapped at neck. "
         "Cols 6-7: BOWTIE — small bow at collar. "
         "Cols 8-9: FLOWER — tucked behind ear. "
         "Cols 10-11: empty (transparent). Transparent background."),

        # Skin palette (row 22): reference
        (22, "skin_palette.png",
         "SKIN PALETTE — ACTUAL COLORS (not gray). Draw 6 vertical color strips: "
         "Strip 1: #fce4c8 (very light skin). Strip 2: #f0c8a0 (light). "
         "Strip 3: #d8a878 (medium-light). Strip 4: #c09060 (medium). "
         "Strip 5: #8a6a48 (medium-dark). Strip 6: #5a4030 (dark). "
         "Each strip ~60px wide, 3 horizontal bands: highlight, base, shadow."),
    ]

    total_calls = len(rows)
    cost_per_call = 0.134  # $0.134 per 1K/2K image
    total_cost = total_calls * cost_per_call
    print(f"=== Character Sprite Sheet Generator ===")
    print(f"Model: {MODEL}")
    print(f"Rows to generate: {total_calls}")
    print(f"Estimated cost: {total_calls} × ${cost_per_call} = ${total_cost:.2f}")
    print(f"Output: {OUTPUT_FILE}")
    print()

    successes = 0
    failures = 0

    for row_idx, filename, prompt in rows:
        # Skip if intermediate already exists (resume support)
        cached = PARTS_DIR / filename
        if cached.exists():
            print(f"  [{filename}] Using cached intermediate")
            img = Image.open(cached)
            sheet.paste(img, (0, row_idx * CELL), img)
            successes += 1
            continue

        img = generate_row(prompt, filename)
        if img:
            sheet.paste(img, (0, row_idx * CELL), img)
            successes += 1
        else:
            failures += 1

        # Brief pause between calls to avoid rate limiting
        time.sleep(1)

    # Save final composite sheet
    sheet.save(OUTPUT_FILE)
    actual_cost = successes * cost_per_call
    print(f"\n=== Done ===")
    print(f"Sheet saved to: {OUTPUT_FILE}")
    print(f"Dimensions: {SHEET_W}x{SHEET_H}")
    print(f"Rows: {successes} OK, {failures} failed")
    print(f"Actual cost: ~${actual_cost:.2f}")

    if failures > 0:
        print(f"\nTo retry failed rows, just run the script again (cached rows are reused).")


if __name__ == "__main__":
    generate_sheet()
