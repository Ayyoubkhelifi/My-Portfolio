# REFERENCE-NOTES — swarm-cursors study record

**Policy reminder (see `Swarm-Rebuild-Implementation-Plan.md` §1):** this file holds
*mechanism summaries and constants learned from the reference* — never verbatim code text or
assets. Implementation is written fresh in TypeScript against these notes. The reference clone
lives outside this repository.

- Repo: https://github.com/DhvanilPatel/swarm-cursors (`main`, tree sha `3d49e0ac…`)
- License status upstream: **none** (`license: null` via GitHub API, checked 2026-11-06)
- Form: Chrome MV3 extension. Injected script = `swarm-rebuild/swarm.js` (~3,826 lines,
  readable, commented); a `background.js` (3.3 kB) handles injection + the tab-screenshot
  API; `demo/index.html` is a standalone test page with forms, canvas, iframe, floats.

## Mechanism (from file header + capture section, confirmed)

1. Snapshot the live page into a blueprint: item kinds `text`, `rect`, `line`, `image`
   (+ form controls rendered as their visual value: checkbox/radio as inline SVG, inputs as
   text overlays, selects as chosen-option text, passwords as bullets).
2. Coordinate spaces: **"world" coords** for scrollable document content, **"over"/"under"
   screen layers** for fixed/sticky UI. Items carry `id`, version counters (`v`/`rv`), clip
   rectangles, parent links, opacity, blend mode.
3. Page is blanked, a swarm of agents rebuilds on canvas: crosshair-drawn rects, typed text,
   pen-tool lines, ruler guides with snapping, **alt-drag duplication** for repeated
   components. Re-injecting toggles the effect off (idempotent host handle `__swarmRebuild`).

## Constants worth reusing as starting points (facts, then tune them ourselves)

- Agent population: min 8, max 48; flock display 36; intro entrance 18. → For a personal
  site intro start near ~–12–16 agents and tune down for our cyan/blue/indigo palette.
- Blueprint item cap: 4,000 nodes; world height cap: 40,000 px.
- Their palette (Figma-like brand colors) is theirs to keep — we regenerate an original
  palette; our site palette suggests cyan/indigo accents on dark, which also differs. Old
  habits avoided here.
- Cursor archetypes supported: arrow, duplicate-arrow, pen (+pen-add, +pen-close), crosshair,
  ibeam, ew/ns resize — drawn as inline SVG paths (~24 px box). We re-draw our own path
  geometry per archetype.
- Visually-hidden nodes excluded via patterns: 1–2 px boxes with hidden overflow,
  `clip: rect(0 0 0 0)`, `clip-path: inset(50%)`.

## Capture techniques validated (ideas we adopt, in our own code)

- Computed-style capture via curated property whitelists per role (text/box/svg/media) rather
  than copying `cssText` wholesale — smaller payload, deterministic.
- `::before/::after` with content → materialized as real static spans (icon glyphs, chevrons,
  separators survive).
- Clones are imported into an **inert document** (`document.implementation.createHTMLDocument`)
  so the host page's framework code never upgrades/interferes with clones. Relevant for our
  testimonial clones / InfiniteCards duplicates.
- Canvas/iframe/video pixels: the **extension** grabs a tab screenshot via background.js and
  crops regions (their `cropShot`). A website cannot do this → our plan's exclusion +
  final-reveal strategy is confirmed as the correct web substitute. On non-tainted 2D canvases
  they attempt `toDataURL` (with a 12×12 probe) — same fallback applies to our site's
  CanvasRevealEffects if we ever want static patches.
- `<hr>` becomes a line item; border-sides of < 4 are emitted as pen lines instead of rects.
- Text leaves: `range.getBoundingClientRect()` for the tight text box; float shims reproduce
  wrap behavior around floated figures; sticky-vs-fixed detection; closed `<details>` builds
  only its summary.
- SVG in clones: `use`/gradients referenced from document defs get inlined so shadow trees
  don't lose them.

## Open questions for the M0 deep read — RESOLVED (full read complete 2026-11-06)

Full-library findings (mechanism level, no code copied):

- **Boot choreography:** overlay (opaque page-bg layer + intro logo) fades in ~0.5 s → page is
  unhidden behind it → an invisible "scan" sweeps the scroller to its bottom in ≤ 28 steps
  (forces lazy content + layout settle) → back to start → fonts.ready (≤ 1.2 s) → model
  capture → mount → build starts after ~1.5 s total. Our plan's capture-gating matches this;
  for a website we keep the page visible under an opaque cover instead of extension hiding.
