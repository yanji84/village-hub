# Village Observer — Tile Art Specification

Art asset spec for upgrading the Social Village observer to sprite-based rendering.
The village world **grows infinitely** — bots build new locations at runtime, the map
expands, new paths form, more bots join. Every art decision must support a world that
could have 6 locations or 60.

## Design Principles

1. **Modular over bespoke** — buildings are assembled from reusable parts, not one-off sprites
2. **Tileable and seamless** — ground tiles work at any world size
3. **Color-tintable** — wall/roof parts drawn in neutral gray, tinted at runtime per-location
4. **Chunk-friendly** — terrain renders in chunks, not one giant canvas
5. **Small file count** — 3 sprite sheets cover everything

## General Rules

- **Tile size**: 16x16 pixels
- **Format**: PNG-32 (RGBA with transparency)
- **Perspective**: 3/4 top-down (camera looks slightly down from the south). Flat surfaces
  tilt slightly toward camera. Vertical surfaces show front face + right side face.
- **Light source**: Top-left. Highlights on top/left edges, shadows on bottom/right
- **Palette**: Earthy, warm — cozy RPG village. Muted greens, warm browns, stone grays
- **Style**: Clean pixel art, 2-4 shades per material, no anti-aliasing to background
- **Characters are 32x32** (2x2 tiles) front-facing sprites

---

## File Structure & Storage

All assets live under `village/games/social-village/assets/` in the repo:

```
village/games/social-village/
  assets/
    ground.png         256x256   Terrain + path tileset
    parts.png          512x256   Modular building parts (walls, roofs, doors, windows)
    decor.png          256x256   Props, trees, nature, furniture
  docs/
    TILE_ART_SPEC.md             This file
  observer.html                  Loads assets from ./assets/ via PIXI.Assets
```

The observer loads them at startup:
```javascript
const [groundTex, partsTex, decorTex] = await Promise.all([
  PIXI.Assets.load('./assets/ground.png'),
  PIXI.Assets.load('./assets/parts.png'),
  PIXI.Assets.load('./assets/decor.png'),
]);
```

3 files. That's it. Every building in the world — current and future — is assembled
from tiles in `parts.png`. Every piece of ground from `ground.png`. Every decoration
from `decor.png`.

---

## 1. Ground Tileset — `ground.png` (256x256)

16 columns x 16 rows = 256 tile slots.

The world is an infinite green field with dirt paths connecting locations and special
ground surfaces at plazas/parks. Ground tiles must be **seamlessly tileable** in all
directions — any tile should look natural next to any other tile of the same type.

### Grass Tiles (row 0) — 8 tiles

The default terrain. Every pixel of the world not covered by something else is grass.

| Col | Tile | Description |
|-----|------|-------------|
| 0 | **Grass base** | The #1 most-used tile. Medium green (`#3b7d34`). Short uniform grass blades — subtle 2-shade variation, darker pixels (`#2d6b28`) scattered over lighter base. Must tile seamlessly in all 4 directions. No features near edges. |
| 1 | **Grass light** | Sun-touched variant (`#4a8b3f`). 3-4 lighter pixels suggesting a patch of sunlight. Seamless with col 0 on all sides. |
| 2 | **Grass dark** | Shaded variant (`#2d6b28`). Slightly denser/taller blades. For areas under tree shadows or variety. Seamless with col 0. |
| 3 | **Grass flowers** | Base grass + 2-3 tiny 1px flowers (yellow `#ff6`, pink `#f8f`, blue `#6ef`). Flowers stay 3px from all edges so they don't get sliced when tiling. Sparse meadow feel. |
| 4 | **Grass tall** | Taller blade marks — 2px vertical dark-green strokes. Unmowed field at map margins. |
| 5 | **Grass dirt-speck** | Base grass with a few bare-dirt pixels (`#8a7a5a`) peeking through. Transitional tile for path edges. |
| 6 | **Grass mushroom** | Base grass + tiny mushroom (2x2px tan cap, 1px brown stem) placed in lower-right quadrant. Occasional scatter variety. |
| 7 | **Grass clover** | Base grass + 3px clover cluster in slightly different green. Subtle variation. |

### Dirt Path Tiles (rows 1-2) — 18 tiles

Dirt paths connect every location. The world can have dozens of paths. Auto-tile capable.

Color: warm brown `#9a8468` base, darker edges `#6b5a40`, lighter center `#b0a080`.
Texture: tiny 1px pebble dots, subtle crack lines (1px darker).

**16-tile blob auto-tile layout** for seamless grass-to-dirt transitions:

