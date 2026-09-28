/**
 * Builds the dashboard's page for GitHub Pages (docs/index.html) from its sources: the markup
 * (dashboard/page.html), its style (dashboard/style.css), the sky and glass renderer
 * (dashboard/glass.js), the page's logic (dashboard/app.js), and the sample it shows when the live
 * feed cannot be reached (dashboard/sample-feed.json).
 *   npx tsx scripts/dashboard-build.ts                     docs/index.html
 *   npx tsx scripts/dashboard-build.ts --sample f.json --out x.html [--fragment]
 * --fragment writes the page without the document wrapper (for a claude.ai artifact preview).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const read = (f: string) => readFileSync(`${root}dashboard/${f}`, "utf8");
const samplePath = arg("sample") ?? `${root}dashboard/sample-feed.json`;
const out = arg("out") ?? `${root}docs/index.html`;
const sample = JSON.stringify(JSON.parse(readFileSync(samplePath, "utf8"))).replace(/<\//g, "<\\/");
const script = `${read("glass.js")}\n${read("app.js")}`;
if (/<\/script/i.test(script)) throw new Error("a script contains </script");
let fragment = read("page.html");
for (const [key, value] of [["STYLE", read("style.css")], ["SCRIPT", script], ["SAMPLE_JSON", sample]] as const) {
  if (!fragment.includes(`{{${key}}}`)) throw new Error(`dashboard/page.html has no {{${key}}}`);
  fragment = fragment.replace(`{{${key}}}`, () => value);
}
const cut = fragment.indexOf("</style>") + 8;
const doc = process.argv.includes("--fragment") ? fragment : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Lancea: an AI agent on a leash. Every step it proposes, what the transaction really does, and the guard's verdict, live on the XRPL and Flare testnets.">
<meta name="theme-color" content="#030409">
${fragment.slice(0, cut)}
</head>
<body>
${fragment.slice(cut)}
</body>
</html>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, doc);
console.log(`${out}: ${doc.length} bytes`);
