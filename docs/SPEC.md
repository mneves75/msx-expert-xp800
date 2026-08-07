# Gradiente Expert XP-800 — Master Reconstruction Spec

Single source of truth. Do not invent dimensions, colors, or labels not documented here
or visible in `reference/raw/`.

## 0. Subject

**Gradiente Expert XP-800**, Brazil, launched 1 December 1985. MSX1 machine, an
unauthorized redraw of the National CF-3000 (bigger case, redrawn boards, non-standard
connectors). Two physical pieces:

1. **Main unit** ("CONSOLE MOD. C-1") — styled like a hi-fi stereo component.
2. **Detached keyboard** ("PERSONAL KEYBOARD") — 89 keys, mechanical, numeric keypad.

Hardware: Z80A @ 3.58 MHz · TMS9918 VDP · 64 KB RAM · 16 KB VRAM · 32 KB ROM · AY-3-8910.

`reference/raw/CREDITS.md` records each photograph's author, source, license, and local
fetch command. Only CC BY 3.0 files are committed; every derived value is recorded below.
- `CF3000_and_XP800.jpg` — XP-800 on the right, next to its National CF-3000 donor. Top + front. *(fetch)*
- `Gradiente_expert_XP-800_back.jpg` — full back panel, all ports, all silkscreen.
- `Gradiente_expert_XP-800_keyboard_correct.jpg` — top-down keyboard, full legend detail. *(fetch)*
- `Gradiente_Logo_Detail.jpg` — the `⊚gradiente` badge. *(fetch)*
- `Expert_Box.jpg`, `Expert_Extras.jpg` — packaging and peripherals.
- `Xp800easter.png` — the ROM easter egg screen (544×480). *(fetch)*

## 1. Units and scene scale

Scene units are **meters**: 1 unit = 1 m. The main unit is ~0.40 m wide. Coordinates are
Y-up and right-handed; the desk center is the origin and its surface is `y = 0`.

## 2. Main unit — geometry

Low, wide, flat slab with a stepped two-tone split. Proportions from `CF3000_and_XP800.jpg`.

| Part | Dimensions (m) | Notes |
|---|---|---|
| Body overall | 0.400 W × 0.092 H × 0.305 D | wide flat slab |
| Upper shell | 0.400 W × 0.031 H × 0.305 D | graphite, near-flat top *(31 mm shell + 61 mm fascia = the measured 92 mm overall; the former 58/34 mm rows were effectively transposed. Recalibrated from `reference/raw/CF3000_and_XP800.jpg`.)* |
| Front fascia band | 0.400 W × 0.061 H | darker, recessed 3 mm from upper shell *(same front-elevation measurement; the dark band occupies ~68 % of the 92 mm height)* |
| Feet | 4 × ⌀0.018 × 0.006 H | soft black rubber, inset 0.025 from corners |

The top is **flat**, not wedged, with a ~1.5° rear rise. Outer vertical edges use a
**5.5 mm fillet** *(~14–16 px across a ~1,050 px / 400 mm front elevation in
`reference/raw/CF3000_and_XP800.jpg`, or ~5–6 mm; recalibrated 2026-07-31)*; the fascia lip
uses **1 mm**. Preserve the upper-shell overhang and its thin contact-shadow line.

### 2.1 Front fascia layout (left → right)

1. **Button cluster** — 10 light warm-gray landscape buttons in a 2×5 grid, far left,
   4.5 × 2.5 mm each, on 5.6 mm horizontal / 6.8 mm vertical pitch, very low profile
   (0.8 mm proud). *(Traced in `reference/raw/CF3000_and_XP800.jpg`; the former 2×3
   cluster of dark square buttons contradicted the photograph.)*
2. **`⊚gradiente`** badge + `PERSONAL COMPUTER` in small caps, white silkscreen.
3. **`POWER`** legend on a glossy recessed strip, with a pin-head indicator at the
   strip's right end, nearly invisible when off. *(Position verified in
   `reference/raw/CF3000_and_XP800.jpg`; it is not below the legend.)*
4. **Cartridge slot A** — recessed bay with a hinged dust cover. Cover face carries a
   **blue label strip** reading `CARTRIDGE`, the `MSX` wordmark centered, and a boxed
   **`A`** at the right end.
5. **Cartridge slot B** — identical, boxed **`B`**.