| Slot | Tile | Description |
|------|------|-------------|
| 0,1 | **Path full** | Solid dirt, no grass edges. Warm brown with 3-4 pebble highlight pixels. Subtle horizontal crack lines. The tile for wide path centers. |
| 1,1 | **Path N-edge** | Grass creeping over top 3px. Bottom 13px solid dirt. Grass-to-dirt transition: irregular green pixels fading into brown. |
| 2,1 | **Path S-edge** | Grass on bottom 3px. |
| 3,1 | **Path E-edge** | Grass on right 3 columns. |
| 4,1 | **Path W-edge** | Grass on left 3 columns. |
| 5,1 | **Path NE outer** | Grass fills top-right corner in a curved mask. Dirt in bottom-left. |
| 6,1 | **Path NW outer** | Grass fills top-left corner. |
| 7,1 | **Path SE outer** | Grass fills bottom-right corner. |
| 0,2 | **Path SW outer** | Grass fills bottom-left corner. |
| 1,2 | **Path NE inner** | Small grass triangle (3x3) in top-right. Rest is dirt. For inner path bends. |
| 2,2 | **Path NW inner** | Grass triangle top-left. |
| 3,2 | **Path SE inner** | Grass triangle bottom-right. |
| 4,2 | **Path SW inner** | Grass triangle bottom-left. |
| 5,2 | **Path H-narrow** | Grass top + bottom edges, 10px dirt band in middle. For thinner connecting paths. |
| 6,2 | **Path V-narrow** | Grass left + right, dirt band center. |
| 7,2 | **Path end-S** | Dead end south. Dirt fades to grass in rounded shape at bottom. |
| 0,3 | **Path end-N** | Dead end north. |
| 1,3 | **Path end-E** | Dead end east. |

### Cobblestone Tiles (row 3) — 8 tiles

Used for plaza-type locations. Any future "town square" or "market" location uses these.

Color: warm gray-beige `#bab0a0` base, `#a09888` grout, `#8a8070` dark stones.
Texture: offset brick pattern — 3-4px wide stones with 1px grout lines. Each stone has
a subtle top-left highlight pixel and bottom-right shadow pixel (3/4 depth cue).

| Slot | Tile | Description |
|------|------|-------------|
| 0,3 | **Cobble full** | Full cobblestone. 4 rows of offset stones. Slight color variation per stone (some beige, some gray). |
| 1,3 | **Cobble N-border** | Top 2px: decorative carved stone band (`#7a6a5a`) with thin highlight line below. Rest: cobble. |
| 2,3 | **Cobble S-border** | Border on bottom. |
| 3,3 | **Cobble E-border** | Border on right. |
| 4,3 | **Cobble W-border** | Border on left. |
| 5,3 | **Cobble NE** | Corner borders (north + east). |
| 6,3 | **Cobble NW** | Corner borders (north + west). |
| 7,3 | **Cobble SE** | Corner borders (south + east). |

### Park Green Tiles (row 4) — 4 tiles

Maintained lawn for park-type locations. Richer than wild grass — `#4a9a50` base,
slightly blue-green. Smoother texture (fewer variation pixels). Suggests trimmed, cared-for ground.

| Slot | Tile | Description |
|------|------|-------------|
| 0,4 | **Park full** | Smooth kept-grass. Only 1-2 shade variation pixels. More saturated than wild grass. |
| 1,4 | **Park light** | Lighter patch variant. |
| 2,4 | **Park edge-N** | Transition to wild grass on top 3px. Park green fades to wilder texture. |
| 3,4 | **Park edge-E** | Transition on right edge. |

### Water Tiles (row 5) — 9 tiles

Ponds, pools, any water feature. Deep blue-teal.

Color: `#3a6a8a` edge shadow, `#4a8aaa` main, `#55bbcc` highlights.
Texture: subtle 1-2px horizontal ripple marks (lighter blue streaks). Edge tiles have
a 2px dark shadow line where water meets land (depth).

| Slot | Tile | Description |
|------|------|-------------|
| 0,5 | **Water full** | Open water. Base blue-teal + 2-3 white-blue ripple highlight pixels. Tiles seamlessly. |
| 1,5 | **Water N-edge** | Land on top. Top 3px: dark depth shadow + land-colored pixels. Remaining: water + ripples. |
| 2,5 | **Water S-edge** | Land on bottom. |
| 3,5 | **Water E-edge** | Land on right. |
| 4,5 | **Water W-edge** | Land on left. |
| 5,5 | **Water NE** | Outer corner — land on top + right. |
| 6,5 | **Water NW** | Land on top + left. |
| 7,5 | **Water SE** | Land on bottom + right. |
| 0,6 | **Water SW** | Land on bottom + left. |

### 3/4 Depth Edges (row 6) — 8 tiles

These tiles create the 3/4 view "thickness" on the right and top edges of elevated
ground surfaces (plazas, parks). They show the side face of a raised platform.

| Slot | Tile | Description |
|------|------|-------------|
| 0,6 | **Depth-R cobble** | Right-side parallelogram strip for cobblestone surfaces. 16px tall, shows the side face of the plaza platform. Darker cobble color `#9a9080`. Sheared upward-right — left column aligns with the ground surface right edge, right column is offset 12px up (matching the 3/4 SIDE_SLOPE of 0.6). |
| 1,6 | **Depth-T cobble** | Top-edge parallelogram for cobblestone. Shows the "away" surface. Slightly lighter than side `#a8a090`. |
| 2,6 | **Depth-R green** | Right-side depth for park green surfaces. Darker green `#2a7a30`. |
| 3,6 | **Depth-T green** | Top-edge depth for park green. `#3a9040`. |
| 4,6 | **Depth-R dirt** | Right-side depth for raised dirt surfaces. |
| 5,6 | **Depth-T dirt** | Top-edge depth for dirt. |
| 6,6 | **Depth-R stone** | Right-side depth for generic stone. For future location types. |
| 7,6 | **Depth-T stone** | Top-edge depth for stone. |

