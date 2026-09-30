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
  // 0059: the glass above the words, the modes, the stop, and no fine print under the conversation
  assert.ok(code.includes("const LG = ("), "the browser's glass (lg.js) is in the page");
  assert.doesNotMatch(code, /operator: "arithmetic"/, "no arithmetic composite in the glass filter (Chromium draws it half transparent)");
  assert.match(html, /id="mode-seg"[\s\S]*data-mode="auto"[\s\S]*data-mode="quick"[\s\S]*data-mode="deep"/);
  assert.match(html, /class="g g-stop"/);
  assert.doesNotMatch(html, /class="fine"/);
  // 0060: a segment's lens rides with its control when the page scrolls; the menu is grown out of the
  // pointer's drop (held while it is open, given back where the menu gathered) and sized by hand in lg.js
  assert.ok(code.includes("{ ...o.lens, el: host }"), "a segment's lens knows its control");
  assert.ok(code.includes("L.offEl === el"), "lenses are moved with the page before their springs run");
  assert.ok(/function morph\(node, s\)[\s\S]*return \{[^}]*morph, warm/.test(code), "lg.js animates a piece of glass by hand");
  assert.ok(code.includes("Glass.dropHold()") && code.includes("Glass.dropRelease(give[0], give[1], give[2], give[3], 1)"), "the menu takes the pointer's drop and gives it back");
  for (const item of ["Analyze with the agent", "Make a drop of glass", "Make a wish", "Ask my own question…"]) assert.ok(code.includes(item), `the menu still offers "${item}"`);
});
