/**
 * routines.ts — per-task construction choreography as generators.
 *
 * Every task runs as a coroutine that owns its cursor: timed bezier
 * glides (bowed approach arcs), presses, drag-draws with dimension
 * badges, character-budget typing with hesitations, alignment-guide
 * snapping and alt-drag duplicates with measure overlays.
 *
 * `yield` returns the raw frame delta; the engine multiplies it by the
 * live tempo inside its primitives (`moveGen/waitGen/…`), so a single
 * global tempo multiplier stretches every choreography uniformly.
 *
 * The engine implements RoutineHost; all source text here is our own.
 */

import type { Cursor } from "../agents/agents";
import type { Box, Guide, OvShape, SwarmItem } from "../capture/model";
import type { View } from "./overlay";
import type { SoundEngine } from "../fx/sound";
import type { LineEditState, Task } from "./scheduler";

// ─── Host contract ────────────────────────────────────────────────────────────

export type RoutineGen = Generator<number, void, number>;

export interface MoveOpts {
  /** Glide speed multiplier (source cursors use 0.35 idle … 3 flicks). */
  speed?: number;
  /** Ease like a mouse-button drag (slower ramp-in, no bend). */
  drag?: boolean;
  /** Perpendicular bow of the approach arc (null during drags). */
  bend?: number | null;
  /** Called every frame while gliding. */
  onStep?: () => void;
}

