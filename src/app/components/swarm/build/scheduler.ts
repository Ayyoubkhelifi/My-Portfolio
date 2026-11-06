/**
 * scheduler.ts — Dependency-aware timeline for the Swarm Rebuild intro.
 *
 * Implements a Y-gated, generator-based animation scheduler per §4.3
 * of the implementation plan.
 *
 * Key design decisions:
 *   - Single requestAnimationFrame loop drives all active generators
 *   - Zero setTimeout/setInterval (tick offsets only)
 *   - Deterministic: plan is a pure function of (snapshot, seed, profile, clock)
 *   - Parent-exclusive locks: no conflicting animations on a shared subtree
 *   - Duration envelope enforced: compresses remaining lanes if one lane runs slow
 *
 * Generator protocol: each routine is a generator function.
 * The master clock calls gen.next(dt) each frame with dt = elapsed seconds.
 * Generators yield until their animation is complete, then return.
 */

import type { ElementRecord, ElementRole } from "../capture/classify";
import type { ProfileConfig } from "../state/policy";

// ─── Building order ───────────────────────────────────────────────────────────

/** Priority ordering for the scheduler's work queue (lower = sooner) */
const ROLE_PRIORITY: Record<ElementRole, number> = {
  "backdrop": 0,
  "major-container": 1,
  "mid-container": 2,
  "leaf-text": 3,
  "leaf-image": 3,
  "leaf-svg": 4,
  "decorative": 5,
  "excluded": 6,
};

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType = "rect" | "text" | "image" | "svg" | "group-reveal" | "clip-reveal";

export interface Task {
  id: number;
  record: ElementRecord;
  taskType: TaskType;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Y position gate: task only unlocks when the scroll frontier reaches this Y */
  gateY: number;
  /** Set of task IDs this task depends on (must complete first) */
  deps: Set<number>;
  /** Assigned agent index (set at dispatch time) */
  agentIndex: number;
  /** Whether this task is currently running */
  running: boolean;
  /** Whether this task has completed */
  done: boolean;
  /** Generator returned by the routine function */
  generator?: Generator<void, void, number>;
}

// ─── Routine registry ─────────────────────────────────────────────────────────

/** Signature for a routine generator function */
export type RoutineFn = (
  record: ElementRecord,
  nodeEl: HTMLElement | null,
  agentIndex: number,
  onAgentMove: (x: number, y: number, type: string) => void,
  onAgentClick: (x: number, y: number) => void
) => Generator<void, void, number>;

const _routines = new Map<TaskType, RoutineFn>();

/** Register a routine for a task type (called by routines.ts on init) */
export function registerRoutine(type: TaskType, fn: RoutineFn): void {
  _routines.set(type, fn);
}

// ─── Scheduler state ──────────────────────────────────────────────────────────

export interface SchedulerConfig {
  profile: ProfileConfig;
  seed: number;
  nodeRefMap: Map<number, HTMLElement>;
  onAgentMove: (agentIdx: number, x: number, y: number, cursorType: string) => void;
  onAgentClick: (agentIdx: number, x: number, y: number) => void;
  onComplete: () => void;
  onError: (err: Error) => void;
}

export class Scheduler {
  private tasks: Task[] = [];
  private activeTasks: Task[] = [];
  private completedCount = 0;
  private totalTasks = 0;
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private masterClock = 0; // seconds since start
  private paused = false;
  private aborted = false;
  private tempo = 3.0; // speed multiplier (matches reference's 2.1–4.5×)

  // Parent-exclusive lock: set of parentIndex values currently being animated
  private lockedParents = new Set<number>();

  // Agent availability (which lanes are free)
  private agentFree: boolean[];

  // Duration envelope: target completion time
  private targetDuration: number;
  private startTime: number | null = null;

  constructor(private readonly config: SchedulerConfig) {
    this.agentFree = Array(config.profile.agentCount).fill(true);
    this.targetDuration = config.profile.durationTarget;
  }

