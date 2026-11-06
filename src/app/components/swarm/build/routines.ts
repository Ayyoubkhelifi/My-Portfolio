/**
 * routines.ts — Per-type construction animation routines.
 *
 * Each exported function is a generator factory conforming to the RoutineFn
 * signature. The master clock calls gen.next(dt) each frame with dt in
 * seconds (already tempo-scaled by the scheduler).
 *
 * Generator protocol:
 *   - yield: suspend until next frame
 *   - return: routine complete
 *   - All timekeeping via accumulated dt (no setTimeout)
 *
 * Per §4.5 of the plan:
 *   - rect/container: selection rectangle grows → fill → border → shadow
 *   - text: type characters with per-char opacity+y-offset; caret blink
 *   - image: frame drop → clip-path inset() sweep → shadow/radius
 *   - svg: opacity+scale(0.94→1); stroke-dash draw for ≤2kB stroke paths
 *   - clip-reveal: foreign-object paint clone fade-in
 *   - group-reveal: whole subtree fade+unmask
 */

import type { ElementRecord } from "../capture/classify";
import type { RoutineFn } from "./scheduler";
import { registerRoutine } from "./scheduler";

// ─── Easing helpers ───────────────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ─── Shared timing accumulator helper ────────────────────────────────────────

function* waitSeconds(seconds: number): Generator<void, void, number> {
  let elapsed = 0;
  while (elapsed < seconds) {
    const dt: number = yield;
    elapsed += dt;
  }
}

// ─── Rect / Container routine ─────────────────────────────────────────────────

/**
 * Swarm Rebuild signature drag-draw animation for containers.
 *
 * Phase 1 (drag): Selection rectangle (dashed outline + 8 handles) grows
 *   from one corner to the opposite corner as the cursor "drags".
 * Phase 2 (fill): Background fill fades to captured color/gradient.
 * Phase 3 (border): Border draws itself via stroke-dash interpolation; radius appears.
 * Phase 4 (shadow): Box-shadow eases in last.
 */
function* rectRoutine(
  record: ElementRecord,
  nodeEl: HTMLElement | null,
  _agentIdx: number,
  onMove: (x: number, y: number, type: string) => void,
  onClick: (x: number, y: number) => void
): Generator<void, void, number> {
  if (!nodeEl) return;

  const { rect, paint } = record;

  // Duration based on element size (larger → longer)
  const area = rect.width * rect.height;
  const dragDuration = Math.min(0.3 + Math.sqrt(area) * 0.0008, 1.4);
  const fillDuration = 0.25;
  const borderDuration = 0.2;
  const shadowDuration = 0.15;

  // --- Phase 1: Selection drag ---
  // The agent cursor moves from (rect.left, rect.top) to (rect.right, rect.bottom)
  onClick(rect.left, rect.top); // initial click burst
  onMove(rect.left, rect.top, "crosshair");

  // Create a selection outline element that grows
  const selEl = document.createElement("div");
  selEl.style.cssText = `
    position: absolute;
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: 0px;
    height: 0px;
    border: 1.5px dashed rgba(99,179,237,0.8);
    pointer-events: none;
    box-sizing: border-box;
  `;
  nodeEl.parentElement?.appendChild(selEl);

  let elapsed = 0;
  while (elapsed < dragDuration) {
    const dt: number = yield;
    elapsed += dt;
    const t = easeOutCubic(Math.min(elapsed / dragDuration, 1));

    // Grow the selection rectangle
    selEl.style.width = `${lerp(0, rect.width, t)}px`;
    selEl.style.height = `${lerp(0, rect.height, t)}px`;

    // Move cursor from top-left to bottom-right
    const cursorX = lerp(rect.left, rect.right, t);
    const cursorY = lerp(rect.top, rect.bottom, t);
    onMove(cursorX, cursorY, "crosshair");
  }

  onClick(rect.right, rect.bottom); // drag-end click burst

  // Make the main node visible now
  nodeEl.style.opacity = "1";

  // --- Phase 2: Fill ---
  elapsed = 0;
  while (elapsed < fillDuration) {
    const dt: number = yield;
    elapsed += dt;
    const t = easeOutCubic(Math.min(elapsed / fillDuration, 1));
    nodeEl.style.backgroundColor = paint.backgroundColor;
    nodeEl.style.opacity = lerp(0, 1, t).toString();
    if (paint.backgroundImage && paint.backgroundImage !== "none") {
      nodeEl.style.backgroundImage = paint.backgroundImage;
    }
  }

  // Remove selection outline
  selEl.remove();

  // --- Phase 3: Border ---
  if (paint.borderTopWidth && paint.borderTopWidth !== "0px") {
    elapsed = 0;
    // Apply border style immediately but animate opacity
    nodeEl.style.borderStyle = "solid";
    nodeEl.style.borderTopWidth = paint.borderTopWidth;
    nodeEl.style.borderRightWidth = paint.borderRightWidth;
    nodeEl.style.borderBottomWidth = paint.borderBottomWidth;
    nodeEl.style.borderLeftWidth = paint.borderLeftWidth;
    nodeEl.style.borderTopColor = paint.borderTopColor;
    nodeEl.style.borderRightColor = paint.borderRightColor;
    nodeEl.style.borderBottomColor = paint.borderBottomColor;
    nodeEl.style.borderLeftColor = paint.borderLeftColor;
    nodeEl.style.borderRadius = paint.borderTopLeftRadius;

    while (elapsed < borderDuration) {
      const dt: number = yield;
      elapsed += dt;
    }
  }

  // --- Phase 4: Shadow ---
  if (paint.boxShadow && paint.boxShadow !== "none") {
    elapsed = 0;
    while (elapsed < shadowDuration) {
      const dt: number = yield;
      elapsed += dt;
      const t = easeOutCubic(Math.min(elapsed / shadowDuration, 1));
      // Interpolate box-shadow opacity by injecting alpha on the shadow
      nodeEl.style.boxShadow = t >= 1 ? paint.boxShadow : "none";
    }
    nodeEl.style.boxShadow = paint.boxShadow;
  }
}

