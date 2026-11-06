/**
 * exclusions.ts — Site-specific skip list for the Swarm Rebuild intro.
 *
 * Nodes that cannot be faithfully reconstructed via DOM geometry alone
 * (canvas-rendered content, procedural SVGs, elements invisible at load)
 * are excluded from per-element animation and handled via the final reveal
 * beat instead.
 *
 * Strategy per §4.4 of the implementation plan:
 *   - Canvas nodes → card frame/text built as DOM; canvas area shows wireframe
 *     placeholder; real canvas appears in finalReveal.
 *   - Large SVGs (outerHTML > 8 kB) → clip-reveal rectangles.
 *   - FloatingNav → not visible on load; skip entirely.
 *   - Lottie/confetti → only playable post-intro; skip entirely.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** SVG inline threshold: outerHTML larger than this → exclude (too costly) */
export const SVG_INLINE_BYTE_LIMIT = 8_192; // 8 kB

// ─── Selector-based exclusion tests ──────────────────────────────────────────

/**
 * Data-attribute we stamp on excluded nodes during the snapshot walk
 * so routines can quickly identify them without re-running exclusion logic.
 */
export const EXCLUDED_ATTR = "data-swarm-excluded";

/**
 * Checks if the element is a canvas element that renders WebGL or 2D content
 * we cannot reconstruct (Globe canvas, CanvasRevealEffect / GradientBg canvas).
 */
function isCanvasNode(el: Element): boolean {
  return el.tagName === "CANVAS";
}

/**
 * Checks if the element is a large Spotlight SVG.
 * The Spotlight component renders SVGs with a very large viewBox (3787×2842)
 * and a Gaussian blur filter — their outerHTML easily exceeds 8 kB.
 * We detect them by the `animate-spotlight` class applied in Spotlight.tsx.
 */
function isSpotlightSVG(el: Element): boolean {
  if (el.tagName !== "svg" && el.tagName !== "SVG") return false;
  return el.classList.contains("animate-spotlight");
}

/**
 * Checks if the element is part of the FloatingNav component.
 * FloatingNav is not visible at page load (it appears on scroll) and
 * uses a fixed position outside the normal document flow.
 */
function isFloatingNav(el: Element): boolean {
  // FloatingNav renders inside a fixed-position div; we detect by its
  // class pattern or by traversal to a known ancestor.
  // The component applies fixed positioning — check the computed style
  // or the element's own class list for the nav container.
  if (el.closest('[class*="floating"]')) return true;
  // Also exclude any fixed-position nav element entirely
  if (
    (el.tagName === "NAV" || el.tagName === "nav") &&
    el.closest('[style*="position: fixed"], [class*="fixed"]')
  ) {
    return true;
  }
  return false;
}

/**
 * Checks if the element belongs to Lottie / confetti animation containers.
 * These are only playable post-intro and have no meaningful static appearance.
 */
function isLottieOrConfetti(el: Element): boolean {
  // react-lottie renders into a div; confetti is canvas-based.
  // We detect by looking for lottie-related attributes or the data-lottie attr.
  if (el.hasAttribute("data-lottie")) return true;
  if (el.closest("[data-lottie]")) return true;
  // Confetti canvas is typically tagged by id or class
  if (el.id === "confetti-canvas") return true;
  return false;
}

/**
 * Checks if the element is a GridBackground decorative SVG/div that
 * spans the full viewport with pointer-events: none — it's a pure
 * decorative layer that will pop in during finalReveal anyway.
 */
function isGridBackground(el: Element): boolean {
  // GridBackground.tsx renders a fixed full-screen div with specific classes
  if (el.classList.contains("dark:bg-black-100")) return false; // keep body
  // Look for the grid container by its characteristic class combo
  if (
    el.classList.contains("pointer-events-none") &&
    el.closest('[class*="absolute"]')
  ) {
    // Only exclude if it's a background-layer element (z < 0 or z = 0)
    const style = window.getComputedStyle(el);
    const z = parseInt(style.zIndex ?? "0", 10);
    if (z <= 0 && style.position === "fixed") return true;
  }
  return false;
}

// ─── Main exclusion check ─────────────────────────────────────────────────────

export type ExclusionReason =
  | "canvas"
  | "spotlight-svg"
  | "floating-nav"
  | "lottie-confetti"
  | "grid-background"
  | "svg-too-large"
  | "zero-area"
  | "visibility-hidden"
  | "display-none"
  | "clip-hidden";

export interface ExclusionResult {
  excluded: boolean;
  reason?: ExclusionReason;
}

/**
 * Returns whether an element should be excluded from per-element animation,
 * and the reason why.
 *
 * Call this during the snapshot walk (capture/snapshot.ts) with the element
 * and its computed style already in hand to avoid redundant style reads.
 */
export function checkExclusion(
  el: Element,
  computed: CSSStyleDeclaration,
  rect: DOMRect
): ExclusionResult {
  // --- Display / visibility pruning ---

  if (computed.display === "none") {
    return { excluded: true, reason: "display-none" };
  }

  if (computed.visibility === "hidden" || computed.opacity === "0") {
    // Keep elements with 0 opacity that are part of animations (e.g., TextGenerateEffect)
    // We detect these by checking if they have an animation or transition
    const hasAnim =
      computed.animationName !== "none" || computed.transition !== "none 0s ease 0s";
    if (!hasAnim) {
      return { excluded: true, reason: "visibility-hidden" };
    }
  }

  // Zero-area nodes (1px clip tricks, collapsed elements)
  if (rect.width < 2 && rect.height < 2) {
    return { excluded: true, reason: "zero-area" };
  }

  // CSS clip-path inset(50%) trick (visually hidden pattern)
  const cp = computed.clipPath;
  if (cp && cp.includes("inset(50%)")) {
    return { excluded: true, reason: "clip-hidden" };
  }

  // --- Content-type exclusions ---

  if (isCanvasNode(el)) {
    return { excluded: true, reason: "canvas" };
  }

  if (isSpotlightSVG(el)) {
    return { excluded: true, reason: "spotlight-svg" };
  }

  if (isFloatingNav(el)) {
    return { excluded: true, reason: "floating-nav" };
  }

  if (isLottieOrConfetti(el)) {
    return { excluded: true, reason: "lottie-confetti" };
  }

  if (isGridBackground(el)) {
    return { excluded: true, reason: "grid-background" };
  }

  return { excluded: false };
}

/**
 * Checks whether a captured SVG's outerHTML exceeds the inline byte limit.
 * Returns true if the SVG is too large to inline → should be treated as excluded.
 */
export function isSVGTooLarge(el: SVGElement): boolean {
  return el.outerHTML.length > SVG_INLINE_BYTE_LIMIT;
}
