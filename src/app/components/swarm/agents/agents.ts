/**
 * agents.ts — The cursor swarm.
 *
 * Each agent is a plain record simulated inside the engine:
 *
 *   - idle:   wandering inside the visible band (engine-fed generator)
 *   - task:   driven by its routine generator (kinematic bezier glides)
 *   - flock:  boids-style orbit around a target / the user's pointer
 *
 * Rendering is DOM: one absolutely-positioned SVG sprite per agent, kept
 * in a pooled layer, positioned with a translate transform per frame.
 * Shape changes swap inline SVG markup; presses scale the sprite down.
 * No canvas, no trails — zero per-agent allocation churn.
 */

import type { OvShape } from "../capture/model";

export type CursorShape =
  | "arrow"
  | "cross"
  | "ibeam"
  | "dup"
  | "pen"
  | "pen-add"
  | "ew"
  | "ns";

export const CURSOR_COLORS = [
  "#F24E1E",
  "#A259FF",
  "#1ABCFE",
  "#0ACF83",
  "#FF7262",
  "#FFC700",
  "#9747FF",
  "#E8467C",
] as const;

export const CURSOR_NAMES = [
  "Ada", "Linus", "Grace", "Alan", "Marga", "Ken", "Barb", "Dennis",
  "Radia", "Guido", "Fran", "Bjar", "Hedy", "Tim", "Kate", "Edsger",
  "Joan", "Don", "Sophie", "Nik", "Anita", "Brian", "Mary", "Rob",
  "Ida", "Yuki", "Shafi", "Leslie", "Jean", "Vint", "Lynn", "Bram",
] as const;

export interface Cursor {
  id: number;
  /** World coordinates (document space), like the build items. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  shape: CursorShape;
  /** 0..1 pressed state, drives sprite scale. */
  press: number;
  /** The routine generator currently steering this cursor, if any. */
  gen: Generator<number, void, number> | null;
  /** Overlay specs this cursor is presenting (selection boxes, measures). */
  ov: (() => OvShape[]) | null;
  idleFor: number;
  leaving: boolean;
  worked: boolean;
  /** Boids params (also gate spawn behavior via speed tier). */
  speed: number;
  force: number;
  spin: number;
  curl: number;
  orbit: number;
  /** True while the cursor is flocking (pre-start or finale). */
  follow: boolean;
  /** Sprite rotation (deg, from velocity heading during flocking). */
  angle: number;
  name: string;
  color: string;
}

export const HOTSPOT: Record<CursorShape, { x: number; y: number }> = {
  arrow: { x: 1.6, y: 1.6 },
  cross: { x: 12, y: 12 },
  ibeam: { x: 12, y: 8 },
  dup: { x: 1.6, y: 1.6 },
  pen: { x: 3, y: 21 },
  "pen-add": { x: 3, y: 21 },
  ew: { x: 12, y: 12 },
  ns: { x: 12, y: 12 },
};

/** Inline-SVG body of a cursor sprite. */
export function cursorSVG(shape: CursorShape, color: string): string {
  const stroke = 'stroke="#fff" stroke-width="1.4" stroke-linejoin="round"';
  const arrowPath =
    "M1.5 1.5 V17.5 L5.6 13.7 L8.2 19.9 L11 18.6 L8.3 12.6 L14 12.6 Z";
  switch (shape) {
    case "arrow":
      return `<path d="${arrowPath}" fill="${color}" ${stroke}/>`;
    case "dup":
      return (
        `<path d="${arrowPath}" transform="translate(4.5 3.5)" fill="#fff" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/>` +
        `<path d="${arrowPath}" fill="${color}" ${stroke}/>`
      );
    case "cross":
      return (
        `<g stroke-linecap="round">` +
        `<path d="M12 3.5 V20.5 M3.5 12 H20.5" stroke="#fff" stroke-width="3.4"/>` +
        `<path d="M12 3.5 V20.5 M3.5 12 H20.5" stroke="${color}" stroke-width="1.5"/>` +
        `</g>`
      );
    case "ibeam": {
      const d =
        "M8.5 4.5 H10.5 Q12 4.5 12 6 Q12 4.5 13.5 4.5 H15.5 M12 6 V18 M8.5 19.5 H10.5 Q12 19.5 12 18 Q12 19.5 13.5 19.5 H15.5";
      return (
        `<g fill="none" stroke-linecap="round">` +
        `<path d="${d}" stroke="#fff" stroke-width="3.4"/>` +
        `<path d="${d}" stroke="${color}" stroke-width="1.5"/>` +
        `</g>`
      );
    }
    case "pen":
    case "pen-add":
      return (
        `<path d="M17.4 10.6 L20.6 13.8 L13.8 20.6 L10.6 17.4 Z" fill="${color}" ${stroke}/>` +
        `<path d="M3 3 L13.1 6.3 L17.4 10.6 L10.6 17.4 L6.3 13.1 Z" fill="${color}" ${stroke}/>` +
        `<path d="M4 4 L9 9" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>` +
        `<circle cx="10.2" cy="10.2" r="1.7" fill="none" stroke="#fff" stroke-width="1.2"/>` +
        (shape === "pen-add"
          ? `<g stroke-linecap="round">` +
            `<path d="M23 19.5 V26.5 M19.5 23 H26.5" stroke="#fff" stroke-width="3.2"/>` +
            `<path d="M23 19.5 V26.5 M19.5 23 H26.5" stroke="#404040" stroke-width="1.2"/>` +
            `</g>`
          : "")
      );
    case "ew":
    case "ns":
      return `<path d="M2.5 12 L7 7.5 V10.4 H17 V7.5 L21.5 12 L17 16.5 V13.6 H7 V16.5 Z"${
        shape === "ns" ? ' transform="rotate(90 12 12)"' : ""
      } fill="${color}" ${stroke}/>`;
  }
}

export function createCursor(
  x: number,
  y: number,
  id: number,
  rand: () => number
): Cursor {
  const fast = rand() < 0.25; // ~25% fast tier
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    shape: "arrow",
    press: 0,
    gen: null,
    ov: null,
    idleFor: 0,
    leaving: false,
    worked: false,
    speed: fast ? 1000 + rand() * 500 : 300 + rand() * 450,
    force: fast ? 3500 + rand() * 2500 : 700 + rand() * 1100,
    spin: fast ? 2.2 + rand() * 1.2 : 0.8 + rand(),
    curl: rand() * 2 - 1,
    orbit: 70 + rand() * 100,
    follow: false,
    angle: 0,
    name: CURSOR_NAMES[id % CURSOR_NAMES.length],
    color: CURSOR_COLORS[id % CURSOR_COLORS.length],
  };
}
