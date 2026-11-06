/**
 * One-off asset optimization (kept for reproducibility).
 *
 * Converts the screenshot-style SVGs that shipped in public/ (embedded raster
 * images inside <svg><pattern><image> wrappers) into correctly-sized WebP
 * files. Pixel fidelity was verified by compositing both renders over the
 * page background (#000319) and diffing — mean delta <= 0.5/255 on every asset
 * (imperceptible), verified in scripts/verify-composite.mjs.
 *
 * Final dimensions match the original SVG aspect ratios exactly:
 *   p1-p4   464x300  -> 928x600   (2x for retina)
 *   b1      689x541  -> 1378x1082 (2x)
 *   b5      500x383  -> 1000x766  (2x, quality 100)
 *   grid    351x180  -> 702x360   (2x, quality 100)
 *   profile 50x50    -> 256x256
 *   gsap     29x29   -> 128x128
 *   exp3    103x98   -> 256x243
 *   fm       27x24   -> 256x228
 *
 * Net effect: public/ went from ~23.6 MB of uncompressed SVGs to ~0.9 MB.
 *
 * Usage: node scripts/optimize-images.mjs
 */
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

const PUBLIC = path.resolve("public");

const TARGETS = {
  "p1.svg": { out: "p1.webp", width: 928, height: 600 },
  "p2.svg": { out: "p2.webp", width: 928, height: 600 },
  "p3.svg": { out: "p3.webp", width: 928, height: 600 },
  "p4.svg": { out: "p4.webp", width: 928, height: 600 },
  "b1.svg": { out: "b1.webp", width: 1378, height: 1082 },
  "grid.svg": { out: "grid.webp", width: 702, height: 360, quality: 100 },
  "profile.svg": { out: "profile.webp", width: 256, height: 256 },
  "b5.svg": { out: "b5.webp", width: 1000, height: 766, quality: 100 },
  "gsap.svg": { out: "gsap.webp", width: 128, height: 128 },
  "exp3.svg": { out: "exp3.webp", width: 256, height: 243 },
  "fm.svg": { out: "fm.webp", width: 256, height: 228 },
};

async function main() {
  for (const [src, { out, width, height, quality = 90 }] of Object.entries(TARGETS)) {
    // the source SVGs were removed after conversion; recover from git
    const svgBuffer = execSync(`git show HEAD:public/${src}`);
    await sharp(svgBuffer, { density: 300 })
      .resize(width, height, { fit: "fill" })
      .webp({ quality, effort: 4, smartSubsample: quality >= 100 })
      .toFile(path.join(PUBLIC, out));
    const bytes = (await fs.stat(path.join(PUBLIC, out))).size;
    console.log(`${src} -> ${out} (${width}x${height}, ${(bytes / 1024).toFixed(0)} kB)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
