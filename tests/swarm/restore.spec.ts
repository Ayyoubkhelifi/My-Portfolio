import { test, expect } from "@playwright/test";

test.describe("Swarm Rebuild — Visual Integrity & Restoration", () => {
  test("post-intro page layout matches baseline without swarm", async ({ browser }) => {
    // 1. Capture baseline layout metrics in a clean tab with ?noSwarm=1
    const page1 = await browser.newPage();
    await page1.setViewportSize({ width: 1920, height: 1080 });
    await page1.goto("/?noSwarm=1");

    const baselineHeight = await page1.evaluate(() => document.body.scrollHeight);
    const baselineHeadings = await page1.evaluate(() =>
      Array.from(document.querySelectorAll("h1, h2, h3")).map((h) => h.textContent?.trim())
    );
    await page1.close();

    // 2. Play intro and skip via Esc in a clean tab to test instant restoration
    const page2 = await browser.newPage();
    await page2.setViewportSize({ width: 1920, height: 1080 });
    await page2.goto("/?replay=1");
    const host = page2.locator("[data-swarm-host]");
    await expect(host).toHaveCount(1, { timeout: 15000 });

    await page2.keyboard.press("Escape");
    await expect(host).toHaveCount(0, { timeout: 3000 });

    // 3. Verify restored layout matches baseline
    const restoredHeight = await page2.evaluate(() => document.body.scrollHeight);
    const restoredHeadings = await page2.evaluate(() =>
      Array.from(document.querySelectorAll("h1, h2, h3")).map((h) => h.textContent?.trim())
    );
    await page2.close();

    expect(restoredHeight).toBe(baselineHeight);
    expect(restoredHeadings).toEqual(baselineHeadings);
  });
});
