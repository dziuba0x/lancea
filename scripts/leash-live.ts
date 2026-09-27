/**
 * The leash, live with dollars and a tripwire (XRPL testnet + Flare Coston2).
 *
 *   0. Flare   a $40 umbrella in DELICTI's VaultSumma v0.16, on the deployed SummaMeter v1.2 (the
 *              tripwire; override with SUMMA_METER); the guard's Flare key is its effector; tripwire 1
 *   1. XRPL    a guarded account: SignerList principal 2 / agent 1 / guard 1, master key off
 *   2. autopilot  mint 20 XRP to its own personal account     guard: policy ✓, ≈$30 of $40 ✓ → co-signed
 *   3. autopilot  deposit the FXRP into Firelight              → co-signed
 *   4. the agent, steered: mint 5 XRP to a stranger           → refused and STRUCK: the umbrella trips
 *   5. autopilot  redeem 1 share                               → refused: tripped, on every rail
 *   6. the principal re-arms                                   → the same redeem is co-signed
 *   7. autopilot  mint 20 XRP more                             → refused: past $40
 *
 * Gas. The guard writes to Flare before every signature (the reservation) and on every attempt (the
 * strike). A Coston2 node fills a transaction at maxFee = 2 × base fee + tip, and viem adds a fifth, so
 * a write must hold gas × that fee up front: about 0.3 C2FLR per write at today's 500 gwei. The guard's
 * key is funded from today's fee and topped up before every step; what is left goes back to the
 * principal at the end. (0.5 C2FLR, as before, ran dry at the fourth write: live on 2026-09-26.)
 *
 * Nothing is lost. The run's keys go to .run/leash-<time>.json (git-ignored, mode 600) before anything
 * is funded. A step that fails is logged and the run goes on; the summary and the sweep always happen.
 *   Sweep a run that was killed:  npx tsx scripts/leash-live.ts --sweep .run/leash-<time>.json
 *
 * Needs PRIVATE_KEY (a Coston2 principal with ≥6 C2FLR; a run spends about 2) and delicti's forge `out/`
 * (v0.16 source, for SummaMeter v1.2). Run: npx tsx scripts/leash-live.ts
 * Rehearsal on a fork, at Coston2's fees: scripts/coston2-fork-proxy.mjs, then COSTON2_RPC=http://127.0.0.1:8546 FORK=1.
 * GUARD_C2FLR=0.5 funds the guard with exactly that and never tops it up: the way to rehearse running dry.
 */
