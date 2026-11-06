# Swarm Rebuild–Style Construction Intro — Implementation Plan

Companion to `Swarm Rebuild Implementation Prompt.md`. This plan applies that prompt to
**this repository** (Next.js 15.5 App Router portfolio, single route `/`), and resolves every
decision the prompt leaves open with a concrete choice for this codebase.

---

## 0. Applicability verdict

**Applicable: YES**, with four site-specific constraints the generic prompt does not cover:

| # | Constraint in this portfolio | Consequence for the plan |
|---|---|---|
| 1 | The page was just optimized: LCP ≈ **0.6–1.1 s**, First Load JS ≈ **406 kB** | The overlay must be code-split (`dynamic(..., { ssr: false })`), never block the critical path, and capture must happen **after** first contentful paint so the browser never shows a blank page |
| 2 | **WebGL globe** (three.js canvas), **CanvasRevealEffect** gradient canvas, huge blurred **Spotlight SVGs**, lofi background blobs | Cursor reconstruction can reproduce DOM geometry, not canvas pixels. These nodes get an **exclusion strategy** (§4.4): their *containers* are constructed as DOM, their *dynamic content* appears only during the final reveal |
| 3 | Hero headline uses **TextGenerateEffect** (opacity/blur stagger, starts after hydration) | Capture waits for the hero animation to settle (~1.6 s after load) so the snapshot represents the final design |
| 4 | Testimonials use a cloned DOM (`cloneNode`) and bento cards contain cloned InfiniteCards | The snapshot must tolerate duplicated/no-id nodes and nodes that mutate during capture; the overlay animates **frozen clones**, never live nodes |

Everything else the prompt requires (isolated overlay, swarm cursors, typed text, drag-drawn
rectangles, dependency-aware scheduling, sound, reliability, testing) is implementable as
specified on a standard React/Next.js DOM tree.

## 1. Reference-usage policy (revised per user decision, 2026-11-06 — binding)

The user chose the normal developer workflow for the reference repo: **compare against their
code while we build, as long as we don't copy it 1:1.** This replaces the earlier strict
clean-room rule. The factual situation stays as measured: the upstream repo ships **no
LICENSE** (`license: null`, checked via GitHub API on 2026-11-06), so its code is
all-rights-reserved by default — and copyright has no "100% identical" threshold.
Substantially-similar code is a derivative work even after renames and reworded comments.

What that means in practice, split by what copyright actually covers:

| Category | Status | Rule for us |
|---|---|---|
| Ideas, algorithms, mechanisms, tuning constants, computed-style property whitelists, visual parameters (agent counts, easing shapes, cursor archetypes) | **Not copyrightable** (facts/ideas) | Free to study and reuse — including specific numeric values as starting points, then tune |
| Their literal code text (structure, identifiers, comments) as whole files or big blocks | **Protected** | Do not paste into our bundle or repo |
| Their assets (mp4/gif/png icons, store screenshots) | **Protected** | Never ship them; synthesize our own visuals/sounds |

Guardrails (checked at M2 code review and at the final review; violations are fixed before
merge):

1. The study clone of `swarm-cursors` lives **outside this project** (e.g.
   `C:\Users\Ayoub\StudioProjects\_refs\swarm-cursors`) — never vendored, never imported, no
   raw copies of its files committed here.
2. Knowledge flows through `REFERENCE-NOTES.md` next to the code: mechanism summaries and
   constants, **zero code text**. We implement in TypeScript against those notes, with our own
   module layout (per §3) — which already diverges heavily (shadow-root overlay, React, capped
   element budgets, Next.js integration vs single-file Chrome extension).
3. Technique reuse is fine (e.g. their pseudo-element→real-span trick, float shims, inert
   document for clones) when written fresh with our own naming and docs. If we do adopt any
   near-verbatim snippet for a technique that is genuinely this-or-bust, it is recorded in
   `REFERENCE-NOTES.md` and we add a courtesy credit line in the README
   ("keyboard-inspired visual experience, original concept: swarm-cursors"). That is best
   effort good faith, not a legal shield — the goal is minimal overlap.
4. A quick similarity audit during final review: grep our modules for distinctive upstream
   function names and long copied strings (their unique literals like the cursor SVG
   path definitions are redesigned as our own drawn shapes, not copied).
5. Not a standing legal opinion, no lawyer consulted: this is a pragmatic policy for a
   personal, non-commercial portfolio that the user has chosen.

