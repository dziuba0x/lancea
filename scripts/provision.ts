/**
 * Provisioning, run once by the principal, where the principal's key lives (never on the services'
 * machine). From the public half of the services' keys (scripts/keys-init.ts) it builds everything
 * the guard and the autopilot will run against, and writes their config:
 *
 *   XRPL    a fresh testnet account; its SignerList: the owner 2, the agent 1, the guard 1, quorum 2;
 *           its master key disabled. The owner's key is made here and saved in .run/, for the owner only.
 *   Flare   an umbrella in USD (SUMMA) naming the agent; the guard's Flare key declared its effector;
 *           the tripwire set; both service keys funded with C2FLR for their gas.
 *   config  lancea.config.json: addresses and ids only, safe to copy to the services' machine.
 *
 *   PRIVATE_KEY=0x… npx tsx scripts/provision.ts --keys keys-public.json [--budget-usd 40] [--tripwire 1]
 *     [--days 90] [--guard-c2flr 3] [--agent-c2flr 0.5] [--data-dir /var/lib/lancea] [--out lancea.config.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Wallet, type AccountSet, type SignerListSet } from "xrpl";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { XrplHttp } from "../src/xrpl-http.js";
import { COSTON2, b32, coston2, meterAbi, registryAbi, smartAccountsAbi } from "../src/flare.js";
import type { LanceaConfig } from "../src/service/config.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const chain = coston2(RPC);
const pc = createPublicClient({ chain, transport: http(RPC) });
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY ?? "")) throw new Error("PRIVATE_KEY (the principal's Coston2 key) is not set");
const principal = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex), chain, transport: http(RPC) });

const keysPath = arg("keys");
if (!keysPath) throw new Error("--keys <file>: the JSON scripts/keys-init.ts printed on the services' machine");
const pub = JSON.parse(readFileSync(keysPath, "utf8")) as { guardXrpl: string; guardFlare: Address; agentXrpl: string; agentEvm: Address };
const budgetUsd6 = BigInt(Math.round(Number(arg("budget-usd", "40")) * 1e6));
const strikes = BigInt(arg("tripwire", "1")!);
const days = BigInt(arg("days", "90")!);
const guardFund = parseEther(arg("guard-c2flr", "3")!);
const agentFund = parseEther(arg("agent-c2flr", "0.5")!);
const registry = (process.env.REGISTRY ?? COSTON2.registry) as Address;
const meter = (process.env.SUMMA_METER ?? COSTON2.summaMeter) as Address;
const summaVault = (process.env.SUMMA_VAULT ?? COSTON2.summaVault) as Address;
const ZERO = `0x${"0".repeat(64)}` as Hex;

async function send(address: Address, abi: any, functionName: string, args: unknown[]) {
  const hash = await principal.writeContract({ address, abi, functionName, args } as any);
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return rc;
}
const read = <T>(address: Address, functionName: string, args: unknown[] = []) =>
  pc.readContract({ address, abi: smartAccountsAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

const have = await pc.getBalance({ address: principal.account.address });
const need = guardFund + agentFund + parseEther("1");
if (have < need) throw new Error(`the principal ${principal.account.address} has ${formatEther(have)} C2FLR; provisioning needs ${formatEther(need)}`);

// ------------------------------------------------------------------ XRPL: the guarded account
const xrpl = new XrplHttp(process.env.XRPL_RPC?.split(","));
xrpl.onRetry = (note) => log(`xrpl: ${note}`);
const owner = Wallet.generate();
const acct = await xrpl.fund();
mkdirSync(new URL("../.run/", import.meta.url).pathname, { recursive: true, mode: 0o700 });
const ownerFile = new URL(`../.run/owner-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url).pathname;
writeFileSync(ownerFile, JSON.stringify({ account: acct.address, accountSeed: acct.seed, owner: owner.address, ownerSeed: owner.seed }, null, 2), { mode: 0o600 });
log(`XRPL account ${acct.address}; the owner's key (weight 2) is in ${ownerFile.slice(ownerFile.indexOf(".run/"))}`);
const master = Wallet.fromSeed(acct.seed);
const list = await xrpl.autofill<SignerListSet>({ TransactionType: "SignerListSet", Account: acct.address, SignerQuorum: 2, SignerEntries: [
  { SignerEntry: { Account: owner.address, SignerWeight: 2 } },
  { SignerEntry: { Account: pub.agentXrpl, SignerWeight: 1 } },
  { SignerEntry: { Account: pub.guardXrpl, SignerWeight: 1 } },
] });
const set = await xrpl.submitAndWait(master.sign(list).tx_blob);
if (set.result !== "tesSUCCESS") throw new Error(`SignerListSet: ${set.result}`);
const off = await xrpl.submitAndWait(master.sign(await xrpl.autofill<AccountSet>({ TransactionType: "AccountSet", Account: acct.address, SetFlag: 4 })).tx_blob);
if (off.result !== "tesSUCCESS") throw new Error(`disabling the master key: ${off.result}`);
log(`SignerList: owner 2, agent ${pub.agentXrpl} 1, guard ${pub.guardXrpl} 1, quorum 2; master key disabled`);

// ------------------------------------------------------------------ Flare: the umbrella, the effector, the tripwire, the gas
const now = BigInt(Math.floor(Date.now() / 1000));
const terms = `Lancea autopilot: $${Number(budgetUsd6) / 1e6} across XRPL and Flare`;
const rc = await send(registry, registryAbi, "commit", [pub.agentEvm, keccak256(toHex(terms)), ZERO, 0n, budgetUsd6, now - 60n, now + days * 86_400n,
  { sourceId: b32("SUMMA"), assetKey: b32("USD/1e6"), agentRef: ZERO, bond: summaVault }]);
const umbrella = BigInt(rc.logs.find((l) => l.address.toLowerCase() === registry.toLowerCase())!.topics[1]!);
await send(meter, meterAbi, "declareEffector", [umbrella, pub.guardFlare]);
await send(meter, meterAbi, "setTripwire", [umbrella, strikes]);
for (const [to, value] of [[pub.guardFlare, guardFund], [pub.agentEvm, agentFund]] as const) {
  await pc.waitForTransactionReceipt({ hash: await principal.sendTransaction({ to, value }) });
}
log(`umbrella #${umbrella}: "${terms}", ${days} days, tripwire ${strikes}; guard ${pub.guardFlare} is its effector (${formatEther(guardFund)} C2FLR), agent ${pub.agentEvm} (${formatEther(agentFund)} C2FLR)`);

// ------------------------------------------------------------------ Smart Accounts, as the account sees them
const MAC = COSTON2.masterAccountController, AM = COSTON2.assetManagerFxrp;
const operators = await read<string[]>(MAC, "getXrplProviderWallets");
const fee = await read<bigint>(MAC, "getDefaultInstructionFee");
const coreVault = await read<string>(AM, "directMintingPaymentAddress");
const fxrp = await read<Address>(AM, "fAsset");
const [ids, addrs, types] = await read<[bigint[], Address[], number[]]>(MAC, "getVaults");
const fi = types.findIndex((t) => Number(t) === 1); // Firelight
if (fi < 0) throw new Error("no Firelight vault on MasterAccountController");
const personalAccount = await read<Address>(MAC, "getPersonalAccount", [acct.address]);

const config: LanceaConfig = {
  network: { rpcUrl: RPC, xrplRpc: process.env.XRPL_RPC?.split(","), xrplSource: "testXRP" },
  account: acct.address,
  umbrella: { id: umbrella.toString(), meter, registry },
  agentEvm: pub.agentEvm,
  smartAccounts: { operators, operatorFeeDrops: fee.toString(), coreVault, personalAccount, fxrp, vault: addrs[fi], vaultId: Number(ids[fi]) },
  strategy: { keepDrops: "70000000", maxMintDrops: "20000000", minMintDrops: "5000000" },
  autopilot: { tickSeconds: 300, executionTimeoutS: 1800, backoffS: 1800 },
  guard: { host: "127.0.0.1", port: 8787, strikeOnPolicy: true },
  dataDir: arg("data-dir", "/var/lib/lancea")!,
};
const out = arg("out", "lancea.config.json")!;
writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
log(`config written to ${out}: copy it to the services' machine (it holds no key)`);
console.log(JSON.stringify({ account: acct.address, umbrella: umbrella.toString(), personalAccount, config: out }));
