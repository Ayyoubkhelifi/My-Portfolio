/**
 * routines.ts — per-task construction choreography as generators.
 *
 * Every routine is a generator factory. The engine's master clock drives
 * `gen.next(scaledDt)` each frame; `yield` returns the (tempo-scaled)
 * delta in seconds. Routines continuously hand cursor targets back to
 * the engine, so the cursor motion stays spring-interpolated even
 * between frames (no snapping, no per-frame tweens with timers).
 *
 * `yield* wait(s)` suspends for s seconds of scaled time.
 */

import type { SwarmItem } from "../capture/model";
import type { AgentSwarm } from "../agents/agents";
import { View } from "./overlay";
import type { SoundEngine } from "../fx/sound";

// ─── Easing ───────────────────────────────────────────────────────────────────

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Yield-looper: suspends until `seconds` of scaled time has elapsed. */
export function* wait(seconds: number): Generator<number, void, number> {
  let elapsed = 0;
  while (elapsed < seconds) {
    const dt: number = yield 0;
    elapsed += dt;
  }
}

// ─── Routine context ──────────────────────────────────────────────────────────

export interface RoutineCtx {
  item: SwarmItem;
  /** The routine's agent slot. */
  agentIdx: number;
  view: View;
  swarm: AgentSwarm;
  sound: SoundEngine;
  /** Guide x this text item must snap onto, or null (world coords). */
  guideX: number | null;
  /** Deterministic jitter source (seeded per run). */
  rand: () => number;
  /** Move the routine's cursor. */
  moveTo(x: number, y: number, type?: "arrow" | "crosshair" | "ibeam" | "ew-resize" | "dup"): void;
  /** Click burst at world coords (converted by the engine). */
  click(x: number, y: number): void;
  /** Throttled typing clack. */
  typeClack(): void;
  /** Light up the alignment guide under a text item (snap beat). */
  snapGuide(x: number): void;
}

export type RoutineGen = Generator<number, void, number>;

// ─── Rect / container ─────────────────────────────────────────────────────────

function* drawRectRoutine(ctx: RoutineCtx): RoutineGen {
  const { item, view } = ctx;
  view.makeDrawOutline(item);

  const x = item.x;
  const y = item.y;
  const w = Math.max(item.w, 4);
  const h = Math.max(item.h, 4);

  // Cursor drags from top-left to bottom-right while the dashed frame grows.
  ctx.moveTo(x + 4, y + 4, "crosshair");
  yield* wait(0.1);
  ctx.click(x + 4, y + 4);

  const dur = Math.min(0.34 + Math.sqrt(w * h) * 0.00075, 0.95);
  let t = 0;
  while (t < 1) {
    const dt: number = yield 0;
    t = clamp01(t + dt / dur);
    const e = easeOutCubic(t);
    if (item.node) {
      item.node.style.width = `${Math.max(6, w * e)}px`;
      item.node.style.height = `${Math.max(6, h * e)}px`;
    }
    ctx.moveTo(x + w * e, y + h * e, "crosshair");
  }
  ctx.click(x + w, y + h);

  yield* wait(0.07);

  // Release: paint + fade in.
  view.clearDrawOutline(item);
  view.applyStyle(item);
  const fadeT = 0.2;
  let ft = 0;
  while (ft < 1) {
    const dt: number = yield 0;
    ft = clamp01(ft + dt / fadeT);
    if (item.node) item.node.style.opacity = String((item.op ?? 1) * easeOutCubic(ft));
  }
  if (item.node) item.node.style.opacity = String(item.op ?? 1);
}

// ─── Text ─────────────────────────────────────────────────────────────────────

