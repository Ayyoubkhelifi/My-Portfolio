/**
 * overlay.ts — the Swarm Rebuild stage.
 *
 * A single shadow-rooted host on documentElement containing, bottom-up:
 *
 *   .surface   (opaque page background — hides the real page during builds)
 *     .world   (document-sized layer in WORLD coords, translated by scroll)
 *     .fx      (alignment guide lines, in world coords)
 *     canvas   (cursor swarm: trails, bursts, sprites)
 *     .hud     (agents · progress readout)
 *
 * Item nodes are created once on demand and mutated in place by the
 * routines (draw sizes, typed text, clip reveals). No React, no
 * per-element re-renders, no layout thrash: everything is transform,
 * opacity, width/height and textContent on absolutely-positioned nodes.
 */

import type { Guide, SwarmItem } from "../capture/model";

// ─── Styles ───────────────────────────────────────────────────────────────────

const OVERLAY_CSS = `
  :host {
    all: initial;
    display: block;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    contain: strict;
    pointer-events: none;
  }
  .surface {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .world {
    position: absolute;
    top: 0;
    left: 0;
    will-change: transform;
    transform: translate3d(0, 0, 0);
  }
  .fx {
    position: absolute;
    top: 0;
    left: 0;
  }
  .guide {
    position: absolute;
    width: 1px;
    background: rgba(244, 63, 94, 0.75);
    box-shadow: 0 0 6px rgba(244, 63, 94, 0.5);
    opacity: 0;
    transition: opacity 0.18s ease;
  }
  .hud {
    position: fixed;
    left: 28px;
    bottom: 26px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: rgba(226, 232, 240, 0.82);
    font-size: 12.5px;
    letter-spacing: 0.01em;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    transition: opacity 0.4s ease;
  }
  .hud .dot {
    width: 8px; height: 8px; border-radius: 50%;
    margin-right: -4px;
    box-shadow: 0 0 4px rgba(0,0,0,0.5);
  }
  .hud .bar {
    width: 110px; height: 3px; border-radius: 2px;
    background: rgba(148, 163, 184, 0.22);
    overflow: hidden;
  }
  .hud .bar > i {
    display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, #38bdf8, #818cf8);
    border-radius: 2px;
  }
  .node-draw {
    border: 1.5px dashed rgba(56, 189, 248, 0.85) !important;
    background-color: transparent !important;
    box-shadow: none !important;
  }
  .node-settle {
    transition: opacity 0.24s ease, transform 0.34s cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  .caret {
    position: relative;
    display: inline-block;
    width: 2px;
    height: 1.15em;
    vertical-align: -0.2em;
    background: currentColor;
    animation: swarmblink 0.9s steps(2, start) infinite;
    margin-left: 1px;
  }
  @keyframes swarmblink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
`;

// ─── View class ───────────────────────────────────────────────────────────────

const DASH = "1.5px dashed rgba(56,189,248,0.85)";

export class View {
  host!: HTMLDivElement;
  shadow!: ShadowRoot;
  surface!: HTMLDivElement;
  world!: HTMLDivElement;
  fx!: HTMLDivElement;
  canvas!: HTMLCanvasElement;
  hudText!: HTMLSpanElement;
  hudBarFill!: HTMLElement;
  hudDots!: HTMLSpanElement;

  private _mounted = false;
  static _shadow: ShadowRoot | null = null;

  /** Current overlay shadow root (used by the controls module). */
  static getShadowRoot(): ShadowRoot | null {
    return View._shadow;
  }