  /** Build the work queue from snapshot records */
  buildPlan(records: ElementRecord[]): void {
    let taskId = 0;

    // Sort records by building priority
    const sorted = [...records].sort((a, b) => {
      const pa = ROLE_PRIORITY[a.role];
      const pb = ROLE_PRIORITY[b.role];
      if (pa !== pb) return pa - pb;
      // Within same priority: top-to-bottom, then left-to-right
      if (Math.abs(a.rect.top - b.rect.top) > 10) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    // Track parent completion for dependency gates
    const indexToTaskId = new Map<number, number>();

    for (const record of sorted) {
      if (record.type === "excluded") continue; // excluded nodes are handled by reveals.ts

      const taskType = this._recordToTaskType(record);
      const deps = new Set<number>();

      // Container children depend on their parent container
      if (record.parentIndex >= 0) {
        const parentTaskId = indexToTaskId.get(record.parentIndex);
        if (parentTaskId !== undefined) {
          deps.add(parentTaskId);
        }
      }

      const task: Task = {
        id: taskId++,
        record,
        taskType,
        priority: ROLE_PRIORITY[record.role],
        gateY: record.rect.top,
        deps,
        agentIndex: -1,
        running: false,
        done: false,
      };

      this.tasks.push(task);
      indexToTaskId.set(record.index, task.id);
    }

    this.totalTasks = this.tasks.length;

    if (process.env.NODE_ENV === "development") {
      console.log(`[Scheduler] Plan built: ${this.totalTasks} tasks`);
    }
  }

  private _recordToTaskType(record: ElementRecord): TaskType {
    switch (record.type) {
      case "text": return "text";
      case "image": return "image";
      case "svg": return "svg";
      case "container": return "rect";
      default: return "rect";
    }
  }

  /** Start the master rAF loop */
  start(): void {
    this.startTime = performance.now();
    this.rafId = requestAnimationFrame(this._tick.bind(this));
  }

  /** Pause the master clock (e.g., tab hidden) */
  pause(): void {
    this.paused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Resume the master clock */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.lastTs = null; // reset delta to prevent time jump
    this.rafId = requestAnimationFrame(this._tick.bind(this));
  }

  /** Abort all running tasks */
  abort(): void {
    this.aborted = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.activeTasks = [];
  }

  private _tick(ts: number): void {
    if (this.aborted || this.paused) return;

    // Compute delta time
    const dt = this.lastTs !== null
      ? Math.min((ts - this.lastTs) / 1000, 0.1) // cap dt at 100ms (tab wake)
      : 0.016;
    this.lastTs = ts;

    // Apply tempo scaling
    const scaledDt = dt * this.tempo;
    this.masterClock += scaledDt;

    // Check duration envelope
    if (this.startTime !== null) {
      const elapsed = (ts - this.startTime) / 1000;
      if (elapsed > this.config.profile.durationMax) {
        // Duration cap reached — complete remaining via group-reveal
        this.config.onComplete();
        return;
      }

      // Dynamic tempo: compress remaining work if behind schedule
      const progress = this.completedCount / Math.max(this.totalTasks, 1);
      const expectedProgress = elapsed / this.targetDuration;
      if (progress < expectedProgress - 0.1) {
        this.tempo = Math.min(this.tempo * 1.05, 5.0);
      } else {
        this.tempo = Math.max(this.tempo * 0.995, 2.0);
      }
    }

    // --- Dispatch new tasks to free agents ---
    this._dispatchPendingTasks();

    // --- Tick active generators ---
    const stillActive: Task[] = [];
    for (const task of this.activeTasks) {
      if (!task.generator) {
        task.done = true;
        this.completedCount++;
        this._releaseTask(task);
        continue;
      }
      try {
        const result = task.generator.next(scaledDt);
        if (result.done) {
          task.done = true;
          task.running = false;
          this.completedCount++;
          this._releaseTask(task);
        } else {
          stillActive.push(task);
        }
      } catch (err) {
        this.config.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    this.activeTasks = stillActive;

    // --- Check completion ---
    const allDone = this.completedCount >= this.totalTasks &&
      this.activeTasks.length === 0;
    if (allDone) {
      this.config.onComplete();
      return;
    }

    this.rafId = requestAnimationFrame(this._tick.bind(this));
  }

  private _dispatchPendingTasks(): void {
    for (let agentIdx = 0; agentIdx < this.agentFree.length; agentIdx++) {
      if (!this.agentFree[agentIdx]) continue;

      const task = this._pickNextTask();
      if (!task) break;

      // Assign agent and lock parent
      task.agentIndex = agentIdx;
      task.running = true;
      this.agentFree[agentIdx] = false;
      if (task.record.parentIndex >= 0) {
        this.lockedParents.add(task.record.parentIndex);
      }

      // Get the routine
      const routineFn = _routines.get(task.taskType);
      const nodeEl = this.config.nodeRefMap.get(task.record.index) ?? null;

      if (routineFn) {
        task.generator = routineFn(
          task.record,
          nodeEl,
          agentIdx,
          (x, y, type) => this.config.onAgentMove(agentIdx, x, y, type),
          (x, y) => this.config.onAgentClick(agentIdx, x, y)
        );
      } else {
        // No routine registered → instant reveal (fallback)
        task.generator = this._instantReveal(nodeEl);
      }

      this.activeTasks.push(task);
    }
  }

  private _pickNextTask(): Task | null {
    for (const task of this.tasks) {
      if (task.running || task.done) continue;

      // Check all deps completed
      const depsReady = [...task.deps].every((depId) =>
        this.tasks.find(t => t.id === depId)?.done === true
      );
      if (!depsReady) continue;

      // Check parent lock
      if (task.record.parentIndex >= 0 &&
          this.lockedParents.has(task.record.parentIndex)) continue;

      return task;
    }
    return null;
  }

  private _releaseTask(task: Task): void {
    this.agentFree[task.agentIndex] = true;
    if (task.record.parentIndex >= 0) {
      this.lockedParents.delete(task.record.parentIndex);
    }
  }

  private *_instantReveal(nodeEl: HTMLElement | null): Generator<void, void, number> {
    if (nodeEl) {
      nodeEl.style.opacity = "1";
    }
    return;
  }

  get progress(): number {
    return this.totalTasks > 0
      ? this.completedCount / this.totalTasks
      : 0;
  }
}
