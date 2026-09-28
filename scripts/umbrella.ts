/**
 * The principal opens a new umbrella for the account that is already running: same XRPL account, same
 * agent, same guard, a new dollar budget and window. An umbrella's budget is fixed when it is committed,
 * so a leash for more traffic is a new umbrella, not an edit. Only the principal can (PRIVATE_KEY, the
 * key that committed the last one, in lancea/.env). The config's umbrella id is updated in place; the
 * services pick it up on restart, and the autopilot acknowledges it on Flare by itself.
 *
 *   set -a; . ./.env; set +a
 *   LANCEA_CONFIG=~/.config/lancea/config.json npx tsx scripts/umbrella.ts --budget-usd 30000 --days 60 [--tripwire 1] [--guard-c2flr 0]
 *
 * Safe to run again: when the current umbrella already has at least that budget and more than a day
 * left, nothing is committed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { COSTON2, b32, coston2, meterAbi, registryAbi } from "../src/flare.js";
import { registryAbi as registryReadAbi, short } from "../src/guard.js";
import { loadConfig } from "../src/service/config.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ZERO = `0x${"0".repeat(64)}` as Hex;

async function main() {
  const path = process.env.LANCEA_CONFIG ?? "lancea.config.json";
  const c = loadConfig(path);
  const key = process.env.PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PRIVATE_KEY (the principal's Coston2 key, in lancea/.env) is not set");
  const budgetUsd6 = BigInt(Math.round(Number(arg("budget-usd", "30000")) * 1e6));
  const days = BigInt(arg("days", "60")!);
  const strikes = BigInt(arg("tripwire", "1")!);
  const guardFund = parseEther(arg("guard-c2flr", "0")!);
  const guardFlare = c.keys?.guardFlare;
  if (!guardFlare) throw new Error("the config names no guard key (keys.guardFlare)");

  const chain = coston2(c.network.rpcUrl);
  const pc = createPublicClient({ chain, transport: http(c.network.rpcUrl) });
  const principal = createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(c.network.rpcUrl) });
  const now = BigInt(Math.floor(Date.now() / 1000));

  const current = await pc.readContract({ address: c.umbrella.registry, abi: registryReadAbi, functionName: "get", args: [BigInt(c.umbrella.id)] });
  if (current.principal.toLowerCase() !== principal.account.address.toLowerCase()) {
    throw new Error(`umbrella #${c.umbrella.id}'s principal is ${current.principal}, not this key (${principal.account.address})`);
  }
  if (!current.revoked && current.budget >= budgetUsd6 && current.validUntil > now + 86_400n) {
    console.log(JSON.stringify({ umbrella: c.umbrella.id, committed: false, note: `umbrella #${c.umbrella.id} already has $${Number(current.budget) / 1e6} until ${new Date(Number(current.validUntil) * 1000).toISOString().slice(0, 10)}` }));
    return;
  }
  const have = await pc.getBalance({ address: principal.account.address });
  if (have < guardFund + parseEther("0.5")) throw new Error(`the principal has ${formatEther(have)} C2FLR; this needs ${formatEther(guardFund + parseEther("0.5"))}`);

  async function send(address: Address, abi: any, functionName: string, args: unknown[]) {
    let hash: Hex;
    try { hash = await principal.writeContract({ address, abi, functionName, args } as any); } catch (e) { throw new Error(`${functionName}: ${short(e)}`); }
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return rc;
  }
  const terms = `Lancea autopilot: $${Number(budgetUsd6) / 1e6} across XRPL and Flare`;
  const rc = await send(c.umbrella.registry, registryAbi, "commit", [c.agentEvm, keccak256(toHex(terms)), ZERO, 0n, budgetUsd6, now - 60n, now + days * 86_400n,
    { sourceId: b32("SUMMA"), assetKey: b32("USD/1e6"), agentRef: ZERO, bond: current.bond ?? COSTON2.summaVault }]);
  const id = BigInt(rc.logs.find((l) => l.address.toLowerCase() === c.umbrella.registry.toLowerCase())!.topics[1]!);
  await send(c.umbrella.meter, meterAbi, "declareEffector", [id, guardFlare]);
  await send(c.umbrella.meter, meterAbi, "setTripwire", [id, strikes]);
  if (guardFund > 0n) await pc.waitForTransactionReceipt({ hash: await principal.sendTransaction({ to: guardFlare, value: guardFund }) });

  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.umbrella.id = id.toString();
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  console.error(`umbrella #${id}: "${terms}", ${days} days, tripwire ${strikes}; guard ${guardFlare} is its effector` +
    (guardFund > 0n ? ` (+${formatEther(guardFund)} C2FLR)` : "") + `; ${path} now names it`);
  console.log(JSON.stringify({ umbrella: id.toString(), committed: true, previous: c.umbrella.id }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