import { Wallet, type Payment, type SignerListSet, type AccountSet } from "xrpl";
import { createPublicClient, createWalletClient, createTestClient, defineChain, http, parseEther, formatEther, formatGwei, keccak256,
  toHex, stringToHex, pad, parseAbi, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { XrplHttp } from "../src/xrpl-http.js";
import { Guard, short, type Decision } from "../src/guard.js";
import { plan, toPayment, type State, type Strategy, type Venue } from "../src/autopilot.js";

const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const REG = "0x2c58fb0504377fef325DceB66219bC6302263AA3" as Address; // MandateRegistry (core, shared by every version)
// DELICTI v0.16 + amendment v1.2 on Coston2 (delicti/deployments/coston2-v0.16.json): the umbrella is bonded in
// VaultSumma, and the guard reads and writes the deployed SummaMeter, the same meter every rail of the umbrella asks.
const SUMMA_VAULT = (process.env.SUMMA_VAULT ?? "0x274e8aa149C0904E10b99c79017EB7EE74184E54") as Address;
const SUMMA_METER = (process.env.SUMMA_METER ?? "0x39aa9b12CDe7bFc936456247DFb3eb78aA1FaB1D") as Address;
const MAC = "0x434936d47503353f06750Db1A444DBDC5F0AD37c" as Address; // MasterAccountController
const AM = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA" as Address; // AssetManagerFXRP
const Z = `0x${"0".repeat(64)}` as Hex;
const FORK = process.env.FORK === "1" || process.env.NO_WAIT === "1"; // a fork: Coston2's executor and operator act on the real chain only
const FIXED_GUARD = process.env.GUARD_C2FLR ? parseEther(process.env.GUARD_C2FLR) : undefined;
const b32 = (s: string) => pad(stringToHex(s), { dir: "right", size: 32 });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (d: unknown, space?: number) => JSON.stringify(d, (_, v) => (typeof v === "bigint" ? v.toString() : v), space);
const C2 = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} C2FLR`;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

const chain = defineChain({ id: 114, name: "coston2", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC) });

/** What one write can need up front today: gas × the fee a Coston2 node fills (2 × base fee + tip), plus viem's fifth. */
async function upFront(gas = 250_000n): Promise<{ wei: bigint; base: bigint; tip: bigint }> {
  const [block, tip] = await Promise.all([pc.getBlock(), pc.estimateMaxPriorityFeePerGas()]);
  const base = block.baseFeePerGas ?? 0n;
  return { wei: (gas * (2n * base + tip) * 12n) / 10n, base, tip };
}

/** Send everything a key holds, less the gas of sending it, to `to`. */
async function sweep(key: Hex, to: Address): Promise<bigint> {
  const from = privateKeyToAccount(key);
  const w = createWalletClient({ account: from, chain, transport: http(RPC) });
  const [balance, { base, tip }] = await Promise.all([pc.getBalance({ address: from.address }), upFront()]);
  const maxFee = 2n * base + tip, cost = 21_000n * maxFee;
  if (balance <= cost) return 0n;
  const hash = await w.sendTransaction({ to, value: balance - cost, gas: 21_000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
  await pc.waitForTransactionReceipt({ hash });
  return balance - cost;
}

type RunFile = {
  started: string; rpc: string; principal: Address; agentEvmKey: Hex; guardKey: Hex;
  xrpl?: { account?: string; seed?: string; principal: string; agent: string; guard: string };
  meter?: Address; umbrella?: string; swept?: Record<string, string>;
};

// ------------------------------------------------------------------ --sweep <run file>: a run that was killed
if (process.argv[2] === "--sweep") {
  const run = JSON.parse(readFileSync(process.argv[3], "utf8")) as RunFile;
  for (const [who, key] of [["agent", run.agentEvmKey], ["guard", run.guardKey]] as const) {
    log(`${who} ${privateKeyToAccount(key).address}: ${C2(await sweep(key, run.principal))} back to ${run.principal}`);
  }
  process.exit(0);
}

const OUT = process.env.DELICTI_OUT ?? new URL("../../delicti/out/", import.meta.url).pathname;
const art = (f: string, c: string) => JSON.parse(readFileSync(`${OUT}${f}/${c}.json`, "utf8"));
const meterArt = art("SummaMeter.sol", "SummaMeter");
if (!meterArt.abi.some((x: { name?: string }) => x.name === "setTripwire")) throw new Error("SummaMeter in out/ has no tripwire: forge build the v0.16 delicti source (its ABI)");
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

// ------------------------------------------------------------------ the run's keys, on disk before anything is funded
const principal = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex), chain, transport: http(RPC) });
const agentEvmKey = generatePrivateKey(), guardKey = generatePrivateKey();
const agentEvm = createWalletClient({ account: privateKeyToAccount(agentEvmKey), chain, transport: http(RPC) });
const guardEvm = privateKeyToAccount(guardKey).address;
const RUN_DIR = new URL("../.run/", import.meta.url).pathname;
mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
const runPath = `${RUN_DIR}leash-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const run: RunFile = { started: new Date().toISOString(), rpc: RPC, principal: principal.account.address, agentEvmKey, guardKey };
const save = () => writeFileSync(runPath, json(run, 2), { mode: 0o600 });
save();

const results: Record<string, unknown> = {};
const verdicts: string[] = []; // decisions that differ from the design
const failures: string[] = [];
let funded = 0n; // what the principal gave the guard's key
let stopped = false; // a prerequisite failed: what depends on it is skipped

/** One stage. A failure is logged and recorded, and the run goes on; after a prerequisite fails, the rest is skipped. */
async function stage(title: string, fn: () => Promise<void>, prerequisite = false) {
  if (stopped) { log(`== ${title}: skipped`); return; }
  log(`== ${title}`);
  const t0 = Date.now();
  try { await fn(); } catch (e) {
    failures.push(`${title}: ${short(e)}`);
    log(`   !! ${short(e)}`);
    if (prerequisite) stopped = true;
  }
  const g = await pc.getBalance({ address: guardEvm }).catch(() => undefined);
  log(`   (${Math.round((Date.now() - t0) / 1000)} s | guard's Flare key ${g === undefined ? "?" : C2(g)})`);
}

/** Before each step: the guard's key holds at least four writes at today's fee. */
async function topUp() {
  if (FIXED_GUARD !== undefined) return;
  const { wei } = await upFront();
  const balance = await pc.getBalance({ address: guardEvm });
  if (balance >= 4n * wei) return;
  const add = 8n * wei - balance;
  await pc.waitForTransactionReceipt({ hash: await principal.sendTransaction({ to: guardEvm, value: add }) });
  funded += add;
  log(`   guard's Flare key topped up +${C2(add)}`);
}