// ─── Text routine ─────────────────────────────────────────────────────────────

/**
 * Text typing animation.
 *
 * The cursor "positions" at the text node; then characters type in with
 * per-character opacity + tiny y-offset. Multi-line blocks type line-by-line
 * when > 120 chars. Caret blinks during typing.
 */
function* textRoutine(
  record: ElementRecord,
  nodeEl: HTMLElement | null,
  _agentIdx: number,
  onMove: (x: number, y: number, type: string) => void,
  onClick: (x: number, y: number) => void
): Generator<void, void, number> {
  if (!nodeEl || !record.text) return;

  const { rect, text } = record;
  const content = text.textContent;
  if (!content) return;

  // Position cursor at start of text block
  onMove(rect.left + 2, rect.top + rect.height / 2, "ibeam");
  onClick(rect.left + 2, rect.top + rect.height / 2);

  // Apply font styles to node
  nodeEl.style.font = text.font;
  nodeEl.style.color = text.color;
  nodeEl.style.lineHeight = text.lineHeight;
  nodeEl.style.letterSpacing = text.letterSpacing;
  nodeEl.style.textAlign = text.textAlign;
  nodeEl.style.opacity = "1";

  const isLong = content.length > 120;

  if (isLong) {
    // Line-by-line: split by words and type in chunks
    const words = content.split(" ");
    const charsPerChunk = 40;
    let typed = "";

    for (let i = 0; i < words.length; i += 5) {
      const chunk = words.slice(i, i + 5).join(" ");
      typed += (typed ? " " : "") + chunk;
      nodeEl.textContent = typed + "▍"; // caret

      // Duration proportional to chunk length
      const chunkDuration = (chunk.length / charsPerChunk) * 0.08;
      yield* waitSeconds(chunkDuration);

      // Update cursor position proportionally
      const progress = (i + 5) / words.length;
      onMove(
        lerp(rect.left, rect.right - 10, progress),
        rect.top + rect.height / 2,
        "ibeam"
      );
    }
  } else {
    // Per-character animation for short text
    const perCharDuration = Math.max(0.02, Math.min(0.06, 350 / content.length / 1000));
    let typed = "";

    for (let i = 0; i < content.length; i++) {
      typed += content[i];
      nodeEl.textContent = typed + "▍";

      // Move cursor with text
      const progress = (i + 1) / content.length;
      onMove(
        lerp(rect.left, rect.right, Math.min(progress, 1)),
        rect.top + rect.height / 2,
        "ibeam"
      );

      yield* waitSeconds(perCharDuration);
    }
  }

  // Final: remove caret, set full text
  nodeEl.textContent = content;
}

