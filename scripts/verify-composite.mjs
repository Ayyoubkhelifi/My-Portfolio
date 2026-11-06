import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

const PUBLIC = path.resolve("public");
// page card background behind these images
const BG = "#000319";

const jobs = [
  { src: "grid.svg", out: "grid.webp", w: 702, h: 360 },
  { src: "b5.svg", out: "b5.webp", w: 1000, h: 766 },
  { src: "profile.svg", out: "profile.webp", w: 256, h: 256 },
  { src: "p1.svg", out: "p1.webp", w: 928, h: 600 },
];

async function diff(a, b) {
  const d = await sharp(a)
    .composite([{ input: b, blend: "difference" }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0, max = 0;
  const n = d.info.width * d.info.height * d.info.channels;
  for (let i = 0; i < n; i += 4) {
    const delta = Math.max(Math.abs(d.data[i]), Math.abs(d.data[i + 1]), Math.abs(d.data[i + 2]));
    sum += delta;
    if (delta > max) max = delta;
  }
  return { mean: sum / n, max };
}

async function main() {
  for (const j of jobs) {
    const svg = await fs.readFile(path.join(PUBLIC, j.src));
    const ref = await sharp(svg, { density: 300 }).resize(j.w, j.h, { fit: "fill" }).png().toBuffer();
    const webp = await sharp(path.join(PUBLIC, j.out)).png().toBuffer();

    // composite exactly like the page: over the real background color
    const refOnBg = await sharp({ create: { width: j.w, height: j.h, channels: 4, background: BG } })
      .composite([{ input: ref }]).png().toBuffer();
    const webpOnBg = await sharp({ create: { width: j.w, height: j.h, channels: 4, background: BG } })
      .composite([{ input: webp }]).png().toBuffer();
    const stats = await diff(refOnBg, webpOnBg);
    console.log(`${j.src} composited over ${BG}: meanDelta=${stats.mean.toFixed(3)} maxDelta=${stats.max}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
