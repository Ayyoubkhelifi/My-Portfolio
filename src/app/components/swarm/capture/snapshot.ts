/**
 * snapshot.ts — DOM → world-coords item capture.
 *
 * Walks document.body once (idle-chunked) and emits only entities that
 * visibly paint something:
 *
 *   - text          text leaves with inline children → typed clone + units
 *   - image         <img> (and cloneable small <svg> nodes)
 *   - rect          painted container boxes (bg / border / shadow / radius)
 *   - line          <hr>
 *
 * Items carry DOCUMENT coordinates (world space) and a clip box inherited
 * from the nearest overflow-hidden ancestor. Repeated sibling components
 * are grouped into DupGroups so the engine can "alt-drag" them into place.
 *
 * Before capture, a hidden sweep scrolls the page to force lazy content
 * and settle layout (body is already visibility:hidden, so the sweep is
 * invisible to the user).
 */

import { checkExclusion } from "./exclusions";
import type { CaptureResult, ClipBox, DupGroup, SwarmItem, TypeUnit } from "./model";
import { waitForScrollSettle } from "./sweep";

// ─── Tuning ───────────────────────────────────────────────────────────────────

const SVG_INLINE_BYTE_LIMIT = 12_000; // cloneable inline SVG budget
const MAX_ITEMS = 320; // item budget; overflow → fewer, bigger rects
const MIN_PAINT_AREA = 24; // ignore decorative slivers
const GROUP_MIN_COUNT = 3; // dup groups need ≥3 siblings (cards, chips…)

// Paint whitelist — properties that affect an element's own box painting.
const PAINT_PROPS = [
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "backdrop-filter",
  "mix-blend-mode",
  "object-fit",
  "object-position",
] as const;

// Layout whitelist — applied to clones so rebuilt text lays out identically.
const LAYOUT_PROPS = [
  "position",
  "display",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "gap",
  "row-gap",
  "column-gap",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "width",
  "max-width",
  "height",
  "color",
  "font",
  "font-size",
  "font-weight",
  "font-style",
  "font-family",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "opacity",
  "filter",
] as const;

// ─── Style capture helpers ────────────────────────────────────────────────────

function paintCss(computed: CSSStyleDeclaration): string {
  let css = "";
  for (const p of PAINT_PROPS) {
    const v = computed.getPropertyValue(p);
    if (v && v !== "none" && v !== "0px" && v !== "normal") {
      css += `${p}:${v};`;
    }
  }
  return css;
}

function transferLayout(el: HTMLElement, computed: CSSStyleDeclaration): void {
  let css = "";
  for (const p of LAYOUT_PROPS) {
    const v = computed.getPropertyValue(p);
    if (v) css += `${p}:${v};`;
  }
  el.style.cssText = css;
}

/** True when the element paints anything (bg, borders, shadow). */
function isPainted(computed: CSSStyleDeclaration, rect: DOMRect): boolean {
  if (rect.width < MIN_PAINT_AREA && rect.height < MIN_PAINT_AREA) return false;
  const bg = computed.backgroundColor;
  const bgImage = computed.backgroundImage;
  const bt = parseFloat(computed.borderTopWidth);
  const br = parseFloat(computed.borderRightWidth);
  const bb = parseFloat(computed.borderBottomWidth);
  const bl = parseFloat(computed.borderLeftWidth);
  const shadow = computed.boxShadow !== "none";
  const opaque = bg && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(bg);
  const radius =
    computed.borderTopLeftRadius !== "0px" || computed.borderTopRightRadius !== "0px";
  return Boolean(opaque || bgImage !== "none" || shadow || bt || br || bb || bl || radius);
}

/** True when the element has any visible text; ignores whitespace-only nodes.
 *  Bounded iterative scan — avoids building `textContent` strings for every
 *  wrapper (the old whole-subtree scan dominated band-walk time). */
