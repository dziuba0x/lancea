/**
 * Films Lancea's hero (assets/hero/hero.html, drawn by the dashboard's own glass) into an animated
 * WebP that loops without a seam, a still poster, and the social preview. Frame by frame: the glass
 * clock is frozen and stepped by hand (window.__lanceaStep), so every frame is exact even in a
 * software renderer. The pointer's drop flies a figure eight through the sky; the last second is
 * blended into the first, so the loop has no cut. Needs Playwright's Chromium and ffmpeg (libwebp).
 *
 *   node scripts/hero.mjs            assets/hero.webp, assets/hero.png, assets/social-preview.png
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const root = resolve(new URL("..", import.meta.url).pathname);
const page = pathToFileURL(join(root, "assets/hero/hero.html")).href;
const FPS = 20, LOOP = 6, FADE = 1; // seconds
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function film(w, h, frames, outDir) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.goto(page);
  await p.waitForFunction(() => window.heroReady !== undefined && document.fonts.status === "loaded");
  if (!(await p.evaluate(() => window.heroReady))) throw new Error("no WebGL2: the glass did not start");
  await p.evaluate(() => { window.__lanceaFreeze = true; });
  // the drop's path: a figure eight across the sky, one lap per loop
  const at = (t) => {
    const a = (2 * Math.PI * t) / LOOP;
    return [w / 2 + 0.43 * w * Math.sin(a), h * 0.5 + 0.34 * h * Math.sin(2 * a + 0.6)];
  };
  const step = async (t) => { const [x, y] = at(t); await p.mouse.move(x, y); await p.evaluate((dt) => window.__lanceaStep(dt, 4), 1 / FPS); };
  for (let i = -3 * FPS; i < 0; i++) await step(i / FPS); // pre-roll: the glass settles, the drop gets going
  for (let i = 0; i < frames; i++) {
    await step(i / FPS);
    if (outDir) await p.screenshot({ path: join(outDir, `f${String(i).padStart(3, "0")}.png`) });
  }
  return p;
}

const dir = mkdtempSync(join(tmpdir(), "lancea-hero-"));
try {
  const N = LOOP * FPS, K = FADE * FPS;
  await (await film(1600, 544, N + K, dir)).close();
  const f = (n) => join(dir, n);
  // the loop: frame i < K is frame N+i fading into frame i, so the last frame flows into the first
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", f("f%03d.png"), "-framerate", String(FPS), "-start_number", String(N), "-i", f("f%03d.png"),
    "-filter_complex", `[0:v]split[x][y];[x]trim=end_frame=${K},setpts=PTS-STARTPTS[a0];[y]trim=start_frame=${K}:end_frame=${N},setpts=PTS-STARTPTS[a1];` +
      `[1:v]trim=end_frame=${K},setpts=PTS-STARTPTS[b0];[b0][a0]blend=all_expr='A*(1-N/${K})+B*(N/${K})'[m];[m][a1]concat=n=2:v=1[out]`,
    "-map", "[out]", "-c:v", "libwebp_anim", "-loop", "0", "-quality", "76", "-compression_level", "6", join(root, "assets/hero.webp")]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", f(`f${String(K).padStart(3, "0")}.png`), join(root, "assets/hero.png")]);
  const social = await film(1280, 640, Math.round(1.5 * FPS));
  await social.screenshot({ path: join(root, "assets/social-preview.png") });
  console.log("assets/hero.webp, assets/hero.png, assets/social-preview.png");
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
