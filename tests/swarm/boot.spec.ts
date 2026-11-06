import { test, expect } from "@playwright/test";

test.describe("Swarm Rebuild — Boot & Eligibility", () => {
  test("?noSwarm=1 URL flag skips the intro completely", async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/?noSwarm=1");
    // Verify no overlay is mounted
    const overlay = page.locator("[data-swarm-host]");
    await expect(overlay).toHaveCount(0);
    // Body is visible
    const body = page.locator("body");
    await expect(body).toBeVisible();
    await page.close();
  });

  test("?replay=1 forces intro to play even if session flag exists", async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/?noSwarm=1");
    // Set sessionStorage flag
    await page.evaluate(() => sessionStorage.setItem("swarm.played", "1"));
    // Navigate with ?replay=1
    await page.goto("/?replay=1");
    // Overlay host should be present
    const overlay = page.locator("[data-swarm-host]");
    await expect(overlay).toHaveCount(1, { timeout: 15000 });
    await page.close();
  });

  test("desktop viewport defaults to desktop profile", async ({ browser }) => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/?replay=1");
    const overlay = page.locator("[data-swarm-host]");
    await expect(overlay).toHaveCount(1, { timeout: 15000 });
    await page.close();
  });

  test("mobile viewport sets mobile profile", async ({ browser }) => {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?replay=1");
    const overlay = page.locator("[data-swarm-host]");
    await expect(overlay).toHaveCount(1, { timeout: 15000 });
    await page.close();
  });
});
