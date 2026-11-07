/**
 * sweep.ts — invisible pre-capture scroll sweep.
 *
 * Runs while the body is already visibility:hidden (see SwarmIntro run
 * order). Scrolls the page to the bottom in ~14 steps to force lazy
 * content (images, cards) and settle layout, then returns to the top.
 * Resolves with the final scroll offsets in world space.
 */

const SWEEP_STEPS = 14;
const STEP_DELAY_MS = 55;
const SETTLE_MS = 350;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WorldOrigin {
  sy: number;
  sx: number;
}

export async function waitForScrollSettle(): Promise<WorldOrigin> {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  if (maxScroll > 10) {
    // Down the page
    for (let i = 1; i <= SWEEP_STEPS; i++) {
      const y = Math.round((i / SWEEP_STEPS) * maxScroll);
      window.scrollTo(0, y);
      await delay(STEP_DELAY_MS);
    }
    await delay(SETTLE_MS);
  }

  // Capture coordinates at final position (we return the page to top AFTER
  // capture, in SwarmIntro.run — items are already in world coords).
  const finalY = window.scrollY;
  const finalX = window.scrollX;

  // Go back to top so the overlay choreography starts at the hero.
  window.scrollTo(0, 0);
  await delay(Math.round(SETTLE_MS / 2));

  return { sy: finalY, sx: finalX };
}