---

## 2. Building Parts Tileset — `parts.png` (512x256)

32 columns x 16 rows = 512 tile slots.

**This is the core of the modular system.** Every building — current and future, built by
bots at runtime — is assembled from parts on this sheet. The code picks wall style + roof
style + door + windows + details and composites them into a building sprite on a canvas
at runtime.

### How Modular Buildings Work

```
     [roof-peak]
    /  [roof-L]  [roof-R]  \        ← Roof row (front face)
   /    [roof-side-L] [roof-side-R]  \  ← Roof row (side face)
  [wall] [wall] [window] [wall] [wall]  ← Wall rows (front face, repeated)
  [wall] [wall] [wall] [wall] [wall]
  [wall] [wall] [door]  [wall] [wall]  ← Bottom wall row with door
  .......[side-wall]...[side-wall].....  ← Side face (parallelogram, tiled vertically)
```

A building N tiles wide and M tiles tall is assembled by:
1. Stamping **wall tiles** in a grid for the front face (N x M)
2. Stamping **side-wall tiles** as a parallelogram column for the right side (1 x M, sheared)
3. Placing **roof tiles** along the top (front triangle + side parallelogram)
4. Placing **door** tile(s) at bottom-center of front wall
5. Placing **window** tiles at regular intervals on front wall
6. Adding **detail** tiles per location type (chimney, sign, etc.)

### IMPORTANT: Gray-Scale Base + Runtime Tinting

**All wall and roof tiles are drawn in NEUTRAL GRAY** — the code applies color tint
at runtime using `PIXI.Color` or canvas `globalCompositeOperation: 'multiply'`.

- Walls: draw in gray range `#808080` base, `#909090` highlight, `#707070` shadow
- Roofs: draw in gray range `#707070` base, `#606060` shadow, `#808080` highlight
- The code tints walls with the location's `c` (wall color) and roofs with `r` (roof color)
- This means ONE set of wall tiles works for ALL buildings — coffee hub gets brown tint,
  knowledge corner gets blue tint, dynamic locations get whatever color they want

Doors, windows, and detail props are drawn in their actual colors (not tinted).

### Wall Tiles (rows 0-3) — 4 wall styles x 8 variants each

Each wall style provides 8 tiles for different positions in the building:

| Variant | Purpose |
|---------|---------|
| full | Interior wall — no edges visible. Uniform material. |
| top | Top row of wall, just below roof. May have a subtle shadow from eave. |
| bottom | Bottom row. May show foundation stones or a baseboard. |
| left-edge | Left edge of front wall. Slightly darker left column (corner shadow). |
| right-edge | Right edge, connects to side wall. |
| side | Side wall tile (for the right-face parallelogram). 15% darker than front. Sheared perspective — draw as if viewed from an angle. |
| side-top | Side wall top row (under roof side). |
| side-bottom | Side wall bottom row. |

#### Style A — Smooth Plaster (row 0)

Clean, smooth wall surface. Minimal texture — very subtle vertical brush marks (1px
shade variation every 6-8px). Good for refined buildings (lounge, library). In gray:
base `#808080`, with `#858585` and `#7b7b7b` subtle streaks.

| Slot | Description |
|------|-------------|
| 0,0 | **Plaster full** — Smooth gray fill. 1-2 barely-visible vertical streaks of lighter/darker gray. No edge features. |
| 1,0 | **Plaster top** — Top 2px slightly darker (shadow under eave overhang). Rest matches full. |
| 2,0 | **Plaster bottom** — Bottom 2px: thin foundation line (slightly darker, suggesting stone base). |
| 3,0 | **Plaster left** — Left 1px column: subtle corner shadow (1 shade darker). |
| 4,0 | **Plaster right** — Right 1px: corner highlight (1 shade lighter, catches light before side wall). |
| 5,0 | **Plaster side** — 15% darker than full. Same smooth texture. Drawn slightly compressed horizontally to suggest the angle. |
| 6,0 | **Plaster side-top** — Side wall under roof. Top 2px darker (eave shadow). |
| 7,0 | **Plaster side-bottom** — Side wall ground row. Foundation line. |

#### Style B — Wood Plank (row 1)

Horizontal plank siding. Visible plank lines every 4px — 1px darker gray line
(`#6a6a6a`) separating planks. Each plank has subtle wood grain: 1-2px horizontal
streaks in slightly varying gray. Rustic feel. Good for coffee shop, workshop.

