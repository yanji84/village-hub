#!/usr/bin/env python3
"""
Generate tile sprite sheets for the social village observer.

Uses Gemini 3 Pro Image to generate rows of tiles, then composites
them into three final sheets:
  - ground.png  256x256  (16 cols × 16 rows of 16x16 tiles)
  - parts.png   512x256  (32 cols × 16 rows of 16x16 tiles)
  - decor.png   256x256  (16 cols × 16 rows of 16x16 tiles)

Usage:
  source /root/openclaw-cloud/.env
  python3 generate-tiles.py [ground|parts|decor]

Without arguments, generates all three sheets.
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
CELL = 16

client = genai.Client(api_key=API_KEY)


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
            if g > 180 and r < 100 and b < 100:
                pixels[x, y] = (0, 0, 0, 0)
    return img


def generate_row(prompt, filename, target_w, target_h, parts_dir, retries=2):
    """Generate a single row image via Gemini API, with retry."""
    for attempt in range(retries + 1):
        try:
            print(f"  [{filename}] Calling API (attempt {attempt + 1})...")
            response = client.models.generate_content(
                model=MODEL,
                contents=prompt,
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
            img = img.resize((target_w, target_h), Image.NEAREST)

            # Chroma key green background to alpha
            img = chromakey_to_alpha(img)

            # Save intermediate
            img.save(parts_dir / filename)
            return img

        except Exception as e:
            print(f"  [{filename}] Error: {e}")
            if attempt < retries:
                time.sleep(2)

    print(f"  [{filename}] FAILED after {retries + 1} attempts")
    return None


# ============================================================
# Shared preamble fragments
# ============================================================

TILE_PREAMBLE = (
    "You are a pixel art tile sheet artist creating tiles for an RPG village game. "
    "Art style: clean retro pixel art, 2-4 shades per material, NO anti-aliasing, "
    "NO gradients, NO smoothing. Perspective: 3/4 top-down. "
    "Light source: top-left. Highlights on top/left edges, shadows on bottom/right. "
    "Use a SOLID BRIGHT GREEN (#00ff00) background for empty/unused tile slots "
    "so they can be chroma-keyed to transparency. "
    "DO NOT use green (#00ff00) on actual tile content."
)

GRAY_RULE = (
    "IMPORTANT: All tiles in this row are GRAY-SCALE (neutral gray). "
    "Base: #808080, Highlight: #909090, Shadow: #707070. "
    "They will be color-tinted at runtime. Do NOT use any color."
)


# ============================================================
# GROUND.PNG — 256x256 (16 cols × 16 rows of 16x16)
# ============================================================

def get_ground_rows():
    W = 256  # 16 tiles × 16px
    return [
        # Row 0: Grass tiles (8 tiles in cols 0-7, rest green bg)
        (0, "ground_r0_grass.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles, each 16x16 pixels, left to right. "
         "The first 8 tiles are GRASS variants. Remaining 8 tiles: solid #00ff00 (empty). "
         "Col 0: Grass base — medium green #3b7d34, short uniform grass, subtle 2-shade variation with darker #2d6b28 pixels. Seamless tiling. "
         "Col 1: Grass light — sun-touched #4a8b3f, 3-4 lighter pixels. "
         "Col 2: Grass dark — shaded #2d6b28, slightly denser. "
         "Col 3: Grass flowers — base grass + 2-3 tiny 1px flowers (yellow, pink, blue). "
         "Col 4: Grass tall — 2px vertical dark-green strokes. "
         "Col 5: Grass dirt-speck — base grass with a few bare-dirt #8a7a5a pixels. "
         "Col 6: Grass mushroom — base grass + tiny mushroom (2x2 tan cap, 1px stem). "
         "Col 7: Grass clover — base grass + 3px clover cluster. "
         "Cols 8-15: solid bright green #00ff00."),

        # Row 1: Dirt path tiles (8 tiles)
        (1, "ground_r1_path1.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). First 8 are DIRT PATH tiles for auto-tiling. "
         "Dirt color: warm brown #9a8468 base, darker edges #6b5a40, lighter center #b0a080. "
         "Tiny 1px pebble dots, subtle crack lines. "
         "Col 0: Path full — solid dirt, no grass edges. Warm brown with pebble highlights. "
         "Col 1: Path N-edge — grass creeping over top 3px, bottom 13px solid dirt. "
         "Col 2: Path S-edge — grass on bottom 3px. "
         "Col 3: Path E-edge — grass on right 3 columns. "
         "Col 4: Path W-edge — grass on left 3 columns. "
         "Col 5: Path NE outer — grass fills top-right corner in curved mask. "
         "Col 6: Path NW outer — grass fills top-left corner. "
         "Col 7: Path SE outer — grass fills bottom-right corner. "
         "Cols 8-15: solid bright green #00ff00."),

        # Row 2: More dirt path tiles
        (2, "ground_r2_path2.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). First 8 are more DIRT PATH auto-tiles. "
         "Same dirt color as before: #9a8468 base, #6b5a40 edges, #b0a080 center. "
         "Col 0: Path SW outer — grass fills bottom-left corner. "
         "Col 1: Path NE inner — small grass triangle (3x3) in top-right, rest dirt. "
         "Col 2: Path NW inner — grass triangle top-left. "
         "Col 3: Path SE inner — grass triangle bottom-right. "
         "Col 4: Path SW inner — grass triangle bottom-left. "
         "Col 5: Path H-narrow — grass top+bottom edges, 10px dirt band in middle. "
         "Col 6: Path V-narrow — grass left+right, dirt band center. "
         "Col 7: Path end-S — dead end south, dirt fades to grass in rounded shape. "
         "Cols 8-15: solid bright green #00ff00."),

        # Row 3: Cobblestone + path ends
        (3, "ground_r3_cobble.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). "
         "Cols 0-1: Path end-N and Path end-E (dirt dead ends). "
         "Cols 2-9: COBBLESTONE tiles. Warm gray-beige #bab0a0 base, #a09888 grout, "
         "#8a8070 dark stones. Offset brick pattern, 3-4px wide stones, 1px grout. "
         "Col 2: Cobble full — full cobblestone surface. "
         "Col 3: Cobble N-border — decorative stone band on top 2px. "
         "Col 4: Cobble S-border — border on bottom. "
         "Col 5: Cobble E-border — border on right. "
         "Col 6: Cobble W-border — border on left. "
         "Col 7: Cobble NE corner — borders north+east. "
         "Col 8: Cobble NW corner — borders north+west. "
         "Col 9: Cobble SE corner — borders south+east. "
         "Cols 10-15: solid bright green #00ff00."),

        # Row 4: Park green tiles
        (4, "ground_r4_park.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). First 4 are PARK GREEN tiles. "
         "Maintained lawn — richer #4a9a50 base, slightly blue-green, smoother texture. "
         "Col 0: Park full — smooth kept-grass, only 1-2 shade variation pixels. "
         "Col 1: Park light — lighter patch variant. "
         "Col 2: Park edge-N — transition to wild grass on top 3px. "
         "Col 3: Park edge-E — transition on right edge. "
         "Cols 4-15: solid bright green #00ff00."),

        # Row 5: Water tiles
        (5, "ground_r5_water.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). First 8 are WATER tiles. "
         "Deep blue-teal: #3a6a8a edge shadow, #4a8aaa main, #55bbcc highlights. "
         "Subtle 1-2px horizontal ripple marks. Edge tiles have 2px dark shadow line. "
         "Col 0: Water full — open water + ripple highlights. Tiles seamlessly. "
         "Col 1: Water N-edge — land on top 3px, dark depth shadow, remaining water. "
         "Col 2: Water S-edge — land on bottom. "
         "Col 3: Water E-edge — land on right. "
         "Col 4: Water W-edge — land on left. "
         "Col 5: Water NE — outer corner, land top+right. "
         "Col 6: Water NW — land top+left. "
         "Col 7: Water SE — land bottom+right. "
         "Cols 8-15: solid bright green #00ff00."),

        # Row 6: Water SW + depth edges
        (6, "ground_r6_depth.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). "
         "Col 0: Water SW — land on bottom+left, water elsewhere. Blue-teal #4a8aaa. "
         "Cols 1-8: 3/4 DEPTH EDGE tiles — parallelogram strips showing side faces of "
         "raised platform surfaces. For 3/4 view perspective depth. "
         "Col 1: Depth-R cobble — right-side face of cobblestone platform, darker #9a9080. "
         "Col 2: Depth-T cobble — top-edge face, slightly lighter #a8a090. "
         "Col 3: Depth-R green — right-side for park green, darker #2a7a30. "
         "Col 4: Depth-T green — top-edge for park green, #3a9040. "
         "Col 5: Depth-R dirt — right-side for raised dirt. "
         "Col 6: Depth-T dirt — top-edge for dirt. "
         "Col 7: Depth-R stone — right-side for generic stone. "
         "Col 8: Depth-T stone — top-edge for stone. "
         "Cols 9-15: solid bright green #00ff00."),
    ]


# ============================================================
# PARTS.PNG — 512x256 (32 cols × 16 rows of 16x16)
# ============================================================

def get_parts_rows():
    W = 512  # 32 tiles × 16px
    return [
        # Row 0: Plaster wall (8 tiles)
        (0, "parts_r0_plaster.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 8 are SMOOTH PLASTER wall tiles. "
         "Clean smooth surface with very subtle vertical brush marks. "
         "Col 0: Plaster full — smooth gray fill with 1-2 barely-visible streaks. "
         "Col 1: Plaster top — top 2px slightly darker (shadow under eave). "
         "Col 2: Plaster bottom — bottom 2px thin foundation line. "
         "Col 3: Plaster left — left 1px column subtle corner shadow. "
         "Col 4: Plaster right — right 1px corner highlight. "
         "Col 5: Plaster side — 15% darker than full, same texture. "
         "Col 6: Plaster side-top — side wall under roof, top 2px darker. "
         "Col 7: Plaster side-bottom — side wall ground row. "
         "Cols 8-31: solid bright green #00ff00."),

        # Row 1: Wood plank wall
        (1, "parts_r1_plank.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 8 are WOOD PLANK wall tiles. "
         "Horizontal plank siding — visible plank lines every 4px (1px darker line). "
         "Each plank has subtle wood grain: 1-2px horizontal streaks. "
         "Col 0: Plank full — 4 horizontal planks with grain lines, dividers at y=3,7,11. "
         "Col 1: Plank top — top 2px darkened (eave shadow). "
         "Col 2: Plank bottom — bottom plank wider, 1px darker baseboard. "
         "Col 3: Plank left — left 1px shadow column. "
         "Col 4: Plank right — right edge highlight. "
         "Col 5: Plank side — same planks 15% darker. "
         "Col 6: Plank side-top — eave shadow over side. "
         "Col 7: Plank side-bottom — foundation on side. "
         "Cols 8-31: solid bright green #00ff00."),

        # Row 2: Stone masonry wall
        (2, "parts_r2_stone.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 8 are STONE MASONRY wall tiles. "
         "Cut stone blocks ~6x3px with 1px mortar lines. Offset pattern. "
         "Col 0: Stone full — 5 rows offset blocks, mortar #6a6a6a, blocks #787878 to #888888. "
         "Col 1: Stone top — lintel stones at top, eave shadow. "
         "Col 2: Stone bottom — larger foundation stones. "
         "Col 3: Stone left — corner quoins (larger alternating blocks). "
         "Col 4: Stone right — right corner quoins. "
         "Col 5: Stone side — same masonry 15% darker. "
         "Col 6: Stone side-top — lintel on side. "
         "Col 7: Stone side-bottom — foundation on side. "
         "Cols 8-31: solid bright green #00ff00."),

        # Row 3: Timber frame wall
        (3, "parts_r3_timber.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 8 are TIMBER FRAME wall tiles. "
         "Half-timbered: dark beams #505050 over lighter plaster #8a8a8a. "
         "Col 0: Timber full — central panel with diagonal brace. "
         "Col 1: Timber top — horizontal beam along top (3px dark strip). "
         "Col 2: Timber bottom — horizontal sill beam along bottom. "
         "Col 3: Timber left — vertical beam along left (3px). "
         "Col 4: Timber right — vertical beam along right. "
         "Col 5: Timber side — same beams 15% darker. "
         "Col 6: Timber side-top — side wall top beam. "
         "Col 7: Timber side-bottom — side wall sill. "
         "Cols 8-31: solid bright green #00ff00."),

        # Row 4: Clay tile roof
        (4, "parts_r4_clay_roof.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 10 are CLAY TILE ROOF tiles. "
         "Semi-circular overlapping tile rows, scalloped lines every 4px. "
         "Gray base #707070, lighter tops #7a7a7a. "
         "Col 0: Clay roof flat — 4 rows of scalloped tiles. "
         "Col 1: Clay roof left-slope — left edge transparent (diagonal slope up). "
         "Col 2: Clay roof right-slope — mirror of left. "
         "Col 3: Clay roof peak — narrow point, ridge cap 2px. "
         "Col 4: Clay roof eave — bottom overhang, shadow strip. "
         "Col 5: Clay roof side — 20% darker, compressed tiles. "
         "Col 6: Clay roof side-slope — side upper slope to ridge. "
         "Col 7: Clay roof ridge — ridge cap from side. "
         "Col 8: Clay eave-corner — 3D corner where front meets side. "
         "Col 9: Clay eave-side — side face eave. "
         "Cols 10-31: solid bright green #00ff00."),

        # Row 5: Thatch roof
        (5, "parts_r5_thatch_roof.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 10 are THATCH ROOF tiles. "
         "Rough straw/reed bundles. Streaky horizontal lines. "
         "Gray base #686868. Irregular edges (1-2px jagged). "
         "Same 10-tile layout as clay roof: "
         "Col 0: flat, Col 1: left-slope, Col 2: right-slope, Col 3: peak with thick rounded bundle, "
         "Col 4: eave (jagged edge), Col 5: side (darker), Col 6: side-slope, "
         "Col 7: ridge (thick bundle), Col 8: eave-corner, Col 9: eave-side. "
         "Cols 10-31: solid bright green #00ff00."),

        # Row 6: Slate roof
        (6, "parts_r6_slate_roof.png", W,
         f"{TILE_PREAMBLE}\n\n{GRAY_RULE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 10 are SLATE ROOF tiles. "
         "Flat rectangular overlapping tiles in neat rows. Clean geometric. "
         "Gray base #6a6a6a, very uniform. Rectangular tiles ~4x2px in strict grid. "
         "Same 10-tile layout: "
         "Col 0: flat, Col 1: left-slope, Col 2: right-slope, Col 3: peak (capping stones), "
         "Col 4: eave, Col 5: side (darker), Col 6: side-slope, "
         "Col 7: ridge (neat capping), Col 8: eave-corner, Col 9: eave-side. "
         "Cols 10-31: solid bright green #00ff00."),

        # Row 7: Doors (actual colors, NOT gray)
        (7, "parts_r7_doors.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). These are DOOR tiles in ACTUAL COLORS (not gray). "
         "Each door is 1 tile wide × 2 tiles tall. This row has the UPPER halves. "
         "Cols 0-1: Wood simple door (top half + bottom half) — dark brown #4a3a2a, vertical planks, iron handle. "
         "Cols 2-3: Wood panel door — medium brown #5a4a3a, two recessed panels, brass handle #ddaa55. "
         "Cols 4-5: Arched door — warm brown with arch top, glass pane warm yellow glow #ffe8c0. "
         "Cols 6-7: Double door — wide, center seam, iron studs. "
         "Cols 8-9: Barn door — wide planks, X-brace pattern, iron rail at top. "
         "Cols 10-11: Shop door — thin wood frame around glass pane, interior glow. "
         "Cols 12-31: solid bright green #00ff00."),

        # Row 8: Windows (actual colors)
        (8, "parts_r8_windows.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). First 6 are WINDOW tiles in ACTUAL COLORS. "
         "Each window uses center ~14x12px with frame. Transparent outside frame. "
         "Warm yellow interior glow #ffffe0. "
         "Col 0: Basic — 14x12 rectangle, wood frame #5a4a3a, cross-bar muntins (4 panes). "
         "Col 1: Arched — same but top curved inward. "
         "Col 2: Shuttered — basic window + wooden shutters (3px each side, slat lines). "
         "Col 3: Round — circular 10px porthole, 4 panes. "
         "Col 4: Tall — full-height 14x14, thinner frame, brighter glow. "
         "Col 5: Boarded — basic frame but wooden boards in X across opening. Dark interior. "
         "Cols 6-31: solid bright green #00ff00."),

        # Row 9: Chimneys (actual colors)
        (9, "parts_r9_chimneys.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). CHIMNEY tiles in ACTUAL COLORS. "
         "Each chimney has 3 tiles: front, side, top view. "
         "Cols 0-2: Brick chimney — 6x14 brick rectangle #6a4020 with mortar lines. "
         "Col 0: front face. Col 1: side face (3px parallelogram, darker #5a3010). Col 2: top view. "
         "Cols 3-5: Stone chimney — gray stone, rougher texture. Same 3 views. "
         "Cols 6-8: Thin pipe — narrow 3px metal chimney, dark gray #444444. 3 views. "
         "Cols 9-11: Wide chimney — broader 10px brick. 3 views. "
         "Cols 12-31: solid bright green #00ff00."),

        # Row 10: Signs & Awnings (gray-scale for tinting)
        (10, "parts_r10_signs.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). SIGNS and AWNING tiles. "
         "Col 0: Hanging sign bracket — actual color, iron L-shape dark gray, extends right. "
         "Col 1: Sign wood blank — actual color, 10x6 brown wood plank #5a3010, lighter center. "
         "Col 2: Awning left — GRAY-SCALE (#808080 base) striped canvas, scalloped bottom. "
         "Col 3: Awning center — GRAY-SCALE striped canvas, tiles horizontally. "
         "Col 4: Awning right — GRAY-SCALE striped canvas, scalloped terminator. "
         "Col 5: Banner — GRAY-SCALE fabric 6x14, pointed bottom, pole at top. "
         "Col 6: Plaque — actual color, small stone frame 8x4 with text area. "
         "Cols 7-31: solid bright green #00ff00."),

        # Row 11: Architectural details (actual colors)
        (11, "parts_r11_details.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 32 tiles (16x16 each). ARCHITECTURAL DETAIL tiles in ACTUAL COLORS. "
         "Col 0: Balcony railing — iron bars #3a3a3a with horizontal rails top/bottom. "
         "Col 1: Flower box — 12x4 terra cotta planter with green foliage + tiny flowers (pink, yellow). "
         "Col 2: Ivy patch — 8x10 dark green #2a5a2a vine/ivy cluster on transparent. "
         "Col 3: Wall lamp — 4x6 black iron bracket + warm glow bulb #ffcc66. "
         "Col 4: Foundation step — 16x4 stone slab #8a8a7a, visible top surface. "
         "Col 5: Scaffold — wooden poles brown in X-pattern, transparent background. "
         "Col 6: Weather vane — 6x8 iron pole + directional arrow, dark gray. "
         "Col 7: Roof dormer — mini triangle roof + tiny window with glow, 10x8. "
         "Cols 8-31: solid bright green #00ff00."),
    ]


# ============================================================
# DECOR.PNG — 256x256 (16 cols × 16 rows of 16x16)
# ============================================================

def get_decor_rows():
    W = 256  # 16 tiles × 16px
    return [
        # Rows 0-1: Trees (4 types, each 2x2 tiles = 32x32, packed into 2 rows)
        (0, "decor_r0_trees_top.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). TOP HALVES of 4 tree types, each 2 tiles wide. "
         "ACTUAL COLORS (not gray). 3/4 top-down perspective. "
         "Cols 0-1: Oak tree top — round canopy, rich green #2a7a2a, layered scalloped foliage. "
         "Lighter highlight #4aaa4a top-left, darker shadow #1a6a1a on right. "
         "Cols 2-3: Pine tree top — conical, 3 triangle tiers, dark green #1a5a2a. "
         "Lighter left edge #3a8a4a, darker right. "
         "Cols 4-5: Birch tree top — white-gray bark #d0c8b8, lighter yellow-green #7aaa4a canopy with gaps. "
         "Cols 6-7: Fruit tree top — like oak but with tiny red #cc4444 / orange #ddaa44 fruit dots. "
         "Cols 8-15: solid bright green #00ff00."),

        (1, "decor_r1_trees_bot.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). BOTTOM HALVES of 4 tree types. "
         "ACTUAL COLORS. These go below the top row to form 32x32 trees. "
         "Cols 0-1: Oak bottom — lower foliage + brown trunk #5a3a1a (4px wide) center. "
         "Darker trunk side #4a2a10 on right. Small dark oval ground shadow. "
         "Cols 2-3: Pine bottom — lowest tier widest + brown trunk below. "
         "Cols 4-5: Birch bottom — white bark trunk with dark horizontal marks. Airy canopy continues. "
         "Cols 6-7: Fruit bottom — oak-style trunk + some lower fruit dots. "
         "Cols 8-15: solid bright green #00ff00."),

        # Row 2: Bushes & small plants (cols 8-15 per spec, but we pack into cols 0-5)
        (2, "decor_r2_bushes.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). SMALL PLANTS in ACTUAL COLORS. "
         "Col 0: Bush — round green 10x8, no trunk, darker bottom, lighter top. "
         "Col 1: Flower bush — bush + 3-4 colored flower pixels (pink, yellow). "
         "Col 2: Tall grass — cluster 6x12, dark green, slight lean right. "
         "Col 3: Reed cluster — 4 brown-green stalks with fluffy tops, 6x14. "
         "Col 4: Stump — cut tree stump 8x6, brown ring pattern on top, bark sides. "
         "Col 5: Log — fallen 14x5, horizontal brown cylinder, bark texture, cut-end on right. "
         "Cols 6-15: solid bright green #00ff00."),

        # Row 3: Rocks + Fence pieces
        (3, "decor_r3_rocks_fence.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). ACTUAL COLORS. "
         "Cols 0-3: ROCKS. "
         "Col 0: Small rock — 8x6, two stones, gray #7a7a6a, top highlight, right shadow. "
         "Col 1: Medium rock — 10x7, single angular boulder, flat top visible, moss pixel. "
         "Col 2: Rock cluster — 12x8, 3-4 pebbles grouped, varying grays. "
         "Col 3: Large boulder — 14x10, crack line, moss on top. "
         "Cols 4-9: FENCE pieces. Warm brown #8a6030. "
         "Col 4: Post — 3px wide, 10px tall, lighter top face. "
         "Col 5: Rail horizontal — 16px wide, rails at y=4 and y=8, posts at edges. "
         "Col 6: Corner NE — post + rails from west. "
         "Col 7: Corner NW — post + rails from east. "
         "Col 8: Rail vertical — vertical rail + posts. "
         "Col 9: Gate — two posts, no rail between, 8px opening. "
         "Cols 10-15: solid bright green #00ff00."),

        # Row 4: Furniture & props part 1
        (4, "decor_r4_props1.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). FURNITURE & PROPS in ACTUAL COLORS. "
         "Col 0: Bench left half — wooden seat warm brown #7a5030, visible top #8a6040, two legs. "
         "Col 1: Bench right half — two legs on right, together forms 32x16 bench. "
         "Col 2: Lantern — black iron pole #2a2a2a, 12px tall, warm yellow-orange glow #ffcc66. "
         "Col 3: Signboard — wooden post + hanging 6x4 brown sign. "
         "Col 4: Anvil — 8x6 dark iron #556666, classic shape, lighter top. "
         "Col 5: Workbench — 10x6 wooden table, top lighter, tool pixels. "
         "Col 6: Barrel — 6x8, oval top, dark iron band stripes. "
         "Col 7: Crate — 7x7, top/front/side faces, X-plank pattern. "
         "Cols 8-15: solid bright green #00ff00."),

        # Row 5: Furniture & props part 2 (larger props span multiple tiles)
        (5, "decor_r5_props2.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). MORE PROPS in ACTUAL COLORS. "
         "Col 0: Flower pot — 4x6 terra cotta pot with green sprout + tiny flower. "
         "Cols 1-2: Well top half (left, right) — stone circular well with roof frame. 2 tiles = 32x16. "
         "Cols 3-4: Cart — 32x16 wooden handcart with wheel. "
         "Cols 5-6: Fountain top half — stone basin, water, central pillar. "
         "Cols 7-8: Market stall top half — wooden frame + striped canvas canopy. "
         "Cols 9-15: solid bright green #00ff00."),

        # Row 6: Nature details + large prop bottom halves
        (6, "decor_r6_nature.png", W,
         f"{TILE_PREAMBLE}\n\n"
         "Draw a ROW of 16 tiles (16x16 each). NATURE DETAILS + PROP BOTTOMS in ACTUAL COLORS. "
         "Col 0: Lily pad — 3x2 green oval. "
         "Col 1: Stepping stone — 4px gray circle. "
         "Col 2: Puddle — 6x3 dark blue-gray oval. "
         "Col 3: Leaf pile — 6x4 autumn leaves (orange, brown, yellow). "
         "Col 4: Campfire — 6x8 log ring with orange-yellow flame center. "
         "Col 5: Grave marker — 4x8 gray stone cross/headstone. "
         "Col 6: Mailbox — 3x8 post with box on top. "
         "Col 7: Streetlamp — 2x14 tall iron pole with warm glow light at top. "
         "Cols 8-9: Well bottom half — bottom of stone well, darker water visible. "
         "Cols 10-11: Fountain bottom half — front basin face + side face darker. "
         "Cols 12-13: Market stall bottom — counter with goods (colored dots). "
         "Cols 14-15: solid bright green #00ff00."),
    ]


# ============================================================
# Main generation
# ============================================================

def generate_sheet(name, rows, sheet_w, sheet_h, output_file):
    """Generate all rows and composite into final sheet."""
    parts_dir = OUTPUT_DIR / f"{name}_parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))

    total = len(rows)
    cost_per_call = 0.134
    print(f"\n=== Generating {name}.png ===")
    print(f"Rows: {total}, Est cost: ${total * cost_per_call:.2f}")
    print(f"Output: {output_file} ({sheet_w}x{sheet_h})")
    print()

    successes = 0
    failures = 0

    for row_idx, filename, row_w, prompt in rows:
        cached = parts_dir / filename
        if cached.exists():
            print(f"  [{filename}] Using cached intermediate")
            img = Image.open(cached)
            sheet.paste(img, (0, row_idx * CELL), img)
            successes += 1
            continue

        img = generate_row(prompt, filename, row_w, CELL, parts_dir)
        if img:
            sheet.paste(img, (0, row_idx * CELL), img)
            successes += 1
        else:
            failures += 1

        time.sleep(1)

    sheet.save(output_file)
    actual_cost = successes * cost_per_call
    print(f"\n  {name}.png: {successes} OK, {failures} failed (${actual_cost:.2f})")
    return successes, failures


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    targets = sys.argv[1:] if len(sys.argv) > 1 else ["ground", "parts", "decor"]
    total_success = 0
    total_fail = 0

    if "ground" in targets:
        s, f = generate_sheet(
            "ground", get_ground_rows(), 256, 256,
            OUTPUT_DIR / "ground.png")
        total_success += s
        total_fail += f

    if "parts" in targets:
        s, f = generate_sheet(
            "parts", get_parts_rows(), 512, 256,
            OUTPUT_DIR / "parts.png")
        total_success += s
        total_fail += f

    if "decor" in targets:
        s, f = generate_sheet(
            "decor", get_decor_rows(), 256, 256,
            OUTPUT_DIR / "decor.png")
        total_success += s
        total_fail += f

    cost = total_success * 0.134
    print(f"\n=== All done ===")
    print(f"Total: {total_success} OK, {total_fail} failed")
    print(f"Cost: ~${cost:.2f}")

    if total_fail > 0:
        print("To retry failed rows, run again (cached rows reused).")


if __name__ == "__main__":
    main()
