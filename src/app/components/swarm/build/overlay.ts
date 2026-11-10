/**
 * overlay.ts — the Swarm Rebuild stage.
 *
 * A single shadow-rooted host on documentElement containing, bottom-up:
 *
 *   .surface   (opaque page background — hides the real page during builds)
 *     .world   (document-sized layer in WORLD coords, translated by scroll)
 *     .fx      (SVG: alignment guides, edit-line polylines, selection boxes)
 *     .badges  (dimension chips, measure labels)
 *     .rulers  (top + left rulers that drop in while guides are placed)
 *     .cursors (pooled SVG cursor sprites)
 *     .hud     (agents · progress readout)
 *
 * Item nodes are created once on demand and mutated in place by the
 * routines (draw sizes, typed text, clip reveals). No React, no
 * per-element re-renders, no layout thrash: everything is transform,
 * opacity, width/height and textContent on absolutely-positioned nodes.
 */

import type { Guide, OvShape, SwarmItem } from "../capture/model";
import type { Cursor, CursorShape } from "../agents/agents";
import { HOTSPOT, cursorSVG } from "../agents/agents";

// ─── Colors ───────────────────────────────────────────────────────────────────

const RED = "rgba(244, 63, 94, 1)";
const OV_BLUE = "rgba(56,189,248,0.95)";
const RULER = 20;

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
  .fx, .badges, .cursors {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .fx svg, .rulers svg { display: block; }
  .badge {
    position: absolute;
    transform: translate(-50%, 0);
    padding: 1px 4px;
    border-radius: 2px;
    color: #fff;
    font: 600 11px/16px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .ruler {
    position: absolute;
    left: 0;
    background: #1b1f24;
  }
  .ruler-top { top: 0; height: 20px; width: 100%; will-change: transform; }
  .ruler-left { top: 0; left: 0; width: 20px; height: 100%; will-change: transform; }
  .ruler-corner {
    position: absolute; left: 0; top: 0; width: 20px; height: 20px;
    background: #1b1f24;
  }
  .ruler text {
    font: 500 9px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    fill: #9aa7b4;
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
  .cspr {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform;
  }
  .cspr svg { display: block; }
`;

// ─── View class ───────────────────────────────────────────────────────────────

export class View {
  host!: HTMLDivElement;
  shadow!: ShadowRoot;
  surface!: HTMLDivElement;
  world!: HTMLDivElement;
  fx!: SVGSVGElement;
  badges!: HTMLDivElement;
  cursorsEl!: HTMLDivElement;
  rulerHost!: HTMLDivElement;
  hudText!: HTMLSpanElement;
  hudBarFill!: HTMLElement;

  private _mounted = false;
  static _shadow: ShadowRoot | null = null;

  /** Current overlay shadow root (used by the controls module). */
  static getShadowRoot(): ShadowRoot | null {
    return View._shadow;
  }

  mount(bgColor: string, docW: number, docH: number): void {
    if (this._mounted) return;
    this._mounted = true;
    this.host = document.createElement("div");
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

    const fx = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    fx.classList.add("fx-svg");
    fx.setAttribute("width", "100%");
    fx.setAttribute("height", "100%");
    this.fx = fx;

    const fxWrap = document.createElement("div");
    fxWrap.className = "fx";
    fxWrap.appendChild(fx);
    this.surface.appendChild(fxWrap);

    this.badges = document.createElement("div");
    this.badges.className = "badges";
    this.surface.appendChild(this.badges);

    this.rulerHost = document.createElement("div");
    this.rulerHost.style.cssText = "position:absolute;inset:0;overflow:hidden;";
    this.surface.appendChild(this.rulerHost);

    this.cursorsEl = document.createElement("div");
    this.cursorsEl.className = "cursors";
    this.surface.appendChild(this.cursorsEl);

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

  private hudDots!: HTMLSpanElement;

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
      node.style.transformOrigin = "0 0";
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
    if (item.node) {
      item.node.classList.add("node-draw");
    }
  }

  clearDrawOutline(item: SwarmItem): void {
    if (item.node) {
      item.node.classList.remove("node-draw");
    }
  }

  /** Re-position / resize a node from the item's runtime geometry. */
  syncItem(item: SwarmItem): void {
    const node = item.node;
    if (!node) return;
    const dx = item.dx ?? 0;
    const dy = item.dy ?? 0;
    const x = item.x + dx;
    const y = item.y + dy;
    const w = item.drawW != null ? item.drawW : item.w;
    const h = item.drawH != null ? item.drawH : item.h;
    node.style.left = `${Math.min(x, x + w)}px`;
    node.style.top = `${Math.min(y, y + h)}px`;
    node.style.width = `${Math.max(w, 1)}px`;
    node.style.height = `${Math.max(h, 1)}px`;
    const sc = item.scale;
    node.style.transform = sc != null && sc !== 1 ? `scale(${sc})` : "";
    if (item.shown != null && item.typed) revealUnits(item, item.shown);
  }

  // ── Typed text ────────────────────────────────────────────────────────────

  /** Reveals `shown` characters of a text item across its typed units. */
  revealText(item: SwarmItem, shown: number): void {
    if (!item.typed) return;
    item.shown = Math.min(shown, item.typed.seq.length);
    revealUnits(item, item.shown);
  }

  removeCaret(item: SwarmItem): void {
    if (item.caret) {
      item.caret.remove();
      item.caret = undefined;
    }
  }

  /** Visible opacity for a node WITHOUT touching position/size. */
  setOpacity(item: SwarmItem, alpha: number): void {
    item.node?.style.setProperty("opacity", String(alpha));
  }

  // ── Overlay SVG + badges ─────────────────────────────────────────────────

  private _ovS = "";
  private _ovB = "";
  private _rulersOn = false;

  /** Rulers openness 0..1 (1 = fully dropped-in). */
  renderRulers(t: number, marks: { top?: string; left?: string }): void {
    if (t <= 0.001) {
      if (this._rulersOn) {
        this.rulerHost.innerHTML = "";
        this._rulersOn = false;
      }
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const top = marks?.top ?? "";
    const left = marks?.left ?? "";
    this.rulerHost.innerHTML =
      `<div class="ruler ruler-top" style="transform:translateY(${Math.round((t - 1) * RULER)}px)"><svg width="${W}" height="${RULER}">${top}</svg></div>` +
      `<div class="ruler ruler-left" style="transform:translateX(${Math.round((t - 1) * RULER)}px)"><svg width="${RULER}" height="${H}">${left}</svg></div>` +
      `<div class="ruler-corner" style="opacity:${t.toFixed(3)}"></div>`;
    this._rulersOn = true;
  }

  /**
   * Render the overlay layer (guides/selections) + badges.
   * `sx/sy` is the scroll offset; `specs`/`guides`/`lines` come from the engine.
   */
  renderOverlay(
    specs: OvShape[],
    guides: Guide[],
    lines: Array<{
      pts: Array<{ x: number; y: number }>;
      placed: number;
      owner: { x: number; y: number } | null;
    }>,
    sx: number,
    sy: number
  ): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const X = (x: number): number => Math.round((x - sx) * 10) / 10;
    const Y = (y: number): number => Math.round((y - sy) * 10) / 10;

    let s = "";
    // Guides (red alignment lines; flash = glow)
    for (const g of guides) {
      if (!g.vis || (g.op ?? 0) <= 0) continue;
      const sw = round1(1 + g.flash);
      const flt =
        g.flash > 0
          ? ` filter="drop-shadow(0 0 ${round1(2 + g.flash * 3)}px ${RED})"`
          : "";
      if (g.axis === "x") {
        s += `<line x1="${X(g.cur ?? g.pos)}" y1="0" x2="${X(g.cur ?? g.pos)}" y2="${H}" stroke="${RED}" stroke-width="${sw}" stroke-opacity="${round1(g.op)}"${flt}/>`;
      } else {
        s += `<line x1="0" y1="${Y(g.cur ?? g.pos)}" x2="${W}" y2="${Y(g.cur ?? g.pos)}" stroke="${RED}" stroke-width="${sw}" stroke-opacity="${round1(g.op)}"${flt}/>`;
      }
    }

    // Edit lines (pen seek: polyline + placed points + chord to cursor)
    for (const ed of lines) {
      const p = ed.pts
        .slice(0, ed.placed)
        .map((pt) => `${X(pt.x)},${Y(pt.y)}`);
      if (ed.owner) p.push(`${X(ed.owner.x)},${Y(ed.owner.y)}`);
      s += `<polyline points="${p.join(" ")}" fill="none" stroke="${OV_BLUE}" stroke-width="1.5"/>`;
      for (const q of ed.pts.slice(0, ed.placed))
        s += `<circle cx="${X(q.x)}" cy="${Y(q.y)}" r="3.6" fill="#fff" stroke="${OV_BLUE}" stroke-width="1.5"/>`;
    }

    // Cursor-attached overlays (selections / measures)
    let b = "";
    for (const v of specs) {
      if (v.t === "box") {
        const x = Math.min(v.b.x, v.b.x + v.b.w);
        const y = Math.min(v.b.y, v.b.y + v.b.h);
        const w = Math.abs(v.b.w);
        const h = Math.abs(v.b.h);
        const lx = X(x);
        const ly = Y(y);
        const col = v.color === "red" ? RED : OV_BLUE;
        s += `<rect x="${lx}" y="${ly}" width="${round1(w)}" height="${round1(h)}" fill="none" stroke="${col}" stroke-width="1"/>`;
        if (v.underline && v.underline.w > 0) {
          const u = v.underline;
          s += `<line x1="${X(u.x)}" y1="${Y(u.y)}" x2="${X(u.x + u.w)}" y2="${Y(u.y)}" stroke="${OV_BLUE}" stroke-width="1.5"/>`;
        }
        if (v.handles)
          for (const [hx, hy] of [
            [lx, ly],
            [lx + w, ly],
            [lx, ly + h],
            [lx + w, ly + h],
          ])
            s += `<rect x="${round1(hx - 3.5)}" y="${round1(hy - 3.5)}" width="7" height="7" fill="#fff" stroke="${col}" stroke-width="1"/>`;
        if (v.badge && w > 2)
          b += `<div class="badge" style="left:${round1(lx + w / 2)}px;top:${round1(ly + h + 8)}px;background:${col}">${v.badge}</div>`;
      } else if (v.t === "measure" && v.a && v.label) {
        const ax = X(v.a.x);
        const ay = Y(v.a.y);
        const bx = X(v.b.x);
        const by = Y(v.b.y);
        s += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${RED}" stroke-width="1"/>`;
        const horiz = ay === by;
        b += `<div class="badge" style="left:${round1(horiz ? (ax + bx) / 2 : ax + 18)}px;top:${round1(horiz ? ay + 8 : (ay + by) / 2 - 9)}px;background:${RED}">${v.label}</div>`;
      }
    }

    if (s !== this._ovS) {
      this.fx.innerHTML = s;
      this._ovS = s;
    }
    if (b !== this._ovB) {
      this.badges.innerHTML = b;
      this._ovB = b;
    }
  }

  // ── Cursor sprites ────────────────────────────────────────────────────────

  private cursorEls = new Map<number, HTMLDivElement>();

  /** Position + shape-sync every cursor sprite. */
  renderCursors(cursors: Cursor[], sx: number, sy: number): void {
    for (const c of cursors) {
      let el = this.cursorEls.get(c.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "cspr";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 28 28");
        svg.setAttribute("width", "28");
        svg.setAttribute("height", "28");
        svg.style.overflow = "visible";
        el.appendChild(svg);
        this.cursorsEl.appendChild(el);
        this.cursorEls.set(c.id, el);
      }
      el.style.transform = `translate(${Math.round((c.x - sx) * 10) / 10}px,${Math.round((c.y - sy) * 10) / 10}px)`;
      const svg = el.firstChild as SVGElement;
      const key = `${c.shape}|${c.color}`;
      if (el.dataset.shp !== key) {
        svg.innerHTML = cursorSVG(c.shape, c.color);
        el.dataset.shp = key;
        const hot = HOTSPOT[c.shape as CursorShape];
        cel(el)._hx = hot.x;
        cel(el)._hy = hot.y;
        svg.style.transformOrigin = `${hot.x}px ${hot.y}px`;
      }
      const sc = 1 - c.press * 0.12;
      svg.style.transform = `translate(${-cel(el)._hx}px,${-cel(el)._hy}px) rotate(${Math.round(c.angle * 10) / 10}deg) scale(${round2(sc)})`;
    }
    for (const [id, el] of this.cursorEls) {
      if (!cursors.some((c) => c.id === id)) {
        el.remove();
        this.cursorEls.delete(id);
      }
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

interface CursorEl extends HTMLDivElement {
  _hx: number;
  _hy: number;
}
function cel(el: HTMLDivElement): CursorEl {
  return el as CursorEl;
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
function round2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

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

function revealUnits(item: SwarmItem, shown: number): void {
  if (!item.typed) return;
  for (const u of item.typed.units) {
    if (u.t && u.src !== undefined) {
      const keep = Math.max(0, Math.min(u.src.length, shown - u.at));
      const next = u.src.slice(0, keep);
      if (u.t.data !== next) u.t.data = next; // Porsche-fast dedupe
    } else if (u.e) {
      const on = shown > u.at;
      if (on !== (u.e.style.visibility === "visible")) {
        u.e.style.visibility = on ? "visible" : "hidden";
      }
    }
  }
}

/** Hide all typed units of a text item before its build starts. */
function hideUnits(item: SwarmItem): void {
  if (!item.typed) return;
  for (const u of item.typed.units) {
    if (u.t) u.t.data = "";
    else if (u.e) u.e.style.visibility = "hidden";
  }
}
