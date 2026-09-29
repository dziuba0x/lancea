/**
 * A principal's Coston2 key, made on the machine that will use it and never printed: $LANCEA_KEYS/principal
 * (mode 600). The playground's owner lives on the demo's server, so it can re-arm the playground a few
 * minutes after a visitor trips it; the live demo's principal never does (it stays on its owner's
 * computer). Prints the address only. A key that exists is kept.
 *
 *   LANCEA_KEYS=~/.config/lancea/playground-keys npx tsx scripts/principal-init.ts
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const dir = process.env.LANCEA_KEYS ?? "keys";
const path = join(dir, "principal");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const made = !existsSync(path);
if (made) writeFileSync(path, generatePrivateKey() + "\n", { mode: 0o600 });
chmodSync(path, 0o600);
const key = readFileSync(path, "utf8").trim() as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} does not hold a key`);
console.log(JSON.stringify({ principal: privateKeyToAccount(key).address, made }));
