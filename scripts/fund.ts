/**
 * The principal (PRIVATE_KEY, in lancea/.env) sends C2FLR to an address on Coston2: the playground's owner,
 * so it can commit the playground's umbrella and fund its guard and agent. It keeps `--keep` for itself,
 * and sends nothing when the address already holds `--c2flr`. Prints one line of JSON either way.
 *
 *   set -a; . ./.env; set +a
 *   npx tsx scripts/fund.ts --to 0x… --c2flr 10 [--keep 2]
 */
import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2 } from "../src/flare.js";

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const key = process.env.PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PRIVATE_KEY (the principal's Coston2 key, in lancea/.env) is not set");
const to = arg("to") as Hex;
if (!to || !isAddress(to)) throw new Error("--to <0x address>");
const want = parseEther(arg("c2flr", "10")!), keep = parseEther(arg("keep", "2")!);
const chain = coston2(RPC);
const pc = createPublicClient({ chain, transport: http(RPC) });
const w = createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(RPC) });
const [has, mine] = await Promise.all([pc.getBalance({ address: to }), pc.getBalance({ address: w.account.address })]);
if (has >= want) {
  console.log(JSON.stringify({ sent: false, reason: "already funded", to, has: formatEther(has) }));
} else if (mine < want - has + keep) {
  console.log(JSON.stringify({ sent: false, reason: "the principal is short", from: w.account.address, has: formatEther(mine), need: formatEther(want - has + keep), to }));
} else {
  const hash = await w.sendTransaction({ to, value: want - has });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`the transfer reverted: ${hash}`);
  console.log(JSON.stringify({ sent: true, to, c2flr: formatEther(want - has), hash }));
}