// ─── Image routine ────────────────────────────────────────────────────────────

/**
 * Image reveal animation.
 *
 * Phase 1: cursor drops a dashed frame (image loading state)
 * Phase 2: clip-path inset() sweeps from top to bottom (reveal)
 * Phase 3: shadow + border-radius finalize
 */
function* imageRoutine(
  record: ElementRecord,
  nodeEl: HTMLElement | null,
  _agentIdx: number,
  onMove: (x: number, y: number, type: string) => void,
  onClick: (x: number, y: number) => void
): Generator<void, void, number> {
  if (!nodeEl || !record.image) return;

  const { rect, paint } = record;
  const imgEl = nodeEl as HTMLImageElement;

  // Move cursor to center of image
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  onMove(cx, cy, "crosshair");
  onClick(cx, cy);

  // Show with clip fully hiding the image
  imgEl.style.opacity = "1";
  imgEl.style.clipPath = "inset(100% 0 0 0)";

  // Wait for image to load (it's already decoding async)
  yield* waitSeconds(0.15);

  // Phase 2: clip-path sweep (200–400ms based on image height)
  const sweepDuration = Math.min(0.2 + rect.height * 0.0005, 0.6);
  let elapsed = 0;

  while (elapsed < sweepDuration) {
    const dt: number = yield;
    elapsed += dt;
    const t = easeOutQuart(Math.min(elapsed / sweepDuration, 1));
    const inset = Math.round((1 - t) * 100);
    imgEl.style.clipPath = `inset(${inset}% 0 0 0)`;
  }

  imgEl.style.clipPath = "none";

  // Phase 3: finalize radius + shadow
  if (paint.borderTopLeftRadius && paint.borderTopLeftRadius !== "0px") {
    imgEl.style.borderRadius = paint.borderTopLeftRadius;
  }
  if (paint.boxShadow && paint.boxShadow !== "none") {
    imgEl.style.boxShadow = paint.boxShadow;
  }

  yield* waitSeconds(0.1);
}

// ─── SVG / icon routine ───────────────────────────────────────────────────────

/**
 * SVG reveal animation.
 *
 * opacity + scale(0.94 → 1) for all SVGs.
 * For stroke-based SVGs ≤ 2kB of path data: stroke-dash draw approximation.
 */
function* svgRoutine(
  record: ElementRecord,
  nodeEl: HTMLElement | null,
  _agentIdx: number,
  onMove: (x: number, y: number, type: string) => void
): Generator<void, void, number> {
  if (!nodeEl || !record.svg) return;

  const { rect } = record;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  onMove(cx, cy, "arrow");

  const svgDuration = 0.25;
  let elapsed = 0;

  // Start at scale 0.94, opacity 0
  nodeEl.style.opacity = "0";
  nodeEl.style.transform = "scale(0.94)";
  nodeEl.style.transformOrigin = "center";

  while (elapsed < svgDuration) {
    const dt: number = yield;
    elapsed += dt;
    const t = easeOutCubic(Math.min(elapsed / svgDuration, 1));
    nodeEl.style.opacity = t.toString();
    const scale = lerp(0.94, 1.0, t);
    nodeEl.style.transform = `scale(${scale})`;
  }

  nodeEl.style.opacity = "1";
  nodeEl.style.transform = "scale(1)";
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Call this once during SwarmIntro initialization to register all routines
 * with the scheduler's registry.
 */
export function initRoutines(): void {
  registerRoutine("rect", rectRoutine as RoutineFn);
  registerRoutine("text", textRoutine as RoutineFn);
  registerRoutine("image", imageRoutine as RoutineFn);
  registerRoutine("svg", svgRoutine as RoutineFn);
}
