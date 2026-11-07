/**
 * agents.ts — The cursor swarm.
 *
 * N synthetic multiplayer cursors. Each agent is a spring-driven point:
 *
 *   - idle:   orbit around a slowly moving "leader" point (radial spring +
 *             tangential swirl + per-agent curl), like a boid flock
 *   - task:   seek the target handed to it by the routine ( bowed
 *             approach with overshoot handled by the spring constants)
 *   - flock:  finale — all agents orbit the viewport center
 *   - exit:   launch off-screen after the finale, fading out
 *
 * Rendering happens once per frame in `draw()` onto a single canvas:
 * fading polyline trails, click bursts, then the cursor sprites on top.
 * All shapes are drawn with canvas paths — zero assets.
 */

export type CursorType = "arrow" | "crosshair" | "ibeam" | "ew-resize" | "dup";

export interface Vec2 {
  x: number;
  y: number;
}

// ─── Palette (original colors chosen for a dark site) ─────────────────────────

interface Palette {
  body: string;
  accent: string;
  outline: string;
}

const AGENT_PALETTES: Palette[] = [
  { body: "#e6edf5", accent: "#38bdf8", outline: "#0b1220" },
  { body: "#e6edf5", accent: "#818cf8", outline: "#0b1220" },
  { body: "#e6edf5", accent: "#34d399", outline: "#0b1220" },
  { body: "#e6edf5", accent: "#fb923c", outline: "#0b1220" },
  { body: "#e6edf5", accent: "#f472b6", outline: "#0b1220" },
  { body: "#e6edf5", accent: "#a78bfa", outline: "#0b1220" },
];

// ─── Seeded random ────────────────────────────────────────────────────────────

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Agent state ──────────────────────────────────────────────────────────────

type AgentPhase = "in" | "idle" | "task" | "flock" | "exit";

interface Agent {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  phase: AgentPhase;
  type: CursorType;
  opacity: number;
  curl: number;
  orbit: number;
  spin: number;
  noisePhase: number;
  trail: Vec2[];
  exitDelay: number;
  /** Set once the agent has launched off-screen; never drawn again. */
  gone: boolean;
}

const TRAIL_MAX = 18;

export class AgentSwarm {
  private agents: Agent[] = [];
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private rand: () => number;
  private bursts: Array<{ x: number; y: number; age: number; accent: string }> = [];
  private leaderAngle = Math.random() * Math.PI * 2;
  private allGone = false;

  constructor(canvas: HTMLCanvasElement, agentCount: number, seed: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("AgentSwarm: no 2d context");
    this.canvas = canvas;
    this.ctx = ctx;
    this.rand = seededRandom(seed);

    for (let i = 0; i < agentCount; i++) {
      const ang = (i / agentCount) * Math.PI * 2;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      this.agents.push({
        x: vw / 2 + Math.cos(ang) * vw * 0.55,
        y: vh / 2 + Math.sin(ang) * vh * 0.55,
        vx: 0,
        vy: 0,
        tx: vw / 2,
        ty: vh / 2,
        phase: "in",
        type: "arrow",
        opacity: 0,
        curl: (this.rand() - 0.5) * 1.6,
        orbit: 90 + this.rand() * 140,
        spin: 0.7 + this.rand() * 0.9,
        noisePhase: i * 1.37,
        trail: [],
        exitDelay: i * 0.09,
        gone: false,
      });
    }
  }

  // ── Command surface (used by the engine/routines) ─────────────────────────

  /** Assign an agent to a routine: continuous target seeking. */
  assignTask(idx: number, x: number, y: number, type: CursorType): void {
    const a = this.agents[idx];
    if (!a) return;
    a.phase = "task";
    a.type = type;
    a.tx = x;
    a.ty = y;
  }

  /** Update a working agent's target this frame. */
  moveTarget(idx: number, x: number, y: number, type?: CursorType): void {
    const a = this.agents[idx];
    if (!a) return;
    a.tx = x;
    a.ty = y;
    if (type) a.type = type;
  }

  /** Release an agent back to idle flocking after its task finished. */
  release(idx: number): void {
    const a = this.agents[idx];
    if (!a) return;
    a.phase = "idle";
    a.type = "arrow";
  }

  click(idx: number, x: number, y: number): void {
    const a = this.agents[idx];
    if (!a) return;
    this.bursts.push({ x, y, age: 0, accent: AGENT_PALETTES[idx % AGENT_PALETTES.length].accent });
  }