Slot covers are spring-loaded flaps that push inward. **Pushing either cover in performs
the soft reset** — the machine has no reset key. This must be the actual reset interaction.

### 2.2 Back panel

Flat recessed plate, lighter gray than the shell, dense white silkscreen with
rounded-rectangle group outlines. Left → right:

- Vent slot bank — two stacked left banks, 42 slots above and 28 below *(counted in
  `reference/raw/Gradiente_expert_XP-800_back.jpg`; the right bank has 19)*
- `SPEAKER LEVEL` — small rotary knob, `−` / `+` legends
- `AUDIO` — white RCA jack
- `VIDEO MONOC` — yellow RCA jack
- `DATA CORDER` — 8-pin DIN
- `RGB` — 8-pin DIN
- `GND` — brass thumbscrew post
- `BUS EXPANSION` — wide edge-connector slot, with warning silkscreen:
  `ATENÇÃO  CONECTE APENAS A EQUIPAMENTOS GRADIENTE. / CONSULTE O MANUAL DE INSTRUÇÕES.`
- `⊚gradiente` / `CONSOLE MOD.` / `C-1` and
  `INDÚSTRIA BRASILEIRA / PRODUZIDO NA ZONA FRANCA DE MANAUS`
- `KEYBOARD INPUT` — 13-pin DIN, two screw posts
- Circular `FINAL INSPECTION` sticker
- `PARALLEL PRINTER` — 25-pin ribbon connector
- `FUSE` — table: `120V | 1A`, `240V | 0.5A`, plus fuse holder
- `SWITCHED OUTLET` — two AC sockets, `MAX. 100W`
- `AC INPUT` — `120V` / `240V` slider selector
- Molded AC cord exiting bottom-right
- Vent slot bank (right)
- An aged amber/orange service sticker, bottom-center — include it, it sells the realism

## 3. Keyboard — geometry

| Part | Dimensions (m) | Notes |
|---|---|---|
| Overall | 0.435 W × 0.030 H × 0.175 D | thin slab, slight forward wedge |
| Outer shell | warm silver-gray | |
| Inset panel | matte black, recessed 3 mm | holds the key field |

The black inset panel has a signature **angled notch** between the function and STOP
groups: a diagonal chamfer, not a straight step.

### 3.1 Key field

Brazilian ABNT-adjacent, post-recall v1.1 layout (nine keys differ from the GPC-1). The
`Ç` key is essential.

Row structure, main block:
- `ESC 1 2 3 4 5 6 7 8 9 0 − = \ BS`
- `TAB Q W E R T Y U I O P [ ] ⏎` (enter is tall, L-shaped, spans two rows)
- `CONTROL A S D F G H J K L Ç ; ' ⏎`
- `SHIFT Z X C V B N M , . / ~ SHIFT`
- `CAPS LOCK | L GRA | ⎵ spacebar | R GRA`

Upper strip: `F1/F6  F2/F7  F3/F8  F4/F9  F5/F10` (gray, in the black recess), then
`STOP  HOME/CLS  SELECT  INSERT  DELETE`, then an `IN USE` indicator strip with a small LED.

Right block: numeric keypad `7 8 9 /` `4 5 6 *` `1 2 3 −` `0 . = +`, and below it the
**cursor cluster**: four blue keys in a chevron/diamond arrangement inside a black bezel.

### 3.2 Keycap colors — the accent palette

This machine's color identity comes from five accents against graphite and silver:

