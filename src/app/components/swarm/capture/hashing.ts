/**
 * hashing.ts — Snapshot integrity checksums.
 *
 * Provides lightweight checksums for the snapshot records array.
 * Used by the scheduler to detect mid-animation layout drift
 * (e.g. if the user resizes the browser during the intro).
 *
 * Not cryptographic — purely for drift detection, not security.
 */

import type { ElementRecord } from "./classify";

// ─── Per-element checksum ─────────────────────────────────────────────────────

/**
 * Computes a cheap integer fingerprint for a single element record.
 * Uses index + rounded rect dimensions to detect meaningful layout changes.
 */
function elementChecksum(record: ElementRecord): number {
  const { index, rect } = record;
  // Encode: index × 1e6 + floor(x) × 10000 + floor(y) × 100 + floor(w+h)
  // This keeps numbers well within safe integer range for a few hundred nodes.
  return (
    index * 1_000_000 +
    Math.floor(rect.left) * 10_000 +
    Math.floor(rect.top) * 100 +
    Math.floor(rect.width + rect.height)
  );
}

// ─── Snapshot hash ────────────────────────────────────────────────────────────

export interface SnapshotHash {
  /** Number of records in the snapshot */
  count: number;
  /** Sum of all individual checksums (wraps to safe integer) */
  checksum: number;
  /** Sum of all element areas (px²) for a quick area sanity check */
  totalArea: number;
}

/**
 * Generates an integrity hash for the full snapshot records array.
 * This should be called once at the end of snapshotDOM() and stored
 * alongside the records. Re-verify during the reveal phase.
 */
export function hashSnapshot(records: ElementRecord[]): SnapshotHash {
  let checksum = 0;
  let totalArea = 0;

  for (const rec of records) {
    checksum = (checksum + elementChecksum(rec)) & 0x7fff_ffff; // keep positive 31-bit
    totalArea += rec.rect.width * rec.rect.height;
  }

  return {
    count: records.length,
    checksum,
    totalArea: Math.round(totalArea),
  };
}

/**
 * Verifies a snapshot hash against a fresh re-measurement of the page.
 * Returns true if layout is stable (within tolerance), false if drifted.
 *
 * Tolerance: ±5% on total area, exact count match.
 */
export function verifySnapshot(
  records: ElementRecord[],
  original: SnapshotHash
): boolean {
  if (records.length !== original.count) return false;

  let totalArea = 0;
  for (const rec of records) {
    // Re-measure rect live at verification time
    const liveRect = (rec as ElementRecord & { _el?: Element })._el?.getBoundingClientRect();
    if (liveRect) {
      totalArea += liveRect.width * liveRect.height;
    } else {
      totalArea += rec.rect.width * rec.rect.height;
    }
  }

  const areaDelta = Math.abs(totalArea - original.totalArea) / (original.totalArea || 1);
  return areaDelta < 0.05; // 5% tolerance
}

/**
 * Quick count-only check — used for fast pre-verification before the
 * more expensive verifySnapshot call.
 */
export function countMatches(records: ElementRecord[], original: SnapshotHash): boolean {
  return records.length === original.count;
}