  mount(bgColor: string, docW: number, docH: number): void {    if (this._mounted) return;
    this._mounted = true;    this.host = document.createElement("div");
    this.host.setAttribute("data-swarm-host", "");
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    this.shadow.appendChild(style);

    this.surface = document.createElement("div");
    this.surface.className = "surface";
    this.surface.style.background = bgColor;
    this.shadow.appendChild(this.surface);

    this.world = document.createElement("div");
    this.world.className = "world";
    this.world.style.width = `${docW}px`;
    this.world.style.height = `${docH}px`;
    this.surface.appendChild(this.world);

    this.fx = document.createElement("div");
    this.fx.className = "fx";
    this.fx.style.width = `${docW}px`;
    this.fx.style.height = `${docH}px`;
    this.surface.appendChild(this.fx);

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    this.surface.appendChild(this.canvas);

    // HUD
    const hud = document.createElement("div");
    hud.className = "hud";
    this.hudDots = document.createElement("span");
    this.hudDots.style.cssText = "display:flex;";
    hud.appendChild(this.hudDots);
    this.hudText = document.createElement("span");
    this.hudText.textContent = "building…";
    hud.appendChild(this.hudText);
    const bar = document.createElement("div");
    bar.className = "bar";
    this.hudBarFill = document.createElement("i");
    bar.appendChild(this.hudBarFill);
    hud.appendChild(bar);
    this.surface.appendChild(hud);

    document.documentElement.appendChild(this.host);
    View._shadow = this.shadow;
  }

  unmount(): void {
    if (!this._mounted) return;
    this._mounted = false;
    View._shadow = null;
    try {
      this.host.remove();
    } catch {
      /* ignore */
    }
  }

  isMounted(): boolean {
    return this._mounted;
  }

  // ── Panning ───────────────────────────────────────────────────────────────

  /** Sync the world layer with the current scroll offsets. */
  pan(sx: number, sy: number): void {
    this.world.style.transform = `translate3d(${-sx}px, ${-sy}px, 0)`;
  }

  // ── Item nodes ────────────────────────────────────────────────────────────

  /** Creates the DOM node for an item (hidden until its routine runs). */
  createNode(item: SwarmItem): HTMLElement {
    const node = document.createElement("div");
    node.style.cssText = [
      "position:absolute",
      `left:${item.x}px`,
      `top:${item.y}px`,
      `width:${Math.max(item.w, 1)}px`,
      `height:${Math.max(item.h, 1)}px`,
      "box-sizing:border-box",
      "overflow:visible",
      `opacity:0`,
    ].join(";");

    if (item.clip) {
      node.style.clipPath = clipInner(item.clip, item.x, item.y, item.w, item.h);
      node.style.overflow = "hidden";
    }

    if (item.kind === "text" && item.typed && item.fs) {
      node.style.fontSize = `${item.fs}px`;
      node.style.lineHeight = item.lh ? `${item.lh}px` : "";
      node.style.color = item.color ?? "";
      node.style.fontFamily = item.font?.split(" / ").pop() ?? "";
      // Typed content clone: starts empty, units revealed progressively.
      const clone = item.typed.clone;
      hideUnits(item);
      clone.style.position = "absolute";
      clone.style.inset = "0";
      node.appendChild(clone);
      const caret = document.createElement("span");
      caret.className = "caret";
      node.appendChild(caret);
      item.caret = caret;
    } else if (item.kind === "image") {
      node.style.overflow = "hidden";
      let inner: HTMLElement;
      if (item.svgHtml) {
        inner = document.createElement("div");
        inner.style.cssText = "position:absolute;inset:0;";
        inner.innerHTML = item.svgHtml;
      } else {
        const img = document.createElement("img");
        img.src = item.src ?? "";
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.style.cssText = [
          "position:absolute;inset:0;width:100%;height:100%",
          `object-fit:${item.fit || "fill"}`,
        ].join(";");
        inner = img;
      }
      node.appendChild(inner);
    } else if (item.kind === "line") {
      node.innerHTML = `<div style="position:absolute;left:0;right:0;top:-0.5px;height:1px;background:${bodyLineColor()}"></div>`;
    }

    this.world.appendChild(node);
    item.node = node;
    item.v = 1;
    return node;
  }

