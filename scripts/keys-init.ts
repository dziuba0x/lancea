/**
 * Run once, on the machine that will run the services. It makes the guard's and the agent's keys
 * there, and the token between them, in $LANCEA_KEYS (default ./keys), readable by this user only,
 * and prints the public half, which scripts/provision.ts needs. Nothing secret is printed, and keys
 * that exist are never overwritten (--force would orphan whatever they hold).
 *
 *   LANCEA_KEYS=/etc/lancea/keys npx tsx scripts/keys-init.ts > keys-public.json
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Wallet } from "xrpl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const dir = process.env.LANCEA_KEYS ?? "keys";
const names = ["guard.json", "agent.json", "token"];
if (names.some((n) => existsSync(join(dir, n))) && !process.argv.includes("--force")) {
  console.error(`keys already exist in ${dir}: nothing written`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const put = (name: string, body: string) => writeFileSync(join(dir, name), body, { mode: 0o600 });

const guard = Wallet.generate(), agent = Wallet.generate();
const guardFlare = generatePrivateKey(), agentEvm = generatePrivateKey();
put("guard.json", JSON.stringify({ xrplSeed: guard.seed, flareKey: guardFlare }, null, 2) + "\n");
put("agent.json", JSON.stringify({ xrplSeed: agent.seed, evmKey: agentEvm }, null, 2) + "\n");
put("token", randomBytes(32).toString("hex") + "\n");

console.log(JSON.stringify({
  guardXrpl: guard.address,
  guardFlare: privateKeyToAccount(guardFlare).address,
  agentXrpl: agent.address,
  agentEvm: privateKeyToAccount(agentEvm).address,
}, null, 2));