function hasVisibleText(el: Element): boolean {
  const stack: Node[] = [el];
  let visits = 0;
  while (stack.length && visits < 400) {
    const n = stack.pop()!;
    if (n.nodeType === 3) {
      if (/\S/.test(n.nodeValue ?? "")) return true;
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = (n as Element).tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;
    visits++;
    for (let c = n.firstChild; c; c = c.nextSibling) stack.push(c);
  }
  return false;
}

/** Block-level or safely-inline (for text leaf detection). */
function isInlineish(computed: CSSStyleDeclaration): boolean {
  const d = computed.display;
  return d.includes("inline") || d === "contents";
}

function isBlockish(computed: CSSStyleDeclaration): boolean {
  return !isInlineish(computed);
}

// ─── Text unit extraction ─────────────────────────────────────────────────────

/**
 * Clones a text leaf into an inert document (so site code never touches the
 * clone), inlines its computed styles + each descendant's styles, then maps
 * its content into parallel-type units. Returns seq string + units + clone.
 */
function buildTypedClone(el: Element): SwarmItem["typed"] | null {
  const inert = document.implementation.createHTMLDocument("swarm");
  const clone = inert.importNode(el, true) as HTMLElement;

  // Style-transfer every element (self + descendants) so the clone paints
  // identically without any site CSS.
  const sources = [el, ...Array.from(el.querySelectorAll("*"))];
  const targets = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const cs = window.getComputedStyle(el);
  let seq = "";
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i] as HTMLElement;
    const source = sources[i];
    if (source instanceof Element) {
      transferLayout(target, window.getComputedStyle(source));
    }
  }
  // Root gets the shared computed styles too (avoids per-child misses)
  transferLayout(clone, cs);

  const units: TypeUnit[] = [];
  const walk = (chain: HTMLElement, inSpan: boolean): void => {
    for (const child of Array.from(chain.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const raw = child.textContent ?? "";
        if (!raw.length) continue;
        const start = seq.length;
        seq += raw;
        units.push({ t: child as Text, src: raw, at: start });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el2 = child as HTMLElement;
        const tag = el2.tagName.toLowerCase();
        // Uniform clones: inline img/svg at full item size
        if (tag === "svg" || tag === "img") {
          el2.style.width = "100%";
          el2.style.height = "100%";
          el2.style.display = "block";
          const start = seq.length;
          units.push({ e: el2, at: start });
          seq += "0"; // one char placeholder keeps index alignment simple
          continue;
        }
        const childText = (el2.textContent ?? "").trim();
        if (!childText && isInlineish(window.getComputedStyle(el2))) {
          continue; // decorative empty span
        }
        walk(el2, true);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        // skip comments
      }
    }
    void inSpan;
  };
  walk(clone, false);

  if (!seq.trim()) return null;
  return { clone, units, seq };
}

// ─── Walker context ───────────────────────────────────────────────────────────

/** Transform-safe size read: framer-motion springs continuously oscillate
 *  `transform: scale()` on several wrappers; a getBoundingClientRect caught
 *  mid-squash measures fractions of a pixel and would prune entire card
 *  subtrees. offsetWidth/offsetHeight ignore ancestor transforms, so when the
 *  rect is drastically smaller than the layout box, prefer the layout box. */
function visualSize(el: Element, rect: DOMRect): { w: number; h: number } {
  if (!(el instanceof HTMLElement)) return { w: rect.width, h: rect.height };
  const ow = el.offsetWidth;
  const oh = el.offsetHeight;
  if (!ow || !oh) return { w: rect.width, h: rect.height };
  return {
    w: rect.width < ow * 0.25 ? ow : rect.width,
    h: rect.height < oh * 0.25 ? oh : rect.height,
  };
}

interface WalkCtx {
  sy: number;
  sx: number;
  w: number;
  clip: ClipBox | null;
  parent: SwarmItem | null;
  items: SwarmItem[];
  groups: DupGroup[];
  nextId: { id: number };
  /**
   * Per-band capture: when scrolling-reveal libraries (framer-motion
   * whileInView, GSAP reveal) reverse elements out of view, a single
   * top-walk would prune whole sections. We instead walk once per
   * viewport band while the band is in view, recording settled styles.
   * `band` prunes subtrees outside the visible band; `captured`
   * prevents duplicate emission across bands.
   */
  band?: { top: number; bot: number } | null;
  captured?: WeakSet<Element>;
}