| Element | Color | Hex (linear-corrected sRGB) |
|---|---|---|
| Main keycaps | warm light gray | `#B8B5AC` |
| Modifier keys | mid gray | `#8A887F` |
| **STOP** | **red** | `#C4342A` |
| **L GRA / R GRA** | **aged green** | nominal effective albedo `#2F5E2F` *(the `#5A9E5C` base is multiplied in linear space by `[0.28, 0.33, 0.27]`, then varied ±6 % per key; calibrated in `Keyboard.ts` by measuring the AgX render against `reference/raw/Gradiente_expert_XP-800_keyboard_correct.jpg`, target ≈ rgb(133,147,122))* |
| **Cursor keys** | **blue** | `#3E7FA8` |
| **MSX badge** | **red box, white type** | `#6F1215` *(input compensation recorded in `Keyboard.ts`: direct `#CC2229` returns pink through AgX; the darker input returns the saturated brick red of the reference. `PALETTE.msxRed = #CC2229` is currently unused.)* |
| Keyboard shell | aged warm silver | `#8D8981` *(the factory `#A8A49B` material is cloned, darkened for 41 years of aging, then modulated by a deterministic 0.88–1.00 grime map; provenance: `Keyboard.ts` material calibration and `reference/raw/Gradiente_expert_XP-800_keyboard_correct.jpg`)* |
| Black inset panel | matte near-black | `#141414` *(formerly `#232323`; at 15% albedo the panel rendered gray under the softbox and made the keycaps appear to float. Real black ABS reflects 4–6%. Recalibrated 2026-07-28 from `shots/probe/sem-capas-topo.png`.)* |
| Main unit shell | warm brown graphite | `#4A3B33` *(formerly `#3A3733`; the top was resampled in `reference/raw/CF3000_and_XP800.jpg` at rgb(42.8,33.5,30.0), then white-balanced against the tile at rgb(81.0,77.7,72.7) to rgb(42.8,34.9,33.4). The former neutral value turned blue under the cool fill.)* |
| Front fascia | near-black graphite | `#232120` *(formerly `#2E2C29`; resampled from the same photograph to preserve the light-shell/dark-panel separation)* |

Badges: `⊚gradiente  PERSONAL KEYBOARD` top-left, stylised `EXPERT` top-right,
red `MSX` box far top-right.

Keycaps are **cylindrical-dish sculpted**, not flat — a subtle concave top. Legends are
pad-printed, slightly worn. Spacebar and Enter get a faint sheen from finger wear.

## 4. Materials — PBR targets

Materials use real PBR with independent roughness, normal, and AO maps; albedo contains
no baked lighting.

- **Case plastic (graphite/silver)** — ABS with a fine *pebble/orange-peel* grain.
  Roughness 0.55–0.72, varying with a noise map. Clearcoat 0. Slight edge wear on
  corners: roughness drops and albedo lifts where hands touch.
- **Keycaps** — ABS, roughness **0.55** on fresh caps, **0.36 on the spacebar/Enter**
  (finger-polished). Very subtle normal-map grain.
  *Calibrated 2026-07-28, superseding the original 0.42/0.28 guess: under the 1.2 m key
  softbox, 0.42 washed the QWERTY block into a specular glare (critic r1 finding,
  reproduced in `shots/pos-ajuste`). 1985-vintage keyboard ABS is more matte than fresh
  ABS. Do not lower these without re-running the keyboard poses and comparing against
  `reference/raw/Gradiente_expert_XP-800_keyboard_correct.jpg`.*
- **Black inset panel** — matte, roughness **0.90**, specular intensity **0.08**.
  *Recalibrated 2026-07-31: in the keyboard photograph the recess remains black under
  flash, without a broad highlight; IBL over the former 0.80/0.30 values lifted and
  shifted the panel blue. Provenance: comparison with
  `reference/raw/Gradiente_expert_XP-800_keyboard_correct.jpg` and the measurement in
  `Keyboard.ts`.*
- **Silkscreen legends** — separate decal layer, slightly *raised* (normal map),
  roughness 0.35, marginally glossier than the substrate it sits on.
- **Metal (thumbscrew, connector shells)** — metalness 1.0 and tinted, with per-part
  roughness: brass GND thumbscrew **0.30**, chrome screws/pins **0.32**, edge-connector
  shells **0.42**, DIN shells **0.46**. *(The former single 0.35 was the library default;
  the shipped spread is recorded at the `MainUnit.ts` call sites and preserves distinct
  aged brass, chrome and connector finishes.)*
- **Rubber feet** — roughness 0.95, metalness 0.
- **Aged stickers** — slightly yellowed, with a soft peeling edge on one corner.
- **CRT glass** — see §5.

At grazing angles, show micro-scratches, light top scuffs, and dust in vents and the
shell/fascia seam. The machine is 41 years old, not showroom-fresh.

## 5. CRT monitor + screen

Period composite monitor, **~21.4"**: scale **1.624**, exactly 40% above the previous
1.16 calibration, per the 2026-08-07 easy-viewing request. The table-level/front-face
origin and `z = −0.465` keep the feet and console gap anchored while the cabinet grows
upward, sideways, and rearward. Use deeply curved glass, a heavy bezel, and visible shadow
mask around the emulator framebuffer.

