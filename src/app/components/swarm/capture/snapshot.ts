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

/** True when the element has any visible text; ignores whitespace-only nodes. */
function hasVisibleText(el: Element): boolean {
  return /\S/.test(el.textContent ?? "");
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

interface WalkCtx {
  sy: number;
  sx: number;
  w: number;
  clip: ClipBox | null;
  parent: SwarmItem | null;
  items: SwarmItem[];
  groups: DupGroup[];
  nextId: { id: number };
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

function walkTextEl(el: Element, ctx: WalkCtx): void {
  const cs = window.getComputedStyle(el);
  // Note: the element itself may be block-level (h1, p, div) — walkNode has
  // already verified it contains only inline-ish children. The element just
  // needs to own visible text.
  if (!hasVisibleText(el)) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;
  const g = toWorld(ctx, rect);
  if (!intersectsClip(ctx.clip, g.x, g.y, g.w, g.h)) return;

  const typed = buildTypedClone(el);
  if (!typed) return;

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
}

function walkImageEl(el: HTMLImageElement, ctx: WalkCtx): void {
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const cs = window.getComputedStyle(el);
  const g = toWorld(ctx, rect);
  if (!intersectsClip(ctx.clip, g.x, g.y, g.w, g.h)) return;
  const item = pushItem(ctx, {
    id: 0,
    kind: "image",
    x: g.x,
    y: g.y,
    w: Math.ceil(rect.width),
    h: Math.ceil(rect.height),
    clip: effectiveClip(el, ctx, ctx.clip),
    op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
    css: paintCss(cs),
    src: el.currentSrc || el.src || "",
    fit: cs.objectFit,
  });
  item.parent = ctx.parent ?? undefined;
}

function walkSvgEl(el: SVGElement, ctx: WalkCtx): void {
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  if (el.outerHTML.length > SVG_INLINE_BYTE_LIMIT) return; // spotlights etc.
  const cs = window.getComputedStyle(el);
  const g = toWorld(ctx, rect);
  if (!intersectsClip(ctx.clip, g.x, g.y, g.w, g.h)) return;

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
    w: Math.ceil(rect.width),
    h: Math.ceil(rect.height),
    clip: effectiveClip(el, ctx, ctx.clip),
    op: cs.opacity === "1" ? 1 : parseFloat(cs.opacity || "1"),
    css: "",
    fit: "fill",
  });
  item.svgHtml = html;
  item.parent = ctx.parent ?? undefined;
}

/** Painted rect container: emit + recurse children inside its clip. */
function walkRectEl(el: Element, ctx: WalkCtx, depth: number): void {
  const cs = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const g = toWorld(ctx, rect);
  if (g.w < 2 || g.h < 2) return;

  let item: SwarmItem | null = null;
  if (isPainted(cs, rect)) {
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
  if (depth < 40 && ctx.items.length < MAX_ITEMS) {
    walkChildren(el, {
      ...ctx,
      clip: innerClip,
      parent: item ?? ctx.parent,
    });
  }
}

function walkChildren(el: Element, ctx: WalkCtx): void {
  for (const child of Array.from(el.children)) {
    walkNode(child, ctx);
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

  // Visibility pruning
  if (cs.display === "none" || cs.visibility === "hidden") return;
  if (cs.opacity === "0" && cs.animationName === "none") return;
  const rect0 = el.getBoundingClientRect();
  if (rect0.width < 1 && rect0.height < 1) return;

  // Exclusions (canvas, spotlights, nav, lottie…)
  const excl = checkExclusion(el, cs, rect0);
  if (excl.excluded) {
    return;
  }

  if (el instanceof SVGElement) {
    walkSvgEl(el, ctx);
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
      walkTextEl(el, ctx);
      return;
    }
  }

  if (el instanceof HTMLImageElement) {
    walkImageEl(el, ctx);
    return;
  }

  if (tag === "hr") {
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
    walkRectEl(el, ctx, depth);
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
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function captureItems(): Promise<CaptureResult> {
  // Hidden pre-sweep: force lazy content + settle layout (body already hidden)
  const { sy, sx } = await waitForScrollSettle();

  const docW = document.documentElement.scrollWidth;
  const docH = document.documentElement.scrollHeight;

  const ctx: WalkCtx = {
    sy,
    sx,
    w: docW,
    clip: null,
    parent: null,
    items: [],
    groups: [],
    nextId: { id: 1 },
  };

  // body's own background color becomes the stage color
  const bodyCs = window.getComputedStyle(document.body);
  const bgColor = bodyCs.backgroundColor === "rgba(0, 0, 0, 0)"
    ? window.getComputedStyle(document.documentElement).backgroundColor
    : bodyCs.backgroundColor;

  // Walk element tree (the walker recursion is bundled inline below)
  const rootChildren = Array.from(document.body.children);
  let batch = 0;
  for (const child of rootChildren) {
    walkNode(child, ctx);
    if (++batch % 2 === 0) await yieldToMain();
  }

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
