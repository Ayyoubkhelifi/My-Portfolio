/**
 * overlay.tsx — Shadow-root overlay host.
 *
 * Creates a full-viewport overlay surface that:
 *   1. Lives outside any transformed ancestor (appended to documentElement).
 *   2. Uses a shadow root to isolate from the site's global CSS.
 *   3. Renders the pseudo-DOM (OverlayNodes) + cursor canvas inside the shadow.
 *   4. Hides the site body via visibility:hidden during the intro.
 *
 * The React root inside the shadow DOM is mounted via createRoot() on a
 * plain container div — no React portals from the app tree (avoids
 * transform-ancestor positioning bugs per §5 of the plan).
 *
 * Usage: call mountOverlay() after snapshot is ready; call unmountOverlay()
 * on completion/abort (revealNow() also calls it internally).
 */

"use client";

import React from "react";
import { createRoot, Root } from "react-dom/client";
import type { ElementRecord } from "../capture/classify";
import { OverlayNodes } from "./nodes";
import {
  registerOverlayHost,
  hideBody,
  engageScrollLock,
} from "./reveals";

// ─── Overlay CSS injected into the shadow root ────────────────────────────────

const OVERLAY_CSS = `
  :host {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 2147483647; /* max z-index */
    pointer-events: none;
  }
  .swarm-surface {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: rgb(2, 6, 23); /* matches the site's bg-black-100 */
  }
  .swarm-wireframe-bg {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(rgba(30, 41, 59, 0.3) 1px, transparent 1px),
      linear-gradient(90deg, rgba(30, 41, 59, 0.3) 1px, transparent 1px);
    background-size: 48px 48px;
    pointer-events: none;
  }
  .swarm-nodes {
    position: absolute;
    inset: 0;
  }
  .swarm-cursor-canvas {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1;
  }
  .swarm-controls {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: flex;
    gap: 8px;
    z-index: 2;
    pointer-events: all;
  }
`;

// ─── Mount state ──────────────────────────────────────────────────────────────

interface OverlayRefs {
  hostEl: HTMLElement;
  shadowRoot: ShadowRoot;
  reactRoot: Root;
  cursorCanvas: HTMLCanvasElement;
  nodeRefMap: Map<number, HTMLElement>;
}

let _overlayRefs: OverlayRefs | null = null;

/**
 * Mounts the overlay into documentElement and returns the cursor canvas
 * and a node-ref map for use by the scheduler + cursor agents.
 */
export interface MountOverlayResult {
  cursorCanvas: HTMLCanvasElement;
  nodeRefMap: Map<number, HTMLElement>;
}

/**
 * Creates and mounts the full overlay stack:
 *   - host div → shadow root → CSS → surface → wireframe bg → nodes → cursor canvas
 *
 * Must be called in a client context (after mount, non-SSR).
 */
export function mountOverlay(
  records: ElementRecord[],
  onNodeRef?: (index: number, el: HTMLElement | null) => void
): MountOverlayResult {
  if (_overlayRefs) {
    // Already mounted — return existing canvas
    return {
      cursorCanvas: _overlayRefs.cursorCanvas,
      nodeRefMap: _overlayRefs.nodeRefMap,
    };
  }

  // --- 1. Create host element (appended to <html>, outside any transformed ancestor) ---
  const hostEl = document.createElement("div");
  hostEl.setAttribute("data-swarm-host", "1");
  hostEl.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(hostEl);

  // --- 2. Attach shadow root ---
  const shadowRoot = hostEl.attachShadow({ mode: "open" });

  // --- 3. Inject overlay CSS ---
  const styleEl = document.createElement("style");
  styleEl.textContent = OVERLAY_CSS;
  shadowRoot.appendChild(styleEl);

  // --- 4. Create the main surface ---
  const surface = document.createElement("div");
  surface.className = "swarm-surface";
  shadowRoot.appendChild(surface);

  // Wireframe background
  const wireframeBg = document.createElement("div");
  wireframeBg.className = "swarm-wireframe-bg";
  surface.appendChild(wireframeBg);

  // Container for React-rendered nodes
  const nodesContainer = document.createElement("div");
  nodesContainer.className = "swarm-nodes";
  surface.appendChild(nodesContainer);

  // --- 5. Create cursor canvas (fixed, composited) ---
  const cursorCanvas = document.createElement("canvas");
  cursorCanvas.className = "swarm-cursor-canvas";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cursorCanvas.width = window.innerWidth * dpr;
  cursorCanvas.height = window.innerHeight * dpr;
  cursorCanvas.style.width = `${window.innerWidth}px`;
  cursorCanvas.style.height = `${window.innerHeight}px`;
  surface.appendChild(cursorCanvas);

  // Scale canvas context for DPR
  const ctx = cursorCanvas.getContext("2d");
  if (ctx) ctx.scale(dpr, dpr);

  // --- 6. Mount React root inside the nodes container ---
  const nodeRefMap = new Map<number, HTMLElement>();

  const handleNodeRef = (index: number, el: HTMLElement | null) => {
    if (el) {
      nodeRefMap.set(index, el);
    } else {
      nodeRefMap.delete(index);
    }
    onNodeRef?.(index, el);
  };

  const reactRoot = createRoot(nodesContainer);
  reactRoot.render(
    <OverlayNodes records={records} onNodeRef={handleNodeRef} />
  );

  // --- 7. Register with reveals.ts for cleanup ---
  registerOverlayHost(hostEl);

  // --- 8. Hide body + engage scroll lock ---
  hideBody();
  engageScrollLock();

  _overlayRefs = {
    hostEl,
    shadowRoot,
    reactRoot,
    cursorCanvas,
    nodeRefMap,
  };

  return { cursorCanvas, nodeRefMap };
}

/**
 * Unmounts the React root and removes the overlay from the DOM.
 * Called by revealNow() / finalReveal() after the transition completes.
 * Safe to call multiple times.
 */
export function unmountOverlay(): void {
  if (!_overlayRefs) return;

  const { reactRoot, hostEl } = _overlayRefs;

  // Unmount React root
  try {
    reactRoot.unmount();
  } catch { /* ignore */ }

  // Remove from DOM
  if (hostEl.isConnected) hostEl.remove();

  _overlayRefs = null;
}

/**
 * Returns the DPR-scaled cursor canvas context, or null if not mounted.
 */
export function getCursorCanvas(): HTMLCanvasElement | null {
  return _overlayRefs?.cursorCanvas ?? null;
}

/**
 * Returns the shadow root (for injecting dynamic control elements).
 */
export function getShadowRoot(): ShadowRoot | null {
  return _overlayRefs?.shadowRoot ?? null;
}

/**
 * Returns the node ref map built by React (index → DOM element).
 */
export function getNodeRefMap(): Map<number, HTMLElement> | null {
  return _overlayRefs?.nodeRefMap ?? null;
}

// ─── Resize observer ──────────────────────────────────────────────────────────

/**
 * Sets up a resize observer that calls `onExceedDelta` if the viewport
 * changes by more than 12% in either dimension during the intro.
 * Returns a cleanup function.
 */
export function watchResize(onExceedDelta: () => void): () => void {
  const baseW = window.innerWidth;
  const baseH = window.innerHeight;

  function handleResize() {
    const dw = Math.abs(window.innerWidth - baseW) / baseW;
    const dh = Math.abs(window.innerHeight - baseH) / baseH;
    if (dw > 0.12 || dh > 0.12) {
      onExceedDelta();
    }
  }

  window.addEventListener("resize", handleResize, { passive: true });
  return () => window.removeEventListener("resize", handleResize);
}
