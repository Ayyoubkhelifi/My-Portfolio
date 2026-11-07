/**
 * scheduler.ts — the Swarm Rebuild engine.
 *
 * One rAF loop drives everything: agent simulation, routine generators,
 * scroll pan ("tour"), guide decay, HUD, sounds and the finale. Tasks are
 * Y-gated by a scroll frontier and unlocked by parent dependencies, so the
 * page builds top-to-bottom exactly as the pan reveals it.
 *
 * Dispatch scans only the ready band per free agent, and each agent runs
 * its own generator coroutine — the previous implementation's O(n²)
 * per-frame scanning and setTimeout pile-ups are gone.
 */

import { AgentSwarm, type CursorType } from "../agents/agents";
import type { CaptureResult, Guide, SwarmItem } from "../capture/model";
import { View } from "./overlay";
import { routineFor, type RoutineCtx, type RoutineGen, type TaskType } from "./routines";
import type { ProfileConfig } from "../state/policy";
import type { SoundEngine } from "../fx/sound";

// ─── Task model ───────────────────────────────────────────────────────────────

interface Task {
  item: SwarmItem;
  type: TaskType;
  /** Tasks that must complete first (parent, master-of-dup). */
  deps: Task[];
  depsLeft: number;
  gen: RoutineGen | null;
  taken: boolean;
  done: boolean;
  /** Build entrance y in world coords (item bottom). */
  bottom: number;
  /** Item top edge in world coords (pan anchor). */
  y: number;
}

export interface EngineCallbacks {
  /** Called once when the build finishes (or the duration cap forces it). */
  onComplete: () => void;
  /** Called on any unrecoverable error inside the loop. */
  onFail: (err: unknown) => void;
}