Adaptation notes already learned from a first read (verified in `REFERENCE-NOTES.md`):

- The extension rebuilds largely **on canvases** (their header comment: "rebuild it on a
  canvas") and takes a **tab screenshot** via the Chrome extension API for pixels its DOM
  cannot give back (WebGL canvases, playing video, cross-origin iframes). A plain website has
  no such API → our exclusion/final-reveal strategy (§4.4) is the right substitute, now
  confirmed by their own design.
- They clone into **inert documents** (`document.implementation.createHTMLDocument`) so the
  host page's framework code never upgrades clones — directly relevant to our
  cloned-testimonials / InfiniteCards tree.

## 2. Non-negotiable invariants (mirrors Phase 2 of the prompt)

The following files are **do-not-touch** (except the integration files listed in §9):

- All of `src/app/components/**` (except nothing — none are modified)
- `src/data/**`, `src/lib/**`
- `globals.css` (overlay ships its own CSS, injected into its shadow root)
- `tailwind/postcss config`, `next.config.ts`

The only integration points in the whole repo:

1. `src/app/page.tsx` — one lazy import of `<SwarmIntro />` (§9).
2. `package.json` — at most one devDependency (`@playwright/test`) for Phase 7 testing; **zero
   runtime dependencies** unless a hard blocker is documented.

Budget caps for the whole feature (constrains implementation choices):

- Runtime bundle: **≤ 25 kB** gzipped (organized as its own lazy chunks, verified in build output).
- Snapshot memory: **≤ 12 MB** for the element payload; elements beyond the cap get a
  cheaper "group reveal" animation rather than per-element routines (§4.5).
- Total animation duration: 9–14 s desktop, 6–8 s mobile profile.
- Main-thread long tasks introduced: **no task > 50 ms** after the intro starts; snapshot work
  is chunked across idle frames.

## 3. Architecture

All new code lives in **one directory**, client-only:

```
src/app/components/swarm/
  index.ts                  — re-exports <SwarmIntro>; the single public surface
  SwarmIntro.tsx            — orchestrator (mount, eligibility, lifecycle, fail-safe)
  capture/
    snapshot.ts             — DOM walker: element records + live-state lock-in
    classify.ts             — element classification (text/rect/image/svg/icon/decor/excluded)
    exclusions.ts           — the site-specific skip list (globe canvas, spotlight SVGs…)
    hashing.ts              — content hashing for snapshot integrity check
  build/
    overlay.tsx             — shadow-root overlay host, viewport math, DPR handling
    nodes.tsx               — renders frozen pseudo-DOM from snapshot records
    routines.ts             — per-type construction animation routines (timeline chords)
    reveals.ts              — clip-reveal / group-reveal / final-reveal helpers
    scheduler.ts            — dependency-aware timeline, priority lanes, no scattered timers
  agents/
    cursors.ts              — N cursor agents: path planner, easing, physics (enter/exit)
    paths.ts                — spline path library (bezier, flock, handoff, gathering)
    pointerLayer.ts         — one composited canvas for all cursors + trails + outlines
  fx/
    sound.ts                — Web Audio synth engine (no audio files), user-triggered only
    controls.tsx            — skip / replay / sound toggle (single small cluster)
  state/
    policy.ts               — eligibility rules + storage keys + URL flags
    session.ts              — persistence (played-once, toggles), SSR-safe
  diagnostics/
    integrity.ts            — post-run assertion suite (§8.3)
```

Data flow (one direction, no global state):

```
SwarmIntro (client mount)
  → policy.ts: eligible? (screen, motion, session, save-data, GPU)
  → wait for readiness (FCP + fonts.ready + hero settle + below-fold images idle-critical)
  → capture/snapshot: walk DOM once → records[] + frozen clones
  → scheduler: topological build plan from records
  → agents/cursors: N agents consume plan via work queue
  → overlay: renders + animates pseudo-DOM inside ShadowRoot
  → completion: integrity check → final reveal (unhide real page) → fade overlay → dispose
```

### Why Shadow DOM for the overlay

`globals.css` is Tailwind v4 preflight + utilities targeting global selectors; a shadow root
guarantees cursor/caret/guide visuals can't collide with site CSS, and site styles can't leak
into the overlay. The reconstructed page content itself is painted via inline styles captured
from the real DOM (§4.2), so it doesn't need Tailwind inside the overlay.

## 4. Module specifications

### 4.1 `capture/snapshot.ts` — visual snapshot

- **When:** after `document.fonts.ready` + first paint (`FCP` observed via
  `PerformanceObserver`) + hero TextGenerateEffect settle (fixed 1.6 s grace, or
  `requestAnimationFrame`-settle detection) + `window.load` or a 4 s timeout, whichever first.
- **How:** a single synchronous-ish `TreeWalker` over `document.body`, chunked with
  `requestIdleCallback` to keep long tasks < 50 ms. Per visible node record:
  - `rect` (`getBoundingClientRect`, viewport coords; converted to overlay coords once)
  - `paint`: `background-color/-image`, `border(s) + radius`, `box-shadow`, `opacity`,
    `transform` if non-identity, `z-index`
  - `type`: `text` (with `textContent`, `font: computed shorthand`, `color`, `lineHeight`,
    `letterSpacing`, `textAlign`), `image` (`currentSrc`, `natural size`, `objectFit`,
    `borderRadius`, alt via element), `svg` (total size + `outerHTML` of leaf SVGs ≤ 8 kB;
    larger ones → exclusion), `container` (geometry + paint only), `excluded`
  - `role`: hierarchy rank used by the scheduler (viewport-major, then depth, then Y order)
- **Frozenness:** all records derive from measured geometry; the overlay never references the
  live nodes after capture, so live animations (globe rotate, moving borders) cannot desync it.
- **Clones:** leaf SVG markup strings are stored (inline `<img>`-like rendering of the same
  path data is **not used** — exact `outerHTML` avoids transform-attribute drift).
- **Integrity:** snapshot records are checksummed (element per index, count + total area);
  used by the scheduler to detect mid-animation layout drift of the real page (browser tab
  resize during intro → abort policy, §4.7).

### 4.2 `build/overlay.tsx` — isolated presentation layer

- A portal-level `<div>` appended to `document.documentElement` containing a **shadow root**.
- Original page hidden with `visibility: hidden` on `body` (not `display:none` — preserves
  layout and prevents reflow/CLS; captures cascade-change events only within overlay).
- Overlay draws a full-viewport-capable surface whose coordinate space is **window-relative at
  current scroll offset**. Scroll is locked during the intro by a `scroll` event
  `preventDefault`-suppression listener + `overscroll-behavior: contain` on the overlay (no
  site-DOM changes; removed on completion).
- The reconstructed page is *rendered as it is built*: a pale-grey wireframe canvas + progress
  ghost rectangles already exist at t=0 (Swarm Rebuild look); built items paint progressively
  on top.
- Support for dynamic viewport units: rebuilt from `visualViewport` values at capture; a
  `resize` beyond 12 % delta → abort + instant reveal (mobile rotation case).
- DPR-aware rendering for the cursor canvas (`devicePixelRatio` capped at 2).

### 4.3 `build/scheduler.ts` — dependency-aware timeline

- Input: snapshot records ranked into a **building order**:
  1. viewport backdrop (body/backgrounds/watermark images)
  2. major section containers (rounded hero ring, bento grid frame, section shells)
  3. mid-level containers (cards, nav, footer bar)
  4. leaf content (text blocks in hierarchy order, images, icons)
  5. decorative details (gradients, borders, small SVGs, alignment passes)
  6. polish wave (selection outlines sweep + final "alignment guides" flash)
- Emits a **work queue** consumed by cursor agents; each task gets a `startGate`
  (dependencies committed) and an assigned cursor at dispatch time.
- Concurrency: default 4 agents on desktop (3 on mid-size, 2 mobile-capable profile), each
  working a task lane; tasks touching >= 1 shared parent container are serialized by the
  scheduler (no conflicting animations on one subtree).
- Timing engine: a single `requestAnimationFrame` loop in `overlay` drives *every* active
  routine against a deterministic master clock (pause when `visibilityState !== 'visible'`,
  resume on re-focus without expiring the plan). **No `setTimeout` in any routine**; delays are
  tick offsets.
- Determinism: the plan is a pure function of (snapshot, seed, profile, clock); the same seed
  produces the same choreography (seed is logged once for reproducibility in testing).
- Duration envelope enforced centrally (12 s ± 2 s desktop): the scheduler compresses
  remaining lanes proportionally if a slow image forces a lane wide.

### 4.4 `capture/exclusions.ts` — site-specific skip list

Cursor routines deal with *geometry and paint*; anything whose pixels are canvas-generated or
procedural is **excluded from reconstruction** and instead handled by the **final reveal**:

| Site node | Handling |
|---|---|
| `Globe.tsx` canvas (bento card 2) | Card frame/text/etc built as DOM; canvas area shows a wireframe placeholder; real canvas pops in during final reveal |
| `GradientBg` canvas (`/api lofi`) internals | Card container reconstructed; canvas content via final reveal |
| `Spotlight` big SVGs (hero, projects) | Too large to inline (`outerHTML` >> 8 kB); reconstructed as **clip-reveal** rectangles revealing the frozen snapshot region (drawn from a paint-clone, §4.5) |
| `bg.png`, webp images | Real `<img>` elements rendered from the same cached URLs (they're already downloaded; zero extra bytes) |
| `FloatingNav` | Excluded (not visible onload; hiding/reshowing it is out-of-scope) |
| confetti/Lottie | Excluded (only playable post-intro) |
| scrollbar-canvas | n/a |

Row principle: reconstruct *anything with a CSS box model*; exclude *anything whose pixels are
canvas/shader-generated*, replacing with a "final reveal" beat.

### 4.5 `build/routines.ts` + `reveals.ts` — per-type construction animations

All routines take `(record, ctx, timeline)` and return a composition of keyframed channel
mutations applied by the master clock (opacity/transform/clip/background/border — no layout
writes inside the overlay).

- **`rect`/container** (Swarm Rebuild's signature drag-draw): cursor drags from a corner seed
  point to the opposite corner; the rectangle interpolation matches my plan spec:
  1. selection rectangle (dashed outline + 8 resize handles) grows as the cursor drags
  2. background fill fades to actual captured color/gradient
  3. border draws itself (stroke-dash interpolated), radius appears
  4. box-shadow eases in last
- **`text`**: cursor "positions" a text cursor; characters type in with per-character opacity
  + tiny y-offset (no blur — keeps LCP-grade clarity); atomic <span> level. Multi-line
  paragraphs type line-by-line, not glyph-by-glyph, when > 120 chars (duration guard). Font
  metrics from the record; caret blink; single quotes and symbols preserved byte-exact.
- **`image`**: cursor drops a frame (dashed outline) → image loads from the working URL set
  (`decoding=async`) → clip-path reveal (sweep of `inset()`), then shadow/radius finalize.
  `onerror` at capture = placeholder grey weave + reveal anyway (never block, §4.7).
- **`svg`/icon**: `opacity + scale (0.94 → 1)` + stroke-dash draw for stroke-based paths
  (approximation only ≤ 2 kB of inline path data; otherwise simple scale reveal).
- **`clip-reveal`** (excluded large nodes): region painted as `background-image` of an
  overlay-native element from a *paint clone* captured per-region (`element.cloneNode(true)`
  rendered into an offscreen SVG `<foreignObject>` → data URL; if this fails, the region is
  left for the final reveal — fallback path).
- **`group-reveal`** (budget overflow): whole subtree fades+unmasks as one unit when the
  element budget (§2) is exhausted — keeps cap deterministic.
- **final reveal**: site `visibility: hidden → visible` in a 380 ms cross-fade with the
  overlay at opacity 0.96→0; overlay removed from DOM within one frame after fade ends.
- **abort path (fail-safe)**: single function `revealNow()` used by abort, error, skip, and
  integrity-mismatch: unhides page, cancels all agents/lanes/sound, removes overlay — idempotent,
  callable at any point, keep at ≤ 100 ms runtime.

### 4.6 `agents/` — the cursor swarm

- **Agents:** `N = clamp(3, 6)` desktop. Plural identities come from generated sprite
  variants (two-color pointer molecules), not the reference's assets.
- **Path planner:** each agent has a waypoint pipeline (current task target → exit point →
  optional handoff target), producing route splines (Catmull-Rom through jittered control
  points, deterministic per seed).
- **Motion model:**
  - acceleration/deceleration: ease-out on approach (no linear travel), `overshoot ± 2–3 px`
    on arrival for organic feel, quick settle-back
  - flocking micro-behavior in transit: gentle attraction to co-moving agents on the same
    lane + per-agent noise, so they *appear* coordinated without merging into a point cloud
  - click burst: on task start (1 frame ellipse + ring), on task end (small ring)
  - drag: while a container draws itself, its cursor is the one "carrying" the handle
  - trails: fading polyline per agent (alpha 0.25 → 0, capped at 24 points, drawn on the
    single shared pointer canvas)
- **Visibility cadence:** agents idle-fly between "gathering points" when their lane is empty,
  then converge center-viewport at the end (the reference's signature finale) and fly away
  (fade + slide out per a staggered schedule).
- All cursors render on **one composited canvas** (fixed layer, own `requestAnimationFrame`
  chunk) — no DOM cursor elements; the trails/ptr layer is purged with the overlay.

### 4.7 Reliability & fail-safe (Phase 6 mapped)

- If anything throws **before** the site is hidden → intro never engages (log + no-op).
  If anything throws after hiding → `revealNow()` immediately (site visible in ≤ 100 ms).
- Failure *specifically inside* each of: snapshot capture, scheduler plan build, cursor
  render loop, reveal — each has the same outermost cancellation-semantics contract.
- No event listeners on site elements; only on `document`/`window` (scroll lock, resize check,
  visibility, keydown for `Esc`-to-skip) — all removed in cleanup (`Throwable` dispose on
  the SwarmIntro host component as well as the overlay materializations).
- Timers: zero `setTimeout`/`setInterval` in SwarmIntro/cursor code (single rAF loop; delay
  lanes are clock offsets — audited in code review + `integrity.ts` asserts at runtime).
- Hydration: server renders nothing for SwarmIntro; mount effect only uses `document` after
  non-SSR flag; `sessionStorage` reads happen inside `useEffect` → no hydration mismatch.
- Tab visibility: master clock pauses while hidden, resumes in place (plan never "expires")
- Resize beyond tolerance / orientation shift mid-run: `revealNow()` + play again on next load
- Flash-of-unstyled-glyphs (FOUT) avoidance: the intro never starts before fonts.ready
- Returning visitors (no replay spam): `sessionStorage` key prevents re-run in the same tab
  (per-tab intent; `?replay=1` or query param forces replay for testing).
- **Every count above is asserted** in diagnostics (assertions run in all builds during dev to
  catch "one sneaky timer" violations).

### 4.8 `fx/sound.ts` — Web Audio synthesis

- **No sound by default** (storage `swarm.sound = off|on`, tiny toggle in controls cluster).
- Synthesised voices (no asset files, no autoplay concerns beyond the gate):
  - cursor launch: soft 40–80 Hz sine sweep (−30 dBFS)
  - "grab": 1.2 kHz short triangle tick (−34 dBFS)
  - type: per-line typing noise burst, band-limited (−38 dBFS)
  - element resolve: gentle "pop" (noise + sine, −28 dBFS)
  - completion: tiny two-note motif (−26 dBFS)
- Strict gate: `AudioContext` created **only inside the first user gesture** on the toggle;
  if created via `?sound=1` param pre-visit, waits for first pointer interaction anyway.
- Master limiter so even repeated sfx at once stay below −20 dBFS.

### 4.9 `state/policy.ts` — eligibility decision (prompt Phase 4 handles listed)

| Guard | Rule | Reason |
|---|---|---|
| Mobile | play reduced profile: same choreography, agent count 2–3, element budget 120, duration 6–8 s | prompt says handle mobile devices, not exclude; phones can play a lighter intro |
| Sanctions/perf | skip if `navigator.hardwareConcurrency <= 2` or `deviceMemory <= 2` | low-end devices: guarantee fail-safe 0s |
| Reduced motion | **skip intro entirely** (and log) | prompt requires reduced-motion support; intro is motion-heavy |
| Save-Data / Data Saver | skip | data has priority |
| Tab was restored / back-forward cache | skip on `pageshow.persisted` | restored session shouldn't re-animate |
| Returning visitor in this tab | skip (sessionStorage `swarm.played`) | no annoyance on reloads |
| URL `?replay=1` | force play + ignore session skip (and force `swarm.played` reset) | testing / sharing |
| URL `?noSwarm=1` | hard disable regardless of session | escape hatch for CI/tests/lighthouse |
| Dev mode | plays in dev too (visual QA); `localStorage.swarm.disabled = 1` respected, `?noSwarm=1` respected | controllable during development |
| Web Audio | only after user gesture on the toggle | §4.8 |

Storage keys (namespaced to avoid collisions):
`swarm.played`, `swarm.sound`, `swarm.disabled` (session/localStorage mix documented in code).

### 4.10 `controls.tsx` — unobtrusive controls

One small cluster of at most 3 36-px circle buttons, bottom-right, appears **during** the
intro (skip + sound) and for 5 s after completion (replay → `?replay=1` behavior, sound),
then disappears entirely. No labels by default (icon-only + `title`/`aria-label`), keyboard
accessible (`Esc` always skips the intro regardless of controls visibility — hardcoded in
SwarmIntro's keydown handler). The cluster lives inside the overlay shadow root → no global
class/style leakage; the cluster uses zero site classes.

## 5. Runtime integration (the only site diff)

```tsx
// src/app/page.tsx — top of file:
const SwarmIntro = dynamic(
  () => import("@/app/components/swarm").then((m) => m.SwarmIntro),
  { ssr: false }
);

// inside the returned outermost fragment/div: <SwarmIntro /> (renders null on server)
```

That's **it** for the site: one component, zero props, zero global CSS additions. The overlay
mounts itself on `documentElement` via its own render call (a `createPortal`-free approach:
shadow-root host div appendChild + a plain-react root via `createRoot(host)`) so no React tree
anywhere in the app is affected. `next.config.ts` untouched (dynamic import is enough).

Risk avoided: the overlay must NOT be a React portal from `SwarmIntro`'s own tree if the site
ancestor applies transforms/filters (`filters[%]`, `overflow` clipping) — the host div is
appended to `documentElement` (outside any transformed ancestor) to guarantee
`position: fixed` behaves correctly.

## 6. Element budget formulation (concrete numbers)

Desktop reference run (DPR 1.0, 1920×1080):

| Element class | Count (measured estimate) | Routine cost |
|---|---|---|
| total candidate DOM nodes | ~900 | cut in 3 passes |
| after `display:none` + zero-area prune | ~420 | — |
| artifacts: icons `<svg>`, badge chips, ring divs | ~180 | micro-anim (≤ 400 ms) |
| text leaf nodes | ~90 | type (20–350 ms each by charcount) |
| rect containers (bento cards, section shells) | ~35 | drag-draw rails (800–1400 ms) |
| images/logos | ~25 | reveal (600–900 ms) |
| excluded (canvas/large svg/watermark) | ~12 | clip or final reveal |

Plan the scheduler to finish the "big structures + all above-fold content" in ≤ 7 s, leaving
the tail wave (below-fold decorative) to the fast group-reveal pass (2–3 s) if needed. Above-
the-fold priority guarantees the *impression* of the site rebuilding, not literally 900
sequences in series.

## 7. Testing & verification plan (Phase 7)

Test tooling (existing `Playwright` not installed): add as **devDependency only** —
`npm i -D @playwright/test` — with `tests/swarm/` containing:

1. `boot.spec.ts` — eligibility (mobile/tablet/desktop viewports), skip flags, replays.
2. `reconstruct.spec.ts` — overlay is inside shadow root at `documentElement`; site becomes
   `visibility: hidden` exactly once; same shadow-root host removed & site unhidden
   (asserted) post-run.
3. `restore.spec.ts` — post-intro: compare screenshots per section against
   `tests/swarm/__screenshots__/baseline-*` (captured via the current site state) with
   per-pixel diff threshold (browser-based, deterministic size 1920×1080 and 390×844).
4. `interaction.spec.ts` — post-intro: all links/buttons clickable, confetti still fires on
   the copy-email button, globe still renders when scrolled to, no console errors during the
   whole intro and after.
5. `a11y.spec.ts` — `prefers-reduced-motion` skips intro; `Esc` skips mid-run.
6. `perf.spec.ts` — Lighthouse run with `?noSwarm=1` (performance ≥ 95) and without
   (performance ≥ 85 while intro plays) — documents the intro's LCP impact; trace assertions:
   no long task > 50 ms after overlay start, no network requests added by the intro beyond
   lazy chunks already cached.
7. **Manual chores** (documented): after first deploy — re-run site audit (globe/confetti
   consoles) with `?replay=1` and on a clean session, three times.

Plus non-Playwright evidence from this session's tooling (browser evaluate console/network
checks) recorded in the final report.

## 8. Acceptance criteria mapping

| Prompt criterion | Where satisfied |
|---|---|
| Auto-play on first visit | policy.ts default-on rules §4.9 |
| Faithful multi-cursor swarm | agents/ §4.6 (paths, easing, flocking, trails, click bursts) |
| Actually constructs the real site | snapshot is the real rendered DOM §4.1; overlay paints real geometry/paint/text §4.2 |
| Per-type construction animations | routines §4.5 by element class |
| Concurrent, conflict-free building | scheduler lanes + parent-exclusive locks §4.3 |
| Final site pixel-identical | restore spec §7.3 + integrity hash §4.1; the site DOM is untouched (only `visibility` toggled) |
| Functionality intact | interaction spec §7.4 + zero site-DOM changes; no listeners on site nodes §4.7 |
| Skip/replay reliable | controls §4.10 + URL flags §4.9 + `Esc` |
| No perf/console errors | perf spec §7.6 + budget caps §2 |
| Mobile, returning visitor, reduced motion, tab changes | §4.9 + §4.7 |
| Failsafe | single `revealNow()` contract §4.5/§4.7 |
| Reference-clean | §1 (guardrailed reference usage: ideas/algorithms/constants OK, literal code + assets not copied) |

## 9. Deliverables summary

- **Files created:** the `src/app/components/swarm/` directory (≈ 16 files plus
  `REFERENCE-NOTES.md`, est. 1800–2200 LOC including JSDoc), `tests/swarm/*`.
- **Files modified:** `src/app/page.tsx` (≈ +5 lines), `package.json` (one devDependency),
  optionally `README.md` (3-line "first visit intro" note).
- **Nothing else in the repository changes.**

## 10. Milestones (each ends in verification, matches the prompt's phased setup)

| M | Deliverable | Verification gate |
|---|---|---|
| **M0** | Repo study + deep-read of `swarm.js` (capture → blueprint → scheduler → render → agents → audio) into `REFERENCE-NOTES.md`, baseline screenshots (desktop/tablet/mobile), this plan finalized | notes cover all subsystems without pasting code text; screenshots committed under `tests/swarm/__screenshots__/` |
| **M1** | Snapshot engine + classifier + exclusions (no overlay yet; runs via debug flag) | console dump of element counts per class matches §6 estimates ± 20 %; snapshot cost < 0.6 s |
| **M2** | Overlay + pseudo-DOM renderer + restore (no animation: "build instantly" mode) | A/B screenshots at merge point: site skipped vs rebuilt → pixel-identical |
| **M3** | Routines (text/rect/image/svg/clip/group) wired to scheduler | all six types demonstrable in one animation at `?replay=1`; no routine > 1.4 s and no total run > 14 s |
| **M4** | Cursor agents + pointer canvas + sounds + controls | visual QA against reference look (not code) at 60 fps; sound toggle only-after-gesture verified |
| **M5** | Policy/fail-safes + integration into `page.tsx` + removal of debug views | full §7 test suite green in `production` mode |
| **M6** | Final polish: budget tuning vs §2 caps, complete report (architecture, limitations, test results, control instructions) | acceptance checklist §8 all ↔ pass |

## 11. Risks & mitigations (top 6)

1. **Canvas regions look "empty" while their DOM frame is rebuilt** — mitigated by the final
   reveal beat (§4.4) which is faithful to the reference (React components appear whole there
   too).
2. **Snapshot drift** (live site animation moves a node between capture and unhide) —
   mitigated by freezing only geometry; restored page is the live tree, not the clones, so
   drift is impossible to *render* wrong; integrity hash only guards abort-worthiness.
3. **Overlay jank on low-end** — capped element budget + reduced profile + abort on
   `deviceMemory`/`hardwareConcurrency` floors §4.9.
4. **Below-fold build feeling fake** — below-fold is the group-reveal wave (§4.5), never
   over-invested; the reference's credible reconstruction is above-the-fold depth + quick tail.
5. **Killed mid-animation** (navigation/reload) — visibility-lock is per-tab with no persisted
   state, and the real page is never hidden before a healthy capture; no restore needed on
   next load (state = site itself).
6. **Pointer-canvas DPR cost** — capped dpr 2, single shared canvas, trails capped at 24 pts,
   all vector sweeps drawn once per frame.

## 12. Explicitly out of scope

- Changing scroll behavior, routing, or any site animation (including hero blur, Lobster
  date cursor, card hover, focus states) — all stay as-is.
- Intro music (only sfx; the reference has none of what the prompt calls "sound track").
- The Chrome-extension feature set itself (only its visual language, re-implemented).
- SSR Or pre-hydration flash mitigation beyond the existing `suppressHydrationWarning`
  already in `layout.tsx`.
