/**
 * Lancea MVP, live on XRPL testnet + Flare Coston2.
 *
 *   One agent spends on two chains under one DELICTI umbrella of $5:
 *     Flare  — 1 mUSDT0 through MandateFacilitator (x402)                    → tally ≈ $1
 *     XRPL   — 2 XRP, co-signed by the Lancea guard                          → tally ≈ $4.07
 *     XRPL   — 2 XRP more: the guard REFUSES (it would reach ≈ $7.1 > $5), because of what the
 *              agent already spent on BOTH chains
 *     XRPL   — the agent alone tries to submit it: tefBAD_QUORUM (weight 1 < quorum 2)
 *     XRPL   — the principal alone (weight 2) moves funds: recovery never depends on the guard
 *
 * Run:  PRIVATE_KEY=0x… npx tsx scripts/live.ts     (DELICTI_OUT = the delicti repo's forge `out/`)
 */
import { Wallet, multisign, type Payment, type Transaction } from "xrpl";
import { XrplHttp } from "../src/xrpl-http.js";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, keccak256, toHex, stringToHex, pad, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Guard } from "../src/guard.js";

const OUT = process.env.DELICTI_OUT ?? fileURLToPath(new URL("../../delicti/out/", import.meta.url));
const abi = (f: string, c: string) => JSON.parse(readFileSync(`${OUT}${f}/${c}.json`, "utf8")).abi;
const RPC = process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";
const A = {
  reg: "0x2c58fb0504377fef325DceB66219bC6302263AA3" as Address,
  railVault: "0xB15f5041F4aA2bc212832dfb0e59CD6c0e9a24aF" as Address,
  summa: "0x211EB7d798F528B4E66201496bE4Cf7f6A62f644" as Address,
  summaVault: "0x8Dd62BE6Ee0689e3Eb5960F08a5356a57bD2F354" as Address,
  meter: "0x6Bc63F3aBc6Fc3055DB9949bb4e14515321a4E0f" as Address,
  fac: "0xBC545E2610EAf68956684c56Dd308c1988f9307B" as Address,
  usdt0: "0x9Eea43feA502609d0D88DAfd1d64B4e929BF18C2" as Address,
};
const Z = `0x${"0".repeat(64)}` as Hex;
const b32 = (s: string) => pad(stringToHex(s), { dir: "right", size: 32 });
const chain = defineChain({ id: 114, name: "coston2", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC) });
const principal = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY as Hex), chain, transport: http(RPC) });
const evmAgent = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain, transport: http(RPC) });
const guardFlareKey = generatePrivateKey();
const guardFlare = privateKeyToAccount(guardFlareKey).address;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const regAbi = abi("MandateRegistry.sol", "MandateRegistry");
const vaultAbi = abi("Vault.sol", "Vault");
const summaAbi = abi("JudgeSumma.sol", "JudgeSumma");
const meterAbi = abi("SummaMeter.sol", "SummaMeter");
const facAbi = abi("MandateFacilitator.sol", "MandateFacilitator");
const tokenAbi = abi("MockUSDT0.sol", "MockUSDT0");

async function send(w: any, address: Address, abi_: any, functionName: string, args: unknown[] = [], value?: bigint) {
  const hash = await w.writeContract({ address, abi: abi_, functionName, args, value });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return rc;
}
const idOf = (rc: any) => BigInt(rc.logs.find((l: any) => l.address.toLowerCase() === A.reg.toLowerCase()).topics[1]);
const now = BigInt(Math.floor(Date.now() / 1000));
const usd = async (u: bigint) => `$${Number(await pc.readContract({ address: A.meter, abi: meterAbi, functionName: "spentUsd6", args: [u] })) / 1e6}`;

// ------------------------------------------------------------------ XRPL: the guarded account
const xrpl = new XrplHttp(process.env.XRPL_RPC?.split(","));
const single = async (w: Wallet, tx: Transaction) => xrpl.submitAndWait(w.sign(await xrpl.autofill(tx)).tx_blob);
log("== 1. XRPL testnet: the agent's account, locked behind a SignerList");
const acct = Wallet.fromSeed((await xrpl.fund()).seed);
const cp = Wallet.fromSeed((await xrpl.fund()).seed);
const P = Wallet.generate(), K = Wallet.generate(), G = Wallet.generate(); // principal, agent key, guard
await single(acct, {
  TransactionType: "SignerListSet", Account: acct.address, SignerQuorum: 2,
  SignerEntries: [
    { SignerEntry: { Account: P.address, SignerWeight: 2 } },
    { SignerEntry: { Account: K.address, SignerWeight: 1 } },
    { SignerEntry: { Account: G.address, SignerWeight: 1 } },
  ],
} as Transaction);
const off = await single(acct, { TransactionType: "AccountSet", Account: acct.address, SetFlag: 4 /* asfDisableMaster */ } as Transaction);
if (off.result !== "tesSUCCESS") throw new Error(`disable master: ${off.result}`);
log(`   account ${acct.address}: master key disabled; signers principal ${P.address} (2), agent ${K.address} (1), guard ${G.address} (1); quorum 2`);

