/**
 * The principal re-arms a tripped umbrella: after a drill, or once a real strike is understood. Only
 * the umbrella's principal can, with the key that committed it (PRIVATE_KEY in lancea/.env). The
 * autopilot resumes on its next tick by itself.
 *
 *   set -a; . ./.env; set +a; LANCEA_CONFIG=~/.config/lancea/config.json npx tsx scripts/rearm.ts
 */
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2, meterAbi } from "../src/flare.js";
import { short } from "../src/guard.js";
import { loadConfig } from "../src/service/config.js";

/** The custom error's name, from anywhere in viem's cause chain. */
export function errorName(e: unknown): string | undefined {
  for (let x = e as { cause?: unknown; data?: { errorName?: string } } | undefined; x; x = x.cause as typeof x) {
    if (x.data?.errorName) return x.data.errorName;
  }
  return undefined;
}

async function main() {
  const c = loadConfig();
  const key = process.env.PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PRIVATE_KEY (the principal's Coston2 key, in lancea/.env) is not set");
  const chain = coston2(c.network.rpcUrl);
  const pc = createPublicClient({ chain, transport: http(c.network.rpcUrl) });
  const id = BigInt(c.umbrella.id);
  const read = (functionName: "strikes" | "tripped") =>
    pc.readContract({ address: c.umbrella.meter, abi: meterAbi, functionName, args: [id] });
  if (!(await read("tripped"))) {
    console.log(`umbrella #${id} is not tripped: nothing to re-arm`);
    return;
  }
  const w = createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(c.network.rpcUrl) });
  let hash: Hex;
  try {
    hash = await w.writeContract({ address: c.umbrella.meter, abi: meterAbi, functionName: "rearm", args: [id] });
  } catch (e) {
    const name = errorName(e);
    throw new Error(`rearm refused${name ? ` (${name})` : ""}: ${short(e)}. Only the umbrella's principal can re-arm it.`);
  }
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`rearm reverted: ${hash}`);
  console.log(`re-armed umbrella #${id}: https://coston2-explorer.flare.network/tx/${hash}`);
  console.log(`  strikes ${await read("strikes")}, tripped ${await read("tripped")}: the autopilot resumes on its next tick`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