Conceptual screen pipeline, in optical order:
1. Source framebuffer uses its native logical size: **272×208** for the classic
   WebMSX MSX1 signal (visible image plus its borders), or **256×192** for the
   procedural fallback's active VDP area. These are the dimensions reported by
   `ScreenSource.width/height`, independent of backing-canvas supersampling.
   The procedural presentation texture stays padded to **272×240** so its
   generated border survives CRT overscan; that padding is not a claim that the
   procedural framebuffer itself is 272×240.
2. **Barrel distortion** matching the physical glass curvature.
3. **Aperture-grille / shadow-mask** phosphor pattern, RGB triads.
4. **Scanlines** with correct duty cycle, slight bloom between lines.
5. **Phosphor persistence** — short trail on bright transitions.
6. **Chroma bleed / composite artifacts** — NTSC dot crawl on high-contrast edges.
7. **Bloom + halation** — light spill into the glass, strongest on white text.
8. **Glass reflection** — the room reflects in the curved glass. Non-negotiable; a CRT
   with no reflection reads as a flat texture immediately.
9. **Vignette + corner geometry pincushion**.
10. Screen emits real light onto the desk and the machine (see §6).

Implementation order differs deliberately: source → native-resolution persistence → tube
pass (barrel/pincushion, chroma bleed/dot crawl, halation, vignette) → screen material
(scanlines, shadow mask) → additive glass reflection → scene bloom and emitted light.
Persistence cannot blur the phosphor mask, and `gl_FragCoord` derivatives preserve the
physical pitch. Provenance: `CrtShader.ts` / `CrtMonitor.ts`, documented 2026-07-31.

TMS9918 palette (the authentic 15 colors + transparent) must be exact.

## 6. Lighting

Studio void, like the reference site. Not a lit room — a photographic set.

- **HDRI-based IBL** as the base, low intensity, neutral.
- **Key light** — large soft area light, upper front-left, ~4500 K.
- **Fill** — dim, opposite side, cooler, ~6000 K.
- **Rim/kicker** — hard, behind and above, separating the graphite from the dark void.
  This is what makes the silhouette read.
- **Screen light** — the CRT is a real emissive area light spilling blue-green onto the
  keyboard and desk. Must respond when the machine powers on/off.
- **Contact shadows** — high-quality soft shadows, plus screen-space AO in the seams,
  vents, and under the shell overhang.

Tone mapping: **AgX**, exposure **0.72**. Physically-correct lights,
`useLegacyLights = false`. Color management on, output sRGB.

*Exposure 0.72 remains the global calibration, not an isolated keycap correction.
`tools/tune-exposure.mjs` originally measured QWERTY at rgb(184,181,175) against
`#B8B5AC` = rgb(184,181,172); after later lighting changes the current readings are
rgb(172,169,162) at 0.72 and rgb(184,181,175) at 1.0. Because 1.0 overexposes the wider
set, fix the measured lighting distribution before changing exposure, then re-run both
`tune-case.mjs` and the ROI sweep.*

## 7. Post-processing chain

Render (4× MSAA on the high profile) → depth-only ambient occlusion (n8ao, normals
reconstructed from depth — no normal pass) → bloom → depth of field (subtle, focus on
the machine) → chromatic aberration (very slight, edges only) + film grain (very fine) +
vignette + AgX tone map → SMAA.

SMAA runs last because raw HDR CRT/graphite contrast saturates its color-edge detector;
tone mapping preserves useful discontinuities. Input MSAA handles geometry, while final
SMAA catches shader, specular, and normal-map edges. The implementation compiles and
links an SMAA probe against the active renderer; only a failed probe substitutes FXAA,
which preserves the scene on incompatible Safari/Metal paths without lowering capable
browsers. Provenance: `PostFX.ts`, verified on Chromium and Safari/iOS 26.5/27 on
2026-08-07.

Restraint is the rule: if a viewer can *name* the effect, it is turned up too high.

Bloom is **threshold 1.45, intensity 0.6**; only CRT phosphor and metal speculars glow.
*A/B in `shots/probe/bloom-{on,off}.png` showed threshold 1.0 admitting the softbox-lit
keycaps and washing out the keyboard. If a non-emissive surface glows, test this threshold
before changing materials.*

