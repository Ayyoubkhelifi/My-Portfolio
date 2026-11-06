import { test, expect } from "@playwright/test";

test.describe("Swarm Rebuild — Performance & Bundle Caps", () => {
  test("no unexpected network requests during intro run", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      requests.push(req.url());
    });

    await page.goto("/?replay=1");
    await page.waitForTimeout(2000);

    // Audio files should NEVER be fetched (synthesized Web Audio only)
    const audioRequests = requests.filter((u) => /\.(mp3|wav|ogg|m4a|aac)$/i.test(u));
    expect(audioRequests).toEqual([]);

    // Cursors should NEVER be fetched as image files (vector drawn on canvas)
    const cursorImageRequests = requests.filter((u) => /cursor.*\.png/i.test(u));
    expect(cursorImageRequests).toEqual([]);
  });
});