function kindRank(item: SwarmItem): number {
  if (item.dupOf) return 3;
  switch (item.kind) {
    case "rect": return 0;
    case "line": return 1;
    case "image": return 2;
    case "text": return 2.5;
    default: return 3;
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class Engine {
  private view: View;
  private swarm: AgentSwarm;
  private sound: SoundEngine;
  private capture: CaptureResult;
  private profile: ProfileConfig;
  private cb: EngineCallbacks;

  private tasks: Task[] = [];
  private taskOfItem = new Map<SwarmItem, Task>();
  private agentOfTask = new Map<Task, number>();
  private agentPool: Array<{ busy: boolean }> = [];

  private maxScroll = 0;
  private frontier = 0;
  private panTarget = 0;

  private rafId: number | null = null;
  private lastTs: number | null = null;
  private paused = false;
  private aborted = false;
  private finished = false;

  private elapsed = 0;
  private masterTime = 0;
  private doneCount = 0;
  private tempo = 2.6;

  private clackCool = 0;
  private hudCool = 0;

  private guidesActive = new Map<number, { until: number; flash: number }>();
  private guides: Guide[];

  private finaleStarted = false;
  private finaleAt = 0;

  private rand: () => number;

  constructor(
    view: View,
    swarm: AgentSwarm,
    sound: SoundEngine,
    capture: CaptureResult,
    profile: ProfileConfig,
    seed: number,
    cb: EngineCallbacks
  ) {
    this.view = view;
    this.swarm = swarm;
    this.sound = sound;
    this.capture = capture;
    this.profile = profile;
    this.cb = cb;
    this.guides = capture.guides;
    this.agentPool = Array.from({ length: profile.agentCount }, () => ({ busy: false }));

    let s = seed >>> 0 || 1;
    this.rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Plan ──────────────────────────────────────────────────────────────────

  buildPlan(): void {
    const items = this.capture.items;
    const guides = this.capture.guides;

    // Guide assignment: big text items snap to the nearest unclaimed guide
    // within 160px (greedy, one guide per beat).
    const claimed = new Set<number>();
    for (const item of items) {
      if (item.kind !== "text" || !item.big) continue;
      const g = guides.find((g) => !claimed.has(g.pos) && Math.abs(item.x - g.pos) < 160);
      if (g) {
        claimed.add(g.pos);
        (item as SwarmItem & { guideX?: number }).guideX = g.pos;
      }
    }

    // Build order: containers first, then top-to-bottom.
    const order = [...items].sort((a, b) => {
      const ka = kindRank(a);
      const kb = kindRank(b);
      if (ka !== kb) return ka - kb;
      if (Math.abs(a.y - b.y) > 12) return a.y - b.y;
      return a.x - b.x;
    });

    for (const item of order) {
      let type: TaskType;
      if (item.dupOf) type = "dup";
      else if (item.kind === "text") type = "text";
      else if (item.kind === "line") type = "line";
      else type = "image";
      if (item.kind === "rect" && !item.dupOf) type = "rect";

      const task: Task = {
        item,
        type,
        deps: [],
        depsLeft: 0,
        gen: null,
        taken: false,
        done: false,
        bottom: item.y + item.h,
        y: item.y,
      };
      this.tasks.push(task);
      this.taskOfItem.set(item, task);
    }

    // Dependencies: parent container first; dup copies wait on their master.
    for (const task of this.tasks) {
      const { item } = task;
      if (item.parent) {
        const pt = this.taskOfItem.get(item.parent);
        if (pt && pt !== task && !pt.done) task.deps.push(pt);
      }
      if (task.type === "dup" && item.dupOf) {
        const mt = this.taskOfItem.get(item.dupOf);
        if (mt) task.deps.push(mt);
      }
      task.depsLeft = task.deps.length;
    }

    // Create all item nodes up front (one batch of simple divs).
    for (const task of this.tasks) {
      this.view.createNode(task.item);
    }
    if (process.env.NODE_ENV === "development") {
      console.log(`[SwarmIntro] plan: ${this.tasks.length} tasks`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.rafId !== null || this.finished || this.aborted) return;
    this.maxScroll = Math.max(0, this.capture.docH - window.innerHeight);
    this.frontier = window.innerHeight;
    this.panTarget = 0;
    this.lastTs = null;
    if (process.env.NODE_ENV === "development") {
      let pulses = 0;
      (window as unknown as Record<string, unknown>).__swarmDebug = () => ({
        pulses,
        elapsed: Math.round(this.elapsed * 10) / 10,
        tempo: Math.round(this.tempo * 100) / 100,
        done: this.doneCount,
        taken: this.tasks.filter((t) => t.taken && !t.done).length,
        gen: this.tasks.filter((t) => t.gen).length,
        slots: this.agentPool.map((s) => s.busy),
        scrollY: Math.round(window.scrollY),
        panTarget: Math.round(this.panTarget),
        frontier: Math.round(this.frontier),
        finished: this.finished,
      });
      const origTick = this.tickFrame;
      this.tickFrame = (ts: number) => {
        pulses++;
        origTick(ts);
      };
    }
    this.rafId = requestAnimationFrame(this.tickFrame);
  }

  pause(): void {
    this.paused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resume(): void {
    if (!this.paused || this.finished || this.aborted) return;
    this.paused = false;
    this.lastTs = null;
    this.rafId = requestAnimationFrame(this.tickFrame);
  }

  abort(): void {
    this.aborted = true;
    this.finished = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.tasks.length = 0;
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  private tickFrame = (ts: number): void => {
    if (this.aborted || this.finished || this.paused) return;

    const dtRaw = this.lastTs === null ? 0.016 : Math.min((ts - this.lastTs) / 1000, 0.09);
    this.lastTs = ts;

    // ── Tempo envelope: keep the intro inside its duration budget.
    this.elapsed += dtRaw;
    const doneRatio = this.doneCount / Math.max(1, this.tasks.length);
    const expected = this.elapsed / this.profile.durationTarget;
    if (doneRatio < expected - 0.06 && this.doneCount < this.tasks.length) {
      this.tempo = Math.min(this.tempo * 1.02, 4.2);
    } else {
      this.tempo = Math.max(this.tempo * 0.995, 2.2);
    }
    const dt = dtRaw * this.tempo;
    this.masterTime += dt;

    // ── Duration cap: force graceful completion instead of hanging.
    if (this.elapsed > this.profile.durationMax && this.doneCount < this.tasks.length) {
      this.forceRevealRemaining();
      this.finish();
      return;
    }

    // ── Pan / tour + dispatch + generators
    const scrollY = window.scrollY;
    this.updatePan(dtRaw);
    this.dispatch(scrollY);
    this.clackCool = Math.max(0, this.clackCool - dt);
    this.stepGenerators(dt);

    // ── Sync visuals
    this.swarm.tick(dtRaw);
    this.swarm.draw();
    this.view.pan(window.scrollX, scrollY);
    this.refreshGuides();

    // ── HUD (throttled)
    this.hudCool -= dtRaw;
    if (this.hudCool <= 0) {
      this.hudCool = 0.2;
      this.view.hudUpdate(
        `${this.profile.agentCount} agents · ${this.doneCount}/${this.tasks.length}`,
        doneRatio
      );
    }

    // ── Completion → finale
    if (this.doneCount >= this.tasks.length && !this.finaleStarted) {
      this.startFinale();
    }

    // Continue the loop (exactly one rAF per frame).
    this.rafId = requestAnimationFrame(this.tickFrame);
  };

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.view.hudUpdate(`${this.doneCount}/${this.tasks.length} built`, 1);
    this.cb.onComplete();
  }

  // ── Guides ────────────────────────────────────────────────────────────────

  /** Light a guide line for ~0.8s (called by text routines at the snap). */
  snapGuide(x: number): void {
    this.guidesActive.set(x, { until: this.masterTime + 0.55, flash: 1 });
  }

  private refreshGuides(): void {
    let any = false;
    for (const g of this.guides) {
      const active = this.guidesActive.get(g.pos);
      g.op = 0;
      if (active) {
        g.flash = active.flash;
        any = true;
      } else {
        g.flash = Math.max(0, g.flash - 0.02);
        if (g.flash > 0) any = true;
      }
    }
    for (const [pos, st] of [...this.guidesActive]) {
      st.flash = Math.max(0, st.flash - 0.018);
      if (this.masterTime > st.until && st.flash <= 0) this.guidesActive.delete(pos);
    }
    if (any) this.view.renderGuides(this.guides);
  }

  // ── Pan / tour logic ──────────────────────────────────────────────────────

  /**
   * The pan is an "anchor-chasing tour": every frame we find the next task
   * that is ready to build (deps satisfied, not taken) with the smallest
   * bottom edge, and keep that neighborhood in view. When no ready task
   * exists (band drained, agents idle), we anchor to the topmost remaining
   * undone task — this walks the viewport back up for dep-blocked work
   * (e.g. dup copies waiting on their master) instead of stranding it.
   */
  private updatePan(dtRaw: number): void {
    const vh = window.innerHeight;
    const scrollY = window.scrollY;
    this.frontier = scrollY + vh;

    let nextReady: Task | null = null;
    let nextUndone: Task | null = null;
    for (const task of this.tasks) {
      if (task.done) continue;
      if (!task.taken && task.depsLeft === 0) {
        if (!nextReady || task.bottom < nextReady.bottom) nextReady = task;
      }
      if (!task.taken) {
        if (!nextUndone || task.bottom < nextUndone.bottom) nextUndone = task;
      }
    }

    const anchor = nextReady ?? nextUndone;
    if (anchor) {
      const desired = Math.max(0, Math.min(this.maxScroll, anchor.y - vh * 0.55));
      this.panTarget = desired;
    }

    // Smooth scroll toward the anchor (both directions), capped speed.
    const dy = this.panTarget - scrollY;
    if (Math.abs(dy) > 1) {
      const maxStep = Math.max(vh * 0.35, vh * dtRaw * 2.2);
      const step = Math.max(-maxStep, Math.min(maxStep, dy));
      window.scrollTo(0, scrollY + step);
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  private dispatch(scrollY: number): void {
    if (this.aborted || this.finished) return;
    for (let i = 0; i < this.agentPool.length; i++) {
      if (this.agentPool[i].busy) continue;
      const task = this.pickNext(scrollY);
      if (!task) return;
      this.begin(task, i);
    }
  }

  private pickNext(scrollY: number): Task | null {
    const vh = window.innerHeight;
    // Gate on the item's TOP edge: large containers (e.g. the page wrapper,
    // whose bottom sits thousands of px below the fold) must still pass the
    // gate once their top enters the band, or the whole build deadlocks.
    const limit = scrollY + vh * 1.4;
    let best: Task | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const task of this.tasks) {
      if (task.taken || task.done || task.depsLeft > 0) continue;
      if (task.y > limit) continue;
      // Prefer tasks nearest the viewport's build focus, then top-most.
      const score = Math.abs(task.bottom - (scrollY + vh * 0.8)) + task.bottom * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = task;
      }
    }
    return best;
  }

  private begin(task: Task, agentIdx: number): void {
    this.agentPool[agentIdx].busy = true;
    task.taken = true;
    this.agentOfTask.set(task, agentIdx);

    const item = task.item;

    // Dup copies start overlapping their master.
    if (task.type === "dup" && item.dupOf && item.node) {
      item.node.style.left = `${item.dupOf.x}px`;
      item.node.style.top = `${item.dupOf.y}px`;
    }

    const entry: { x: number; y: number; type: CursorType } =
      task.type === "text"
        ? { x: item.x + 2, y: item.y + Math.min(item.h, 24) / 2, type: "ibeam" }
        : task.type === "dup"
          ? {
              x: (item.dupOf?.x ?? item.x) + item.w * 0.5,
              y: (item.dupOf?.y ?? item.y) + item.h * 0.5,
              type: "dup",
            }
          : { x: item.x + 4, y: item.y + 4, type: "crosshair" };

    const guideX =
      task.type === "text" ? (item as SwarmItem & { guideX?: number }).guideX ?? null : null;

    const agentIdxCaptured = agentIdx;
    const ctx: RoutineCtx = {
      item,
      agentIdx,
      view: this.view,
      swarm: this.swarm,
      sound: this.sound,
      guideX,
      rand: this.rand,
      moveTo: (x, y, type) => this.swarm.moveTarget(agentIdxCaptured, x, y, type),
      click: (x, y) => {
        this.swarm.click(agentIdxCaptured, x, y);
        this.sound.playGrab();
      },
      typeClack: () => {
        if (this.clackCool <= 0) {
          this.clackCool = 0.05;
          this.sound.playTyping();
        }
      },
      snapGuide: (x) => this.snapGuide(x),
    };

    this.swarm.assignTask(agentIdx, entry.x, entry.y, entry.type);
    task.gen = routineFor(task.type)(ctx);
  }

  // ── Generator stepping ────────────────────────────────────────────────────

  private stepGenerators(dt: number): void {
    for (const task of this.tasks) {
      if (!task.taken || task.done || !task.gen) continue;
      try {
        const result = task.gen.next(dt);
        if (result.done) this.finishTask(task);
      } catch (err) {
        this.cb.onFail(err);
        return;
      }
    }
  }

  private finishTask(task: Task): void {
    task.done = true;
    task.gen = null;
    this.doneCount++;

    // Free the agent slot that ran this task.
    const slot = this.agentOfTask.get(task);
    if (slot !== undefined) {
      this.agentPool[slot].busy = false;
      this.swarm.release(slot);
      this.agentOfTask.delete(task);
    }

    // Resolve note (bigger elements → sweeping resolve sound engine-side).
    this.sound.playElementResolve();

    // Unlock dependents.
    for (const other of this.tasks) {
      if (!other.done && other.deps.includes(task)) {
        other.depsLeft = Math.max(0, other.depsLeft - 1);
      }
    }
  }

  private forceRevealRemaining(): void {
    for (const task of this.tasks) {
      if (task.done) continue;
      const item = task.item;
      if (!item.node) this.view.createNode(item);
      if (item.typed) {
        this.view.revealText(item, item.typed.seq.length);
        this.view.removeCaret(item);
      }
      if (item.kind === "rect") this.view.applyStyle(item);
      if (item.node) {
        item.node.style.left = `${item.x}px`;
        item.node.style.top = `${item.y}px`;
        item.node.style.transform = "";
        item.node.style.opacity = String(item.op ?? 1);
      }
      task.done = true;
      const slot = this.agentOfTask.get(task);
      if (slot !== undefined) {
        this.agentPool[slot].busy = false;
        this.swarm.release(slot);
        this.agentOfTask.delete(task);
      }
      this.doneCount++;
    }
  }

  // ── Finale ────────────────────────────────────────────────────────────────

  private startFinale(): void {
    this.finaleStarted = true;
    this.finaleAt = this.elapsed;
    this.swarm.startFinale();
    this.view.hudFade();
  }

  /** Polled by SwarmIntro: true once the finale beat has played out. */
  isFinaleDone(): boolean {
    return this.finaleStarted && this.elapsed - this.finaleAt > 1.4;
  }
}