- **Scheduler is Y-gated:** every task gets `gate = max(own y, deps' gates)`; tasks unlock
  only inside the current view band; a "frontier" = bottom of the current scroll. Seed `Tour`
  auto-scrolls to keep building. Our intro auto-pans by build progress (a Tour that runs on
  its own).
- **Coroutines:** each task routine is a JS generator; every frame the master clock calls
  `gen.next(dt)` with dt scaled by a global `tempo` (2.1–4.5 × speed, throttled by scroll
  velocity + available-task pressure). No per-routine timers. We adopt this pattern verbatim
  as an *idea*.
- **Cursor motion:** spring/orbit blend ("boids around a leader point"): radial spring + a
  tangential swirl term, per-agent `curl`/`orbit`/`spin`; neighbor velocity blending inside a
  ~90 px radius; quick arrival push; real-mouse repulsion ring (~48 px). `moveTo` = duration
  `clamp(0.12 + √dist·0.021, 0.14, 0.9)`, eased with a perpendicular bow `sin(π·e)·bend`.
  Tasks pick: nearest in-band task with view-band priority and guide boost.
- **Rect draw:** crosshair cursor → press → drag to far corner (drag end clamps so huge boxes
  keep the cursor on screen) → background/border/shadow appear via a `styled` flip (CSS
  transition). Big text: types at reduced scale then "grows" through size steps
  (24→32→…→its own fs) with tick sounds, then snaps to an alignment guide if assigned.
- **Dup groups:** sibling nodes with same tag|class|layer|kinds-signature and similar size
  (≤ 1.8× h, ≤ 1.6× w) group up; master builds normally; copies render **using the master's
  text clone/media** and are dragged from master into place (double-arrow cursor, red
  source/target outlines + gap-measure badge), then land with a settle transition. Copies
  whose text/media differs get follow-up edit/retype tasks. Identical text twins in the same
  rounded position merge into one build task.
- **Guides/rulers:** ruler strips slide in while a guide task runs; guides dragged out of the
  ruler with ew/ns cursors; player texts get ±28–64 px offsets while building, then a cursor
  drags them onto the guide with a red flash at the snap.
- **Overlay DOM:** selection rectangles + 8 handles + "W × H" badge, measure badges between
  elements, red guide lines, DOM-element cursors (not canvas) with per-frame transforms, an
  SVG layer diff-rendered for guides/selections/measures, bottom-center HUD with agent dots,
  "N / M layers", progress bar, Tour/speed/sound/Live/Replay/✕.
- **Sound ("glass piano"):** finished elements play one note of an E-major pentatonic
  anchored at E2, quantized to a 104 bpm 16th grid; octave from area (big→low, small→high) —
  the note rises left→right; voice = sine partials (one inharmonic) + felt-hammer noise tick,
  exponential decay through a generated noise-convolver "room"; typing = filtered noise
  clacks (throttled ≤ 80/s, per-key ≥ 24 ms); compressor + 0.9 master. Intro = noise swell +
  low pads; finale = strummed add9; exit = falling sweep. ALL synthesized. Our sound will be
  written fresh with a different scale/root/voice graph (D-pent-minor, own partials).
- **Teardown:** "Go live"/✕ really exits; ESC exits; replay re-runs from the original scroll
  position; on reveal the engine flips into a release flock, HUD fades, host fades after
  ~450 ms and is removed at ~1.15 s. Sound context closes after a tail.
- **Failure mode observed:** capture failure → empty model ({...} guards); frame-loop errors
  log via console.error and keep the loop alive; our plan requires stronger fail-safes
  (revealNow on any error) which we keep.

## Remaining adaptation notes

- Web page (not extension): no `chrome.runtime` screenshot for canvas pixels; implement the
  2D-canvas `toDataURL` probe for untainted canvases (our lofi gradient), else placeholder.
- No inner-scrolling port containers on our route → "under" layer unnecessary; layers become
  bg / world / overlay svg / cursors / hud.
- Single dark page, no forms → skip their form renderer entirely.
- Text: their leaf/run splitting handles our word-span headings perfectly (inline-block
  passes their "inline" test) — adopt leaf/run logic but written fresh.


## Recorded decisions

- 2026-11-06: read first 1,183/3,826 lines (constants, cursor drawing, capture/model side);
  remainder to be chunked by subsystem in M0 per the table above. No code text copied into
  this file.