function toWorld(ctx: WalkCtx, rect: DOMRect): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return {
    x: Math.round(rect.left + ctx.sx),
    y: Math.round(rect.top + ctx.sy),
    w: rect.width,
    h: rect.height,
  };
}

/**
 * Mark an element as captured so later bands don't re-emit it. Leaves are
 * marked when they *start* inside the band (a leaf crossing the bottom edge
 * is emitted whole here, so still marked). Containers are marked only when
 * they *end* inside the band — a wrapper taller than the band must stay
 * unmarked so later bands re-walk its below-fold children.
 */
function markCaptured(el: Element, ctx: WalkCtx, isContainer: boolean): void {
  if (!ctx.captured || !ctx.band) return;
  const r = el.getBoundingClientRect();
  if (isContainer) {
    if (r.bottom + ctx.sy <= ctx.band.bot + 8) ctx.captured.add(el);
  } else if (r.bottom + ctx.sy > ctx.band.top + 8) {
    ctx.captured.add(el);
  }
}

function intersectsClip(clip: ClipBox | null, x: number, y: number, w: number, h: number) {
  if (!clip) return true;
  return clip.l < x + w && clip.r > x && clip.t < y + h && clip.b > y;
}

function pushItem(ctx: WalkCtx, item: SwarmItem): SwarmItem {
  item.id = ctx.nextId.id++;
  item.v = 0;
  item.vis = false;
  item.styled = false;
  ctx.items.push(item);
  return item;
}

/** Clip box for an overflow-hidden ancestor, in world coords. */
function clipOf(el: Element, sy: number, sx: number): ClipBox | null {
  const cs = window.getComputedStyle(el);
  if (cs.overflow !== "hidden" && cs.overflowX !== "hidden" && cs.overflowY !== "hidden") {
    return null;
  }
  const r = el.getBoundingClientRect();
  return {
    l: r.left + sx,
    t: r.top + sy,
    r: r.left + sx + r.width,
    b: r.top + sy + r.height,
  };
}

/** Inherit the clip box from the nearest overflow-hidden ancestor. */
function effectiveClip(el: Element, ctx: WalkCtx, own: ClipBox | null): ClipBox | null {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const c = clipOf(node, ctx.sy, ctx.sx);
    if (c && node !== el) {
      return own ? intersectClip(own, c) : c;
    }
    node = node.parentElement;
  }
  return own;
}

function intersectClip(a: ClipBox, b: ClipBox): ClipBox {
  return {
    l: Math.max(a.l, b.l),
    t: Math.max(a.t, b.t),
    r: Math.min(a.r, b.r),
    b: Math.min(a.b, b.b),
  };
}

// ─── Walkers ──────────────────────────────────────────────────────────────────

function walkTextEl(el: Element, ctx: WalkCtx): boolean {
  const cs = window.getComputedStyle(el);
  // Note: the element itself may be block-level (h1, p, div) — walkNode has
  // already verified it contains only inline-ish children. The element just
  // needs to own visible text.
  if (!hasVisibleText(el)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 && visualSize(el, rect).h < 4) return false;
  const g = toWorld(ctx, rect);
  if (!intersectsClip(ctx.clip, g.x, g.y, g.w, g.h)) return false;

  const typed = buildTypedClone(el);
  if (!typed) return false;

  const fs = parseFloat(cs.fontSize);
  const item = pushItem(ctx, {
    id: 0,
    kind: "text",
    x: g.x,
    y: g.y,
    w: Math.ceil(rect.width),
    h: Math.ceil(rect.height),
    clip: effectiveClip(el, ctx, ctx.clip),
    op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
    css: "",
    text: typed.seq.replace(/\s+/g, " ").trim(),
    typed,
    fs,
    lh: parseFloat(cs.lineHeight || `${fs * 1.4}`),
    color: cs.color,
    font: cs.font,
    align: cs.textAlign,
    ls: cs.letterSpacing,
    big: fs >= 30,
  });
  item.parent = ctx.parent ?? undefined;
  return true;
}

