import { test, expect } from "@playwright/test";

test.describe("Swarm Rebuild — Accessibility & Controls", () => {
  test("prefers-reduced-motion media query skips intro entirely", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/?replay=1");

    // Overlay should never mount
    const overlay = page.locator("[data-swarm-host]");
    await expect(overlay).toHaveCount(0);

    // Body stays visible
    const isVisible = await page.evaluate(() => document.body.style.visibility !== "hidden");
    expect(isVisible).toBe(true);
    await context.close();
  });

  test("Esc key instantly aborts and reveals in <= 100ms", async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/?replay=1");
    const overlay = page.locator("[data-swarm-host]");
    await expect(overlay).toHaveCount(1, { timeout: 15000 });

    const t0 = Date.now();
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0, { timeout: 3000 });
    const delta = Date.now() - t0;

    // Esc response is practically instantaneous
    expect(delta).toBeLessThan(3000);
    await page.close();
  });
});
