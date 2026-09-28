/**
 * The dashboard builds into one self-contained page: every placeholder filled, the sample feed
 * embedded, and its scripts valid JavaScript (the sky, the glass and the page). Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

test("the dashboard builds into one page whose scripts compile", () => {
  const out = join(mkdtempSync(join(tmpdir(), "lancea-dash-")), "index.html");
  execFileSync(process.execPath, ["--import", "tsx", "scripts/dashboard-build.ts", "--out", out], { cwd: new URL("..", import.meta.url) });
  const html = readFileSync(out, "utf8");
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.match(html, /<title>Lancea Watch<\/title>/);
  const sample = JSON.parse(html.match(/<script type="application\/json" id="sample">([\s\S]*?)<\/script>/)![1]);
  assert.ok(sample.umbrella && sample.guard.length > 0, "the sample feed is embedded");
  const code = html.match(/<script>\n([\s\S]*?)\n<\/script>/)![1];
  assert.doesNotThrow(() => new Script(code), "the page's script compiles");
  for (const shader of ["FS_NEBULA", "FS_SKY", "FS_GLASS", "VS_STARS", "FS_MARKS"]) assert.ok(code.includes(`const ${shader}`), shader);
});
