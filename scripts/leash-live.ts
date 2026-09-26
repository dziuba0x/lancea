/**
 * The leash, live with dollars and a tripwire (XRPL testnet + Flare Coston2).
 *
 *   0. Flare   deploy SummaMeter v1.2 (the tripwire) over the live MandateRegistry and JudgeSumma
 *              price map; a $40 umbrella; the guard's Flare key is its effector; tripwire 1
 *   1. XRPL    a guarded account: SignerList principal 2 / agent 1 / guard 1, master key off
 *   2. autopilot  mint 20 XRP to its own personal account     guard: policy ✓, ≈$30 of $40 ✓ → co-signed
 *   3. autopilot  deposit the FXRP into Firelight              → co-signed
 *   4. the agent, steered: mint 5 XRP to a stranger           → refused and STRUCK: the umbrella trips
 *   5. autopilot  redeem 1 share                               → refused: tripped, on every rail
 *   6. the principal re-arms                                   → the same redeem is co-signed
 *   7. autopilot  mint 20 XRP more                             → refused: past $40
 *
 * Needs PRIVATE_KEY (a Coston2 principal with ≥3 C2FLR) and the delicti repo's forge `out/`
 * (v0.16 source, for SummaMeter v1.2). Run: npx tsx scripts/leash-live.ts
 * Rehearsal on a fork: anvil --fork-url <coston2> --chain-id 114, then COSTON2_RPC=http://127.0.0.1:8545 NO_WAIT=1.
 */
import { Wallet, type Payment, type SignerListSet, type AccountSet } from "xrpl";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, keccak256, toHex, stringToHex, pad, parseAbi, zeroAddress, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
import { XrplHttp } from "../src/xrpl-http.js";
import { Guard, type Decision } from "../src/guard.js";
import { plan, toPayment, type State, type Strategy, type Venue } from "../src/autopilot.js";

const OUT = process.env.DELICTI_OUT ?? new URL("../../delicti/out/", import.meta.url).pathname;
const art = (f: string, c: string) => JSON.parse(readFileSync(`${OUT}${f}/${c}.json`, "utf8"));
const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const REG = "0x2c58fb0504377fef325DceB66219bC6302263AA3" as Address; // MandateRegistry (core, shared by every version)
const SUMMA = "0x211EB7d798F528B4E66201496bE4Cf7f6A62f644" as Address; // JudgeSumma v0.15: the immutable price map
const SUMMA_VAULT = "0x8Dd62BE6Ee0689e3Eb5960F08a5356a57bD2F354" as Address;
const MAC = "0x434936d47503353f06750Db1A444DBDC5F0AD37c" as Address; // MasterAccountController
const AM = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA" as Address; // AssetManagerFXRP
const Z = `0x${"0".repeat(64)}` as Hex;
const b32 = (s: string) => pad(stringToHex(s), { dir: "right", size: 32 });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (d: unknown) => JSON.stringify(d, (_, v) => (typeof v === "bigint" ? v.toString() : v));

const chain = defineChain({ id: 114, name: "coston2", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC) });
const principal = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex), chain, transport: http(RPC) });
const agentEvm = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain, transport: http(RPC) });
const guardKey = generatePrivateKey();
const guardEvm = privateKeyToAccount(guardKey).address;

