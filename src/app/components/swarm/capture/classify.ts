/**
 * classify.ts — Element classification for the snapshot walker.
 *
 * Maps each visible DOM element to one of the swarm's element types,
 * and extracts the computed-style properties needed for each type.
 *
 * Property whitelists are intentionally narrow — we capture only
 * what the routines in build/routines.ts actually use to avoid
 * over-fetching computed styles (each getComputedStyle call is O(n props)).
 */

import { ExclusionReason, isSVGTooLarge } from "./exclusions";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The 6 element types the routines understand */
export type ElementType =
  | "text"
  | "image"
  | "svg"
  | "container"
  | "excluded";

/** Hierarchy rank for the scheduler's building order */
export type ElementRole =
  | "backdrop"           // body, full-viewport backgrounds
  | "major-container"    // hero ring, bento grid frame, section shells
  | "mid-container"      // cards, nav bar, footer bar
  | "leaf-text"          // text leaf nodes
  | "leaf-image"         // images, logos
  | "leaf-svg"           // icons, inline SVGs
  | "decorative"         // subtle gradients, borders, small decorative SVGs
  | "excluded";          // canvas, spotlights, etc.

// ─── Paint properties (shared across all types) ───────────────────────────────

export interface PaintProps {
  backgroundColor: string;
  backgroundImage: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
  boxShadow: string;
  opacity: string;
  transform: string;
  zIndex: string;
  position: string;
}

// ─── Type-specific extra properties ──────────────────────────────────────────

export interface TextProps {
  textContent: string;
  font: string;         // computed shorthand: "style weight size/lineHeight family"
  color: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  whiteSpace: string;
  display: string;
  textTransform: string;
}

export interface ImageProps {
  currentSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  objectFit: string;
  alt: string;
}

export interface SvgProps {
  outerHTML: string;    // only stored if ≤ SVG_INLINE_BYTE_LIMIT
  width: string;
  height: string;
  hasStrokePaths: boolean;
}

// ─── Unified element record ───────────────────────────────────────────────────

export interface ElementRecord {
  /** Stable index within the snapshot array (used for hashing) */
  index: number;
  type: ElementType;
  role: ElementRole;
  /** Viewport-relative rect at time of capture */
  rect: DOMRect;
  paint: PaintProps;
  /** Set for type === 'excluded' */
  excludedReason?: ExclusionReason;
  /** Set for type === 'text' */
  text?: TextProps;
  /** Set for type === 'image' */
  image?: ImageProps;
  /** Set for type === 'svg' */
  svg?: SvgProps;
  /** True if this element has children that will be animated separately */
  hasAnimatedChildren: boolean;
  /** Parent index in the snapshot array (-1 for root) */
  parentIndex: number;
  /** Depth in the DOM tree (used for priority ordering) */
  depth: number;
}

// ─── Paint property extractor ─────────────────────────────────────────────────

const PAINT_PROPS: Array<keyof PaintProps> = [
  "backgroundColor",
  "backgroundImage",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "boxShadow",
  "opacity",
  "transform",
  "zIndex",
  "position",
];

export function extractPaint(computed: CSSStyleDeclaration): PaintProps {
  const paint = {} as PaintProps;
  for (const prop of PAINT_PROPS) {
    paint[prop] = computed[prop as keyof CSSStyleDeclaration] as string ?? "";
  }
  return paint;
}

// ─── Text property extractor ──────────────────────────────────────────────────

export function extractText(el: Element, computed: CSSStyleDeclaration): TextProps {
  // Build the font shorthand manually since `computed.font` can be empty on
  // some browsers when the shorthand isn't directly set.
  const size = computed.fontSize;
  const family = computed.fontFamily;
  const weight = computed.fontWeight;
  const style = computed.fontStyle;
  const lh = computed.lineHeight;
  const font = `${style} ${weight} ${size}/${lh} ${family}`.trim();

  return {
    textContent: (el.textContent ?? "").trim(),
    font,
    color: computed.color,
    lineHeight: computed.lineHeight,
    letterSpacing: computed.letterSpacing,
    textAlign: computed.textAlign,
    whiteSpace: computed.whiteSpace,
    display: computed.display,
    textTransform: computed.textTransform,
  };
}

