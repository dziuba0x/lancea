/**
 * Builds the dashboard's page for GitHub Pages (docs/index.html) from its source (dashboard/page.html)
 * and the sample it shows when the live feed cannot be reached (dashboard/sample-feed.json).
 *   npx tsx scripts/dashboard-build.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const root = new URL("../", import.meta.url).pathname;
const page = readFileSync(`${root}dashboard/page.html`, "utf8");
const sample = JSON.stringify(JSON.parse(readFileSync(`${root}dashboard/sample-feed.json`, "utf8"))).replace(/<\//g, "<\\/");
const fragment = page.replace("{{SAMPLE_JSON}}", sample);
if (fragment.includes("{{SAMPLE_JSON}}") || !fragment.includes("</style>")) throw new Error("dashboard/page.html is not the expected template");
const [head, body] = [fragment.slice(0, fragment.indexOf("</style>") + 8), fragment.slice(fragment.indexOf("</style>") + 8)];
const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Lancea: an AI agent on a leash. Every step it proposes, what the transaction really does, and the guard's verdict.">
${head}
</head>
<body>
${body}
</body>
</html>
`;
mkdirSync(`${root}docs`, { recursive: true });
writeFileSync(`${root}docs/index.html`, doc);
console.log(`docs/index.html: ${doc.length} bytes`);