  /** Finale: everyone converges to the center then launches off-screen. */
  startFinale(): void {
    for (const a of this.agents) {
      a.phase = "flock";
      a.type = "arrow";
    }
  }

  /** True once every agent has exited (or after a safety timeout in Engine). */
  isAllGone(): boolean {
    return this.allGone;
  }

  // ── Simulation ────────────────────────────────────────────────────────────

  tick(dt: number): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    this.leaderAngle += dt * 0.35;
    const lcx = vw / 2 + Math.cos(this.leaderAngle * 0.9) * vw * 0.18;
    const lcy = vh / 2 + Math.sin(this.leaderAngle * 1.3) * vh * 0.16;

    for (const a of this.agents) {
      a.noisePhase += dt * 2.1;

      // Fade in on entry (agents that already exited stay gone)
      if (a.opacity < 1 && a.phase !== "exit" && !a.gone) {
        a.opacity = Math.min(1, a.opacity + dt * 2.4);
      }

      // Choose desired target per phase
      if (a.phase === "in" || a.phase === "idle") {
        const ang = this.leaderAngle * a.spin + a.noisePhase;
        const rr = a.orbit * (1 + 0.22 * Math.sin(2 * ang));
        a.tx = lcx + Math.cos(ang) * rr;
        a.ty = lcy + Math.sin(ang) * rr;
        a.type = "arrow";
      } else if (a.phase === "flock") {
        const ang = this.leaderAngle * 1.6 + a.curl * 2;
        const rr = 120 * (1 + 0.25 * Math.sin(3 * ang));
        a.tx = vw / 2 + Math.cos(ang) * rr;
        a.ty = vh / 2 + Math.sin(ang) * rr;
        if (a.exitDelay > 0) a.exitDelay -= dt;
        else if (this.finaleElapsed > 1.2) {
          a.phase = "exit";
          const angle = Math.atan2(a.y - vh / 2, a.x - vw / 2) + a.curl * 0.2;
          const dist = Math.max(vw, vh) * 0.9;
          a.tx = vw / 2 + Math.cos(angle) * dist;
          a.ty = vh / 2 + Math.sin(angle) * dist;
        }
      } else if (a.phase === "exit") {
        a.opacity = Math.max(0, a.opacity - dt * 1.2);
      }

      // Spring toward target (acceleration + damping — no tweens, no timeouts)
      const k = a.phase === "task" ? 90 : 26;
      const damp = a.phase === "task" ? 12 : 5;
      a.vx += ((a.tx - a.x) * k - a.vx * damp) * dt;
      a.vy += ((a.ty - a.y) * k - a.vy * damp) * dt;

      // Idle swirl: tangential + curl drift while orbiting
      if (a.phase === "idle" || a.phase === "in" || a.phase === "flock") {
        const dx = a.tx - a.x;
        const dy = a.ty - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const tang = 180 * (0.5 + a.spin * 0.3);
        a.vx += (-dy / d) * tang * dt;
        a.vy += (dx / d) * tang * dt;
        a.vx += Math.sin(a.noisePhase) * a.curl * 26 * dt;
        a.vy += Math.cos(a.noisePhase * 0.73) * a.curl * 26 * dt;
      }

      // Clamp velocity for sanity
      const vmax = a.phase === "task" ? 2400 : 700;
      const v = Math.hypot(a.vx, a.vy);
      if (v > vmax) {
        a.vx = (a.vx / v) * vmax;
        a.vy = (a.vy / v) * vmax;
      }

      a.x += a.vx * dt;
      a.y += a.vy * dt;

      // Trail
      a.trail.push({ x: a.x, y: a.y });
      if (a.trail.length > TRAIL_MAX) a.trail.shift();

      if (a.phase === "exit" && a.opacity <= 0) {
        a.gone = true;
        a.phase = "idle";
        a.opacity = 0;
        a.trail.length = 0;
      }
    }

    // Bursts age
    for (const b of this.bursts) b.age += dt;
    this.bursts = this.bursts.filter((b) => b.age < 0.4);