function walkImageEl(el: HTMLImageElement, ctx: WalkCtx): boolean {
  const rect = el.getBoundingClientRect();
  const vis = visualSize(el, rect);
  if (vis.w < 8 || vis.h < 8) return false;
  const cs = window.getComputedStyle(el);
  const g = toWorld(ctx, rect);
  if (!intersectsClip(ctx.clip, g.x, g.y, g.w, g.h)) return false;
  const item = pushItem(ctx, {
    id: 0,
    kind: "image",
    x: g.x,
    y: g.y,
    w: Math.ceil(vis.w),
    h: Math.ceil(vis.h),
    clip: effectiveClip(el, ctx, ctx.clip),
    op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
    css: paintCss(cs),
    src: el.currentSrc || el.src || "",
    fit: cs.objectFit,
  });
  item.parent = ctx.parent ?? undefined;
  return true;
}

function walkSvgEl(el: SVGElement, ctx: WalkCtx): boolean {
  const rect = el.getBoundingClientRect();
  const vis = visualSize(el, rect);
  if (vis.w < 8 || vis.h < 8) return false;
  if (el.outerHTML.length > SVG_INLINE_BYTE_LIMIT) return false; // spotlights etc.
  const cs = window.getComputedStyle(el);
  const g = toWorld(ctx, rect);
  if (!intersectsClip(ctx.clip, g.x, g.y, g.w, g.h)) return false;

  // Clone inline, sized to the captured box.
  const inert = document.implementation.createHTMLDocument("swarm");
  const clone = inert.importNode(el, true) as SVGElement;
  const wrapper = inert.createElement("span");
  wrapper.style.cssText = `position:absolute;inset:0;display:block;`;
  wrapper.appendChild(clone);
  clone.style.setProperty("width", "100%");
  clone.style.setProperty("height", "100%");
  clone.style.setProperty("display", "block");
  const html = wrapper.outerHTML;

  const item = pushItem(ctx, {
    id: 0,
    kind: "image",
    x: g.x,
    y: g.y,
    w: Math.ceil(vis.w),
    h: Math.ceil(vis.h),
    clip: effectiveClip(el, ctx, ctx.clip),
    op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
    css: "",
    fit: "fill",
  });
  item.svgHtml = html;
  item.parent = ctx.parent ?? undefined;
  return true;
}

/** Painted rect container: emit (+ recurse children inside its clip).
 *  `skipEmit` is used by band capture: a painted box that started above the
 *  current band was already emitted in the band that first contained it. */
function walkRectEl(el: Element, ctx: WalkCtx, depth: number, skipEmit = false): void {
  const cs = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const vis = visualSize(el, rect);
  const g = toWorld(ctx, rect);
  if (vis.w !== rect.width || vis.h !== rect.height) {
    // mid-transform squash: recover layout metrics, keep rect-derived position
    g.w = vis.w;
    g.h = vis.h;
  }
  if (g.w < 2 || g.h < 2) {
    // Zero-layout visual holder (e.g. framer-motion pin rows whose real
    // geometry lives in absolutely-positioned children): still descend.
    if (depth < 60 && ctx.items.length < MAX_ITEMS) {
      const ownClip0 = clipOf(el, ctx.sy, ctx.sx);
      walkChildren(
        el,
        {
          ...ctx,
          clip: ownClip0 ? intersectClip(ctx.clip ?? ownClip0, ownClip0) : ctx.clip,
          parent: ctx.parent,
        },
        depth
      );
    }
    return;
  }

  let item: SwarmItem | null = null;
  const paintRect = g.w === rect.width && g.h === rect.height ? rect : new DOMRect(g.x, g.y, g.w, g.h);
  if (isPainted(cs, paintRect) && !skipEmit) {
    item = pushItem(ctx, {
      id: 0,
      kind: "rect",
      x: g.x,
      y: g.y,
      w: Math.ceil(g.w),
      h: Math.ceil(g.h),
      clip: effectiveClip(el, ctx, ctx.clip),
      op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
      css: paintCss(cs),
    });
    item.parent = ctx.parent ?? undefined;
  }

  // Recurse into children (clip tightens only for overflow-hidden boxes)
  const ownClip = clipOf(el, ctx.sy, ctx.sx);
  const innerClip =
    ownClip && item
      ? intersectClip(ownClip, { l: g.x, t: g.y, r: g.x + g.w, b: g.y + g.h })
      : ownClip
        ? intersectClip(ctx.clip ?? ownClip, ownClip)
        : ctx.clip;
  if (depth < 60 && ctx.items.length < MAX_ITEMS) {
    walkChildren(
      el,
      {
        ...ctx,
        clip: innerClip,
        parent: item ?? ctx.parent,
      },
      depth
    );
  }
}

