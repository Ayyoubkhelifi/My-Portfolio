/**
 * scheduler.ts — the Swarm Rebuild engine.
 *
 * One rAF loop drives everything: agent simulation (spawn / idle / leave
 * / flock), task dispatch (band-priority picking with dependency +
 * scroll-frontier gating), routine generators, the auto "tour" pan
 * (velocity-ramped, backlog-gated), guide decay, rulers, HUD, sounds
 * and the flock finale.
 *
 * Tasks are planned in capture (DOM) order: containers build before
 * their children, inner groups before outer copies, guide tasks carry
 * the snap beat for nearby text. Every task unlocks when its propagated
 * gate passes the scroll frontier, so the page builds top-to-bottom as
 * the tour reveals it.
 *
 * Cursor motion during a task is kinematic (the routine owns the
 * position via timed bezier glides); outside of tasks cursors run a
 * small boids simulation. Mechanisms/constants are drawn from
 * REFERENCE-NOTES.md; all source text here is our own.
 */

import type { Cursor } from "../agents/agents";
import { createCursor } from "../agents/agents";
import type {
  Box,
  CaptureResult,
  DupGroup,
  Guide,
  OvShape,
  SwarmItem,
} from "../capture/model";
import { View } from "./overlay";
import {
  runTask,
  type MoveOpts,
  type RoutineGen,
  type RoutineHost,
} from "./routines";
import type { ProfileConfig } from "../state/policy";
import type { SoundEngine } from "../fx/sound";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskType = "rect" | "image" | "text" | "line" | "guide" | "dup" | "edit" | "restyle";

/** A pen-line being placed: the overlay reads placed points + owner cursor. */
export interface LineEditState {
  pts: Array<{ x: number; y: number }>;
  placed: number;
  owner: Cursor | null;
}

export interface Task {
  id: number;
  /** World y of the build (item top; guides sit above their band). */
  y: number;
  /** Availability gate: earliest scroll frontier at which this can run. */
  gate: number;
  type: TaskType;
  item: SwarmItem | null;
  guide: Guide | null;
  group: DupGroup | null;
  copyIdx: number;
  masterItems: SwarmItem[];
  copyItems: SwarmItem[];
  /** Snap spec: nearby guide + the offset the text starts drifted from. */
  snap: { guide: Guide; dx: number; dy: number } | null;
  /** Big headings type small and grow to full size in steps. */
  grow: boolean;
  deps: Task[];
  state: "wait" | "active" | "done";
  doneAt: number;
  owner: Cursor | null;
}

