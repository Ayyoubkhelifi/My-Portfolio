/**
 * pointerLayer.ts — Single shared canvas for all cursor agents.
 *
 * Manages the cursor canvas: draws cursors, trails, click bursts, and
 * selection outlines for all N agents in a single rAF loop.
 *
 * Key design constraints (§4.6, §2):
 *   - Single composited canvas (fixed layer, own rAF chunk)
 *   - Fading polyline trails per agent (alpha 0.25→0, capped 24 points)
 *   - DPR-aware rendering (capped at 2)
 *   - Entirely vector-drawn (no image assets)
 *   - Purged with the overlay on cleanup
 */

import type { Vec2 } from "./paths";

// ─── Cursor archetypes ────────────────────────────────────────────────────────

export type CursorType =
  | "arrow"
  | "crosshair"
  | "ibeam"
  | "ew-resize"
  | "pen";

/** Two-color cursor sprite (body + accent, original designs) */
interface CursorPalette {
  body: string;
  accent: string;
  outline: string;
}

/** Palette per agent (cyan/indigo dark-site palette) */
const AGENT_PALETTES: CursorPalette[] = [
  { body: "#e2e8f0", accent: "#38bdf8", outline: "#0f172a" }, // sky
  { body: "#e2e8f0", accent: "#818cf8", outline: "#0f172a" }, // indigo
  { body: "#e2e8f0", accent: "#34d399", outline: "#0f172a" }, // emerald
  { body: "#e2e8f0", accent: "#fb923c", outline: "#0f172a" }, // orange
  { body: "#e2e8f0", accent: "#f472b6", outline: "#0f172a" }, // pink
  { body: "#e2e8f0", accent: "#a78bfa", outline: "#0f172a" }, // violet
];

// ─── Cursor drawing routines ──────────────────────────────────────────────────

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  palette: CursorPalette
): void {
  ctx.save();
  ctx.translate(x, y);
  // Arrow pointer shape (original path geometry)
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 18);
  ctx.lineTo(4, 14);
  ctx.lineTo(7, 20);
  ctx.lineTo(9, 19);
  ctx.lineTo(6, 13);
  ctx.lineTo(11, 13);
  ctx.closePath();
  ctx.fillStyle = palette.body;
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Accent dot at tip
  ctx.beginPath();
  ctx.arc(0, 0, 2, 0, Math.PI * 2);
  ctx.fillStyle = palette.accent;
  ctx.fill();
  ctx.restore();
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  palette: CursorPalette
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.5;
  // Cross lines
  ctx.beginPath();
  ctx.moveTo(-10, 0); ctx.lineTo(-3, 0);
  ctx.moveTo(3, 0); ctx.lineTo(10, 0);
  ctx.moveTo(0, -10); ctx.lineTo(0, -3);
  ctx.moveTo(0, 3); ctx.lineTo(0, 10);
  ctx.stroke();
  // Center circle
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.strokeStyle = palette.body;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawIbeam(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  palette: CursorPalette
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = palette.body;
  ctx.lineWidth = 1.5;
  // Vertical bar
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(0, 9);
  // Top serif
  ctx.moveTo(-3, -9); ctx.lineTo(3, -9);
  // Bottom serif
  ctx.moveTo(-3, 9); ctx.lineTo(3, 9);
  ctx.stroke();
  // Accent line mid
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-2, 0); ctx.lineTo(2, 0);
  ctx.stroke();
  ctx.restore();
}

function drawPen(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  palette: CursorPalette
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 4);
  // Pen body
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.lineTo(2, -6);
  ctx.lineTo(2, 6);
  ctx.lineTo(0, 10);
  ctx.lineTo(-2, 6);
  ctx.lineTo(-2, -6);
  ctx.closePath();
  ctx.fillStyle = palette.body;
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Nib tip
  ctx.beginPath();
  ctx.moveTo(0, 10);
  ctx.lineTo(-1, 14);
  ctx.lineTo(1, 14);
  ctx.closePath();
  ctx.fillStyle = palette.accent;
  ctx.fill();
  ctx.restore();
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  type: CursorType,
  palette: CursorPalette
): void {
  switch (type) {
    case "crosshair": drawCrosshair(ctx, x, y, palette); break;
    case "ibeam": drawIbeam(ctx, x, y, palette); break;
    case "pen": drawPen(ctx, x, y, palette); break;
    default: drawArrow(ctx, x, y, palette);
  }
}

// ─── Click burst drawing ──────────────────────────────────────────────────────

interface Burst {
  x: number;
  y: number;
  age: number; // seconds
  palette: CursorPalette;
}

// ─── Trail management ─────────────────────────────────────────────────────────

const TRAIL_MAX_POINTS = 24;