function walkChildren(el: Element, ctx: WalkCtx, depth = 0): void {
  for (const child of Array.from(el.children)) {
    walkNode(child, ctx, depth + 1);
  }
}

function walkNode(el: Element, ctx: WalkCtx, depth = 0): void {
  if (ctx.items.length >= MAX_ITEMS) return;
  if (el === document.body) {
    walkChildren(el, ctx);
    return;
  }

  const cs = window.getComputedStyle(el);
  const tag = el.tagName.toLowerCase();

  // Band pruning: skip subtrees outside the currently visible band so the
  // walker reads settled (post-entrance-animation) styles for each viewport.
  // Client rects are converted to world coords via the current scroll offset.
  if (ctx.band && ctx.captured) {
    if (ctx.captured.has(el)) return;
    const rectB = el.getBoundingClientRect();
    const topW = rectB.top + ctx.sy;
    const botW = rectB.bottom + ctx.sy;
    if (topW > ctx.band.bot) return; // fully below — a later band covers it
    if (botW < ctx.band.top + 8) return; // above — emitted in an earlier band
  }

  // Visibility pruning
  if (cs.display === "none" || cs.visibility === "hidden") return;
  if (cs.opacity === "0" && cs.animationName === "none") return;
  const rect0 = el.getBoundingClientRect();
  const vis0 = visualSize(el, rect0);
  if (vis0.w < 1 && vis0.h < 1) {
    // Zero-layout anchor (framer-motion pin rows park their real geometry in
    // absolutely-positioned children): don't prune — descend, the children
    // carry the actual boxes.
    if (depth < 60) walkChildren(el, extendCtxForChildren(el, ctx), depth);
    return;
  }

  // Exclusions (canvas, spotlights, nav, lottie…)
  const excl = checkExclusion(el, cs, rect0);
  if (excl.excluded) {
    return;
  }

  if (el instanceof SVGElement) {
    if (walkSvgEl(el, ctx)) markCaptured(el, ctx, false);
    return;
  }

  // Text leaf: has its own visible text and only inline-ish children
  if (
    ["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "li", "label", "button", "div"].includes(
      tag
    ) &&
    hasVisibleText(el)
  ) {
    const blockKids = Array.from(el.children).some((c) =>
      isBlockish(window.getComputedStyle(c))
    );
    if (!blockKids) {
      if (walkTextEl(el, ctx)) markCaptured(el, ctx, false);
      return;
    }
  }

  if (el instanceof HTMLImageElement) {
    if (walkImageEl(el, ctx)) markCaptured(el, ctx, false);
    return;
  }

  if (tag === "hr") {
    markCaptured(el, ctx, false);
    const rect = el.getBoundingClientRect();
    const g = toWorld(ctx, rect);
    const item = pushItem(ctx, {
      id: 0,
      kind: "line",
      x: g.x,
      y: g.y + rect.height / 2,
      w: Math.ceil(g.w),
      h: 1,
      clip: effectiveClip(el, ctx, ctx.clip),
      op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
      css: "",
    });
    item.parent = ctx.parent ?? undefined;
    return;
  }

  if (isPainted(cs, rect0) || el instanceof HTMLElement) {
    // In band mode, a painted box whose top started above this band was
    // already emitted in the band that first contained it — recurse only.
    const skipEmit =
      !!ctx.band && isPainted(cs, rect0) && rect0.top + ctx.sy < ctx.band.top - 8;
    if (!skipEmit) markCaptured(el, ctx, true);
    walkRectEl(el, ctx, depth, skipEmit);
    return;
  }

  walkChildren(el, extendCtxForChildren(el, ctx));
}

