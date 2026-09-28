/**
 * Merge settings into a services' config, one level deep, in place: what the patch names changes,
 * everything else stays. It holds no keys, so it can travel to the services' machine.
 *
 *   node scripts/config-merge.mjs <config.json> '{"strategy":{"loopLots":5}}'
 *   ssh host "node - ~/.config/lancea/config.json '<patch>'" < scripts/config-merge.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [file, patch] = process.argv.slice(-2).map((a, i) => (i === 0 ? a.replace(/^~(?=\/)/, homedir()) : a));
const config = JSON.parse(readFileSync(file, "utf8"));
for (const [key, value] of Object.entries(JSON.parse(patch))) {
  config[key] = value && typeof value === "object" && !Array.isArray(value) ? { ...config[key], ...value } : value;
}
writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
console.log(`${file}: ${Object.keys(JSON.parse(patch)).join(", ")} set`);
