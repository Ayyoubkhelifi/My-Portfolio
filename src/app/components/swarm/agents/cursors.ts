/**
 * cursors.ts — N cursor agents: path planning, motion, and lifecycle.
 *
 * Each agent follows a waypoint pipeline through tasks assigned by the
 * scheduler. Between tasks, agents idle-fly to gathering points.
 * At the finale, all agents converge to viewport center then fly away.
 *
 * Motion model per REFERENCE-NOTES.md / §4.6:
 *   - Smooth Catmull-Rom spline paths (paths.ts)
 *   - Overshoot ±2–3px on arrival, quick settle
 *   - Flocking micro-behavior: gentle attraction to co-moving agents + per-agent noise
 *   - Spring/orbit blend on arrival approach
 */

import {
  buildPath,
  gatheringPoints,
  centerViewport,
  exitTarget,
  seededRandom,
  Vec2,
} from "./paths";
import type { PointerLayer } from "./pointerLayer";
import type { CursorType } from "./pointerLayer";

// ─── Agent state machine ──────────────────────────────────────────────────────

type AgentPhase = "idle" | "traveling" | "working" | "gathering" | "finale" | "exiting" | "done";

interface PathProgress {
  points: Vec2[];
  duration: number;
  elapsed: number;
  pointIdx: number;
}

export interface CursorAgent {
  idx: number;
  x: number;
  y: number;
  phase: AgentPhase;
  path: PathProgress | null;
  cursorType: CursorType;
  opacity: number;
  /** Noise offset for flocking jitter (per-agent, constant) */
  noisePhase: number;
}

// ─── CursorManager ────────────────────────────────────────────────────────────

export class CursorManager {
  private agents: CursorAgent[];
  private rand: () => number;
  private gatherPts: Vec2[];
  private finaleStarted = false;
  private allDone = false;

  constructor(
    private readonly agentCount: number,
    private readonly layer: PointerLayer,
    seed: number
  ) {
    this.rand = seededRandom(seed);
    this.gatherPts = [];

    // Initialize agents at off-screen positions (they fly in)
    this.agents = Array.from({ length: agentCount }, (_, i) => ({
      idx: i,
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 200,
      y: -50 - i * 30,
      phase: "idle" as AgentPhase,
      path: null,
      cursorType: "arrow" as CursorType,
      opacity: 0,
      noisePhase: i * 1.3,
    }));
  }

  /** Initialize gathering points (must be called after mount, since it reads window) */
  init(): void {
    this.gatherPts = gatheringPoints(this.rand);
    // Start agents with fly-in animation (enter from off-screen)
    for (const agent of this.agents) {
      const targetPt = this.gatherPts[agent.idx % this.gatherPts.length];
      this._setPath(agent, targetPt);
      agent.phase = "gathering";
    }
  }

  /**
   * Tick all agents by dt seconds.
   * Called by the scheduler's master rAF loop.
   */
  tick(dt: number): void {
    for (const agent of this.agents) {
      if (agent.phase === "done") continue;
      this._tickAgent(agent, dt);
    }
  }

  /**
   * Dispatch a movement command to an agent (called by scheduler when
   * an agent's routine calls onMove).
   */
  moveAgent(
    agentIdx: number,
    x: number,
    y: number,
    cursorType: CursorType = "arrow"
  ): void {
    const agent = this.agents[agentIdx];
    if (!agent) return;
    agent.cursorType = cursorType;
    // Smooth toward target
    agent.x = agent.x + (x - agent.x) * 0.4;
    agent.y = agent.y + (y - agent.y) * 0.4;
    this.layer.setAgentState(agentIdx, agent.x, agent.y, cursorType, agent.opacity);
  }

  /**
   * Trigger a click burst for an agent.
   */
  clickAgent(agentIdx: number, x: number, y: number): void {
    this.layer.addClickBurst(agentIdx, x, y);
  }

  /**
   * Trigger the finale sequence: agents converge center → fly away.
   */
  startFinale(): void {
    if (this.finaleStarted) return;
    this.finaleStarted = true;

    const center = centerViewport();
    for (const agent of this.agents) {
      agent.phase = "finale";
      this._setPath(agent, center);
    }
  }

  /** Returns true once all agents have exited (finale complete) */
  isFinaleComplete(): boolean {
    return this.allDone;
  }

  private _tickAgent(agent: CursorAgent, dt: number): void {
    // Update noise phase for flocking
    agent.noisePhase += dt * 2.1;

    // Fade in agents during gathering
    if (agent.phase === "gathering" || agent.phase === "idle") {
      agent.opacity = Math.min(agent.opacity + dt * 2, 1);
    }

    // Fade out during exit
    if (agent.phase === "exiting") {
      agent.opacity = Math.max(agent.opacity - dt * 1.5, 0);
      if (agent.opacity <= 0) {
        agent.phase = "done";
        this.layer.setAgentVisible(agent.idx, false);
        this._checkAllDone();
        return;
      }
    }

    if (!agent.path) {
      if (agent.phase === "gathering" || agent.phase === "idle") {
        // Pick a new gathering target
        const pt = this.gatherPts[Math.floor(this.rand() * this.gatherPts.length)];
        this._setPath(agent, pt);
      }
      return;
    }

    // Advance path
    agent.path.elapsed += dt;
    const t = Math.min(agent.path.elapsed / agent.path.duration, 1);
    const pointIdx = Math.floor(t * (agent.path.points.length - 1));
    const pt = agent.path.points[Math.min(pointIdx, agent.path.points.length - 1)];

    if (pt) {
      // Apply flocking micro-jitter
      const jitter = Math.sin(agent.noisePhase) * 2;
      const jitterY = Math.cos(agent.noisePhase * 0.7) * 1.5;

      agent.x = pt.x + jitter;
      agent.y = pt.y + jitterY;
      this.layer.setAgentState(
        agent.idx,
        agent.x,
        agent.y,
        agent.cursorType,
        agent.opacity
      );
    }

    // Path complete
    if (t >= 1) {
      agent.path = null;

      if (agent.phase === "finale") {
        // Arrived at center — wait a moment then start exit
        agent.phase = "exiting";
        const exitPt = exitTarget(agent.idx, this.agentCount);
        // Stagger exits
        setTimeout(() => {
          this._setPath(agent, exitPt);
        }, agent.idx * 120);
      }
    }
  }

  private _setPath(agent: CursorAgent, target: Vec2): void {
    const segment = buildPath(
      { x: agent.x, y: agent.y },
      target,
      this.rand
    );
    agent.path = {
      points: segment.points,
      duration: segment.duration,
      elapsed: 0,
      pointIdx: 0,
    };
  }

  private _checkAllDone(): void {
    if (this.agents.every(a => a.phase === "done")) {
      this.allDone = true;
    }
  }
}