function* textRoutine(ctx: RoutineCtx): RoutineGen {
  const { item, view } = ctx;
  if (!item.typed || !item.node) return;

  // Placement offset for the guide-snap beat.
  const snapTarget = ctx.guideX;
  const offX = snapTarget != null
    ? (ctx.rand() < 0.5 ? -1 : 1) * (18 + ctx.rand() * 34)
    : 0;
  item.node.style.transform = `translate3d(${offX}px, 0, 0)`;
  item.node.style.left = `${item.x}px`;

  // Move to the text start with an ibeam cursor.
  const ix = item.x + offX + 2;
  const iy = item.y + Math.min(item.h, 22) / 2;
  ctx.moveTo(ix, iy, "ibeam");
  yield* wait(0.08);
  ctx.click(ix, iy);

  // Fade in the empty box.
  let ft = 0;
  while (ft < 1) {
    const dt: number = yield 0;
    ft = clamp01(ft + dt / 0.14);
    if (item.node) item.node.style.opacity = String(easeOutCubic(ft) * (item.op ?? 1));
  }

  // Type characters. Big headings type slower (they matter more).
  const total = item.typed.seq.length;
  const cps = item.big ? 22 : 46;
  let shown = 0;
  let lastClackAt = 0;
  let t = 0;
  while (shown < total) {
    const dt: number = yield 0;
    t += dt;
    // Round to integer chars (avoids subchar writes).
    shown = Math.min(total, Math.floor(t * cps));
    view.revealText(item, shown);
    if (t - lastClackAt > 0.055) {
      lastClackAt = t;
      ctx.typeClack();
    }
    // Caret tracks the text edge.
    const edge = Math.min(item.w - 2, (shown / total) * item.w);
    ctx.moveTo(item.x + offX + edge, item.y + item.h / 2, "ibeam");
  }
  yield* wait(0.05);
  view.revealText(item, total);
  view.removeCaret(item);

  // Guide snap: drag the finished text onto the alignment guide.
  if (snapTarget != null && offX !== 0) {
    ctx.moveTo(item.x, item.y + item.h / 2, "ew-resize");
    yield* wait(0.06);
    ctx.click(item.x, item.y + item.h / 2);
    // Show the red guide while we settle.
    if (snapTarget != null) ctx.snapGuide(snapTarget);
    const settleDur = 0.3;
    let st = 0;
    while (st < 1) {
      const dt: number = yield 0;
      st = clamp01(st + dt / settleDur);
      const e = easeOutCubic(st);
      const cx = item.x + offX + (item.w / 2 - offX) * e;
      ctx.moveTo(cx, item.y + item.h / 2, "ew-resize");
      item.node!.style.transform = `translate3d(${offX * (1 - e)}px, 0, 0)`;
    }
    ctx.click(item.x, item.y + item.h / 2);
    item.node!.style.transform = "";
    if (snapTarget != null) ctx.snapGuide(snapTarget);
  } else {
    // No guide: just clear the transform.
    item.node.style.transform = "";
  }
}

// ─── Image ────────────────────────────────────────────────────────────────────

function* imageRoutine(ctx: RoutineCtx): RoutineGen {
  const { item, view } = ctx;
  const inner = item.node?.firstElementChild as HTMLElement | null;
  if (!item.node) return;

  const cx0 = item.x;
  const cy0 = item.y;
  ctx.moveTo(cx0 + 18, cy0 + 18, "crosshair");
  yield* wait(0.12);
  ctx.click(cx0 + 18, cy0 + 18);

  // Clip sweep on the inner content (top → bottom).
  view.makeDrawOutline(item);
  let ft = 0;
  const fadeT = 0.16;
  while (ft < 1) {
    const dt: number = yield 0;
    ft = clamp01(ft + dt / fadeT);
    if (item.node) item.node.style.opacity = String(easeOutCubic(ft) * (item.op ?? 1));
  }
  view.clearDrawOutline(item);

  if (inner) {
    inner.style.clipPath = "inset(100% 0 0 0)";
    const sweepDur = Math.min(0.24 + item.h * 0.0006, 0.55);
    let st = 0;
    while (st < 1) {
      const dt: number = yield 0;
      st = clamp01(st + dt / sweepDur);
      const e = easeOutCubic(st);
      inner.style.clipPath = `inset(${Math.round((1 - e) * 100)}% 0 0 0)`;
      // Cursor rides the reveal edge
      ctx.moveTo(item.x + item.w * 0.7, item.y + item.h * e, "crosshair");
    }
    inner.style.clipPath = "";
  }
  yield* wait(0.08);
}