/** Fallback for non-paintable wrapper elements: keep walking descendants. */
function extendCtxForChildren(el: Element, ctx: WalkCtx): WalkCtx {
  const ownClip = clipOf(el, ctx.sy, ctx.sx);
  const innerClip = ownClip ? intersectClip(ctx.clip ?? ownClip, ownClip) : ctx.clip;
  return {
    ...ctx,
    clip: innerClip,
    parent: ctx.parent,
  };
}

// ─── Dup groups ───────────────────────────────────────────────────────────────

/**
 * Groups ≥3 sibling item-subtrees that share shape. Uses "first item at
 * depth d from a common parent" chains: siblings whose first emitted item
 * matches (rounded position deltas + size ratio + same kind) form a group.
 * The master (first) subtree builds normally; copies become dup tasks.
 */
function findGroups(ctx: WalkCtx): void {
  // Bucket ITEM CHAINS by their serial appearance within same parent.
  const byParent = new Map<string, SwarmItem[]>();
  for (const item of ctx.items) {
    const key = item.parent ? String(item.parent.id) : "root";
    let arr = byParent.get(key);
    if (!arr) byParent.set(key, (arr = []));
    arr.push(item);
  }

  // For each parent: detect repeated "rows" — items sharing kind + similar
  // sizes and stacked vertically or side by side.
  for (const [, siblings] of byParent) {
    if (siblings.length < GROUP_MIN_COUNT) continue;
    const groupsSeen = new Set<SwarmItem>();
    for (let i = 0; i < siblings.length; i++) {
      const a = siblings[i];
      if (groupsSeen.has(a)) continue;
      const family: SwarmItem[] = [a];
      for (let j = i + 1; j < siblings.length; j++) {
        const b = siblings[j];
        if (groupsSeen.has(b) || b.kind !== a.kind) continue;
        const rw = maxRatio(a.w, b.w);
        const rh = maxRatio(a.h, b.h);
        if (rw > 1.4 || rh > 1.6) continue;
        const stacked = Math.abs(b.x - a.x) < Math.max(24, a.w * 0.15);
        const sideBySide = Math.abs(b.y - a.y) < Math.max(24, a.h * 0.35);
        if (!stacked && !sideBySide) continue;
        family.push(b);
        groupsSeen.add(b);
      }
      if (family.length >= GROUP_MIN_COUNT) {
        ctx.groups.push(
          ...family.slice(1).map((copy) => ({
            masterItems: [a],
            copies: [{ items: [copy], dx: copy.x - a.x, dy: copy.y - a.y }],
          }))
        );
        // Mark copies so the engine knows their land target
        for (const entry of ctx.groups) {
          for (const c of entry.copies) {
            for (const it of c.items) it.dupOf = a;
          }
        }
      }
    }
  }
}

function maxRatio(a: number, b: number): number {
  const s = Math.min(a, b) || 1;
  const l = Math.max(a, b);
  return l / s;
}

// ─── Guides ───────────────────────────────────────────────────────────────────