const meterArt = art("SummaMeter.sol", "SummaMeter");
if (!meterArt.abi.some((x: { name?: string }) => x.name === "setTripwire")) throw new Error("SummaMeter in out/ has no tripwire: forge build the v0.16 delicti source");
const regAbi = art("MandateRegistry.sol", "MandateRegistry").abi;
const meterAbi = meterArt.abi;
const read = parseAbi([
  "function getXrplProviderWallets() view returns (string[])",
  "function getDefaultInstructionFee() view returns (uint256)",
  "function getPersonalAccount(string) view returns (address)",
  "function getVaults() view returns (uint256[], address[], uint8[])",
  "function directMintingPaymentAddress() view returns (string)",
  "function fAsset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const call = <T>(address: Address, functionName: string, args: unknown[] = []) =>
  pc.readContract({ address, abi: read, functionName: functionName as never, args: args as never }) as Promise<T>;
async function send(w: any, address: Address, abi: any, functionName: string, args: unknown[] = []) {
  const hash = await w.writeContract({ address, abi, functionName, args });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return rc;
}

// ------------------------------------------------------------------ 0. Flare: the meter with a tripwire, a $40 umbrella
log("== 0. Flare: SummaMeter v1.2, a $40 umbrella, tripwire 1");
const dep = await principal.deployContract({ abi: meterAbi, bytecode: meterArt.bytecode.object as Hex, args: [REG, SUMMA, zeroAddress] });
const meter = (await pc.waitForTransactionReceipt({ hash: dep })).contractAddress as Address;
for (const to of [agentEvm.account.address, guardEvm]) {
  await pc.waitForTransactionReceipt({ hash: await principal.sendTransaction({ to, value: parseEther(to === guardEvm ? "0.5" : "0.2") }) });
}
const now = BigInt(Math.floor(Date.now() / 1000));
const rc = await send(principal, REG, regAbi, "commit", [agentEvm.account.address, keccak256(toHex("Lancea autopilot: $40 across XRPL and Flare")), Z, 0n, 40_000_000n,
  now - 60n, now + 86_400n, { sourceId: b32("SUMMA"), assetKey: b32("USD/1e6"), agentRef: Z, bond: SUMMA_VAULT }]);
const umbrella = BigInt(rc.logs.find((l: any) => l.address.toLowerCase() === REG.toLowerCase())!.topics[1]!);
await send(agentEvm, REG, regAbi, "acknowledge", [umbrella]);
await send(principal, meter, meterAbi, "declareEffector", [umbrella, guardEvm]);
await send(principal, meter, meterAbi, "setTripwire", [umbrella, 1n]);
log(`   meter ${meter} | umbrella #${umbrella} ($40) | guard's Flare key ${guardEvm} is its effector | tripwire 1`);
const meterState = async () => {
  const [spent, strikes, tripped] = await Promise.all(["spentUsd6", "strikes", "tripped"].map((f) =>
    pc.readContract({ address: meter, abi: meterAbi, functionName: f, args: [umbrella] })));
  return `tally $${Number(spent) / 1e6} | strikes ${strikes} | tripped ${tripped}`;
};

// ------------------------------------------------------------------ 1. XRPL: the guarded account
log("== 1. XRPL: the guarded account");
const xrpl = new XrplHttp(process.env.XRPL_RPC?.split(","));
const acct = await xrpl.fund();
const master = Wallet.fromSeed(acct.seed);
const [P, K, G] = [Wallet.generate(), Wallet.generate(), Wallet.generate()]; // principal, agent, guard
const sl = await xrpl.autofill<SignerListSet>({ TransactionType: "SignerListSet", Account: acct.address, SignerQuorum: 2, SignerEntries: [
  { SignerEntry: { Account: P.address, SignerWeight: 2 } }, { SignerEntry: { Account: K.address, SignerWeight: 1 } },
  { SignerEntry: { Account: G.address, SignerWeight: 1 } }] });
await xrpl.submitAndWait(master.sign(sl).tx_blob);
const off = await xrpl.submitAndWait(master.sign(await xrpl.autofill<AccountSet>({ TransactionType: "AccountSet", Account: acct.address, SetFlag: 4 })).tx_blob);
if (off.result !== "tesSUCCESS") throw new Error(`disable master: ${off.result}`);

const [operator] = await call<string[]>(MAC, "getXrplProviderWallets");
const fee = await call<bigint>(MAC, "getDefaultInstructionFee");
const coreVault = await call<string>(AM, "directMintingPaymentAddress");
const fxrp = await call<Address>(AM, "fAsset");
const [ids, addrs, types] = await call<[bigint[], Address[], number[]]>(MAC, "getVaults");
const fi = types.findIndex((t) => t === 1);
const vaultId = Number(ids[fi]), vault = addrs[fi];
const pa = await call<Address>(MAC, "getPersonalAccount", [acct.address]);
log(`   ${acct.address} → personal account ${pa} | Firelight vault ${vaultId} ${vault}`);

const guard = new Guard({ account: acct.address, guardSeed: G.seed!, flareKey: guardKey, chain, rpcUrl: RPC, meter, umbrellaId: umbrella, xrplSource: "testXRP",
  smartAccounts: { operators: [operator], coreVault, policy: { vaults: [vaultId], personalAccount: pa } }, strikeOnPolicy: true }, xrpl);
const venue: Venue = { account: acct.address, operator, fee, coreVault, personalAccount: pa };
const strategy: Strategy = { vaultId, keepDrops: 70_000_000n, maxMintDrops: 20_000_000n, minMintDrops: 5_000_000n };
const state = async (): Promise<State> => {
  const info = await xrpl.rpc("account_info", { account: acct.address, ledger_index: "validated" });
  return { xrpDrops: BigInt(info.account_data.Balance) - 2_000_000n, fxrp: await call<bigint>(fxrp, "balanceOf", [pa]),
    shares: { [vaultId]: await call<bigint>(vault, "balanceOf", [pa]) } };
};

/** The agent signs its proposal; the guard alone decides whether it becomes a transaction. */
const results: Record<string, unknown> = {};
async function propose(label: string, tx: Payment): Promise<Decision> {
  const filled = await xrpl.autofill<Payment>(tx, 2);
  const d = await guard.cosign(K.sign(filled, true).tx_blob);
  results[label] = d;
  log(`   ${label}: ${d.signed ? `CO-SIGNED ${d.hash}` : `REFUSED — ${d.reason}${d.struck ? ` | struck ${d.struck}` : ""}`}`);
  log(`      ${await meterState()}`);
  return d;
}
const NO_WAIT = process.env.NO_WAIT === "1"; // rehearsal on a fork: Coston2's executor and operator act on the real chain
async function until(what: string, test: () => Promise<boolean>, minutes = 15) {
  if (NO_WAIT) { log(`   (${what}: not awaited, NO_WAIT)`); return false; }
  for (let i = 0; i < minutes * 6; i++) { if (await test()) return true; await sleep(10_000); }
  log(`   (${what}: not within ${minutes} min)`); return false;
}

// ------------------------------------------------------------------ 2–7
log("== 2. autopilot: mint");
let step = plan(await state(), strategy);
if (step?.kind !== "mint") throw new Error(`expected a mint, planned ${json(step)}`);
if ((await propose("2. mint 20 XRP to own personal account", toPayment(step, venue))).signed) {
  await until("direct mint", async () => (await call<bigint>(fxrp, "balanceOf", [pa])) > 0n);
}
log("== 3. autopilot: deposit");
step = plan(await state(), strategy);
if (step?.kind === "deposit" && (await propose(`3. deposit ${Number(step.amount) / 1e6} FXRP into Firelight`, toPayment(step, venue))).signed) {
  await until("deposit", async () => (await call<bigint>(vault, "balanceOf", [pa])) > 0n);
}
log("== 4. the agent, steered: mint to a stranger");
await propose("4. mint 5 XRP to 0x…bEEF", toPayment({ kind: "mint", drops: 5_000_000n }, { ...venue, personalAccount: "0x000000000000000000000000000000000000bEEF" }));
log("== 5. autopilot: redeem 1 share");
// The guard does not read balances, so without shares (a rehearsal) the same proposal is judged the same way.
const planned = plan(await state(), { ...strategy, withdrawShares: 1_000_000n });
const redeem = planned?.kind === "redeem" ? planned : { kind: "redeem" as const, shares: 1_000_000n, vaultId };
await propose("5. redeem 1 share (tripped)", toPayment(redeem, venue));
log("== 6. the principal re-arms");
await send(principal, meter, meterAbi, "rearm", [umbrella]);
log(`      ${await meterState()}`);
const again = await propose("6. redeem 1 share (re-armed)", toPayment(redeem, venue));
if (again.signed) {
  const before = (await state()).shares[vaultId];
  await until("redeem request", async () => (await call<bigint>(vault, "balanceOf", [pa])) < before!, 5);
}
log("== 7. autopilot: mint 20 XRP more");
await propose("7. mint 20 XRP more (budget)", toPayment({ kind: "mint", drops: 20_000_000n }, venue));

const end = await state();
log(`== done: ${await meterState()} | XRP ${Number(end.xrpDrops) / 1e6} spendable | FXRP ${Number(end.fxrp) / 1e6} | stXRP ${Number(end.shares[vaultId]) / 1e6}`);
console.log("SUMMARY " + json({ meter, umbrella, account: acct.address, personalAccount: pa, vault, results }));