| Slot | Description |
|------|-------------|
| 0,1 | **Plank full** — 4 horizontal planks. Grain lines within each plank (horizontal 1px streaks, `#848484` and `#7c7c7c` alternating). Plank-divider lines at y=3, y=7, y=11. |
| 1,1 | **Plank top** — Same planks, top 2px darkened (eave shadow). |
| 2,1 | **Plank bottom** — Bottom plank slightly wider. 1px darker baseboard strip. |
| 3,1 | **Plank left** — Left 1px shadow column. Planks don't touch left edge (1px gap = corner shadow). |
| 4,1 | **Plank right** — Right edge highlight. Plank ends visible (slightly lighter end-grain). |
| 5,1 | **Plank side** — Planks continue on side wall, 15% darker. Same horizontal lines. |
| 6,1 | **Plank side-top** — Eave shadow over side planks. |
| 7,1 | **Plank side-bottom** — Foundation visible on side. |

#### Style C — Stone Masonry (row 2)

Cut stone blocks — rectangular blocks ~6x3px with 1px mortar lines between them.
Offset pattern (each row shifted half a block). Individual blocks vary slightly in
shade. Scholarly/castle feel. Good for library, future castle/tower buildings.

| Slot | Description |
|------|-------------|
| 0,2 | **Stone full** — 5 rows of offset stone blocks. Mortar `#6a6a6a`. Blocks range `#787878` to `#888888`. Each block has a 1px highlight on top edge and 1px shadow on bottom edge (depth). |
| 1,2 | **Stone top** — Top 2px: lintel stones (wider, more uniform). Eave shadow. |
| 2,2 | **Stone bottom** — Bottom row: larger foundation stones (wider blocks, rougher texture). |
| 3,2 | **Stone left** — Corner quoins: left 3px column has larger alternating blocks (decorative corner stones). |
| 4,2 | **Stone right** — Right corner quoins. |
| 5,2 | **Stone side** — Same masonry, 15% darker. Blocks continue at angle. |
| 6,2 | **Stone side-top** — Lintel on side wall. |
| 7,2 | **Stone side-bottom** — Foundation on side. |

#### Style D — Timber Frame (row 3)

Half-timbered style — visible dark timber beams (`#505050`) over lighter plaster fill
(`#8a8a8a`). Beams: 3px wide vertical at edges, horizontal at mid-height, diagonal
cross-braces. Plaster between beams. Good for workshop, tavern, future medieval builds.

| Slot | Description |
|------|-------------|
| 0,3 | **Timber full** — Central panel: light plaster fill surrounded by dark beam edges. One diagonal brace line corner-to-corner (1px dark). |
| 1,3 | **Timber top** — Horizontal beam along top (3px dark strip). Plaster below. |
| 2,3 | **Timber bottom** — Horizontal beam along bottom (sill beam). |
| 3,3 | **Timber left** — Vertical beam along left (3px dark strip). |
| 4,3 | **Timber right** — Vertical beam along right. |
| 5,3 | **Timber side** — Same beams on side wall, 15% darker. |
| 6,3 | **Timber side-top** — Side wall top beam. |
| 7,3 | **Timber side-bottom** — Side wall sill. |

### Roof Tiles (rows 4-6) — 3 roof styles x 10 tiles each

Roofs are assembled as a triangle (front face) + parallelogram (side face). The code
needs tiles for: peak, left slope, right slope, eave (bottom edge), and side-face
equivalents.

#### Style A — Clay Tile Roof (row 4)

Semi-circular overlapping tile rows. Rows every 4px — each row is a scalloped line of
rounded tile ends. Classic Mediterranean/RPG look.

| Slot | Description |
|------|-------------|
| 0,4 | **Clay roof flat** — Full tile. 4 rows of scalloped clay tiles. Each tile ~3px wide with rounded bottom edge. Alternating slight shade variation row-to-row. Gray base `#707070`, lighter tops `#7a7a7a`. |
| 1,4 | **Clay roof left-slope** — Left edge of roof front face. Tiles end at a diagonal — left columns are transparent (roof slopes up). Used to build the triangular front face. |
| 2,4 | **Clay roof right-slope** — Mirror of left-slope for the right side of the triangle. |
| 3,4 | **Clay roof peak** — The very top tile where left and right slopes meet. Narrow point. Ridge cap: 2px raised strip along top (lighter gray). |
| 4,4 | **Clay roof eave** — Bottom edge of roof. Tiles overhang by 2px (extend slightly below the tile boundary). Shadow underneath eave (2px darker strip at very bottom). |
| 5,4 | **Clay roof side** — Side face of roof (right parallelogram). 20% darker than front. Same tile pattern but viewed from angle — tiles appear compressed horizontally. |
| 6,4 | **Clay roof side-slope** — Side face upper slope meeting the ridge line. |
| 7,4 | **Clay roof ridge** — Ridge cap tile for the roof peak, viewed from side. Horizontal strip. |
| 8,4 | **Clay eave-corner** — Where eave meets the side face. The 3D corner where front overhang turns into side. |
| 9,4 | **Clay eave-side** — Side face eave (bottom of side roof). |

#### Style B — Thatch Roof (row 5)

Rough straw/reed bundles. Uneven, organic texture. Rougher edge at eave line (1-2px
jagged instead of straight). Good for rustic/workshop buildings. Gray base `#686868`
with streaky horizontal lines suggesting reed bundles.

Same 10 tile layout as Clay (slots 0-9, row 5). Key difference:
- Texture is streaky horizontal lines (like bundled reeds) instead of scalloped tiles
- Edges are irregular (1-2px jagged, not smooth)
- Ridge cap is a thick rounded bundle along the top