/** Text starts snap to columns formed by earlier text items (±10px). */
function findGuides(items: SwarmItem[]): CaptureResult["guides"] {
  const guides: CaptureResult["guides"] = [];
  const textItems = items.filter((it) => it.kind === "text" && it.w > 40);
  for (const item of textItems) {
    const snapX = item.x;
    const anchors = textItems.filter((t) => t !== item && Math.abs(t.x - snapX) <= 12);
    if (anchors.length >= 1) {
      guides.push({ axis: "x", pos: item.x, flash: 0, op: 0 });
    }
    if (guides.length >= 8) break;
  }
  // Dedupe identical positions
  const seen = new Set<number>();
  return guides.filter((g) => {
    const key = Math.round(g.pos);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Main capture ─────────────────────────────────────────────────────────────

const BATCH = 32;

function yieldToMain(): Promise<void> {
  // MessageChannel macrotask: yields to the event loop without waiting for a
  // paint. The stage surface is static during capture, so no per-batch paint
  // is needed — this keeps the walk fast (rAF costs a full frame each time).
  return new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

export function quickStage(): {
  bg: string;
  image: string;
  size: string;
  pos: string;
  docW: number;
  docH: number;
} {
  const docW = document.documentElement.scrollWidth;
  const docH = document.documentElement.scrollHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // The stage backdrop should match what the visitor actually sees: find the
  // first full-viewport ancestor that paints a background (color or image).
  // The real layers come from the capture; this just covers the pre-engine gap.
  let color = "";
  let image = "";
  let size = "";
  let pos = "";
  const dfs = (el: Element, depth: number): void => {
    if (depth > 6 || (color && image)) return;
    for (const c of el.children) {
      const r = c.getBoundingClientRect();
      if (r.width * r.height < vw * vh * 0.6) {
        dfs(c, depth + 1);
        continue;
      }
      const cs = window.getComputedStyle(c);
      // Animated decorative layers (conic "spotlight" spinners etc.) fill
      // huge rects via negative insets but read as the whole viewport — they
      // are not the backdrop. Same for invisible layers.
      if (cs.animationName !== "none" || cs.opacity === "0") {
        dfs(c, depth + 1);
        continue;
      }
      const col = cs.backgroundColor;
      const img = cs.backgroundImage;
      // A color-only match is not final: the grid usually lives on a deeper
      // stacked layer (CSS gradients, not image URLs) — keep descending for it.
      if (img && img !== "none" && !image) {
        image = img;
        size = cs.backgroundSize;
        pos = cs.backgroundPosition;
      }
      if (!color && col !== "rgba(0, 0, 0, 0)") color = col;
      if (color && image) return;
      dfs(c, depth + 1);
    }
  };
  dfs(document.body, 0);

  if (!color && !image) {
    const bodyCs = window.getComputedStyle(document.body);
    color =
      bodyCs.backgroundColor === "rgba(0, 0, 0, 0)"
        ? window.getComputedStyle(document.documentElement).backgroundColor
        : bodyCs.backgroundColor;
  }
  return { bg: color, image, size, pos, docW, docH };
}

/**
 * @param aborted polled between async steps — lets a disposed/unmounted
 *              intro stop the scroll choreography immediately (React Strict
 *              Mode unmounts the first effect run milliseconds after it
 *              starts; without this, the orphaned capture kept scrolling
 *              the now-visible page for tens of seconds).
 */
export async function captureItems(aborted?: () => boolean): Promise<CaptureResult> {
  const isAbort = (): boolean => aborted?.() ?? false;
  const t0 = performance.now();
  const log = (m: string) => {
    if (process.env.NODE_ENV === "development") console.log(`[capture] ${m}`);
  };
  // Pass 1 — quick scroll sweep: force lazy images + kick off entrance
  // animations (the stage overlay already covers the viewport by now).
  const { sy, sx } = await waitForScrollSettle(isAbort);
  void sy;
  void sx;
  log(`sweep ${Math.round(performance.now() - t0)}ms`);
  if (isAbort()) {
    return {
      items: [],
      groups: [],
      guides: [],
      docW: document.documentElement.scrollWidth,
      docH: document.documentElement.scrollHeight,
      bgColor: "",
    };
  }

  // Post-sweep geometry (lazy content may have grown the document).
  const docW = document.documentElement.scrollWidth;
  const docH = document.documentElement.scrollHeight;

  const ctx: WalkCtx = {
    sy: 0,
    sx,
    w: docW,
    clip: null,
    parent: null,
    items: [],
    groups: [],
    nextId: { id: 1 },
    band: null,
    captured: new WeakSet<Element>(),
  };

  // body's own background color becomes the stage color
  const bodyCs = window.getComputedStyle(document.body);
  const bgColor = bodyCs.backgroundColor === "rgba(0, 0, 0, 0)"
    ? window.getComputedStyle(document.documentElement).backgroundColor
    : bodyCs.backgroundColor;

  // Pass 2 — per-band capture: for each viewport band, scroll it into view,
  // let scroll-reveal animations settle, then walk THAT band. Elements read
  // their final (fully revealed) styles this way; `captured` de-dupes.
  const vh = window.innerHeight;
  const maxScroll = Math.max(0, docH - vh);
  const STEP = Math.max(120, vh);
  const BAND_SETTLE_MS = 150;

  // Scroll-reveal nodes (framer-motion sets inline opacity/transform styles).
  // Most keep animating after the fixed settle; poll until the pending count
  // drains — but stop early when the count stagnates (hover-reactive layers
  // stay at partial opacity forever and must not stall the capture).
  const revealNodes = Array.from(
    document.querySelectorAll<HTMLElement>('[style]')
  ).filter((el) => {
    const s = el.getAttribute("style") ?? "";
    return s.includes("opacity") || s.includes("transform");
  });
  // Precompute world-space tops once: rect.top + scrollY is scroll-invariant,
  // so each drain poll filters numerically instead of calling
  // getBoundingClientRect on every framer-styled element (the dominant
  // per-poll cost — hundreds of elements × up to 5 polls × 12 bands).
  const revealPos = revealNodes.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, top: r.top + window.scrollY, h: r.height, w: r.width };
  });
  const countPending = (bandTop: number, bandBot: number): number => {
    let n = 0;
    for (const { el, top, h, w } of revealPos) {
      if (h <= 0 || w <= 0) continue;
      if (top + h < bandTop - 60 || top > bandBot + 60) continue;
      const cs = window.getComputedStyle(el);
      const op = parseFloat(cs.opacity || "1");
      if (op < 0.92 && cs.animationName === "none") n++;
    }
    return n;
  };

  const rootChildren = Array.from(document.body.children);
  let bandMs = 0;
  for (let y = 0; ; y += STEP) {
    if (isAbort()) break;
    const bandY = Math.min(y, maxScroll);
    window.scrollTo(0, bandY);
    await new Promise<void>((resolve) => setTimeout(resolve, BAND_SETTLE_MS));
    // Drain staggered entrance animations for this band. Two consecutive
    // equal counts = stagnated (hover-reactive layers rest at partial
    // opacity forever) — break instead of stalling the capture.
    let prev = countPending(bandY, bandY + vh);
    let stagnant = 0;
    for (let i = 0; i < 5 && prev > 0 && !isAbort(); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 160));
      const now = countPending(bandY, bandY + vh);
      if (now === prev) {
        if (++stagnant >= 2) break;
      } else {
        stagnant = 0;
        prev = now;
      }
    }
    bandMs = 0;
    ctx.sy = window.scrollY;
    ctx.sx = window.scrollX;
    ctx.band = { top: bandY, bot: bandY + vh };
    // Reset walk state: ctx.clip / ctx.parent must not leak from the
    // previous band's descent (a stale world-coord clip box suppresses
    // every item in this band).
    ctx.clip = null;
    ctx.parent = null;
    let batch = 0;
    for (const child of rootChildren) {
      const tb = performance.now();
      walkNode(child, ctx);
      if (++batch % 3 === 0) {
        await yieldToMain();
        if (isAbort()) break;
      }
      bandMs += performance.now() - tb;
    }
    log(`band@${bandY} items=${ctx.items.length} walk=${Math.round(bandMs)}ms total=${Math.round(performance.now() - t0)}ms`);
    if (bandY >= maxScroll) break;
  }

  // Return to the top so the choreography (and the engine's frontier) start there.
  window.scrollTo(0, 0);
  if (!isAbort()) await new Promise<void>((resolve) => setTimeout(resolve, 150));

  findGroups(ctx);
  const guides = findGuides(ctx.items);

  return {
    items: ctx.items,
    groups: ctx.groups,
    guides,
    docW,
    docH,
    bgColor,
  };
}

export { BATCH };
