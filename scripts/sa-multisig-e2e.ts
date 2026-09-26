/**
 * Does a Lancea-guarded (multi-signed) XRPL account drive a Flare Smart Account?
 *
 * 1. XRPL testnet: a fresh account with SignerList principal 2 / agent 1 / guard 1, quorum 2, and
 *    the master key disabled. That is Lancea's account shape.
 * 2. The agent's signature alone sends an instruction to the operator: tefBAD_QUORUM.
 * 3. Agent + guard co-sign the same instruction (FXRP transfer of 0 to 0x…dEaD, the one instruction
 *    that needs no balance). It is submitted.
 * 4. Coston2, read-only: wait for the operator to prove the payment with the FDC and call the
 *    controller for our account. Measured 2026-09-26: relayed in ~86 s, reverted ValueZero() —
 *    the controller checked the instruction itself, for the multi-signed owner. A zero transfer is
 *    the only instruction that needs no balance, so a full success needs FXRP minted first.
 *
 * No Flare key and no gas: the operator relays. Run: npx tsx scripts/sa-multisig-e2e.ts
 */
import { Wallet, multisign, type Payment, type SignerListSet, type AccountSet } from "xrpl";
import { createPublicClient, http, parseAbi } from "viem";
import { flareTestnet } from "viem/chains";
import { XrplHttp } from "../src/xrpl-http.js";

const COSTON2 = "https://coston2-api.flare.network/ext/C/rpc";
const MAC = "0x434936d47503353f06750Db1A444DBDC5F0AD37c" as const; // FlareContractRegistry → MasterAccountController
const abi = parseAbi([
  "function getXrplProviderWallets() view returns (string[])",
  "function getDefaultInstructionFee() view returns (uint256)",
  "function getPersonalAccount(string) view returns (address)",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const pc = createPublicClient({ chain: flareTestnet, transport: http(COSTON2) });
const x = new XrplHttp();

const [operator] = (await pc.readContract({ address: MAC, abi, functionName: "getXrplProviderWallets" })) as string[];
const fee = (await pc.readContract({ address: MAC, abi, functionName: "getDefaultInstructionFee" })) as bigint;
log("operator", operator, "instruction fee (drops)", fee);

const acct = await x.fund();
const master = Wallet.fromSeed(acct.seed);
const [principal, agent, guard] = [Wallet.generate(), Wallet.generate(), Wallet.generate()];
log("guarded account", acct.address);

const sl = await x.autofill<SignerListSet>({
  TransactionType: "SignerListSet", Account: acct.address, SignerQuorum: 2,
  SignerEntries: [
    { SignerEntry: { Account: principal.address, SignerWeight: 2 } },
    { SignerEntry: { Account: agent.address, SignerWeight: 1 } },
    { SignerEntry: { Account: guard.address, SignerWeight: 1 } },
  ],
});
log("SignerListSet", (await x.submitAndWait(master.sign(sl).tx_blob)).result);
const off = await x.autofill<AccountSet>({ TransactionType: "AccountSet", Account: acct.address, SetFlag: 4 }); // asfDisableMaster
log("master key disabled", (await x.submitAndWait(master.sign(off).tx_blob)).result);

// FXRP transfer (0x01), wallet 0, value 0, recipient 0x…dEaD: 32 bytes, the payment reference
const reference = ("01" + "00" + "00".repeat(10) + "000000000000000000000000000000000000dead").toUpperCase();
const pay = await x.autofill<Payment>(
  { TransactionType: "Payment", Account: acct.address, Destination: operator, Amount: fee.toString(), Memos: [{ Memo: { MemoData: reference } }] },
  2,
);
const byAgent = agent.sign(pay, true).tx_blob;
log("agent alone", (await x.rpc("submit", { tx_blob: multisign([byAgent]) })).engine_result);
const sub = await x.submitAndWait(multisign([byAgent, guard.sign(pay, true).tx_blob]));
log("agent + guard", sub.result, sub.hash);
if (sub.result !== "tesSUCCESS") process.exit(1);

const pa = (await pc.readContract({ address: MAC, abi, functionName: "getPersonalAccount", args: [acct.address] })) as `0x${string}`;
log("personal account (deterministic)", pa);

// The operator's call is a top-level transaction to the controller. Find the one that names our
// XRPL account (Coston2 explorer API), then report what the controller did with it.
const EXPLORER = "https://coston2-explorer.flare.network/api/v2";
for (let i = 0; i < 90; i++) {
  await sleep(10_000);
  const list = await (await fetch(`${EXPLORER}/addresses/${MAC}/transactions?filter=to`)).json();
  for (const t of list.items ?? []) {
    const params = t.decoded_input?.parameters ?? [];
    if (!params.some((p: { name: string; value: unknown }) => p.name === "_xrplAddress" && p.value === acct.address)) continue;
    const d = await (await fetch(`${EXPLORER}/transactions/${t.hash}`)).json();
    log("operator called", d.decoded_input?.method_call?.split("(")[0], "tx", t.hash, "status", d.status);
    if (d.status === "ok") {
      const code = await pc.getCode({ address: pa });
      log("RESULT: a multi-signed XRPL account drove its Flare smart account; code at", pa, code && code !== "0x" ? "deployed" : "missing");
    } else {
      log("RESULT: relayed and proven; the controller reverted with", d.revert_reason?.method_call ?? d.result);
      log("        (with value 0 this is expected: ValueZero means the instruction itself was checked for our account)");
    }
    process.exit(0);
  }
  if (i % 6 === 5) log(`waiting for the operator… ${(i + 1) * 10}s`);
}
log("RESULT: the operator did not relay within 15 min");
process.exit(2);
