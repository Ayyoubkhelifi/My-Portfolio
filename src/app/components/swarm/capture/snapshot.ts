/**
 * snapshot.ts — DOM walker that builds the element records snapshot.
 *
 * Runs after: FCP + document.fonts.ready + hero TextGenerateEffect settle
 * (1.6s grace) + window.load or a 4s timeout, whichever comes first.
 *
 * The walk is chunked via requestIdleCallback to keep long tasks < 50 ms.
 * Returns a SnapshotResult containing records + integrity hash.
 *
 * Key design constraints (§4.1 of the plan):
 * - Single pass: TreeWalker over document.body
 * - Records derive from measured geometry only → overlay never references live nodes
 * - Frozen clones for leaf SVG markup strings stored as outerHTML
 * - Excludes canvas, large SVGs, FloatingNav, Lottie per exclusions.ts
 */

import {
  ElementRecord,
  ElementType,
  classifyType,
  classifyRole,
  extractPaint,
  extractText,
  extractImage,
  extractSvg,
} from "./classify";
import { checkExclusion } from "./exclusions";
import { hashSnapshot, SnapshotHash } from "./hashing";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotResult {
  records: ElementRecord[];
  hash: SnapshotHash;
  /** Wall-clock ms from call to completion (for performance assertion) */
  durationMs: number;
  /** Diagnostic counts per element type */
  typeCounts: Record<ElementType, number>;
}

// ─── Readiness gating ─────────────────────────────────────────────────────────

/**
 * Waits for the page to be ready for snapshot capture.
 *
 * Resolves after:
 *   1. document.fonts.ready + FCP + load (in parallel, ~0.2–0.5s)
 *   2. Hero TextGenerateEffect settle (~1.2s grace)
 * Total wait: ~1.5s (matches reference-notes benchmark).
 */
export async function waitForReadiness(): Promise<void> {
  // 1. Parallel readiness check: fonts, FCP, load
  const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();

  const fcpReady = new Promise<void>((resolve) => {
    // Check if paint already recorded
    const paints = performance.getEntriesByType("paint");
    if (paints.some((e) => e.name === "first-contentful-paint")) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, 800);
    try {
      const observer = new PerformanceObserver((list) => {
        if (list.getEntriesByName("first-contentful-paint").length > 0) {
          clearTimeout(timeout);
          observer.disconnect();
          resolve();
        }
      });
      observer.observe({ type: "paint", buffered: true });
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });

  const loadReady =
    document.readyState === "complete"
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500);
          window.addEventListener(
            "load",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true }
          );
        });

  await Promise.all([fontsReady, fcpReady, loadReady]);

  // 2. Hero TextGenerateEffect settle grace (~1.2s)
  await new Promise<void>((resolve) => setTimeout(resolve, 1200));
}

// ─── Idle-chunked walker ──────────────────────────────────────────────────────

/** Yields to the browser between processing batches. */
function yieldToMain(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// ─── Main snapshot function ───────────────────────────────────────────────────

const BATCH_SIZE = 50; // elements processed per idle-chunk

/**
 * Walks the live DOM and builds an array of ElementRecord snapshots.
 * Must be called after waitForReadiness() resolves.
 */
export async function snapshotDOM(): Promise<SnapshotResult> {
  const startMs = performance.now();
  const records: ElementRecord[] = [];
  const typeCounts: Record<ElementType, number> = {
    text: 0,
    image: 0,
    svg: 0,
    container: 0,
    excluded: 0,
  };

  // We use a TreeWalker to iterate element nodes only
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  // Track depth via a stack of (element → depth) pairs
  // We approximate depth by counting ancestor levels from body
  const depthMap = new WeakMap<Element, number>();
  depthMap.set(document.body, 0);

  // Track parent indices for the records array
  const parentIndexMap = new WeakMap<Element, number>();
  parentIndexMap.set(document.body, -1);

  let batchCount = 0;
  let currentNode: Node | null = walker.nextNode();

  while (currentNode !== null) {
    const el = currentNode as Element;

    // Compute depth
    const parentEl = el.parentElement;
    const depth = parentEl ? (depthMap.get(parentEl) ?? 0) + 1 : 0;
    depthMap.set(el, depth);

    // Determine parent index in records array
    const parentIndex = parentEl ? (parentIndexMap.get(parentEl) ?? -1) : -1;

    // Get computed style and rect
    const computed = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    // Run exclusion checks first
    const exclusion = checkExclusion(el, computed, rect);

    let type: ElementType;
    let record: ElementRecord;

    if (exclusion.excluded) {
      type = "excluded";
      record = {
        index: records.length,
        type,
        role: "excluded",
        rect,
        paint: extractPaint(computed),
        excludedReason: exclusion.reason,
        hasAnimatedChildren: false,
        parentIndex,
        depth,
      };
    } else {
      type = classifyType(el, computed);

      if (type === "excluded") {
        record = {
          index: records.length,
          type,
          role: "excluded",
          rect,
          paint: extractPaint(computed),
          excludedReason: exclusion.reason,
          hasAnimatedChildren: false,
          parentIndex,
          depth,
        };
      } else {
        const role = classifyRole(el, rect, type, depth);
        const paint = extractPaint(computed);

        record = {
          index: records.length,
          type,
          role,
          rect,
          paint,
          hasAnimatedChildren: el.children.length > 0,
          parentIndex,
          depth,
        };

        // Type-specific extras
        if (type === "text") {
          record.text = extractText(el, computed);
        } else if (type === "image" && el instanceof HTMLImageElement) {
          record.image = extractImage(el);
        } else if (type === "svg" && el instanceof SVGElement) {
          const svgProps = extractSvg(el);
          if (svgProps) {
            record.svg = svgProps;
          } else {
            // SVG too large → downgrade to excluded
            record.type = "excluded";
            record.role = "excluded";
            record.excludedReason = "svg-too-large";
            type = "excluded";
          }
        }
      }
    }

    records.push(record);
    typeCounts[type]++;

    // Track this element's index for children to reference as parent
    parentIndexMap.set(el, record.index);

    // Chunk: yield every BATCH_SIZE nodes
    batchCount++;
    if (batchCount % BATCH_SIZE === 0) {
      await yieldToMain();
    }

    currentNode = walker.nextNode();
  }

  const hash = hashSnapshot(records);
  const durationMs = performance.now() - startMs;

  if (process.env.NODE_ENV === "development") {
    console.group("[SwarmIntro] Snapshot complete");
    console.log(`Duration: ${durationMs.toFixed(1)} ms`);
    console.log("Type counts:", typeCounts);
    console.log("Total records:", records.length);
    console.log("Hash:", hash);
    console.groupEnd();
  }

  return { records, hash, durationMs, typeCounts };
}