    this.finaleElapsed += dt;
    if (this.finaleElapsed > 4.2) this.allGone = true;
  }

  private finaleElapsed = 0;

  // ── Rendering ─────────────────────────────────────────────────────────────

  draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Trails
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.opacity <= 0.02 || a.trail.length < 2) continue;
      const accent = AGENT_PALETTES[i % AGENT_PALETTES.length].accent;
      ctx.strokeStyle = accent;
      ctx.lineCap = "round";
      for (let j = 1; j < a.trail.length; j++) {
        const t = j / a.trail.length;
        ctx.globalAlpha = t * t * 0.28 * a.opacity;
        ctx.lineWidth = 1 + t * 1.6;
        ctx.beginPath();
        ctx.moveTo(a.trail[j - 1].x, a.trail[j - 1].y);
        ctx.lineTo(a.trail[j].x, a.trail[j].y);
        ctx.stroke();
      }
    }

    // Bursts
    for (const b of this.bursts) {
      const t = b.age / 0.4;
      const eased = 1 - Math.pow(1 - t, 2);
      ctx.globalAlpha = (1 - t) * 0.65;
      ctx.strokeStyle = b.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4 + eased * 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Cursor sprites
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.opacity < 0.02) continue;
      const palette = AGENT_PALETTES[i % AGENT_PALETTES.length];
      ctx.save();
      ctx.globalAlpha = a.opacity;
      const speed = Math.hypot(a.vx, a.vy);
      ctx.translate(a.x, a.y);
      ctx.rotate(Math.min(Math.max(speed / 2600, 0), 0.5));
      this.drawCursor(ctx, a.type, palette);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  private drawCursor(ctx: CanvasRenderingContext2D, type: CursorType, p: Palette): void {
    ctx.lineJoin = "round";
    switch (type) {
      case "crosshair": {
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-11, 0); ctx.lineTo(-4, 0);
        ctx.moveTo(4, 0); ctx.lineTo(11, 0);
        ctx.moveTo(0, -11); ctx.lineTo(0, -4);
        ctx.moveTo(0, 4); ctx.lineTo(0, 11);
        ctx.stroke();
        ctx.globalAlpha *= 0.9;
        ctx.beginPath();
        ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = p.body;
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      }
      case "ibeam": {
        ctx.strokeStyle = p.body;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, -9); ctx.lineTo(0, 9);
        ctx.moveTo(-3, -9); ctx.lineTo(3, -9);
        ctx.moveTo(-3, 9); ctx.lineTo(3, 9);
        ctx.stroke();
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 11); ctx.lineTo(0, 14);
        ctx.stroke();
        break;
      }
      case "ew-resize": {
        ctx.strokeStyle = p.body;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-9, 0); ctx.lineTo(9, 0);
        ctx.moveTo(-9, 0); ctx.lineTo(-5, -3.5);
        ctx.moveTo(-9, 0); ctx.lineTo(-5, 3.5);
        ctx.moveTo(9, 0); ctx.lineTo(5, -3.5);
        ctx.moveTo(9, 0); ctx.lineTo(5, 3.5);
        ctx.stroke();
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-4, 0); ctx.lineTo(4, 0);
        ctx.stroke();
        break;
      }
      case "dup": {
        // Two stacked arrows (alt-drag duplicate)
        for (const off of [0, -7]) {
          ctx.beginPath();
          ctx.moveTo(0, off);
          ctx.lineTo(0, off + 16);
          ctx.lineTo(4, off + 12);
          ctx.lineTo(7, off + 18);
          ctx.lineTo(9, off + 17);
          ctx.lineTo(6, off + 11);
          ctx.lineTo(11, off + 11);
          ctx.closePath();
          ctx.globalAlpha *= off === 0 ? 1 : 0.45;
          ctx.fillStyle = p.body;
          ctx.fill();
          ctx.globalAlpha = Math.max(0.12, (ctx.globalAlpha as number) / (off === 0 ? 1 : 0.45));
          ctx.strokeStyle = p.outline;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        ctx.fillStyle = p.accent;
        ctx.beginPath();
        ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 17);
        ctx.lineTo(4.5, 13.5);
        ctx.lineTo(7.5, 19.5);
        ctx.lineTo(9.5, 18.5);
        ctx.lineTo(6.5, 12.5);
        ctx.lineTo(11.5, 12.5);
        ctx.closePath();
        ctx.fillStyle = p.body;
        ctx.fill();
        ctx.strokeStyle = p.outline;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.fillStyle = p.accent;
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
