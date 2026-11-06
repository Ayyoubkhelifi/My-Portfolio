/**
 * paths.ts — Spline path library for cursor agent motion.
 *
 * Provides Catmull-Rom spline paths through jittered control points,
 * deterministic per seed. Used by cursors.ts for smooth agent motion.
 *
 * Key algorithms per §4.6 and REFERENCE-NOTES.md:
 *   - moveTo duration: clamp(0.12 + √dist·0.021, 0.14, 0.9)
 *   - Perpendicular bow: sin(π·e)·bend (organic curve, not straight line)
 *   - Overshoot ±2–3px on arrival, quick settle-back
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

export interface PathSegment {
  points: Vec2[];
  duration: number; // seconds
}

// ─── Seeded random ────────────────────────────────────────────────────────────

/** Simple mulberry32 PRNG for deterministic jitter */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Move-to duration ─────────────────────────────────────────────────────────

/**
 * Computes the travel duration for a cursor moving from (x1,y1) to (x2,y2).
 * Formula from REFERENCE-NOTES.md: clamp(0.12 + √dist·0.021, 0.14, 0.9)
 */
export function moveToDuration(from: Vec2, to: Vec2): number {
  const dist = Math.sqrt(
    Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2)
  );
  return Math.max(0.14, Math.min(0.9, 0.12 + Math.sqrt(dist) * 0.021));
}

// ─── Catmull-Rom spline evaluation ────────────────────────────────────────────

/**
 * Evaluates a Catmull-Rom spline at parameter t ∈ [0,1] through points p0..p3.
 */
function catmullRom(
  p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number
): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (
      (2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    ),
    y: 0.5 * (
      (2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    ),
  };
}

// ─── Path builder ─────────────────────────────────────────────────────────────

/**
 * Builds a smooth spline path from `from` to `to` with jittered control
 * points (organic feel) and a perpendicular bow (from REFERENCE-NOTES.md).
 *
 * Returns an array of sampled Vec2 positions along the path and the total
 * duration of travel.
 */
export function buildPath(
  from: Vec2,
  to: Vec2,
  rand: () => number,
  samples: number = 32
): PathSegment {
  const duration = moveTouration(from, to);

  // Midpoint with perpendicular bow
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  // Perpendicular direction (90° rotated from travel direction)
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / (dist || 1); // normalized perpendicular
  const ny = dx / (dist || 1);

  // Bow magnitude: sin(π·e)·bend where e is the mid-travel ease and bend is a jitter
  const bend = (rand() - 0.5) * Math.min(dist * 0.25, 60);
  const bowX = mx + nx * bend;
  const bowY = my + ny * bend;

  // Control point: ghost p0 (before from) for smooth spline start
  const ghostP0: Vec2 = { x: from.x - dx * 0.3, y: from.y - dy * 0.3 };

  // Add a small overshoot at the target (±2–3px)
  const overshoot = (rand() - 0.5) * 5;
  const overshootPt: Vec2 = {
    x: to.x + nx * overshoot,
    y: to.y + ny * overshoot,
  };

  // Build a 4-point Catmull-Rom: ghost → from → bow+mid → to
  // Then add settle: bow → to → overshoot → to (quick settle)
  const controlPoints: Vec2[] = [ghostP0, from, { x: bowX, y: bowY }, to, overshootPt, to];

  const points: Vec2[] = [];
  // Sample along the main path (from → bow → to)
  const mainSamples = Math.floor(samples * 0.85);
  for (let i = 0; i <= mainSamples; i++) {
    const t = i / mainSamples;
    // Map t across the 4-point span: segment index = floor(t * 3)
    const totalSegs = 3;
    const seg = Math.min(Math.floor(t * totalSegs), totalSegs - 1);
    const localT = (t * totalSegs) - seg;
    const pt = catmullRom(
      controlPoints[seg],
      controlPoints[seg + 1],
      controlPoints[seg + 2],
      controlPoints[seg + 3] ?? controlPoints[seg + 2],
      localT
    );
    points.push(pt);
  }

  // Settle samples (overshoot → back to target)
  const settleSamples = samples - mainSamples;
  for (let i = 1; i <= settleSamples; i++) {
    const t = i / settleSamples;
    const eased = 1 - Math.pow(1 - t, 3);
    points.push({
      x: overshootPt.x + (to.x - overshootPt.x) * eased,
      y: overshootPt.y + (to.y - overshootPt.y) * eased,
    });
  }

  return { points, duration };
}

// Alias fix
function moveTouration(from: Vec2, to: Vec2): number {
  return moveToTuration(from, to);
}
function moveToTuration(from: Vec2, to: Vec2): number {
  const dist = Math.sqrt(
    Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2)
  );
  return Math.max(0.14, Math.min(0.9, 0.12 + Math.sqrt(dist) * 0.021));
}

// ─── Gathering points ─────────────────────────────────────────────────────────

/**
 * Returns a set of "gathering points" for agents to idle-fly between tasks.
 * Distributed around the viewport with some jitter.
 */
export function gatheringPoints(rand: () => number): Vec2[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return [
    { x: vw * (0.2 + rand() * 0.1), y: vh * (0.2 + rand() * 0.1) },
    { x: vw * (0.7 + rand() * 0.1), y: vh * (0.15 + rand() * 0.1) },
    { x: vw * (0.5 + rand() * 0.05), y: vh * (0.5 + rand() * 0.1) },
    { x: vw * (0.1 + rand() * 0.1), y: vh * (0.7 + rand() * 0.1) },
    { x: vw * (0.8 + rand() * 0.1), y: vh * (0.65 + rand() * 0.1) },
  ];
}

/**
 * Returns the center-viewport gathering point for the finale convergence.
 */
export function centerViewport(): Vec2 {
  return {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };
}

/**
 * Returns an exit target for each agent (fly off-screen at end).
 * Each agent gets a different direction.
 */
export function exitTarget(agentIdx: number, totalAgents: number): Vec2 {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const angle = (agentIdx / totalAgents) * Math.PI * 2;
  const dist = Math.max(vw, vh) * 1.5;
  return {
    x: vw / 2 + Math.cos(angle) * dist,
    y: vh / 2 + Math.sin(angle) * dist,
  };
}
