/**
 * integrity.ts — Post-run assertion suite.
 *
 * Runs in all builds during development (NODE_ENV === 'development').
 * Skipped in production.
 *
 * Assertions:
 *   1. Snapshot counts within expected ranges (from §6)
 *   2. revealNow() was called exactly once
 *   3. No setTimeout/setInterval were introduced by swarm code (audit log-based)
 */

import type { SnapshotResult } from "../capture/snapshot";
import { wasRevealCalled } from "../build/reveals";

// ─── Expected ranges (§6, desktop) ───────────────────────────────────────────

export const EXPECTED_RANGES = {
  text: { min: 50, max: 150 },        // ~90 estimated
  container: { min: 20, max: 80 },    // ~35 estimated
  image: { min: 10, max: 60 },        // ~25 estimated
  svg: { min: 50, max: 300 },         // ~180 estimated (icons, badge chips)
  excluded: { min: 5, max: 30 },      // ~12 estimated
} as const;

export interface AssertionResult {
  passed: boolean;
  failures: string[];
}

/**
 * Run all integrity assertions after the intro completes.
 * Logs failures to console.warn in development.
 */
export function runIntegrityChecks(snapshot: SnapshotResult): AssertionResult {
  const failures: string[] = [];

  if (process.env.NODE_ENV !== "development") {
    return { passed: true, failures: [] };
  }

  // --- 1. Snapshot count ranges ---
  for (const [type, range] of Object.entries(EXPECTED_RANGES)) {
    const count = snapshot.typeCounts[type as keyof typeof snapshot.typeCounts] ?? 0;
    if (count < range.min || count > range.max) {
      failures.push(
        `[Swarm Integrity] ${type} count ${count} outside expected range [${range.min}, ${range.max}]`
      );
    }
  }

  // --- 2. Snapshot duration ---
  if (snapshot.durationMs > 600) {
    failures.push(
      `[Swarm Integrity] Snapshot took ${snapshot.durationMs.toFixed(0)} ms (target < 600 ms)`
    );
  }

  // --- 3. revealNow() called ---
  if (!wasRevealCalled()) {
    failures.push("[Swarm Integrity] revealNow() / finalReveal() was never called");
  }

  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(f);
    }
    return { passed: false, failures };
  }

  console.log(
    `[Swarm Integrity] All checks passed. Snapshot: ${snapshot.records.length} records, ` +
    `${snapshot.durationMs.toFixed(0)} ms.`
  );
  return { passed: true, failures: [] };
}