// ------------------------------------------------------------------ Flare: the umbrella and the brake
log("== 2. Flare: a $5 umbrella over an x402 rail; the guard and the facilitator may keep its tally");
for (const to of [evmAgent.account.address, guardFlare]) {
  await pc.waitForTransactionReceipt({ hash: await principal.sendTransaction({ to, value: parseEther("0.5") }) });
}
const rail = idOf(await send(principal, A.reg, regAbi, "commit", [evmAgent.account.address, keccak256(toHex("x402 rail")), Z, 0n, 10_000_000n, now - 60n, now + 86400n,
  { sourceId: b32("testFLR"), assetKey: pad(A.usdt0, { size: 32 }), agentRef: Z, bond: A.railVault }]));
const umbrella = idOf(await send(principal, A.reg, regAbi, "commit", [evmAgent.account.address, keccak256(toHex(`Lancea umbrella: $5 across Flare and ${acct.address}`)), Z, 0n, 5_000_000n, now - 60n, now + 86400n,
  { sourceId: b32("SUMMA"), assetKey: b32("USD/1e6"), agentRef: Z, bond: A.summaVault }]));
await send(evmAgent, A.reg, regAbi, "declareExclusive", [rail]);
await send(evmAgent, A.reg, regAbi, "acknowledge", [umbrella]);
await send(principal, A.summaVault, vaultAbi, "post", [umbrella], parseEther("0.5"));
await send(evmAgent, A.summa, summaAbi, "link", [umbrella, rail]);
await send(principal, A.meter, meterAbi, "declareEffector", [umbrella, A.fac]);
await send(principal, A.meter, meterAbi, "declareEffector", [umbrella, guardFlare]);
await send(principal, A.usdt0, tokenAbi, "mint", [evmAgent.account.address, 1_000_000n]);
log(`   umbrella #${umbrella} ($5), rail #${rail}; effectors: facilitator ${A.fac}, guard ${guardFlare}`);

log("== 3. Flare: 1 mUSDT0 through the facilitator (x402)");
{
  const seller = "0x2222222222222222222222222222222222222222" as Address;
  const salt = toHex(randomBytes(32));
  const nonce = await pc.readContract({ address: A.fac, abi: facAbi, functionName: "payNonce", args: [seller, umbrella, rail, salt] }) as Hex;
  const validBefore = now + 3600n;
  const sig = await evmAgent.signTypedData({
    domain: { name: "Mock USDT0", version: "1", chainId: 114, verifyingContract: A.usdt0 },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: evmAgent.account.address, to: A.fac, value: 1_000_000n, validAfter: 0n, validBefore, nonce },
  });
  const rc = await send(principal, A.fac, facAbi, "settle", [umbrella, rail, seller,
    { value: 1_000_000n, validAfter: 0n, validBefore, salt, v: parseInt(sig.slice(130, 132), 16), r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}` }, 0]);
  log(`   settled ${rc.transactionHash}; umbrella tally ${await usd(umbrella)}`);
}

// ------------------------------------------------------------------ XRPL: the guard at work
const guard = new Guard({ account: acct.address, guardSeed: G.seed!, flareKey: guardFlareKey, chain, rpcUrl: RPC, meter: A.meter,
  umbrellaId: umbrella, xrplSource: "testXRP" }, xrpl);
async function agentSigns(drops: string) {
  const tx = await xrpl.autofill({ TransactionType: "Payment", Account: acct.address, Destination: cp.address, Amount: drops } as Payment, 2);
  return K.sign(tx, true).tx_blob;
}

log("== 4. XRPL: 2 XRP — the agent signs, the guard checks the umbrella and co-signs");
const d1 = await guard.cosign(await agentSigns("2000000"));
log(`   ${JSON.stringify(d1, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);

log("== 5. XRPL: 2 XRP more — past $5 across both chains");
const blob2 = await agentSigns("2000000");
const d2 = await guard.cosign(blob2);
log(`   ${JSON.stringify(d2, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);

log("== 6. the agent alone submits it anyway");
const alone = await xrpl.rpc("submit", { tx_blob: multisign([blob2]) }).catch((e: any) => ({ engine_result: e?.data?.error ?? e.message }));
log(`   engine_result: ${alone.engine_result}`);

log("== 7. the principal alone (weight 2): recovery never depends on the guard");
{
  const tx = await xrpl.autofill({ TransactionType: "Payment", Account: acct.address, Destination: cp.address, Amount: "1000000" } as Payment, 1);
  const r = await xrpl.submitAndWait(multisign([P.sign(tx, true).tx_blob]));
  log(`   ${r.hash}: ${r.result}`);
}
log(`== umbrella #${umbrella} tally ${await usd(umbrella)} of $5`);