export interface RoutineHost {
  readonly view: View;
  readonly sound: SoundEngine;
  readonly rand: () => number;
  readonly editLines: LineEditState[];
  readonly vw: number;
  tempoNum(): number;
  viewTop(): number;
  viewBot(): number;
  fromViewport(x: number, y: number): { x: number; y: number };
  scr(c: Cursor): { x: number; y: number };
  bump(it: SwarmItem): void;
  bounds(it: SwarmItem): Box;
  unionBounds(items: SwarmItem[]): Box;
  selectionOf(it: SwarmItem): OvShape;
  spacing(a: Box, b: Box): OvShape | null;
  dragEnd(c: Cursor, it: SwarmItem): { x: number; y: number };
  sfxPlace(kind: string, it?: SwarmItem, b?: Box): void;
  flashGuide(g: Guide): void;
  rulersPush(open: boolean): void;
  // generator primitives
  waitGen(t: number): RoutineGen;
  moveGen(
    c: Cursor,
    target: { x: number; y: number } | (() => { x: number; y: number }),
    opts?: MoveOpts
  ): RoutineGen;
  clickGen(c: Cursor): RoutineGen;
  typeGen(c: Cursor, it: SwarmItem): RoutineGen;
  waitRulers(): RoutineGen;
  waitGuideDone(gt: Task): RoutineGen;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const randRange = (rand: () => number, min: number, max: number): number =>
  min + rand() * (max - min);

const easeInOut = (k: number): number =>
  k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const easeOut = (k: number): number => 1 - Math.pow(1 - k, 3);

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export function runTask(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const it = task.item;
  if (it && !it.node) host.view.createNode(it);
  switch (task.type) {
    case "rect":
      return boxRoutine(host, c, it!, false);
    case "image":
      return boxRoutine(host, c, it!, true);
    case "line":
      return lineRoutine(host, c, task);
    case "text":
      return textRoutine(host, c, task);
    case "guide":
      return guideRoutine(host, c, task);
    case "dup":
      return dupRoutine(host, c, task);
    case "edit":
      return editTextRoutine(host, c, task);
    case "restyle":
      return restyleRoutine(host, c, task);
  }
}

// ─── Boxes & images (crosshair drag-draw) ─────────────────────────────────────

function* boxRoutine(host: RoutineHost, c: Cursor, it: SwarmItem, isImg: boolean): RoutineGen {
  c.shape = "cross";
  yield* host.moveGen(c, { x: it.x, y: it.y });
  c.press = 1;
  host.view.setOpacity(it, it.op ?? 1);
  // Giant containers paint immediately so their drag never reads as a blank zone.
  if (it.big) host.view.applyStyle(it);
  else host.view.makeDrawOutline(it);
  it.drawW = 0;
  it.drawH = 0;
  host.bump(it);
  c.ov = () => [host.selectionOf(it)];
  const end = host.dragEnd(c, it);
  yield* host.moveGen(c, end, {
    speed: 0.75,
    drag: true,
    bend: 0,
    onStep: () => {
      it.drawW = Math.max(0, c.x - it.x);
      it.drawH = Math.max(0, c.y - it.y);
      host.bump(it);
    },
  });
  // Drag clamped at the viewport edge: tween the rest of the way.
  if (end.x < it.x + it.w - 0.5 || end.y < it.y + it.h - 0.5) {
    const w0 = it.drawW ?? 0;
    const h0 = it.drawH ?? 0;
    let k = 0;
    while (k < 1) {
      k = Math.min(1, k + ((yield 0) * host.tempoNum()) / 0.5);
      const e = easeOut(k);
      it.drawW = w0 + (it.w - w0) * e;
      it.drawH = h0 + (it.h - h0) * e;
      host.bump(it);
    }
  }
  it.drawW = undefined;
  it.drawH = undefined;
  host.bump(it);
  c.shape = "arrow";
  yield* host.waitGen(randRange(host.rand, 0.18, 0.3));
  host.view.applyStyle(it);
  host.bump(it);
  host.sfxPlace(isImg ? "image" : "rect", it);
  yield* host.waitGen(isImg ? 0.5 : 0.35);
  c.ov = null;
}

// ─── Pen lines ────────────────────────────────────────────────────────────────

function* lineRoutine(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const it = task.item!;
  const pts = it.pts ?? [];
  if (pts.length < 2) return;
  c.shape = "pen-add";
  yield* host.moveGen(c, pts[0]);
  yield* host.clickGen(c);
  host.view.setOpacity(it, it.op ?? 1);
  const st: LineEditState = { pts, placed: 1, owner: c };
  host.editLines.push(st);
  c.shape = "pen";
  for (let i = 1; i < pts.length; i++) {
    yield* host.moveGen(c, pts[i], {
      bend: (host.rand() < 0.5 ? -1 : 1) * randRange(host.rand, 0.02, 0.05),
    });
    yield* host.clickGen(c);
    st.placed = i + 1;
    it.drawW = Math.abs(c.x - pts[0].x);
    host.bump(it);
    yield* host.waitGen(randRange(host.rand, 0.04, 0.12));
  }
  st.owner = null;
  yield* host.moveGen(
    c,
    { x: c.x + randRange(host.rand, 14, 30), y: c.y + randRange(host.rand, 10, 24) },
    { speed: 1.4 }
  );
  yield* host.waitGen(0.3);
  const i = host.editLines.indexOf(st);
  if (i >= 0) host.editLines.splice(i, 1);
  it.drawW = undefined;
  host.bump(it);
  host.sfxPlace("line", it);
}

// ─── Text (ghost-select, type, grow, snap onto guides) ───────────────────────

function* textRoutine(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const it = task.item!;
  if (!it.typed || !it.node) return;
  let guide = task.snap?.guide ?? null;
  const fs = it.fs ?? 16;

  // Drift offsets so the snap beat has somewhere to travel.
  if (guide) {
    if (guide.axis === "x") {
      it.dx = randRange(host.rand, 28, 64);
      it.dy = randRange(host.rand, -8, 8);
    } else {
      it.dx = randRange(host.rand, -8, 8);
      it.dy = randRange(host.rand, 18, 34) * (host.rand() < 0.5 ? -1 : 1);
    }
  }
  if (task.grow) it.scale = Math.min(1, 18 / fs);

  const b0 = host.bounds(it);
  c.shape = "cross";
  yield* host.moveGen(c, { x: b0.x, y: b0.y });
  const lineH = Math.min(b0.h, (it.lh ?? fs) * (it.scale ?? 1));
  if (b0.w < 140 && it.h < (it.lh ?? fs) * 1.6) {
    yield* host.clickGen(c);
  } else {
    c.press = 1;
    const ghost = { x: b0.x, y: b0.y, w: 0, h: 0 };
    c.ov = () => [
      {
        t: "box",
        b: ghost,
        handles: true,
        badge: `${Math.round(ghost.w)} × ${Math.round(ghost.h)}`,
        rulerLines: true,
      },
    ];
    yield* host.moveGen(
      c,
      { x: b0.x + b0.w, y: b0.y + lineH },
      {
        speed: 0.9,
        drag: true,
        bend: 0,
        onStep: () => {
          ghost.w = Math.max(0, c.x - b0.x);
          ghost.h = Math.max(0, c.y - b0.y);
        },
      }
    );
    c.ov = null;
  }
  it.vis = true;
  it.editing = true;
  it.shown = 0;
  host.view.setOpacity(it, it.op ?? 1);
  host.bump(it);
  c.shape = "ibeam";
  c.ov = () => [{ t: "box", b: host.bounds(it) }];
  yield* host.moveGen(
    c,
    { x: c.x + randRange(host.rand, -30, 10), y: c.y + randRange(host.rand, 10, 30) },
    { speed: 1.5 }
  );
  yield* host.typeGen(c, it);
  yield* host.waitGen(0.12);
  it.editing = false;
  host.bump(it);
  host.view.removeCaret(it);
  host.sfxPlace("text", it);
  c.shape = "arrow";
  c.ov = () => [host.selectionOf(it)];

  // Grow beat: big headings step from tiny type up to full size.
  if (task.grow) {
    const steps = [24, 32, 40, 48, 56, 64, 72, 88, 104].filter((s) => s < fs && s > 18);
    for (const s of [...steps, fs]) {
      yield* host.waitGen(0.06);
      it.scale = s / fs;
      host.bump(it);
      host.sound.playTyping();
    }
    it.scale = 1;
    host.bump(it);
    yield* host.waitGen(0.15);
  }

  if (guide) {
    // Give the guide a moment to land; never block a cursor on it.
    const gt = (guide as Guide & { task?: Task }).task;
    if (gt) {
      let waited = 0;
      while (gt.state !== "done" && waited < 1.6) waited += (yield 0) * host.tempoNum();
      if (gt.state !== "done") {
        // Guide never arrived — settle any drift instead of snapping.
        guide = null;
      }
    }
  }
  if (guide) {
    const u = host.bounds(it);
    const a = {
      x: u.x + Math.min(u.w * 0.4, 60) + randRange(host.rand, -6, 6),
      y: u.y + Math.min(u.h * 0.5, 22),
    };
    yield* host.moveGen(c, a);
    c.press = 1;
    const p = { x: a.x - (it.dx ?? 0), y: a.y - (it.dy ?? 0) };
    const m = {
      x: p.x + (guide.axis === "x" ? -randRange(host.rand, 2, 5) : randRange(host.rand, -6, 6)),
      y: p.y + (guide.axis === "y" ? -randRange(host.rand, 2, 5) : randRange(host.rand, -3, 3)),
    };
    const drag = () => {
      let h = c.x - p.x;
      let v = c.y - p.y;
      if (guide!.axis === "x" && Math.abs(h) < 9) {
        if (h !== 0 && it.dx) {
          if (guide!.flash < 0.5) host.flashGuide(guide!);
        }
        h = 0;
      }
      if (guide!.axis === "y" && Math.abs(v) < 9) {
        if (v !== 0 && it.dy) {
          if (guide!.flash < 0.5) host.flashGuide(guide!);
        }
        v = 0;
      }
      it.dx = h;
      it.dy = v;
      host.bump(it);
    };
    yield* host.moveGen(c, m, { speed: 0.6, drag: true, onStep: drag });
    yield* host.waitGen(0.1);
    yield* host.moveGen(c, p, { speed: 2, onStep: drag });
    it.dx = 0;
    it.dy = 0;
    host.bump(it);
    yield* host.waitGen(0.25);
  } else if (it.dx || it.dy) {
    const dx0 = it.dx ?? 0;
    const dy0 = it.dy ?? 0;
    let k = 0;
    while (k < 1) {
      k = Math.min(1, k + ((yield 0) * host.tempoNum()) / 0.3);
      const e = easeInOut(k);
      it.dx = dx0 * (1 - e);
      it.dy = dy0 * (1 - e);
      host.bump(it);
    }
    yield* host.waitGen(0.15);
  } else {
    yield* host.waitGen(0.2);
  }
  c.ov = null;
}

// ─── Guide placement (drag a ruler line in, snap-flash) ──────────────────────

function* guideRoutine(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const g = task.guide!;
  host.rulersPush(true);
  try {
    const r = randRange(host.rand, -0.15, 0.15);
    const from = () =>
      g.axis === "x"
        ? host.fromViewport(10, window.innerHeight * (0.45 + r))
        : host.fromViewport(window.innerWidth * 0.3 + r * 200, 10);
    c.shape = "arrow";
    yield* host.moveGen(c, from());
    yield* host.waitRulers();
    yield* host.moveGen(c, from(), { speed: 3 });
    c.press = 1;
    c.shape = g.axis === "x" ? "ew" : "ns";
    g.vis = true;
    g.dragging = true;
    g.op = 1;
    const upd = () => {
      g.cur = g.axis === "x" ? c.x : c.y;
    };
    upd();
    const to = () => {
      const s = from();
      return g.axis === "x" ? { x: g.pos, y: s.y + 40 } : { x: s.x + 30, y: g.pos };
    };
    yield* host.moveGen(c, to, { speed: 0.55, drag: true, onStep: upd });
    g.cur = g.pos;
    g.dragging = false;
    host.sfxPlace("guide");
    c.shape = "arrow";
    yield* host.waitGen(0.25);
  } finally {
    host.rulersPush(false);
  }
}

// ─── Alt-drag group duplicate ────────────────────────────────────────────────—

function* dupRoutine(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const g = task.group!;
  const dstItems = task.copyItems;
  if (dstItems.length === 0) return;
  const copy = g.copies[task.copyIdx];
  const ox = copy?.dx ?? 0;
  const oy = copy?.dy ?? 0;

  const sb = host.unionBounds(g.masterItems);
  c.shape = "arrow";
  const u = {
    x: sb.x + Math.min(sb.w * 0.45, 70) + randRange(host.rand, -8, 8),
    y: sb.y + Math.min(sb.h * 0.45, 30) + randRange(host.rand, -4, 4),
  };
  yield* host.moveGen(c, u);
  yield* host.clickGen(c);
  c.ov = () => [{ t: "box", b: sb, handles: true, badge: `${Math.round(sb.w)} × ${Math.round(sb.h)}` }];
  yield* host.waitGen(randRange(host.rand, 0.15, 0.3));
  c.shape = "dup";
  yield* host.waitGen(0.12);
  c.press = 1;

  // Lift: the copies appear stacked on their master (offset by -ox/-oy).
  for (const it of dstItems) {
    it.dx = ox;
    it.dy = oy;
    host.view.setOpacity(it, it.op ?? 1);
    if (it.kind === "rect" || it.kind === "image") host.view.applyStyle(it);
    if (it.typed) host.view.revealText(it, it.typed.seq.length);
    it.dx = ox;
    it.dy = oy;
    host.bump(it);
  }
  c.ov = () => {
    const cb = host.unionBounds(dstItems);
    const h: OvShape[] = [
      { t: "box", b: sb, color: "red" },
      { t: "box", b: cb, color: "red" },
    ];
    const sp = host.spacing(sb, cb);
    if (sp) h.push(sp);
    return h;
  };
  const m = { x: u.x - ox, y: u.y - oy };
  yield* host.moveGen(c, m, {
    speed: 0.6,
    drag: true,
    onStep: () => {
      for (const it of dstItems) {
        it.dx = ox + (c.x - u.x);
        it.dy = oy + (c.y - u.y);
        host.bump(it);
      }
    },
  });
  host.sfxPlace("dup");
  // Release: settle into the captured positions with the real content.
  for (const it of dstItems) {
    it.dx = 0;
    it.dy = 0;
    if (it.typed) {
      host.view.revealText(it, it.typed.seq.length);
      host.view.removeCaret(it);
    }
    if (it.node) {
      it.node.classList.add("node-settle");
    }
    host.bump(it);
  }
  yield* host.waitGen(0.1);
  c.shape = "arrow";
  c.ov = () => [{ t: "box", b: host.unionBounds(dstItems), handles: true, badge: `${Math.round(host.unionBounds(dstItems).w)} × ${Math.round(host.unionBounds(dstItems).h)}` }];
  yield* host.waitGen(0.35);
  for (const it of dstItems) {
    if (it.node) it.node.classList.remove("node-settle");
  }
  c.ov = null;
}

// ─── Text edits (select-all → retype) ────────────────────────────────────────—

function* editTextRoutine(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const it = task.item!;
  if (!it.typed || !it.node) return;
  c.shape = "arrow";
  const b = host.bounds(it);
  yield* host.moveGen(c, {
    x: b.x + Math.min(b.w * 0.5, 50) + randRange(host.rand, -5, 5),
    y: b.y + Math.min(it.lh ?? 16, b.h) * 0.55,
  });
  yield* host.clickGen(c);
  yield* host.waitGen(0.08);
  yield* host.clickGen(c);
  it.selAll = true;
  it.editing = true;
  host.bump(it);
  c.shape = "ibeam";
  c.ov = () => [{ t: "box", b: host.bounds(it) }];
  yield* host.waitGen(randRange(host.rand, 0.2, 0.35));
  it.selAll = false;
  it.shown = 0;
  host.bump(it);
  yield* host.typeGen(c, it);
  yield* host.waitGen(0.12);
  it.editing = false;
  host.bump(it);
  host.view.removeCaret(it);
  c.shape = "arrow";
  c.ov = () => [host.selectionOf(it)];
  host.sfxPlace("edit", it);
  yield* host.waitGen(0.3);
  c.ov = null;
}

// ─── Restyles (paint swap on a dup'd card) ───────────────────────────────────—

function* restyleRoutine(host: RoutineHost, c: Cursor, task: Task): RoutineGen {
  const it = task.item!;
  if (!it.node) return;
  c.shape = "arrow";
  const b = host.bounds(it);
  yield* host.moveGen(c, {
    x: b.x + Math.min(b.w * 0.5, 60) + randRange(host.rand, -6, 6),
    y: b.y + Math.min(b.h * 0.5, 30) + randRange(host.rand, -4, 4),
  });
  yield* host.clickGen(c);
  c.ov = () => [host.selectionOf(it)];
  yield* host.waitGen(randRange(host.rand, 0.15, 0.3));
  host.view.setOpacity(it, it.op ?? 1);
  if (it.kind === "rect" || it.kind === "image") host.view.applyStyle(it);
  host.bump(it);
  host.sfxPlace(it.kind === "image" ? "image" : "restyle", it);
  yield* host.waitGen(0.4);
  c.ov = null;
}