#### Style C — Slate Roof (row 6)

Flat rectangular overlapping tiles in neat rows. Clean, geometric. More upscale look.
Good for library, lounge, future government buildings. Gray base `#6a6a6a`, very
uniform. Visible rectangular tile edges in precise grid.

Same 10 tile layout. Key difference:
- Rectangular tiles (~4x2px each) in strict grid pattern
- Very clean edges
- Subtle variation between individual tiles (2-3 slightly different gray shades)
- Ridge: neat capping stones

### Doors (row 7) — 6 door styles

Each door is 1 tile wide x 2 tiles tall (16x32). The top tile is the upper half of the
door, bottom tile is the lower half. Doors are drawn in **actual color** (not gray —
they're not tinted).

| Slots | Door | Description |
|-------|------|-------------|
| 0-1,7 | **Wood simple** | Plain wooden door. Dark brown (`#4a3a2a`). Vertical plank lines. Black iron handle (2px, right side). No decoration. For workshops, dynamic buildings. |
| 2-3,7 | **Wood panel** | Paneled wooden door. Medium brown (`#5a4a3a`). Two rectangular recessed panels (slightly darker, with highlight edge). Brass handle (gold `#ddaa55`, 2x2). For homes, shops. |
| 4-5,7 | **Arched** | Door with arched top. Upper tile has the arch — top row curves inward. Warm brown wood with glass pane in upper half (warm yellow glow `#ffe8c0`). Ornate handle. For refined buildings (lounge, library). |
| 6-7,7 | **Double** | Wide double door (needs 2 tiles width = 32px). Each half 16px. Center seam visible. Heavier construction. Iron studs (dark dots). For large buildings, future town hall. Lower half only — upper half from regular door tops. |
| 8-9,7 | **Barn** | Sliding barn-door style. Wide planks with X-brace pattern (diagonal cross in darker wood). Iron rail visible at top. Slightly open — 2px dark gap on right showing interior. For workshop, stables. |
| 10-11,7 | **Shop** | Glass-front shop door. Thin wood frame around glass pane. Interior glow visible through glass. Small "step" at bottom (1px lighter strip). For cafes, future shops. |

### Windows (row 8) — 6 window styles

Each window is 1 tile (16x16) but uses only the center ~14x12px (frame included).
Transparent outside the frame. Drawn in actual color (not tinted).

| Slot | Window | Description |
|------|--------|-------------|
| 0,8 | **Basic** | Simple rectangle, 14x12. Wood frame (`#5a4a3a`, 1px wide). Warm yellow interior glow (`#ffffe0`). Cross-bar muntins dividing into 4 panes (1px dark cross at center). |
| 1,8 | **Arched** | Same but top 2 rows curved inward (arch shape). Frame follows arch. 4 panes with arch on top two. For refined buildings. |
| 2,8 | **Shuttered** | Basic window + wooden shutters on both sides. Shutters: 3px wide each, dark wood, with horizontal slat lines. Window itself narrower (8px). Cozy/residential. |
| 3,8 | **Round** | Circular porthole window. 10px diameter circle frame. 4 panes divided by a cross. For nautical-themed or unique buildings. |
| 4,8 | **Tall** | Full-height window (14x14 — uses more of the tile). More glass, thinner frame. For libraries, modern buildings. Brighter interior glow. |
| 5,8 | **Boarded** | Basic window frame but glass replaced with wooden boards (brown planks crossing the opening in an X). Dark interior. For abandoned, under-construction, or haunted buildings. |

### Building Detail Parts (rows 9-11)

Unique elements that give each building type its character. Placed on top of the
assembled wall/roof structure. Drawn in actual color.

#### Chimneys (row 9) — 4 styles, 3 tiles each (front + side + top)

| Slots | Chimney | Description |
|-------|---------|-------------|
| 0-2,9 | **Brick chimney** | Front: 6x14px brick rectangle (`#6a4020`, with mortar lines). Side: 3px parallelogram, darker (`#5a3010`). Top: flat opening view (dark center hole, lighter stone rim). For coffee hub. |
| 3-5,9 | **Stone chimney** | Similar shape in gray stone. Rougher texture. For workshop/forge. |
| 6-8,9 | **Thin pipe** | Narrow metal chimney/stovepipe. 3px wide, 12px tall. Dark gray (`#444`). For industrial buildings. |
| 9-11,9 | **Wide chimney** | Broader brick chimney (10px wide). For bakery, future large buildings. |

#### Signs & Awnings (row 10)

| Slot | Part | Description |
|------|------|-------------|
| 0,10 | **Hanging sign bracket** | Iron bracket: L-shape, dark gray. Extends right from wall. 8x4px. Sign hangs from right end. |
| 1,10 | **Sign — wood blank** | 10x6px wooden plank sign. Brown (`#5a3010`). Hangs from bracket. Painted symbol area (lighter center rectangle). The code can stamp a tiny icon on this per-location. |
| 2,10 | **Awning left** | Left end of a fabric awning/canopy. Striped canvas (alternating color bands — drawn in gray stripes for tinting). Scalloped bottom edge. |
| 3,10 | **Awning center** | Center segment — tiles horizontally for wider awnings. Same stripe pattern. |
| 4,10 | **Awning right** | Right end of awning. Scalloped edge terminator. |
| 5,10 | **Banner** | Vertical hanging banner. 6x14px. Fabric (`#808080` for tinting). Pointed bottom. Pole at top. |
| 6,10 | **Plaque** | Small wall-mounted sign. 8x4px. Stone frame with text area (lighter center). |

#### Architectural Details (row 11)

| Slot | Part | Description |
|------|------|-------------|
| 0,11 | **Balcony railing** | Iron railing segment, 16px wide. Thin vertical bars (`#3a3a3a`) with horizontal rail top and bottom. For upper floor decoration. |
| 1,11 | **Flower box** | Window planter. 12x4px. Terra cotta box with green foliage + tiny flower pixels (pink, yellow). Mounted below a window. |
| 2,11 | **Ivy patch** | 8x10px cluster of ivy/vine on wall. Dark green pixels (`#2a5a2a`) on transparent background. Place on wall corners for aged look. |
| 3,11 | **Wall lamp** | Small sconce lamp. 4x6px. Black iron bracket + warm glow bulb (`#ffcc66`). 1-2 semi-transparent yellow glow pixels around it. |
| 4,11 | **Foundation step** | Door step/stoop. 16x4px. Stone slab (`#8a8a7a`). Placed in front of doors. Visible top surface (lighter, 3/4 view). |
| 5,11 | **Scaffold** | Construction scaffolding. Wooden poles (brown) in X-pattern. Transparent background. Overlaid on wall for under-construction buildings. |
| 6,11 | **Weather vane** | Small ornament for roof peak. 6x8px. Iron pole + directional arrow. Dark gray. |
| 7,11 | **Roof dormer** | Small window protruding from roof. Mini triangle roof + tiny window with glow. 10x8px. For large buildings. |

---

## 3. Decoration Tileset — `decor.png` (256x256)

16 columns x 16 rows = 256 tile slots.

Props, trees, nature, and furniture placed on the ground around buildings. All have
transparent backgrounds. All are in **actual color** (not tinted). Objects cast a small
ground shadow (2-3 semi-transparent dark pixels to the bottom-right).

### Trees (rows 0-2) — 4 types, each 2x2 tiles (32x32)

Trees are the main world filler. They're scattered procedurally across the map between
locations. Must look good at any density. 3/4 view: trunk visible at bottom, round
foliage canopy on top. Right side of foliage has side-shadow (darker parallelogram
suggesting depth).

| Slots | Tree | Description |
|-------|------|-------------|
| (0,0)-(1,1) | **Oak** | Classic round canopy. Rich green (`#2a7a2a`). Layered scalloped foliage — 2-3 overlapping rounded clumps. Lighter highlight pixels (`#4aaa4a`) top-left of each clump. Darker shadow (`#1a6a1a`) on right side as parallelogram face. Brown trunk (`#5a3a1a`, 4px wide) at bottom-center. Darker trunk side face (`#4a2a10`, 2px parallelogram) on right. Small dark oval ground shadow (semi-transparent). |
| (2,0)-(3,1) | **Pine** | Conical — 3 layered triangle tiers getting wider toward bottom. Dark green (`#1a5a2a`). Each tier: lighter left edge (`#3a8a4a`, highlight), darker right edge (shadow). Brown trunk below lowest tier. Narrower, more vertical than oak. |
| (4,0)-(5,1) | **Birch** | White-gray bark (`#d0c8b8`) with dark horizontal marks (birch lines). Lighter, airier canopy — yellow-green (`#7aaa4a`) with transparent gaps. Delicate, wispy feel. |
| (6,0)-(7,1) | **Fruit tree** | Like oak but with tiny colored dots in foliage (red `#cc4444` or orange `#ddaa44` fruit, 1px each, 4-5 scattered). Slightly rounder shape. For orchards, gardens. |

### Bushes & Small Plants (row 2, cols 8-15)

Single-tile (16x16) plants. For ground scatter and garden areas.

| Slot | Plant | Description |
|------|-------|-------------|
| 8,2 | **Bush** | Round green bush, 10x8px. Medium green. No trunk visible. Darker bottom, lighter top. Slight right-side shadow. |
| 9,2 | **Flower bush** | Bush + 3-4 colored flower pixels on top (pink, yellow). |
| 10,2 | **Tall grass** | Cluster of tall grass blades. 6x12px. Dark green, taller than regular grass tiles. Slight lean to the right (wind). |
| 11,2 | **Reed cluster** | For pond edges. 4 vertical brown-green stalks with fluffy tops. 6x14px. |
| 12,2 | **Stump** | Cut tree stump. 8x6px. Brown ring pattern visible on top (tree rings — concentric circles, 3/4 view). Bark texture on sides. |
| 13,2 | **Log** | Fallen log. 14x5px. Horizontal brown cylinder. Bark texture. Lighter cut-end visible on right (cross-section circle). |

### Rocks (row 3, cols 0-3)

| Slot | Rock | Description |
|------|------|-------------|
| 0,3 | **Small rock** | 8x6px. Two stones — one larger oval, one smaller. Gray (`#7a7a6a`). Top highlight, right shadow. 2px ground shadow. |
| 1,3 | **Medium rock** | 10x7px. Single angular boulder. Flat top visible (3/4 view). Moss pixel (dark green) on top-left. |
| 2,3 | **Rock cluster** | 12x8px. 3-4 pebbles grouped. Varying grays. For path edges. |
| 3,3 | **Large boulder** | 14x10px. Dominant landscape rock. Crack line across face. Moss on top. |

### Fence Pieces (row 3, cols 4-9)

Wooden fence for park perimeters, any enclosed area. Warm brown `#8a6030`.
3/4 view: posts have visible top face.

| Slot | Piece | Description |
|------|-------|-------------|
| 4,3 | **Post** | Single vertical post. 3px wide, 10px tall. Top: 2x1 lighter brown (visible top surface). Front face medium brown. Right edge 1px darker (side). |
| 5,3 | **Rail horizontal** | 16px wide, rails at y=4 and y=8. Posts at edges. Seamless tiling. |
| 6,3 | **Corner NE** | Post + rails ending from west. |
| 7,3 | **Corner NW** | Post + rails ending from east. |
| 8,3 | **Rail vertical** | Vertical rail + posts for left/right edges. |
| 9,3 | **Gate** | Gap in fence — two posts, no rail between. 8px opening. |

### Furniture & Props (rows 4-5)

Items placed in and around buildings. Actual colors.

| Slot | Prop | Description |
|------|------|-------------|
| 0,4 | **Bench L** | Left half of park bench. Wooden seat (warm brown `#7a5030`). Visible top surface (`#8a6040`, lighter). Two legs on left. Backrest behind. |
| 1,4 | **Bench R** | Right half. Two legs on right. Forms 32x16 bench together with L. |
| 2,4 | **Lantern** | Standing lantern. Black iron pole (`#2a2a2a`), 12px tall. Warm yellow-orange glow housing at top (`#ffcc66` center, `#ffaa44` edges). Semi-transparent yellow glow pixels around. |
| 3,4 | **Signboard** | Wooden post + hanging sign. Sign is 6x4 brown rectangle. Code stamps a per-location icon. |
| 4,4 | **Anvil** | Blacksmith anvil. 8x6px. Dark iron (`#556666`). Classic anvil shape. Top lighter (`#778888`), right side darker (`#445555`). Ground shadow. |
| 5,4 | **Workbench** | 10x6px wooden table. Top surface lighter, front face medium, right side darker. Tool pixels on top. |
| 6,4 | **Barrel** | 6x8px. Oval top (lighter wood). Dark iron band stripes. Right side face darker. |
| 7,4 | **Crate** | 7x7px. Top/front/side faces. X-plank pattern on front. |
| 0,5 | **Flower pot** | 4x6px. Terra cotta pot with green sprout + tiny flower pixel. |
| 1,5 | **Well** | 2x2 tile prop (32x32). Stone circular well with roof frame. Bucket hanging from crossbeam. Dark water visible inside. |
| 3,5 | **Cart** | 2x1 tile prop (32x16). Wooden handcart with wheel. For markets, workshop areas. |
| 5,5 | **Fountain** | 2x2 tile prop (32x32). Stone basin, octagonal. Water inside with central pillar and spray. 3/4 view — front basin face + right side face (darker). |
| 7,5 | **Market stall** | 2x2 tile prop (32x32). Wooden frame + canvas canopy (striped). Counter with goods (colored pixel dots). For future market/bazaar locations. |

### Nature Details (row 6)

Small scatter elements for making the world feel alive.

| Slot | Element | Description |
|------|---------|-------------|
| 0,6 | **Lily pad** | 3x2px green oval for pond surfaces. |
| 1,6 | **Stepping stone** | 4px gray circle. For garden paths. |
| 2,6 | **Puddle** | 6x3px dark blue-gray oval. After-rain detail. |
| 3,6 | **Leaf pile** | 6x4px. Autumn leaves — orange, brown, yellow pixel mix. |
| 4,6 | **Campfire** | 6x8px. Log ring with orange-yellow flame center. Warm glow pixels. For future campsite locations. |
| 5,6 | **Grave marker** | 4x8px. Gray stone cross/headstone. For future cemetery/spooky locations. |
| 6,6 | **Mailbox** | 3x8px. Post with box on top. Red or blue. For residential areas. |
| 7,6 | **Streetlamp** | 2x14px. Tall iron pole with light at top. Warm glow. For paths at night. |

---

## 4. How Buildings Are Assembled at Runtime

This is the key to infinite extensibility. The code does NOT load a pre-made building
sprite. Instead, it composites one on demand:

```
Given a location with:
  - width:  W tiles (building front face width)
  - height: H tiles (building front face height)
  - wallStyle: A/B/C/D (plaster/plank/stone/timber)
  - roofStyle: A/B/C (clay/thatch/slate)
  - doorStyle: 0-5
  - windowStyle: 0-5
  - color: wall tint hex
  - roofColor: roof tint hex
  - details: [chimney, sign, ivy, ...]

Procedure:
  1. Create canvas (W*16 + DEPTH) x (H*16 + ROOF_HEIGHT)
  2. Fill front wall: stamp wall tiles in W x H grid, applying color tint
  3. Fill side wall: stamp side-wall tiles in parallelogram column, tinted darker
  4. Draw roof: stamp roof tiles in triangle (front) + parallelogram (side)
  5. Place door: stamp door tiles at bottom-center of front wall
  6. Place windows: stamp window tiles at regular grid positions on front wall
  7. Overlay details: chimney on side wall, sign on front, ivy on corner, etc.
  8. Convert canvas → PIXI.Texture → PIXI.Sprite
  9. Cache texture by hash of building params (reuse for same config)
```

### Mapping Existing Locations to Parts

| Location | Wall | Roof | Door | Window | Details |
|----------|------|------|------|--------|---------|
| coffee-hub | B (plank) | A (clay) | Shop | Basic | Brick chimney, hanging sign, awning |
| knowledge-corner | C (stone) | C (slate) | Arched | Arched | Ivy, wall lamp, flower box, dormer |
| workshop | D (timber) | B (thatch) | Barn | Basic | Stone chimney, scaffold (if recent build) |
| sunset-lounge | A (plaster) | A (clay) | Arched | Shuttered | Lanterns at door, flower box, banner |
| dynamic (new) | Random | Random | Wood simple | Basic or Boarded | Flag, scaffold |

### Assigning Styles to Dynamic Locations

When a bot builds a new location, the code deterministically picks styles from the
slug hash:

```javascript
const wallStyles = ['A', 'B', 'C', 'D'];
const roofStyles = ['A', 'B', 'C'];
const doorStyles = [0, 1, 2, 3, 4, 5];
const windowStyles = [0, 1, 2, 3, 4, 5];

function buildingStyleFromSlug(slug) {
  const h = hashStr(slug);
  return {
    wall:   wallStyles[Math.abs(h) % wallStyles.length],
    roof:   roofStyles[Math.abs(h >> 4) % roofStyles.length],
    door:   doorStyles[Math.abs(h >> 8) % doorStyles.length],
    window: windowStyles[Math.abs(h >> 12) % windowStyles.length],
  };
}
```

This means every dynamic building looks unique but consistent (same slug always
produces the same building appearance). 4 walls x 3 roofs x 6 doors x 6 windows =
**432 unique building combinations** from the same tileset.

---

## 5. Chunk-Based Terrain Rendering

The world grows as new locations are built. Terrain must render efficiently at any size.

### Chunk System

- **Chunk size**: 512x512 px (32x32 tiles)
- Chunks render on demand when they enter the camera viewport
- Each chunk is a canvas/texture cached until the world layout changes
- A chunk contains: grass base + any path segments passing through + any ground features

### Chunk Rendering Procedure

```
For each visible chunk (cx, cy):
  1. If cached and not dirty, use cached texture
  2. Else: create 512x512 canvas
  3. Fill with grass tiles (stamp base + random variants using seeded RNG from chunk coords)
  4. For each path passing through this chunk: stamp path auto-tiles along the curve
  5. For each location overlapping this chunk: stamp ground surface tiles (cobble/green)
  6. Cache as PIXI.Texture
  7. Mark clean
```

Dirty flags set when: new location added, world bounds change, path added.

### Why Not One Giant Canvas

At 50 locations, the world might be 6000x4000+ pixels. A single canvas that size
uses ~96MB of GPU memory and takes seconds to re-render. Chunks use only ~3-6MB
for the visible area and update incrementally.

---

## 6. Character Sprites (reference)

Characters stay as 32x32 canvas-drawn sprites (existing system). Listed for scale:

- **Size**: 32x32 px (2x2 tiles)
- **View**: Front-facing
- **Proportions**: ~28px character height + 4px shadow
- **Poses**: idle, walk, talk, think, sit, wave (2 frames each)

A character standing by a door should be ~60-70% of door height. Building walls
should be 5-8 tiles tall (80-128px), making characters comfortably smaller than
buildings but clearly visible in front of them.

---

## 7. Future-Proofing Checklist

When drawing tiles, keep these expansion scenarios in mind:

- [ ] **New wall styles**: rows 0-3 of parts.png use 4 styles. Rows 12-15 are empty for 4 more
- [ ] **New roof styles**: rows 4-6 use 3 styles. Rows 13-15 available for more
- [ ] **New ground types**: sand, snow, brick road — add rows 7+ in ground.png
- [ ] **New tree types**: cherry blossom, palm, dead tree — add at rows 3+ in decor.png
- [ ] **Seasonal variants**: autumn trees (orange foliage), snow-covered roofs — add as extra rows
- [ ] **Interior tiles**: if buildings become enterable, add floor/furniture tiles as new sheet
- [ ] **Night variants**: window glow tiles brighter at night, lamp tiles lit — code handles this with tinting, no extra art needed
- [ ] **Biome support**: desert village, snow village — new ground.png variants, same parts.png + decor.png work everywhere with tinting