// ─── Agent state ──────────────────────────────────────────────────────────────

export interface AgentRenderState {
  x: number;
  y: number;
  cursorType: CursorType;
  visible: boolean;
  opacity: number;
  trail: Vec2[];
}

// ─── PointerLayer class ───────────────────────────────────────────────────────

export class PointerLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private agents: AgentRenderState[];
  private bursts: Burst[] = [];
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private active = false;

  constructor(canvas: HTMLCanvasElement, agentCount: number) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("PointerLayer: could not get 2d context");
    this.ctx = ctx;

    this.agents = Array.from({ length: agentCount }, () => ({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
      cursorType: "arrow" as CursorType,
      visible: false,
      opacity: 1,
      trail: [],
    }));
  }

  /** Update a specific agent's position and cursor type */
  setAgentState(
    idx: number,
    x: number,
    y: number,
    cursorType: CursorType = "arrow",
    opacity = 1
  ): void {
    const agent = this.agents[idx];
    if (!agent) return;

    // Add to trail
    agent.trail.push({ x: agent.x, y: agent.y });
    if (agent.trail.length > TRAIL_MAX_POINTS) {
      agent.trail.shift();
    }

    agent.x = x;
    agent.y = y;
    agent.cursorType = cursorType;
    agent.visible = true;
    agent.opacity = opacity;
  }

  /** Add a click burst at (x, y) for the given agent */
  addClickBurst(agentIdx: number, x: number, y: number): void {
    const palette = AGENT_PALETTES[agentIdx % AGENT_PALETTES.length];
    this.bursts.push({ x, y, age: 0, palette });
  }

  /** Set agent visibility (for fade-in/out) */
  setAgentVisible(idx: number, visible: boolean, opacity = 1): void {
    const agent = this.agents[idx];
    if (!agent) return;
    agent.visible = visible;
    agent.opacity = opacity;
  }

  /** Start the render loop */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.rafId = requestAnimationFrame(this._render.bind(this));
  }

  /** Stop the render loop */
  stop(): void {
    this.active = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private _render(ts: number): void {
    if (!this.active) return;

    const dt = this.lastTs !== null ? (ts - this.lastTs) / 1000 : 0.016;
    this.lastTs = ts;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    // Clear canvas
    this.ctx.clearRect(0, 0, w, h);

    // Draw trails
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      if (!agent.visible || agent.trail.length < 2) continue;

      const palette = AGENT_PALETTES[i % AGENT_PALETTES.length];
      this._drawTrail(agent.trail, palette, agent.opacity);
    }

    // Draw click bursts
    this.bursts = this.bursts.filter((burst) => {
      burst.age += dt;
      const t = burst.age / 0.4; // 400ms burst lifetime
      if (t >= 1) return false;

      const eased = 1 - Math.pow(1 - t, 2);
      this.ctx.save();
      // Expanding ring
      this.ctx.beginPath();
      this.ctx.arc(burst.x, burst.y, eased * 18, 0, Math.PI * 2);
      this.ctx.strokeStyle = burst.palette.accent;
      this.ctx.globalAlpha = (1 - t) * 0.7;
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
      // Small center ellipse (1 frame)
      if (t < 0.1) {
        this.ctx.beginPath();
        this.ctx.ellipse(burst.x, burst.y, 4, 2, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = burst.palette.accent;
        this.ctx.globalAlpha = (1 - t * 10) * 0.8;
        this.ctx.fill();
      }
      this.ctx.restore();
      return true;
    });

    // Draw cursors (on top)
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      if (!agent.visible) continue;

      const palette = AGENT_PALETTES[i % AGENT_PALETTES.length];
      this.ctx.save();
      this.ctx.globalAlpha = agent.opacity;
      drawCursor(this.ctx, agent.x, agent.y, agent.cursorType, palette);
      this.ctx.restore();
    }

    this.rafId = requestAnimationFrame(this._render.bind(this));
  }

  private _drawTrail(trail: Vec2[], palette: CursorPalette, agentOpacity: number): void {
    if (trail.length < 2) return;

    for (let i = 1; i < trail.length; i++) {
      const t = i / trail.length; // 0 at oldest, 1 at newest
      const alpha = t * 0.25 * agentOpacity; // max 0.25 alpha
      this.ctx.beginPath();
      this.ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      this.ctx.lineTo(trail[i].x, trail[i].y);
      this.ctx.strokeStyle = palette.accent;
      this.ctx.lineWidth = 1 + t;
      this.ctx.globalAlpha = alpha;
      this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
  }

  /** Dispose: stop loop and clear canvas */
  dispose(): void {
    this.stop();
    if (this.canvas.isConnected) {
      const ctx = this.canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