## 8. Interaction

- Orbit / pan / zoom, damped, with sensible limits (never below the desk plane).
- Auto-rotate idle mode, disengages on user input. It starts disabled for coarse pointers
  and `prefers-reduced-motion: reduce`, and remains manually toggleable.
- **Power switch** — real toggle, boots the emulator, screen warms up (CRT warm-up is a
  visible ramp, not an instant on).
- **Cartridge insert/eject** on both slots A and B, with physical slide animation and the
  dust-cover flap lifting.
- **Push a slot cover in → soft reset.** Authentic, no reset key exists.
- **Keyboard keys are individually pressable** and drive real emulator input.
- Wireframe and X-ray modes (reference-site parity).
- View reset.
- Keyboard shortcuts. All UI copy in **pt-BR**.

Physics: keycap travel with proper damping, cartridge insertion resistance, dust-cover
flap swing with gravity, cable catenary sag on the keyboard cable and AC cord.

## 9. Emulator integration

- **Primary**: WebMSX, hotlinked, pinned to commit `4f4009e`, with SRI.
  `https://cdn.jsdelivr.net/gh/ppeccin/WebMSX@4f4009e86d3e0bb9be7dcd7f0a582b0cd411d660/release/stable/6.0/cbios/embedded/wmsx.js`
  `integrity="sha384-ZrKfFA57c2hR6DHPG3q0c55xd7wx70ZQLpoWj87znFJaebQcxkKRDJQxZFh+B49S"`
  Verified byte-identical to upstream, `access-control-allow-origin: *`, immutable.
  **We redistribute nothing** — WebMSX has no declared license, so we never self-host it.
- **Fallback**: procedural TMS9918 renderer, same CRT pipeline, engages if the CDN fails,
  is blocked, or the canvas turns out to be tainted. The visual bar must not drop.
- C-BIOS build only. Never ship copyrighted MSX BIOS ROMs.
- **Routing follows the cartridge because C-BIOS has no BASIC.** MSX BASIC is proprietary
  and will not ship; C-BIOS can only start cartridges, so empty WebMSX slots produce a
  dead end. The route mirrors the real machine:
  - both slots empty → procedural BASIC prompt, with no third-party request;
  - a cartridge is inserted → WebMSX is fetched and promoted, carrying the inserted ROMs
    (`promoteToWebMsx` re-applies the desired slots before switching);
  - last cartridge ejected → BASIC prompt without marking WebMSX unavailable.
  `webMsxNeedsCartridge` implements this. WebMSX-always would restore the initial dead end.

## 10. Performance budget

60 fps at 1440p on an M-series Mac; 60 fps at 1080p on a 2020 mid-range laptop.
- Draw calls < 150. Instance the keycaps.
- Triangles < 900 k.
- Texture memory < 256 MB. Procedural/canvas-generated maps preferred over downloads.
- Lazy-load the emulator only on power-on.
- Full asset budget < 3 MB gzipped, excluding the hotlinked emulator.

Presentation is capped at approximately **60 Hz**, independent of 120/144 Hz display
refresh. The drawing buffer is capped at **2560×1440 physical pixels**. The CRT processor
runs at approximately **60 Hz** on a dirty scheduler and follows the active drawing-buffer
width while retaining at least **2×** source resolution, up to **1536×1152**.

Measured 2026-08-07: at 1920×1080 DPR 1, scene draw calls fell from **258 to 137** and
triangles from **677,173 to 507,817**; at 390×844 DPR 1, scene calls fell from **129 to
71** and triangles from **584,617 to 445,825**. A requested mobile DPR 3 is capped to an
effective DPR 2 and a 780×1688 drawing buffer. `tools/profile.mjs` records viewport,
effective DPR, buffer dimensions, CPU count, and load average with every artifact.
With the corrected full-screen framing, the current default views measure **112**
scene-only calls and **467,609** triangles at desktop DPR 1, and **110** calls /
**477,637** triangles at mobile DPR 3. Both full projected CRT bounds fit their viewport;
these counters are frustum-dependent, so use an identical pose for A/B claims.

## 11. Quality bar

Acceptance is a blind side-by-side against `reference/raw/`. A critic must not reliably
identify the render; the target is product photography, not a game asset.
