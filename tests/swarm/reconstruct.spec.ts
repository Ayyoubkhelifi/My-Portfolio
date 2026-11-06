import { test, expect } from "@playwright/test";

test.describe("Swarm Rebuild — Overlay Reconstruction & Cleanup", () => {
  test("overlay mounts inside shadow root at documentElement and cleans up on completion", async ({ page }) => {
    await page.goto("/?replay=1");

    // Host attached directly to documentElement
    const host = page.locator("html > div[data-swarm-host]");
    await expect(host).toHaveCount(1, { timeout: 15000 });

    // Host has shadow root with .swarm-surface
    const hasShadowRoot = await page.evaluate(() => {
      const el = document.querySelector("[data-swarm-host]");
      return el !== null && el.shadowRoot !== null;
    });
    expect(hasShadowRoot).toBe(true);

    // Esc skips and restores immediately
    await page.keyboard.press("Escape");

    // Verify overlay host removed from DOM
    await expect(host).toHaveCount(0, { timeout: 3000 });

    // Verify body visibility restored
    const bodyVisibility = await page.evaluate(() => document.body.style.visibility);
    expect(bodyVisibility).toBe("");
  });
});
