/**
 * model.ts — Item model for the Swarm Rebuild capture.
 *
 * A handful of *paintable entities* ("items") in DOCUMENT ("world")
 * coordinates — not one record per DOM element. This is the core
 * difference from a naive per-element snapshot: nested wrappers merge
 * away, only things that visibly paint something become items.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemKind = "rect" | "text" | "image" | "line";

export interface ClipBox {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** One typed-character (or atomic element) unit inside a text item. */
export interface TypeUnit {
  /** Text node whose data is progressively sliced */
  t?: Text;
  /** The original full string of that text node */
  src?: string;
  /** First char index of this unit in item.seq */
  at: number;
  /** Atomic element revealed all at once (icon, img, badge span) */
  e?: HTMLElement;
}

export interface SwarmItem {
  id: number;
  kind: ItemKind;
  /** World (document) coords */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clip region in world coords (from overflow-hidden ancestors) */
  clip: ClipBox | null;
  /** Computed opacity at capture (item is drawn at this opacity) */
  op: number;
  /** Paint properties as an inline cssText (bg, borders, radius, shadow) */
  css: string;
  /** text items */
  text?: string;
  typed?: { clone: HTMLElement; units: TypeUnit[]; seq: string };
  fs?: number;
  lh?: number;
  color?: string;
  font?: string;
  align?: string;
  ls?: string;
  /** image items */
  src?: string;
  fit?: string;
  /** inline SVG markup (used for svg-derived image items) */
  svgHtml?: string;
  /** text/image drawing hints */
  big?: boolean;
  /** structural */
  parent?: SwarmItem;
  dupOf?: SwarmItem;
  /** runtime (managed by view/scheduler — not captured) */
  v?: number;
  vis?: boolean;
  styled?: boolean;
  drawW?: number;
  drawH?: number;
  node?: HTMLElement;
  snl?: HTMLElement;
  caret?: HTMLElement;
  offX?: number;
  offY?: number;
  scale?: number;
  shown?: number;
  settleAt?: number;
  /** Drag offset applied by a duplicate routine (world px). */
  dx?: number;
  dy?: number;
  /** Text item is mid-edit (caret active, box outlined). */
  editing?: boolean;
  /** Text item has a full-content selection active (bounds show full box). */
  selAll?: boolean;
  /** Line items carry their pen path (built by the planner). */
  pts?: Array<{ x: number; y: number }>;
}

// ─── Overlay specs (selection boxes, measures) ───────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OvShape {
  t: "box" | "measure";
  /** For boxes: the rectangle. For measures: endpoint A. */
  b: Box;
  /** For measures: endpoint B. */
  a?: Box;
  color?: "blue" | "red";
  handles?: boolean;
  badge?: string;
  rulerLines?: boolean;
  /** Text baseline accent line drawn during selection. */
  underline?: Box | null;
  /** For measures: the gap label ("24"). */
  label?: string;
}

/** A repeated component: master subtree + one or more copies. */
export interface DupGroup {
  masterItems: SwarmItem[];
  copies: Array<{
    items: SwarmItem[];
    dx: number;
    dy: number;
  }>;
}

/** Vertical / horizontal alignment guide snapped to during text builds. */
export interface Guide {
  axis: "x" | "y";
  pos: number; // world coordinate of the guide
  flash: number; // 0..1 animation state
  op: number;
  /** Live drag head position while being placed (world coord). */
  cur?: number;
  /** Shown at all? (dragging or placed) */
  vis?: boolean;
  /** Currently under drag. */
  dragging?: boolean;
  /** builder task that placed this guide */
  task?: unknown;
  /** Text tasks that snap to this guide */
  deps?: unknown[];
  shownAt?: number;
}

export interface CaptureResult {
  items: SwarmItem[];
  groups: DupGroup[];
  guides: Guide[];
  docW: number;
  docH: number;
  /** page background color at capture */
  bgColor: string;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

export function rectsIntersect(
  a: ClipBox,
  l: number,
  t: number,
  r: number,
  b: number
): boolean {
  return a.l < r && a.r > l && a.t < b && a.b > t;
}

/** Union of a rect into a clip box (intersection semantics, inverted). */
export function clipFromRect(w: number, h: number): ClipBox {
  return { l: 0, t: 0, r: w, b: h };
}