  /** Applies the captured paint (runs when the routine finishes drawing). */
  applyStyle(item: SwarmItem): void {
    if (!item.node) return;
    item.node.classList.remove("node-draw");
    item.node.style.border = "";
    item.node.style.outline = "";
    if (item.kind === "rect" && item.css) {
      item.node.style.cssText += item.css;
    }
  }

  /** Dashed draw outline helper on the node itself. */
  makeDrawOutline(item: SwarmItem): void {
    item.node?.style.removeProperty("outline");
    if (item.node) item.node.style.setProperty("outline", DASH, "important");
    if (item.node) item.node.style.setProperty("outline-offset", "0px");
  }

  clearDrawOutline(item: SwarmItem): void {
    item.node?.style.removeProperty("outline");
    item.node?.style.removeProperty("outline-offset");
  }

  // ── Typed text ────────────────────────────────────────────────────────────

  /** Reveals `shown` characters of a text item across its typed units. */
  revealText(item: SwarmItem, shown: number): void {
    if (!item.typed || !item.node) return;
    const total = item.typed.seq.length;
    const s = Math.min(shown, total);
    for (const u of item.typed.units) {
      if (u.t && u.src !== undefined) {
        const keep = Math.max(0, Math.min(u.src.length, s - u.at));
        const next = u.src.slice(0, keep);
        if (u.t.data !== next) u.t.data = next; // Porsche-fast dedupe
      } else if (u.e) {
        const on = s > u.at;
        if (on !== (u.e.style.visibility === "visible")) {
          u.e.style.visibility = on ? "visible" : "hidden";
        }
      }
    }
    item.shown = s;
  }

  removeCaret(item: SwarmItem): void {
    if (item.caret) {
      item.caret.remove();
      item.caret = undefined;
    }
  }

  // ── Guides ────────────────────────────────────────────────────────────────

  /** Sets the visible guide set; alpha driven by the engine each frame. */
  renderGuides(guides: Guide[]): void {
    for (const g of guides) {
      const alpha = Math.max(g.op, g.flash);
      let el = (g as Guide & { _el?: HTMLElement })._el;
      if (alpha < 0.02 && el) {
        el.style.opacity = "0";
        continue;
      }
      if (!el) {
        el = document.createElement("div");
        el.className = "guide";
        el.style.top = "0";
        el.style.height = "120%";
        el.style.left = `${g.pos}px`;
        this.fx.appendChild(el);
        (g as Guide & { _el?: HTMLElement })._el = el;
      }
      el.style.opacity = String(alpha);
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  hudSetAgentColors(colors: string[]): void {
    this.hudDots.innerHTML = colors
      .map((c) => `<span class="dot" style="background:${c}"></span>`)
      .join("");
  }

  hudUpdate(text: string, progress: number): void {
    if (this.hudText.textContent !== text) this.hudText.textContent = text;
    this.hudBarFill.style.width = `${Math.round(progress * 100)}%`;
  }

  hudFade(): void {
    const hud = this.surface.querySelector<HTMLElement>(".hud");
    if (hud) hud.style.opacity = "0";
  }
}

/** Module-level accessor used by fx/controls.tsx. */
export function getShadowRoot(): ShadowRoot | null {
  return View._shadow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clipInner(clip: { l: number; t: number; r: number; b: number }, x: number, y: number, w: number, h: number): string {
  const top = Math.max(0, clip.t - y);
  const bottom = Math.max(0, y + h - clip.b);
  const left = Math.max(0, clip.l - x);
  const right = Math.max(0, x + w - clip.r);
  if (top <= 0 && bottom <= 0 && left <= 0 && right <= 0) return "";
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

/** Extract a thin representative border shorthand from captured paint css. */
function bodyLineColor(): string {
  return "rgba(148,163,184,0.5)";
}

/** Hide all typed units of a text item before its build starts. */
function hideUnits(item: SwarmItem): void {
  if (!item.typed) return;
  for (const u of item.typed.units) {
    if (u.t) u.t.data = "";
    else if (u.e) u.e.style.visibility = "hidden";
  }
}