let finished = false;
/** The sweep and the summary: always, once. */
async function finish(code: number): Promise<never> {
  if (!finished) {
    finished = true;
    const left = await pc.getBalance({ address: guardEvm }).catch(() => 0n);
    run.swept = {};
    for (const [who, key] of [["agent", agentEvmKey], ["guard", guardKey]] as const) {
      try { run.swept[who] = C2(await sweep(key, principal.account.address)); } catch (e) { run.swept[who] = `not swept: ${short(e)} (use --sweep)`; }
    }
    save();
    log(`== swept back to the principal: guard ${run.swept.guard}, agent ${run.swept.agent} | the guard's writes cost ${C2(funded - left)}`);
    const decided = Object.keys(results).length;
    log(`== verdict: ${code === 130 ? `interrupted after ${decided} decision(s); ` : ""}${decided - verdicts.length} of ${decided} decisions as designed${
      failures.length ? `, ${failures.length} stage(s) failed` : ""}`);
    for (const v of [...verdicts, ...failures]) log(`   ✗ ${v}`);
    console.log("SUMMARY " + json({ meter: run.meter, umbrella: run.umbrella, account: run.xrpl?.account, results, verdicts, failures,
      guardGasC2flr: formatEther(funded - left), swept: run.swept, runFile: runPath }));
  }
  process.exit(code);
}
// Ctrl-C (or a closed terminal): sweep and summarise first. The same Ctrl-C can arrive twice (tsx relays
// it), so only a second one after three seconds quits at once. A log piped into a closed tee must not
// stop the sweep either.
let interruptedAt = 0;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (interruptedAt) { if (Date.now() - interruptedAt > 3000) process.exit(130); return; }
    interruptedAt = Date.now();
    log("!! interrupted: sweeping the run's keys back to the principal (Ctrl-C again, after 3 s, to quit at once)");
    void finish(130);
  });
}
process.stdout.on("error", () => {});