// ─── Line ─────────────────────────────────────────────────────────────────────

function* lineRoutine(ctx: RoutineCtx): RoutineGen {
  ctx.moveTo(ctx.item.x + 2, ctx.item.y, "arrow");
  yield* wait(0.12);
  ctx.click(ctx.item.x + 2, ctx.item.y);

  let t = 0;
  const dur = 0.2;
  while (t < 1) {
    const dt: number = yield 0;
    t = clamp01(t + dt / dur);
    const e = easeOutCubic(t);
    if (ctx.item.node) {
      const child = ctx.item.node.firstElementChild as HTMLElement | null;
      if (child) child.style.width = `${e * 100}%`;
      ctx.moveTo(ctx.item.x + ctx.item.w * e, ctx.item.y);
    }
  }
  ctx.click(ctx.item.x + ctx.item.w, ctx.item.y);
  yield* wait(0.05);
}

// ─── Duplicate drag ───────────────────────────────────────────────────────────

function* dupRoutine(ctx: RoutineCtx): RoutineGen {
  const { item, view } = ctx;
  const master = item.dupOf;
  if (!master || !item.node) return;

  const dx = item.x - master.x;
  const dy = item.y - master.y;

  // Start as a copy sitting on top of the master.
  item.node.style.left = `${master.x}px`;
  item.node.style.top = `${master.y}px`;

  const mx = master.x + master.w * 0.5;
  const my = master.y + master.h * 0.5;
  ctx.moveTo(mx, my, "dup");
  yield* wait(0.1);
  ctx.click(mx, my);

  // Fade the copy in over the master, then drag it into place.
  let ft = 0;
  while (ft < 1) {
    const dt: number = yield 0;
    ft = clamp01(ft + dt / 0.14);
    item.node.style.opacity = String(easeOutCubic(ft) * 0.95);
  }

  const dragDur = Math.min(0.4 + Math.hypot(dx, dy) * 0.0013, 0.8);
  let t = 0;
  while (t < 1) {
    const dt: number = yield 0;
    t = clamp01(t + dt / dragDur);
    const e = easeOutCubic(t);
    // Non-linear path: slight arc instead of a straight lerp.
    const bow = Math.sin(Math.PI * t) * Math.min(30, Math.hypot(dx, dy) * 0.08);
    const nx = master.x + dx * e - (dy / (Math.hypot(dx, dy) || 1)) * bow;
    const ny = master.y + dy * e + (dx / (Math.hypot(dx, dy) || 1)) * bow;
    item.node.style.left = `${nx}px`;
    item.node.style.top = `${ny}px`;
    ctx.moveTo(nx + master.w * 0.5, ny + master.h * 0.5, "dup");
  }

  // Land: snap to the exact target and settle.
  item.node.style.left = `${item.x}px`;
  item.node.style.top = `${item.y}px`;
  ctx.click(item.x + item.w * 0.5, item.y + item.h * 0.5);

  // Copies show their full content as they settle.
  if (item.typed) {
    view.revealText(item, item.typed.seq.length);
    view.removeCaret(item);
  } else if (item.kind === "rect") {
    view.applyStyle(item);
  }
  item.node.classList.add("node-settle");
  let lt = 0;
  while (lt < 1) {
    const dt: number = yield 0;
    lt = clamp01(lt + dt / 0.2);
    item.node!.style.opacity = String((item.op ?? 1) * (0.95 + 0.05 * easeOutCubic(lt)));
  }
  item.node.classList.remove("node-settle");
  item.node.style.opacity = String(item.op ?? 1);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export type TaskType = "rect" | "text" | "image" | "line" | "dup";

export function routineFor(type: TaskType): (ctx: RoutineCtx) => RoutineGen {
  switch (type) {
    case "rect": return drawRectRoutine;
    case "text": return textRoutine;
    case "image": return imageRoutine;
    case "line": return lineRoutine;
    case "dup": return dupRoutine;
  }
}
