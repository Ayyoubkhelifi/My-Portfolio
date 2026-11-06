/**
 * nodes.tsx — Frozen pseudo-DOM renderer for the overlay.
 *
 * Renders snapshot records as positioned elements inside the shadow root.
 * Uses inline styles derived from captured paint properties so the overlay
 * is entirely independent of the site's Tailwind / global CSS.
 *
 * Rendering philosophy:
 *   - Elements start invisible (opacity: 0) and are made visible by routines.ts
 *     as cursor agents build them.
 *   - Excluded elements render as wireframe placeholder rectangles (grey outline).
 *   - The overlay background is a pale-grey wireframe canvas at t=0.
 */

"use client";

import React from "react";
import type { ElementRecord, PaintProps } from "../capture/classify";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a PaintProps object to a React CSSProperties object */
function paintToStyle(paint: PaintProps): React.CSSProperties {
  return {
    backgroundColor: paint.backgroundColor || undefined,
    backgroundImage: paint.backgroundImage !== "none" ? paint.backgroundImage : undefined,
    borderTopWidth: paint.borderTopWidth,
    borderRightWidth: paint.borderRightWidth,
    borderBottomWidth: paint.borderBottomWidth,
    borderLeftWidth: paint.borderLeftWidth,
    borderTopColor: paint.borderTopColor,
    borderRightColor: paint.borderRightColor,
    borderBottomColor: paint.borderBottomColor,
    borderLeftColor: paint.borderLeftColor,
    borderTopLeftRadius: paint.borderTopLeftRadius,
    borderTopRightRadius: paint.borderTopRightRadius,
    borderBottomRightRadius: paint.borderBottomRightRadius,
    borderBottomLeftRadius: paint.borderBottomLeftRadius,
    boxShadow: paint.boxShadow !== "none" ? paint.boxShadow : undefined,
    opacity: paint.opacity !== "1" ? parseFloat(paint.opacity) : undefined,
    transform: paint.transform !== "none" ? paint.transform : undefined,
    zIndex: paint.zIndex !== "auto" ? parseInt(paint.zIndex, 10) : undefined,
  };
}

/** Shared base style for all overlay nodes: absolutely positioned, initially hidden */
function baseStyle(rect: DOMRect): React.CSSProperties {
  return {
    position: "absolute",
    left: `${rect.left}px`,
    top: `${rect.top + window.scrollY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    boxSizing: "border-box",
    pointerEvents: "none",
    opacity: 0, // animations bring this to 1
    willChange: "opacity, transform, clip-path",
  };
}

// ─── Individual node renderers ────────────────────────────────────────────────

interface NodeProps {
  record: ElementRecord;
  nodeRef?: React.RefCallback<HTMLElement>;
}

/** Wireframe placeholder for excluded nodes (canvas, spotlights, etc.) */
function ExcludedNode({ record }: NodeProps) {
  return (
    <div
      style={{
        ...baseStyle(record.rect),
        border: "1px dashed rgba(100,116,139,0.4)",
        backgroundColor: "rgba(30,41,59,0.15)",
        // Excluded nodes are shown at 0.3 opacity as placeholders from t=0
        opacity: 0.3,
      }}
      data-swarm-type="excluded"
      data-swarm-reason={record.excludedReason}
    />
  );
}

/** Text leaf node */
function TextNode({ record, nodeRef }: NodeProps) {
  if (!record.text) return null;
  const { text } = record;
  return (
    <span
      ref={nodeRef as React.RefCallback<HTMLSpanElement>}
      style={{
        ...baseStyle(record.rect),
        ...paintToStyle(record.paint),
        font: text.font,
        color: text.color,
        lineHeight: text.lineHeight,
        letterSpacing: text.letterSpacing,
        textAlign: text.textAlign as React.CSSProperties["textAlign"],
        whiteSpace: text.whiteSpace as React.CSSProperties["whiteSpace"],
        textTransform: text.textTransform as React.CSSProperties["textTransform"],
        display: "block",
        overflow: "hidden",
      }}
      data-swarm-type="text"
    >
      {/* Text content is injected by routines.ts character-by-character */}
    </span>
  );
}

/** Image node */
function ImageNode({ record, nodeRef }: NodeProps) {
  if (!record.image) return null;
  const { image } = record;
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      ref={nodeRef as React.RefCallback<HTMLImageElement>}
      src={image.currentSrc}
      alt={image.alt}
      decoding="async"
      style={{
        ...baseStyle(record.rect),
        ...paintToStyle(record.paint),
        objectFit: image.objectFit as React.CSSProperties["objectFit"],
        display: "block",
        clipPath: "inset(100% 0 0 0)", // reveal animation starts with full clip
      }}
      data-swarm-type="image"
    />
  );
}

/** SVG / icon node */
function SvgNode({ record, nodeRef }: NodeProps) {
  if (!record.svg) return null;
  return (
    <span
      ref={nodeRef as React.RefCallback<HTMLSpanElement>}
      style={{
        ...baseStyle(record.rect),
        display: "block",
        transform: "scale(0.94)", // scale reveal starts at 0.94
      }}
      dangerouslySetInnerHTML={{ __html: record.svg.outerHTML }}
      data-swarm-type="svg"
    />
  );
}

/** Container / rect node */
function ContainerNode({ record, nodeRef }: NodeProps) {
  return (
    <div
      ref={nodeRef as React.RefCallback<HTMLDivElement>}
      style={{
        ...baseStyle(record.rect),
        ...paintToStyle(record.paint),
        // Containers start with no fill, border draws in via routines
        backgroundColor: "transparent",
        backgroundImage: "none",
        border: "none",
      }}
      data-swarm-type="container"
    />
  );
}

// ─── Main OverlayNodes component ──────────────────────────────────────────────

interface OverlayNodesProps {
  records: ElementRecord[];
  /** Called with (index, el) whenever a node ref resolves */
  onNodeRef?: (index: number, el: HTMLElement | null) => void;
}

/**
 * Renders all snapshot records into the overlay layer.
 * This component is mounted inside the shadow root by overlay.tsx.
 */
export function OverlayNodes({ records, onNodeRef }: OverlayNodesProps) {
  return (
    <>
      {records.map((record) => {
        const ref: React.RefCallback<HTMLElement> = (el) => {
          onNodeRef?.(record.index, el);
        };

        switch (record.type) {
          case "excluded":
            return <ExcludedNode key={record.index} record={record} />;
          case "text":
            return <TextNode key={record.index} record={record} nodeRef={ref} />;
          case "image":
            return <ImageNode key={record.index} record={record} nodeRef={ref} />;
          case "svg":
            return <SvgNode key={record.index} record={record} nodeRef={ref} />;
          case "container":
            return <ContainerNode key={record.index} record={record} nodeRef={ref} />;
          default:
            return null;
        }
      })}
    </>
  );
}