// ------------------------------------------------------------------ 0. Flare: the meter with a tripwire, a $40 umbrella
let meter!: Address, umbrella!: bigint;
const meterState = async () => {
  const [spent, strikes, tripped] = await Promise.all(["spentUsd6", "strikes", "tripped"].map((f) =>
    pc.readContract({ address: meter, abi: meterAbi, functionName: f, args: [umbrella] })));
  return `tally $${Number(spent) / 1e6} | strikes ${strikes} | tripped ${tripped}`;
};
await stage("0. Flare: a $40 umbrella on the deployed SummaMeter v1.2, tripwire 1", async () => {
  const { wei, base, tip } = await upFront();
  const guardFund = FIXED_GUARD ?? max(parseEther("3"), 8n * wei);
  const agentFund = max(parseEther("0.5"), 2n * wei);
  const need = guardFund + agentFund + parseEther("1"); // + the principal's own gas: four calls and the re-arm
  const have = await pc.getBalance({ address: principal.account.address });
  log(`   fees: base ${formatGwei(base)} gwei, tip ${formatGwei(tip)} gwei → a write may need ${C2(wei)} up front | principal ${C2(have)}`);
  if (have < need) throw new Error(`the principal ${principal.account.address} has ${C2(have)}; this run needs ${C2(need)} at today's fees`);
  log(`   keys: ${runPath.slice(runPath.indexOf(".run/"))} (git-ignored; for --sweep if the run is killed)`);

  meter = SUMMA_METER;
  await pc.readContract({ address: meter, abi: meterAbi, functionName: "tripwire", args: [0n] }).catch(() => {
    throw new Error(`${meter} is not a SummaMeter v1.2 (no tripwire): set SUMMA_METER`);
  });
  run.meter = meter; save();
  for (const [to, value] of [[agentEvm.account.address, agentFund], [guardEvm, guardFund]] as const) {
    await pc.waitForTransactionReceipt({ hash: await principal.sendTransaction({ to, value }) });
    if (to === guardEvm) funded += value;
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const rc = await send(principal, REG, regAbi, "commit", [agentEvm.account.address, keccak256(toHex("Lancea autopilot: $40 across XRPL and Flare")), Z, 0n, 40_000_000n,
    now - 60n, now + 86_400n, { sourceId: b32("SUMMA"), assetKey: b32("USD/1e6"), agentRef: Z, bond: SUMMA_VAULT }]);
  umbrella = BigInt(rc.logs.find((l: any) => l.address.toLowerCase() === REG.toLowerCase())!.topics[1]!);
  run.umbrella = umbrella.toString(); save();
  await send(agentEvm, REG, regAbi, "acknowledge", [umbrella]);
  await send(principal, meter, meterAbi, "declareEffector", [umbrella, guardEvm]);
  await send(principal, meter, meterAbi, "setTripwire", [umbrella, 1n]);
  log(`   meter ${meter} | umbrella #${umbrella} ($40) | guard's Flare key ${guardEvm} is its effector (${C2(guardFund)}) | tripwire 1`);
}, true);

// ------------------------------------------------------------------ 1. XRPL: the guarded account
const xrpl = new XrplHttp(process.env.XRPL_RPC?.split(","));
xrpl.onRetry = (note) => log(`   xrpl: ${note}`);
let acct!: { address: string; seed: string }, K!: Wallet, guard!: Guard, venue!: Venue, strategy!: Strategy;
let pa!: Address, fxrp!: Address, vault!: Address, vaultId!: number;
await stage("1. XRPL: the guarded account", async () => {
  const [P, G] = [Wallet.generate(), Wallet.generate()]; // principal, guard; K is the agent
  K = Wallet.generate();
  run.xrpl = { principal: P.seed!, agent: K.seed!, guard: G.seed! }; save();
  acct = await xrpl.fund();
  run.xrpl = { ...run.xrpl, account: acct.address, seed: acct.seed }; save();
  const master = Wallet.fromSeed(acct.seed);
  const sl = await xrpl.autofill<SignerListSet>({ TransactionType: "SignerListSet", Account: acct.address, SignerQuorum: 2, SignerEntries: [
    { SignerEntry: { Account: P.address, SignerWeight: 2 } }, { SignerEntry: { Account: K.address, SignerWeight: 1 } },
    { SignerEntry: { Account: G.address, SignerWeight: 1 } }] });
  const set = await xrpl.submitAndWait(master.sign(sl).tx_blob);
  if (set.result !== "tesSUCCESS") throw new Error(`SignerListSet: ${set.result}`);
  const off = await xrpl.submitAndWait(master.sign(await xrpl.autofill<AccountSet>({ TransactionType: "AccountSet", Account: acct.address, SetFlag: 4 })).tx_blob);
  if (off.result !== "tesSUCCESS") throw new Error(`disable master: ${off.result}`);

  const [operator] = await call<string[]>(MAC, "getXrplProviderWallets");
  const fee = await call<bigint>(MAC, "getDefaultInstructionFee");
  const coreVault = await call<string>(AM, "directMintingPaymentAddress");
  fxrp = await call<Address>(AM, "fAsset");
  const [ids, addrs, types] = await call<[bigint[], Address[], number[]]>(MAC, "getVaults");
  const fi = types.findIndex((t) => t === 1);
  vaultId = Number(ids[fi]); vault = addrs[fi];
  pa = await call<Address>(MAC, "getPersonalAccount", [acct.address]);
  log(`   ${acct.address} → personal account ${pa} | Firelight vault ${vaultId} ${vault}`);
  guard = new Guard({ account: acct.address, guardSeed: G.seed!, flareKey: guardKey, chain, rpcUrl: RPC, meter, umbrellaId: umbrella, xrplSource: "testXRP",
    smartAccounts: { operators: [operator], coreVault, policy: { vaults: [vaultId], personalAccount: pa } }, strikeOnPolicy: true }, xrpl);
  venue = { account: acct.address, operator, fee, coreVault, personalAccount: pa };
  strategy = { vaultId, keepDrops: 70_000_000n, maxMintDrops: 20_000_000n, minMintDrops: 5_000_000n };
}, true);

const state = async (): Promise<State> => {
  const info = await xrpl.rpc("account_info", { account: acct.address, ledger_index: "validated" });
  return { xrpDrops: BigInt(info.account_data.Balance) - 2_000_000n, fxrp: await call<bigint>(fxrp, "balanceOf", [pa]),
    shares: { [vaultId]: await call<bigint>(vault, "balanceOf", [pa]) } };
};

/** The agent signs its proposal; the guard alone decides whether it becomes a transaction. */
async function propose(label: string, tx: Payment, designed: "co-signed" | "refused"): Promise<Decision> {
  await topUp();
  const filled = await xrpl.autofill<Payment>(tx, 2);
  const d = await guard.cosign(K.sign(filled, true).tx_blob);
  results[label] = d;
  if ((d.signed ? "co-signed" : "refused") !== designed) verdicts.push(`${label}: designed ${designed}, was ${d.signed ? "co-signed" : `refused (${d.reason})`}`);
  log(`   ${label}: ${d.signed ? `CO-SIGNED ${d.hash}` : `REFUSED — ${d.reason}${d.struck ? ` | struck ${d.struck}` : ""}`}`);
  log(`      ${await meterState().catch((e) => `meter unreadable: ${short(e)}`)}`);
  return d;
}
async function until(what: string, test: () => Promise<boolean>, minutes = 15) {
  if (FORK) { log(`   (${what}: not awaited on a fork)`); return false; }
  for (let i = 0; i < minutes * 6; i++) { if (await test().catch(() => false)) return true; await sleep(10_000); }
  log(`   (${what}: not within ${minutes} min)`); return false;
}
/** On a fork, Coston2's executor does not act: do what it would have done, so the steps after it see the
 *  same state as live. FXRP (the mint less about 1 % in fees) comes from the Firelight vault's holdings. */
async function forkExecutorMint(drops: bigint) {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  const amount = (drops * 99n) / 100n;
  await t.impersonateAccount({ address: vault });
  await t.setBalance({ address: vault, value: parseEther("10") });
  const w = createWalletClient({ account: vault, chain, transport: http(RPC) });
  await pc.waitForTransactionReceipt({ hash: await w.writeContract({ address: fxrp, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [pa, amount] }) });
  await t.stopImpersonatingAccount({ address: vault });
  log(`   (fork: acting as Coston2's executor, ${Number(amount) / 1e6} FXRP to the personal account)`);
}

// ------------------------------------------------------------------ 2–7
try {
  await stage("2. autopilot: mint", async () => {
    const step = plan(await state(), strategy);
    if (step?.kind !== "mint") throw new Error(`expected a mint, planned ${json(step)}`);
    if ((await propose("2. mint 20 XRP to own personal account", toPayment(step, venue), "co-signed")).signed) {
      if (FORK) await forkExecutorMint(step.drops);
      else await until("direct mint", async () => (await call<bigint>(fxrp, "balanceOf", [pa])) > 0n);
    }
  });
  await stage("3. autopilot: deposit", async () => {
    const step = plan(await state(), strategy);
    if (step?.kind !== "deposit") { log(`   nothing to deposit (planned ${json(step)})`); return; }
    if ((await propose(`3. deposit ${Number(step.amount) / 1e6} FXRP into Firelight`, toPayment(step, venue), "co-signed")).signed) {
      await until("deposit", async () => (await call<bigint>(vault, "balanceOf", [pa])) > 0n);
    }
  });
  await stage("4. the agent, steered: mint to a stranger", async () => {
    await propose("4. mint 5 XRP to 0x…bEEF", toPayment({ kind: "mint", drops: 5_000_000n }, { ...venue, personalAccount: "0x000000000000000000000000000000000000bEEF" }), "refused");
  });
  // The guard does not read balances, so without shares (a fork) the same proposal is judged the same way.
  let redeem: ReturnType<typeof plan> = { kind: "redeem", shares: 1_000_000n, vaultId };
  await stage("5. autopilot: redeem 1 share", async () => {
    const planned = plan(await state(), { ...strategy, withdrawShares: 1_000_000n });
    if (planned?.kind === "redeem") redeem = planned;
    await propose("5. redeem 1 share (tripped)", toPayment(redeem!, venue), "refused");
  });
  await stage("6. the principal re-arms; the same redeem", async () => {
    await send(principal, meter, meterAbi, "rearm", [umbrella]);
    log(`      re-armed: ${await meterState()}`);
    const again = await propose("6. redeem 1 share (re-armed)", toPayment(redeem!, venue), "co-signed");
    if (again.signed) {
      const before = (await state()).shares[vaultId];
      await until("redeem request", async () => (await call<bigint>(vault, "balanceOf", [pa])) < before!, 5);
    }
  });
  await stage("7. autopilot: mint 20 XRP more", async () => {
    await propose("7. mint 20 XRP more (budget)", toPayment({ kind: "mint", drops: 20_000_000n }, venue), "refused");
  });
  if (!stopped) {
    const end = await state().catch(() => undefined);
    log(`== done: ${await meterState().catch(() => "?")}${end ? ` | XRP ${Number(end.xrpDrops) / 1e6} spendable | FXRP ${Number(end.fxrp) / 1e6} | stXRP ${Number(end.shares[vaultId]) / 1e6}` : ""}`);
  }
} catch (e) {
  failures.push(`the run: ${short(e)}`);
  log(`!! ${short(e)}`);
}
await finish(failures.length || verdicts.length || Object.keys(results).length < 6 ? 1 : 0);