export interface EngineCallbacks {
  /** Called once when the build finishes (or the duration cap forces it). */
  onComplete: () => void;
  /** Called on any unrecoverable error inside the loop. */
  onFail: (err: unknown) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

const easing = {
  inOut: (k: number): number => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  out: (k: number): number => 1 - Math.pow(1 - k, 3),
};

export function randRange(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class Engine implements RoutineHost {
  public readonly view: View;
  public readonly sound: SoundEngine;
  public readonly rand: () => number;
  public readonly editLines: LineEditState[] = [];
  private capture: CaptureResult;
  private profile: ProfileConfig;
  private cb: EngineCallbacks;

  // plan
  private tasks: Task[] = [];
  private groups: DupGroup[];
  private guides: Guide[] = [];
  private guideDeps = new Map<Guide, Task[]>();

  // agents
  private cursors: Cursor[] = [];
  private nextId = 0;
  private homeIds = new Set<number>();
  private taskOfCursor = new Map<Cursor, Task>();
  private retired = 0;

  // clock & tour
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private paused = false;
  private autoPaused = false;
  private aborted = false;
  private started = false;
  private flocking = false;
  private elapsed = 0;

  private time = 0;
  private tempo = 2.1;
  private frontier = 0;
  private vel = 0;
  private lastScroll: number | null = null;
  private doneCount = 0;
  private waitCount = 0;

  private spawnCooldown = 0;
  private mouse: { x: number; y: number } | null = null;
  private tv = { x: 0, y: 0 };
  private lastT: { x: number; y: number } | null = null;

  private rulers = { want: 0, t: 0, lastNeed: -10 };
  private hop: { from: number; dest: number; t: number; dur: number } | null = null;
  private lastDispatchAt = 0;
  private finaleStart = 0;

  private clackCool = 0;
  private hudCool = 0;

  constructor(
    view: View,
    sound: SoundEngine,
    capture: CaptureResult,
    profile: ProfileConfig,
    seed: number,
    cb: EngineCallbacks
  ) {
    this.view = view;
    this.sound = sound;
    this.capture = capture;
    this.profile = profile;
    this.cb = cb;
    this.groups = capture.groups;
    let s = seed >>> 0 || 1;
    this.rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // The opening flock orbits the viewport center until the build starts.
    const introCrew = Math.min(Math.max(profile.agentMin + 6, 10), profile.agentMax);
    for (let n = 0; n < introCrew; n++) {
      const fromLeft = n % 2 === 0;
      const x = window.scrollX + (fromLeft
        ? -40 - randRange(this.rand, 0, 200)
        : window.innerWidth + 40 + randRange(this.rand, 0, 200));
      const y = window.scrollY + randRange(this.rand, 0.05, 0.95) * window.innerHeight;
      this.cursors.push(this.makeCursor(x, y, n < profile.agentMin, true));
    }
  }

  private makeCursor(x: number, y: number, home: boolean, flock = false): Cursor {
    const c = createCursor(x, y, this.nextId++, this.rand);
    c.follow = flock; // flock-mode cursors (pre-start/finale) don't take tasks
    if (home) this.homeIds.add(c.id);
    return c;
  }

  // ── Plan ──────────────────────────────────────────────────────────────────

  buildPlan(): void {
    const items = this.capture.items;
    const groups = this.groups;

    // ── 1. One build task per non-copy item, in capture (DOM) order.
    const taskOfItem = new Map<SwarmItem, Task>();
    const mk = (y: number, type: TaskType, deps: Task[]): Task => {
      const t: Task = {
        id: this.tasks.length,
        y,
        gate: y,
        type,
        item: null,
        guide: null,
        group: null,
        copyIdx: 0,
        masterItems: [],
        copyItems: [],
        snap: null,
        grow: false,
        deps,
        state: "wait",
        doneAt: 0,
        owner: null,
      };
      this.tasks.push(t);
      return t;
    };
    for (const it of items) {
      if (it.dupOf) continue; // copy items belong to their group's dup task
      const task = mk(
        it.y,
        it.kind === "text" ? "text" : it.kind === "line" ? "line" : it.kind === "image" ? "image" : "rect",
        []
      );
      task.item = it;
      if (it.parent) {
        const pt = taskOfItem.get(it.parent);
        if (pt) task.deps.push(pt);
      }
      taskOfItem.set(it, task);
    }

    // ── 2. Dup groups: inner first (reverse order) so outer copies wait on them.
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const g = groups[gi];
      const masterFinals: Task[] = [];
      for (const m of g.masterItems) {
        const mt = taskOfItem.get(m);
        if (mt) masterFinals.push(mt);
      }
      const first = g.masterItems[0];
      if (first?.parent) {
        const pt = taskOfItem.get(first.parent);
        if (pt && !masterFinals.includes(pt)) masterFinals.push(pt);
      }
      g.copies.forEach((copy, k) => {
        const minY = copy.items.reduce((acc, it) => Math.min(acc, it.y), Infinity);
        const dupTask = mk(minY, "dup", masterFinals);
        dupTask.group = g;
        dupTask.copyIdx = k;
        dupTask.masterItems = g.masterItems;
        dupTask.copyItems = copy.items;

        // Per-item differences inside the copy get an edit/restyle beat.
        copy.items.forEach((it, ii) => {
          const m = g.masterItems[ii];
          if (!m) return;
          let type: "edit" | "restyle" | null = null;
          if (it.kind === "text" && it.text !== m.text) type = "edit";
          else if (
            (it.kind === "image" && it.src !== m.src) ||
            (it.kind === "rect" && it.css !== m.css)
          )
            type = "restyle";
          if (type) {
            const sub = mk(it.y, type, [dupTask]);
            sub.item = it;
          }
        });
      });
    }

    // ── 3. Guides: strongest text alignment cluster per 900px band.
    const BAND = 900;
    const texts = items.filter(
      (it) => it.kind === "text" && taskOfItem.has(it) && (it.fs ?? 0) >= 13 && it.w > 30
    );
    const bands = new Map<number, SwarmItem[]>();
    for (const it of texts) {
      const k = Math.floor(it.y / BAND);
      if (!bands.has(k)) bands.set(k, []);
      bands.get(k)!.push(it);
    }
    const bucketX = (list: SwarmItem[], get: (n: SwarmItem) => number): SwarmItem[][] => {
      // Sliding-cluster pass: sorted values grouped within a 24px tolerance.
      const s = [...list].sort((a, b) => get(a) - get(b));
      const clusters: SwarmItem[][] = [];
      let i = 0;
      while (i < s.length) {
        const clustersJ = [s[i]];
        const base = get(s[i]);
        let j = i + 1;
        while (j < s.length && get(s[j]) - base <= 24) clustersJ.push(s[j++]);
        clusters.push(clustersJ);
        i = j;
      }
      return clusters;
    };
    for (const [, list] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
      if (this.guides.length >= 16) break;
      const xClusters = bucketX(list, (n) => n.x);
      let best: SwarmItem[] | null = null;
      for (const l of xClusters) if (l.length >= 3 && (!best || l.length > best.length)) best = l;
      if (best) {
        const pos = best.reduce((s, m) => s + m.x, 0) / best.length; // average left edge
        const topIn = Math.min(...best.map((m) => m.y));
        const members = best
          .filter((m) => m.y < topIn + 450)
          .sort((a, b) => (b.fs ?? 0) - (a.fs ?? 0))
          .slice(0, 2);
        const g: Guide = {
          axis: "x",
          pos,
          cur: pos,
          op: 1,
          flash: 0,
          vis: false,
          dragging: false,
        };
        this.guides.push(g);
        const gt = mk(Math.min(...members.map((m) => m.y)) - 30, "guide", []);
        gt.guide = g;
        (g as Guide & { task?: Task }).task = gt;
        const deps: Task[] = [];
        for (const m of members) {
          const mt = taskOfItem.get(m)!;
          mt.snap = { guide: g, dx: m.x - pos, dy: 0 };
          deps.push(mt);
        }
        this.guideDeps.set(g, deps);
      }
      // Same pass for y-aligned rows (horizontal guide).
      const yClusters = bucketX(list, (n) => n.y);
      let row: SwarmItem[] | null = null;
      for (const l of yClusters) if (l.length >= 3 && (!row || l.length > row.length)) row = l;
      if (row) {
        const pos = Math.round(row.reduce((s, m) => s + m.y, 0) / row.length);
        const m = row.find((it) => {
          const mt = taskOfItem.get(it);
          return mt && !mt.snap;
        });
        if (m) {
          const g: Guide = {
            axis: "y",
            pos,
            cur: pos,
            op: 1,
            flash: 0,
            vis: false,
            dragging: false,
          };
          this.guides.push(g);
          const gt = mk(pos - 30, "guide", []);
          gt.guide = g;
          (g as Guide & { task?: Task }).task = gt;
          taskOfItem.get(m)!.snap = { guide: g, dx: 0, dy: m.y - pos };
          this.guideDeps.set(g, [taskOfItem.get(m)!]);
        }
      }
    }

    // ── 4. Big headings type small and grow to size.
    for (const it of items) {
      const t = taskOfItem.get(it);
      if (it.kind === "text" && t && (it.fs ?? 0) >= 28 && it.h < 400) t.grow = true;
    }

    // ── 5. Line items get a 2-point pen path.
    for (const it of items) {
      if (it.kind === "line" && !it.pts)
        it.pts = [
          { x: it.x, y: it.y },
          { x: it.x + it.w, y: it.y },
        ];
    }

    // ── 6. Gates: an item unlocks once ANY of its dependents is reachable
    // (propagate the earliest need up to each dependency).
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const t = this.tasks[i];
      for (const d of t.deps) if (t.gate < d.gate) d.gate = t.gate;
    }

    // ── 7. Create all item nodes up front (one batch of simple divs).
    for (const it of items) this.view.createNode(it);

    this.waitCount = this.tasks.length;
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[SwarmIntro] plan: ${this.tasks.length} tasks, ${groups.length} groups, ${this.guides.length} guides`
      );
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.rafId !== null || this.aborted) return;
    this.frontier = window.scrollY + window.innerHeight;
    this.lastTs = null;
    if (process.env.NODE_ENV === "development") {
      let pulses = 0;
      (window as unknown as Record<string, unknown>).__swarmDebug = () => ({
        pulses,
        time: Math.round(this.time * 10) / 10,
        tempo: Math.round(this.tempo * 100) / 100,
        crew: this.cursors.length,
        busy: this.taskOfCursor.size,
        done: this.doneCount,
        waiting: this.waitCount,
        avail: this.available().length,
        stuckGate: this.tasks.filter((t) => t.state === "wait" && t.gate > this.frontier).length,
        stuckDeps: this.tasks.filter(
          (t) => t.state === "wait" && t.gate <= this.frontier && t.deps.some((d) => d.state !== "done")
        ).length,
        elapsed: Math.round(this.elapsed),
        scrollY: Math.round(window.scrollY),
        hop:
          this.hop == null
            ? null
            : {
                dest: Math.round(this.hop.dest),
                p: Math.round((this.hop.t / this.hop.dur) * 100) / 100,
              },
        frontier: Math.round(this.frontier),
        flocking: this.flocking,
      });
      (window as unknown as Record<string, unknown>).__swarmStuck = () =>
        this.tasks
          .filter((t) => t.state === "wait" && t.gate <= this.frontier + 2000)
          .slice(0, 12)
          .map((t) => ({
            type: t.type,
            g: Math.round(t.gate),
            y: Math.round(t.y),
            deps: t.deps.map((d) => d.type + ":" + d.state),
          }));
      const origTick = this.tickFrame;
      this.tickFrame = (ts: number) => {
        pulses++;
        origTick(ts);
      };
    }
    this.rafId = requestAnimationFrame(this.tickFrame);
    // Let the opening flock gather before the build starts.
    window.setTimeout(() => {
      if (!this.aborted && !this.paused) this.beginBuild();
    }, 1150);
  }

  /** Release the flock into work mode (the build begins). */
  private beginBuild(): void {
    if (this.started || this.aborted) return;
    this.started = true;
    for (const c of this.cursors) {
      c.follow = false;
      c.gen = null;
      c.ov = null;
      c.angle = 0;
      c.shape = "arrow";
    }
  }

  pause(): void {
    this.paused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resume(): void {
    if (!this.paused || this.aborted) return;
    this.paused = false;
    this.lastTs = null;
    this.rafId = requestAnimationFrame(this.tickFrame);
  }

  /** Pause triggered by tab-hidden (reversible by the visibility watchdog). */
  autoPause(): void {
    if (this.paused || this.aborted) return;
    this.autoPaused = true;
    this.pause();
  }

  autoResume(): void {
    if (!this.autoPaused) return;
    this.autoPaused = false;
    this.resume();
  }

  abort(): void {
    this.aborted = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.tasks.length = 0;
    this.cursors.length = 0;
    this.editLines.length = 0;
  }

  /**
   * Flock phase → launch: true once the finale boids orbit has played
   * (force-finish path skips the dwell since the reveal already happened).
   */
  isFinaleDone(): boolean {
    if (this.aborted) return true;
    return this.flocking && this.time - this.finaleStart > 2.4;
  }

  /** Pointer position feeding the flock (viewport coords). */
  setMouse(x: number, y: number): void {
    this.mouse = { x, y };
  }

  clearMouse(): void {
    this.mouse = null;
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  private tickFrame = (ts: number): void => {
    if (this.aborted || this.paused) return;

    const dtRaw = this.lastTs === null ? 0.016 : Math.min((ts - this.lastTs) / 1000, 0.05);
    this.lastTs = ts;
    this.elapsed += dtRaw;

    this.step(dtRaw);
    this.tourStep(dtRaw);

    const sx = window.scrollX;
    const sy = window.scrollY;
    this.view.pan(sx, sy);
    this.view.renderOverlay(this.collectSpecs(), this.guides, this.editLines, sx, sy);
    this.view.renderCursors(this.cursors, sx, sy);
    this.view.renderRulers(this.rulers.t, this.rulers.t > 0.001 ? this.rulerMarks(sx, sy) : {});

    // HUD (throttled)
    this.hudCool -= dtRaw;
    if (this.hudCool <= 0) {
      this.hudCool = 0.2;
      const workers = this.cursors.filter((c) => c.worked).length + this.retired;
      this.view.hudUpdate(
        this.started && !this.flocking
          ? `${workers} agents · ${this.doneCount.toLocaleString()}/${this.tasks.length.toLocaleString()} layers`
          : `${this.cursors.length} agents ready · ${this.tasks.length.toLocaleString()} layers`,
        this.tasks.length ? this.doneCount / this.tasks.length : 0
      );
      const live = this.cursors.filter((c) => !c.follow && !c.leaving).slice(-6);
      this.view.hudSetAgentColors(live.map((c) => c.color));
    }

    this.rafId = requestAnimationFrame(this.tickFrame);
  };

  /** Ruler tick marks (world-coord rulers that scroll with the page). */
  private rulerMarks(sx: number, sy: number): { top: string; left: string } {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let u = "";
    let a = "";
    const x0 = Math.floor(sx / 100) * 100;
    for (let g = x0; g <= sx + W; g += 50) {
      const x = g - sx;
      const major = g % 100 === 0;
      u += `<line x1="${x}" y1="${major ? 10 : 14}" x2="${x}" y2="20" stroke="#5E5E5E"/>`;
      if (major) u += `<text x="${x + 3}" y="9">${g}</text>`;
    }
    const y0 = Math.floor(sy / 100) * 100;
    for (let g = y0; g <= sy + H; g += 50) {
      const y = g - sy;
      const major = g % 100 === 0;
      a += `<line x1="${major ? 10 : 14}" y1="${y}" x2="20" y2="${y}" stroke="#5E5E5E"/>`;
      if (major)
        a += `<text x="3" y="${y - 3}" transform="rotate(-90 3 ${y - 3})">${g}</text>`;
    }
    return { top: u, left: a };
  }

  // ── Step ──────────────────────────────────────────────────────────────────

  private step(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.05);
    this.time += dt;
    const sy = window.scrollY;
    const vh = window.innerHeight;
    const viewBot = sy + vh;

    // Smooth scroll velocity (drives tempo + demo pace).
    const sv = this.lastScroll == null ? 0 : Math.abs(sy - this.lastScroll) / Math.max(dt, 0.001);
    this.lastScroll = sy;
    this.vel = Math.max(this.vel * Math.exp(-dt * 1.2), this.vel * 0.7 + sv * 0.3);

    if (this.started) this.frontier = Math.max(this.frontier, viewBot);

    if (this.tasks.length === 0) return;

    const avail = this.started ? this.available() : [];
    const crew = Math.max(1, this.cursors.filter((c) => !c.leaving).length);
    this.tempo =
      clamp(2.1 + this.vel / 900 + (avail.length / crew) * 0.5, 2.1, 4.5) *
      this.profile.speed;

    // Duration fail-safe.
    if (!this.flocking && this.elapsed > this.profile.durationMax) {
      this.forceRevealRemaining();
      return;
    }

    // Rulers fade state.
    const rt = this.time - this.rulers.lastNeed < 0.7 ? 1 : 0;
    this.rulers.t += (rt - this.rulers.t) * Math.min(1, dt * 10);
    if (Math.abs(rt - this.rulers.t) < 0.002) this.rulers.t = rt;

    // Guide decay.
    for (const g of this.guides) {
      if (!g.vis) continue;
      if (g.flash > 0) g.flash = Math.max(0, g.flash - dt * 1.5);
      if (g.shownAt == null) g.shownAt = this.time;
      const deps = this.guideDeps.get(g) ?? [];
      if (!g.dragging && g.op > 0 && this.time - g.shownAt > 7 && !deps.some((t) => t.state === "active"))
        g.op = Math.max(0, g.op - dt * 1.2);
      else if (!g.dragging && deps.every((t) => t.state === "done")) {
        const last = Math.max(0, ...deps.map((t) => t.doneAt));
        if (this.time - last > 1.2 && g.op > 0) g.op = Math.max(0, g.op - dt * 1.2);
      }
    }

    // Finale trigger: every task has been dispatched at least once.
    if (!this.flocking && this.started && this.waitCount === 0) {
      for (const c of this.cursors) {
        if (!this.taskOfCursor.has(c) && !c.follow) {
          c.follow = true;
          c.gen = null;
          c.leaving = false;
          c.ov = null;
          c.shape = "arrow";
        }
      }
      if (this.cursors.every((c) => c.follow)) {
        this.flocking = true;
        this.finaleStart = this.time;
        this.view.hudFade();
        this.doneCount = this.tasks.length;
        this.cb.onComplete();
      }
    }
    if (this.flocking) {
      this.flock(dt);
      return;
    }

    if (!this.started) {
      const center = { x: window.scrollX + window.innerWidth / 2, y: window.scrollY + vh / 2 };
      this.follow(dt, this.cursors, center, 0.7);
      return;
    }

    // Spawn crew up to demand.
    this.spawnCooldown -= dt;
    const want = clamp(
      this.profile.agentMin + Math.floor(this.vel / 40) + Math.floor(avail.length / 2),
      this.profile.agentMin,
      this.profile.agentMax
    );
    if (this.cursors.filter((c) => !c.leaving).length < want && this.spawnCooldown <= 0) {
      const fromLeft = this.rand() < 0.5;
      const x = window.scrollX + (fromLeft ? -40 : window.innerWidth + 40);
      const y = window.scrollY + randRange(this.rand, 0.2, 0.8) * vh;
      this.cursors.push(this.makeCursor(x, y, false));
      this.spawnCooldown = 0.035;
    }

    // Dispatch: free cursors grab the best available task.
    if (!this.flocking) {
      for (const c of this.cursors) {
        if (c.follow || c.leaving || c.gen || this.taskOfCursor.has(c)) continue;
        const t = this.pick(c, avail);
        if (!t) break;
        const ix = avail.indexOf(t);
        if (ix >= 0) avail.splice(ix, 1);
        t.state = "active";
        this.waitCount--;
        this.lastDispatchAt = this.time;
        t.owner = c;
        this.taskOfCursor.set(c, t);
        c.worked = true;
        c.idleFor = 0;
        c.gen = runTask(this, c, t);
      }
    }

    // Cursor lifecycle + generator stepping.
    for (const c of [...this.cursors]) {
      if (c.follow) continue;
      c.press = Math.max(0, c.press - dt * 6);
      if (c.angle !== 0)
        c.angle = Math.abs(c.angle) < 0.5 ? 0 : c.angle * (1 - Math.min(1, dt * 10));

      if (!this.taskOfCursor.has(c)) {
        c.idleFor += dt;
        if (
          !c.leaving &&
          c.idleFor > 2.5 &&
          this.cursors.filter((m) => !m.leaving).length > this.profile.agentMin &&
          !this.homeIds.has(c.id)
        ) {
          c.leaving = true;
          c.gen = this.gLeave(c);
        }
      }
      if (!c.gen) c.gen = c.leaving ? this.gLeave(c) : this.gIdle(c);

      let done = false;
      try {
        const r = c.gen.next(dt);
        done = !!r.done;
      } catch (err) {
        this.cb.onFail(err);
        return;
      }
      if (done) {
        const t = this.taskOfCursor.get(c);
        this.taskOfCursor.delete(c);
        c.gen = null;
        if (c.leaving) {
          if (c.worked) this.retired++;
          const i = this.cursors.indexOf(c);
          if (i >= 0) this.cursors.splice(i, 1);
        } else {
          c.shape = "arrow";
          c.ov = null;
        }
        if (t) {
          t.state = "done";
          t.doneAt = this.time;
          t.owner = null;
          this.doneCount++;
          this.sound.playElementResolve();
        }
      }
    }

    this.clackCool = Math.max(0, this.clackCool - dt);
  }

  // ── Availability & picking ────────────────────────────────────────────────

  private available(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks) {
      if (t.state !== "wait") continue;
      if (t.gate > this.frontier) continue;
      let ok = true;
      for (const d of t.deps)
        if (d.state !== "done") {
          ok = false;
          break;
        }
      if (ok) out.push(t);
    }
    return out;
  }

  /** Band-first, topmost-first task score — mirrors a human's reading order. */
  private pick(c: Cursor, avail: Task[]): Task | null {
    let best: Task | null = null;
    let bestS = Number.POSITIVE_INFINITY;
    const top = window.scrollY - 40;
    const bot = window.scrollY + window.innerHeight;
    const cy = c.y;
    for (const t of avail) {
      const y = t.y;
      const u = y >= top && y <= bot ? 0 : y < top ? 1 : 2;
      const s =
        u * 1e6 +
        (u === 1 ? top - y : y) * 0.6 +
        Math.abs(y - cy) * 0.4 -
        (t.type === "guide" ? 5e5 : 0);
      if (s < bestS) {
        bestS = s;
        best = t;
      }
    }
    return best;
  }

  // ── Auto tour (backlog-gated, velocity-ramped pan) ────────────────────────

  private tourStep(dt: number): void {
    if (!this.started || this.aborted) return;
    if (this.flocking) {
      // drift back to the top during the finale
      return;
    }
    const vh = window.innerHeight;
    const maxY = this.capture.docH - vh;
    const sy = window.scrollY;
    if (sy >= maxY - 1) {
      this.hop = null;
      return;
    }

    // Stay-and-paint / hop model: the camera NEVER glides. It locks in place
    // while unlocked work is being painted (cursors drawing dominate the
    // view), then flicks one full viewport when that viewport is drained.
    // A hop completes even if new tasks unlock mid-flight — work paints after
    // arrival. A long stall with no dispatches (dep-gated tasks) hops anyway
    // to advance the frontier and unstick the pipeline.
    if (this.hop) {
      this.hop.t += dt;
      const p = Math.min(1, this.hop.t / this.hop.dur);
      const e = p * p * (3 - 2 * p);
      window.scrollTo(0, Math.round(this.hop.from + (this.hop.dest - this.hop.from) * e));
      if (p >= 1) this.hop = null;
      return;
    }

    const stalled = this.time - this.lastDispatchAt > 2.5 && this.backlog() > 0;
    if (stalled || this.backlog() === 0) {
      const dest = Math.min(sy + vh, maxY);
      if (dest > sy) {
        const dur = Math.min(0.9, Math.max(0.35, (dest - sy) / 900));
        this.hop = { from: sy, dest, t: 0, dur };
      }
    }
  }

  /** Unfinished work already unlocked by the frontier. */
  private backlog(): number {
    let n = 0;
    for (const t of this.tasks) if (t.state !== "done" && t.gate <= this.frontier) n++;
    return n;
  }

  // ── Boids flocking (pre-start orbit + finale) ─────────────────────────────

  private flockTarget(): { x: number; y: number } {
    if (this.mouse)
      return { x: this.mouse.x - window.scrollX, y: this.mouse.y - window.scrollY };
    const t = this.time;
    return {
      x: window.scrollX + window.innerWidth * (0.5 + 0.28 * Math.sin(t * 0.37)),
      y: window.scrollY + window.innerHeight * (0.5 + 0.25 * Math.sin(t * 0.53 + 1)),
    };
  }

  private flock(dt: number): void {
    this.spawnCooldown -= dt;
    if (this.cursors.length < this.profile.agentMax && this.spawnCooldown <= 0) {
      const fromLeft = this.rand() < 0.5;
      const x = window.scrollX + (fromLeft ? -30 : window.innerWidth + 30);
      const y = window.scrollY + randRange(this.rand, 0.1, 0.9) * window.innerHeight;
      this.cursors.push(this.makeCursor(x, y, false, true));
      this.spawnCooldown = 0.04;
    }
    this.follow(dt, this.cursors);
  }

  /** Boids-ish orbit around a target; returns true when a cursor is touched. */
  private follow(
    dt: number,
    list: Cursor[],
    target?: { x: number; y: number },
    scale = 1
  ): boolean {
    const m = this.mouse
      ? { x: this.mouse.x - window.scrollX, y: this.mouse.y - window.scrollY }
      : null;
    const o = target ?? this.flockTarget();
    const time = this.time;
    if (m && this.lastT && dt > 0) {
      const k = Math.min(1, dt * 18);
      this.tv.x += ((m.x - this.lastT.x) / dt - this.tv.x) * k;
      this.tv.y += ((m.y - this.lastT.y) / dt - this.tv.y) * k;
    }
    this.lastT = m;

    const R = 135 * scale * (1 + 0.18 * Math.sin(time * 0.55));
    const swirl = Math.tanh(Math.cos(time * 0.11) * 3);
    const want: Array<[number, number]> = [];
    for (const c of list) {
      const vx = c.x - o.x;
      const vy = c.y - o.y;
      const d = Math.hypot(vx, vy) || 0.01;
      const nx = vx / d;
      const ny = vy / d;
      const ang = Math.atan2(vy, vx);
      const off = (c.orbit - 120) * 0.55 * scale;
      const rr = R * (1 + 0.3 * Math.sin(3 * ang + time * 0.7)) + off;
      const tang = 300 * (0.7 + c.spin * 0.2) * swirl;
      const rad = clamp((rr - d) * 4, -2600, 1400);
      const far = clamp((d - rr) / 600, 0, 1);
      want.push([
        -ny * tang + nx * rad - ny * c.curl * 400 * far,
        nx * tang + ny * rad + nx * c.curl * 400 * far,
      ]);
    }
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let ax = 0;
      let ay = 0;
      let wsum = 0;
      for (let j = 0; j < list.length; j++) {
        if (j === i) continue;
        const q = list[j];
        const d = Math.hypot(q.x - c.x, q.y - c.y);
        if (d > 90) continue;
        const w = 1 - d / 90;
        ax += q.vx * w;
        ay += q.vy * w;
        wsum += w;
      }
      let fx = want[i][0];
      let fy = want[i][1];
      if (wsum > 0) {
        fx = fx * 0.7 + (ax / wsum) * 0.3;
        fy = fy * 0.7 + (ay / wsum) * 0.3;
      }
      const dist = Math.max(0, Math.hypot(c.x - o.x, c.y - o.y) - 180 * scale);
      const maxV = c.speed * (1.3 + Math.min(3.2, dist / 90));
      const L = Math.hypot(fx, fy);
      if (L > maxV) {
        fx *= maxV / L;
        fy *= maxV / L;
      }
      let gx = (fx - c.vx) * 6;
      let gy = (fy - c.vy) * 6;
      const maxF = c.force * (1.4 + Math.min(5, dist / 50));
      const G = Math.hypot(gx, gy);
      if (G > maxF) {
        gx *= maxF / G;
        gy *= maxF / G;
      }
      c.vx += gx * dt;
      c.vy += gy * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
    }

    const R0 = 48;
    let touched = false;
    if (m) {
      for (const c of list) {
        const vx = c.x - m.x;
        const vy = c.y - m.y;
        const d = Math.hypot(vx, vy) || 0.01;
        if (d >= R0) continue;
        touched = true;
        const nx = vx / d;
        const ny = vy / d;
        c.x = m.x + nx * R0;
        c.y = m.y + ny * R0;
        const rel = (c.vx - this.tv.x) * nx + (c.vy - this.tv.y) * ny;
        if (rel < 0) {
          c.vx -= nx * rel * 1.6;
          c.vy -= ny * rel * 1.6;
        }
        c.vx += nx * 260;
        c.vy += ny * 260;
      }
    }
    for (const c of list) {
      if (Math.hypot(c.vx, c.vy) < 30) continue;
      const d =
        ((((Math.atan2(c.vy, c.vx) * 180) / Math.PI + 128 - c.angle + 540) % 360) + 360) % 360 - 180;
      c.angle += d * Math.min(1, dt * 8);
      c.press = Math.max(0, c.press - dt * 6);
    }
    return touched;
  }

  // ── Overlay + fail-safe ───────────────────────────────────────────────────

  private collectSpecs(): OvShape[] {
    const out: OvShape[] = [];
    for (const c of this.cursors) {
      if (!c.ov) continue;
      try {
        out.push(...c.ov());
      } catch {
        /* overlay builders are pure reads — ignore */
      }
    }
    return out;
  }

  /**
   * Duration fail-safe: stop scheduling, visually finish everything left.
   * (The finale then plays as usual from the reactor loop.)
   */
  private forceRevealRemaining(): void {
    try {
      for (const task of this.tasks) {
        if (task.state === "done") continue;
        task.state = "done";
        task.doneAt = this.time;
        task.owner = null;
        this.doneCount++;
        const it = task.item;
        if (it) {
          if (!it.node) this.view.createNode(it);
          if (it.typed) {
            this.view.revealText(it, it.typed.seq.length);
            this.view.removeCaret(it);
          }
          if (it.kind === "rect") this.view.applyStyle(it);
          it.drawW = undefined;
          it.drawH = undefined;
          it.dx = 0;
          it.dy = 0;
          it.scale = undefined;
          this.view.syncItem(it);
          this.view.setOpacity(it, it.op ?? 1);
          if (it.node) it.node.style.transform = it.scale ? `scale(${it.scale})` : "";
        }
      }
      this.waitCount = 0;
      this.flocking = true;
      this.view.hudFade();
      this.doneCount = this.tasks.length;
    } finally {
      this.cb.onComplete();
    }
  }

  // ── RoutineHost implementation (consumed by routines.ts) ──────────────────

  get vw(): number {
    return window.innerWidth;
  }

  viewTop(): number {
    return window.scrollY;
  }

  viewBot(): number {
    return window.scrollY + window.innerHeight;
  }

  fromViewport(x: number, y: number): { x: number; y: number } {
    return { x: window.scrollX + x, y: window.scrollY + y };
  }

  scr(c: Cursor): { x: number; y: number } {
    return { x: c.x - window.scrollX, y: c.y - window.scrollY };
  }

  bump(it: SwarmItem): void {
    this.view.syncItem(it);
  }

  bounds(it: SwarmItem): Box {
    if (it.kind === "text") {
      const s = it.scale ?? 1;
      let h = it.h;
      const total = it.typed ? it.typed.seq.length : 0;
      if (it.editing && !it.selAll && total && it.lh) {
        const lines = Math.max(1, Math.round(it.h / it.lh));
        h = Math.min(
          it.h,
          Math.max(it.lh, Math.ceil(((it.shown ?? 0) / total) * lines) * it.lh)
        );
      }
      return {
        x: it.x + (it.dx ?? 0),
        y: it.y + (it.dy ?? 0),
        w: Math.max(1, it.w * s),
        h: Math.max(1, h * s),
      };
    }
    if (it.kind === "line")
      return { x: it.x + (it.dx ?? 0), y: it.y + (it.dy ?? 0), w: it.drawW ?? it.w, h: it.h };
    return {
      x: it.x + (it.dx ?? 0),
      y: it.y + (it.dy ?? 0),
      w: it.drawW ?? it.w,
      h: it.drawH ?? it.h,
    };
  }

  unionBounds(items: SwarmItem[]): Box {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const it of items) {
      const b = this.bounds(it);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (minX > maxX) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
  }

  selectionOf(it: SwarmItem): OvShape {
    const b = this.bounds(it);
    return {
      t: "box",
      b,
      handles: true,
      badge: `${Math.round(Math.abs(b.w))} × ${Math.round(Math.abs(b.h))}`,
      rulerLines: true,
      underline: it.kind === "text" ? this.underlineOf(it, b) : undefined,
    };
  }

  underlineOf(it: SwarmItem, b: Box): Box {
    const lh = it.lh ?? it.fs ?? 16;
    const fs = it.fs ?? lh;
    const s = it.scale ?? 1;
    return { x: b.x, y: b.y + (lh * 0.5 + fs * 0.42) * s, w: Math.min(b.w, it.w * s), h: 0 };
  }

  spacing(a: Box, b: Box): OvShape | null {
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (oy > 0) {
      const y = Math.max(a.y, b.y) + oy / 2;
      const [l, r] = a.x < b.x ? [a, b] : [b, a];
      const gap = r.x - (l.x + l.w);
      if (gap > 0)
        return {
          t: "measure",
          b: { x: r.x, y, w: 0, h: 0 },
          a: { x: l.x + l.w, y, w: 0, h: 0 },
          label: String(Math.round(gap)),
        };
    } else if (ox > 0) {
      const x = Math.max(a.x, b.x) + ox / 2;
      const [tp, bt] = a.y < b.y ? [a, b] : [b, a];
      const gap = bt.y - (tp.y + tp.h);
      if (gap > 0)
        return {
          t: "measure",
          b: { x, y: bt.y, w: 0, h: 0 },
          a: { x, y: tp.y + tp.h, w: 0, h: 0 },
          label: String(Math.round(gap)),
        };
    }
    return null;
  }

  /** Where a drag should end so a huge box never drags the cursor off-screen. */
  dragEnd(c: Cursor, it: SwarmItem): { x: number; y: number } {
    void c;
    const right = window.scrollX + window.innerWidth;
    const bot = window.scrollY + window.innerHeight;
    const x =
      it.x + it.w > right - 16 ? Math.max(it.x + Math.min(it.w, 40), right - 30) : it.x + it.w;
    const y =
      it.y + it.h > bot - 16 ? Math.max(it.y + Math.min(it.h, 40), bot - 40) : it.y + it.h;
    return { x: Math.min(x, it.x + it.w), y: Math.min(y, it.y + it.h) };
  }

  sfxPlace(): void {
    this.sound.playElementResolve();
  }

  flashGuide(g: Guide): void {
    g.flash = 1;
    this.sound.playGrab();
  }

  rulersPush(open: boolean): void {
    this.rulers.want += open ? 1 : -1;
    this.rulers.want = Math.max(0, this.rulers.want);
    if (this.rulers.want > 0) this.rulers.lastNeed = this.time;
  }

  tempoNum(): number {
    return this.tempo;
  }

  // ── RoutineHost generator primitives ──────────────────────────────────────

  waitGen(t: number): RoutineGen {
    return this.gWait(t);
  }

  moveGen(
    c: Cursor,
    target: { x: number; y: number } | (() => { x: number; y: number }),
    opts?: MoveOpts
  ): RoutineGen {
    return this.gMove(c, target, opts);
  }

  clickGen(c: Cursor): RoutineGen {
    return this.gClick(c);
  }

  typeGen(c: Cursor, it: SwarmItem): RoutineGen {
    return this.gType(c, it);
  }

  waitRulers(): RoutineGen {
    return (function* (self: Engine): RoutineGen {
      while (self.rulers.t < 0.95) {
        yield 0;
      }
    })(this);
  }

  waitGuideDone(gt: Task): RoutineGen {
    return (function* (self: Engine): RoutineGen {
      let waited = 0;
      while (gt.state !== "done" && waited < 1.6) {
        waited += (yield 0) * self.tempo;
      }
    })(this);
  }

  // ── Engine-side cursor generators ─────────────────────────────────────────

  /** Idle wander — bounce somewhere inside the visible band. */
  private *gIdle(c: Cursor): RoutineGen {
    for (;;) {
      const p = {
        x: window.scrollX + window.innerWidth * (0.17 + this.rand() * 0.66),
        y: this.viewTop() + (this.viewBot() - this.viewTop()) * (0.2 + this.rand() * 0.6),
      };
      yield* this.gMove(c, p, { speed: 0.35 });
      let w = 0.4 + this.rand();
      while (w > 0) {
        w -= yield 0;
        if (c.y < this.viewTop() || c.y > this.viewBot()) break;
      }
    }
  }

  /** Exit to the nearest screen edge. */
  private *gLeave(c: Cursor): RoutineGen {
    const right = c.x > window.scrollX + window.innerWidth / 2;
    const sideX = () =>
      window.scrollX + (right ? window.innerWidth + 60 : -60);
    yield* this.gMove(
      c,
      () => ({ x: sideX(), y: c.y - this.viewTop() + window.scrollY }),
      { speed: 0.8 }
    );
  }

  /** Timed bezier glide: speed ∝ sqrt(distance), bowed approach arc. */
  private *gMove(
    c: Cursor,
    target: { x: number; y: number } | (() => { x: number; y: number }),
    o: MoveOpts = {}
  ): RoutineGen {
    const get = typeof target === "function" ? target : () => target;
    const x0 = c.x;
    const y0 = c.y;
    const p0 = get();
    const dist = Math.hypot(p0.x - x0, p0.y - y0);
    if (dist < 0.5) {
      c.x = p0.x;
      c.y = p0.y;
      o.onStep?.();
      return;
    }
    const dur = clamp((0.12 + Math.sqrt(dist) * 0.021) / (o.speed ?? 1), 0.14, 0.9);
    const bend =
      (o.bend != null ? o.bend : (this.rand() < 0.5 ? -1 : 1) * randRange(this.rand, 0.04, 0.14)) *
      Math.min(dist, 600);
    let t = 0;
    while (t < dur) {
      t += (yield 0) * this.tempo;
      const k = Math.min(1, t / dur);
      const e = o.drag || k < 0.15 ? easing.inOut(k) : easing.out(k);
      const p = get();
      const dx = p.x - x0;
      const dy = p.y - y0;
      const L = Math.hypot(dx, dy) || 1;
      const off = Math.sin(Math.PI * e) * bend;
      c.x = x0 + dx * e + (-dy / L) * off;
      c.y = y0 + dy * e + (dx / L) * off;
      o.onStep?.();
    }
    const p = get();
    c.x = p.x;
    c.y = p.y;
    o.onStep?.();
  }

  /** Press → short dwell (the click sound is a short thock via sfx). */
  private *gClick(c: Cursor): RoutineGen {
    c.press = 1;
    this.sound.playGrab();
    yield* this.gWait(0.07);
  }

  private *gWait(t: number): RoutineGen {
    let n = 0;
    while (n < t) n += (yield 0) * this.tempo;
  }

  /** Character-budget typing bursts (hesitations, spaces, newlines). */
  private *gType(c: Cursor, it: SwarmItem): RoutineGen {
    if (!it.typed) return;
    const view = this.view;
    const N = it.typed.seq.length;
    if (N === 0) return;
    const k = clamp(70 / N, 0.06, 1);
    let budget = 0;
    let i = it.shown ?? 0;
    while (i < N) {
      budget += (yield 0) * this.tempo;
      while (i < N && budget > 0) {
        const ch = it.typed.seq[i];
        let d = 0.012 + this.rand() * 0.028;
        if (ch === " ") d += this.rand() * 0.03;
        if (ch === "\n") d += 0.1;
        if (this.rand() < 0.025) d += 0.08 + this.rand() * 0.12;
        budget -= d * k;
        i++;
      }
      view.revealText(it, i);
      if (this.clackCool <= 0) {
        this.clackCool = 0.05;
        this.sound.playTyping();
      }
      // The cursor hovers just past the reveal edge.
      void c;
    }
  }
}
