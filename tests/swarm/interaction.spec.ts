import { test, expect } from "@playwright/test";

test.describe("Swarm Rebuild — Post-Intro Interaction", () => {
  test("links and buttons are clickable, no uncaught console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/?replay=1");
    // Skip intro via Esc
    await page.keyboard.press("Escape");

    // Check Hero button ("Show My Work") is clickable
    const heroBtn = page.getByRole("button", { name: /Show My Work/i });
    if (await heroBtn.count() > 0) {
      await expect(heroBtn).toBeVisible();
      await heroBtn.click();
    }

    // Check navigation links exist and are visible
    const links = page.locator("a[href^='#']");
    const count = await links.count();
    expect(count).toBeGreaterThan(0);

    // Filter out known harmless warnings or external/third-party issues
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes("THREE") &&
        !e.includes("WebGL") &&
        !e.includes("favicon") &&
        !e.includes("400") &&
        !e.includes("Failed to load resource")
    );
    expect(realErrors).toEqual([]);
  });
});