// ─── Image property extractor ─────────────────────────────────────────────────

export function extractImage(el: HTMLImageElement): ImageProps {
  return {
    currentSrc: el.currentSrc || el.src || "",
    naturalWidth: el.naturalWidth,
    naturalHeight: el.naturalHeight,
    objectFit: (window.getComputedStyle(el).objectFit) || "fill",
    alt: el.alt || "",
  };
}

// ─── SVG property extractor ───────────────────────────────────────────────────

export function extractSvg(el: SVGElement): SvgProps | null {
  if (isSVGTooLarge(el)) return null; // caller marks as excluded
  const paths = el.querySelectorAll("path[stroke], line[stroke], polyline[stroke]");
  return {
    outerHTML: el.outerHTML,
    width: el.getAttribute("width") ?? el.getBoundingClientRect().width.toString(),
    height: el.getAttribute("height") ?? el.getBoundingClientRect().height.toString(),
    hasStrokePaths: paths.length > 0,
  };
}

// ─── Role classifier ──────────────────────────────────────────────────────────

/**
 * Assigns a hierarchy role to an element based on its size, depth,
 * and type — used by the scheduler to determine building order.
 */
export function classifyRole(
  el: Element,
  rect: DOMRect,
  type: ElementType,
  depth: number
): ElementRole {
  if (type === "excluded") return "excluded";

  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const area = rect.width * rect.height;
  const viewArea = viewW * viewH;

  // Backdrop: very large containers that cover most of the viewport
  if (type === "container" && area > viewArea * 0.6 && depth <= 3) {
    return "backdrop";
  }

  // Major containers: section shells, hero ring, bento frame
  if (type === "container" && area > viewArea * 0.08 && depth <= 6) {
    return "major-container";
  }

  // Mid containers: cards, narrower section boxes
  if (type === "container" && depth <= 10) {
    return "mid-container";
  }

  // Leaf nodes
  if (type === "text") return "leaf-text";
  if (type === "image") return "leaf-image";
  if (type === "svg") {
    // Small SVGs in deep nesting → decorative
    if (rect.width < 32 && rect.height < 32 && depth > 8) return "decorative";
    return "leaf-svg";
  }

  // Deep containers → decorative
  if (type === "container" && depth > 10) return "decorative";

  return "decorative";
}

// ─── Type classifier ──────────────────────────────────────────────────────────

/**
 * Classifies an element's primary type based on tag + computed properties.
 * Returns 'excluded' for elements that should be skipped — the caller
 * should still call checkExclusion() separately for the full reason.
 */
export function classifyType(el: Element, computed: CSSStyleDeclaration): ElementType {
  const tag = el.tagName.toUpperCase();

  // Canvas → always excluded
  if (tag === "CANVAS") return "excluded";

  // Images
  if (tag === "IMG") return "image";

  // SVG elements (top-level SVG, not child paths)
  if (tag === "SVG") return "svg";

  // Text-primary nodes: headings, paragraphs, spans with text content
  if (["H1", "H2", "H3", "H4", "H5", "H6", "P", "SPAN", "A", "LABEL", "LI"].includes(tag)) {
    // If the element has only text content (no block children), classify as text
    const hasBlockChildren = Array.from(el.children).some(
      (c) => window.getComputedStyle(c).display !== "inline"
    );
    if (!hasBlockChildren || el.children.length === 0) {
      return "text";
    }
  }

  // Buttons with text
  if (tag === "BUTTON") {
    return "container"; // button containers get rect-draw; inner text typed separately
  }

  // Everything else with a visible box → container
  const display = computed.display;
  if (display === "none") return "excluded";
  if (display !== "inline") return "container"; // block, flex, grid, etc.

  // Inline elements with visible text → text
  if ((el.textContent ?? "").trim().length > 0) return "text";

  return "excluded";
}
