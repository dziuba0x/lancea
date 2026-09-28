/**
 * The demo's watchman, run by GitHub Actions every half hour (.github/workflows/watch.yml). It reads
 * the public feed and fails, so GitHub sends its owner an email, when the demo needs a hand:
 *
 *   the feed is old        the server stopped publishing (down, reclaimed, out of disk)
 *   the guard's gas is low  every co-signature costs it C2FLR on Flare: top it up from the faucet
 *   the umbrella tripped    a drill, or a real strike: re-arm it once understood (scripts/rearm.ts)
 *   the budget or window    is nearly used up: open a new umbrella (scripts/umbrella.ts)
 *
 *   node scripts/watch.mjs            (FEED_URL overrides the feed's address)
 */
const FEED = process.env.FEED_URL ?? "https://raw.githubusercontent.com/dziuba0x/lancea-feed/main/feed.json";
const f = await (await fetch(`${FEED}?t=${Date.now()}`, { cache: "no-store" })).json();
const now = Date.now(), u = f.umbrella ?? {}, problems = [];
const ageMin = (now - Date.parse(f.generatedAt)) / 60_000;
const gas = f.fuel?.guardWei != null ? Number(BigInt(f.fuel.guardWei) / 10n ** 14n) / 1e4 : undefined;
const spent = Number(u.spentUsd6 ?? 0) / 1e6, budget = Number(u.budgetUsd6 ?? 0) / 1e6;
const daysLeft = u.validUntil ? (Number(u.validUntil) * 1000 - now) / 864e5 : undefined;

if (!(ageMin < 30)) problems.push(`the feed is ${Math.round(ageMin)} min old: the server stopped publishing (bash 0054-oracle.sh --status)`);
if (gas !== undefined && gas < 10) problems.push(`the guard has ${gas.toFixed(2)} C2FLR of gas: send C2FLR from https://faucet.flare.network/coston2 to ${f.keys?.guardFlare}`);
if (u.tripped) problems.push(`umbrella #${u.id} is tripped: a drill, or a real strike. Re-arm it once understood (scripts/rearm.ts)`);
if (budget && spent / budget > 0.9) problems.push(`umbrella #${u.id} has spent $${spent.toFixed(0)} of $${budget.toFixed(0)}: open a new one (scripts/umbrella.ts)`);
if (daysLeft !== undefined && daysLeft < 5) problems.push(`umbrella #${u.id} ends in ${daysLeft.toFixed(1)} days: open a new one (scripts/umbrella.ts)`);

const line = `feed ${Math.round(ageMin)} min old · guard gas ${gas?.toFixed(2) ?? "?"} C2FLR · umbrella #${u.id} $${spent.toFixed(2)} of $${budget.toFixed(0)}` +
  (daysLeft !== undefined ? `, ${daysLeft.toFixed(1)} days left` : "") + (u.tripped ? " · TRIPPED" : "");
console.log(line);
for (const p of problems) console.log(`::error::${p}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lancea demo\n\n${line}\n\n${problems.map((p) => `- ${p}`).join("\n") || "All well."}\n`);
}
process.exit(problems.length ? 1 : 0);
