/**
 * XRP into a Firelight vault on Flare, from a guarded account, with the guard reading every step.
 *
 *   XRPL testnet   a fresh account, SignerList principal 2 / agent 1 / guard 1, master key off
 *   refused        the agent asks the Core Vault to mint to a stranger: the guard does not sign
 *   1. mint        agent + guard pay the Core Vault; the memo mints FXRP to the account's own
 *                  personal account on Flare (the only FAssets recipient the policy allows)
 *   refused        the agent asks to deposit into an Upshift vault the policy does not list
 *   2. deposit     agent + guard send the operator a Firelight deposit instruction (vault 1)
 *   Coston2        read-only: FXRP arrives, then stXRP shares
 *
 * Every verdict is Lancea's own (Guard.smartAccountVerdict). The dollar budget and the tripwire
 * are left out here: they need a Flare key for SummaMeter. Run: npx tsx scripts/sa-guarded-deposit.ts
 */
import { Wallet, multisign, type Payment, type SignerListSet, type AccountSet } from "xrpl";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { flareTestnet } from "viem/chains";
import { XrplHttp } from "../src/xrpl-http.js";
import { Guard, type SmartAccountsConfig } from "../src/guard.js";

const MAC = "0x434936d47503353f06750Db1A444DBDC5F0AD37c" as const; // MasterAccountController, Coston2
const AM = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA" as const; // AssetManagerFXRP, Coston2
const abi = parseAbi([
  "function getXrplProviderWallets() view returns (string[])",
  "function getDefaultInstructionFee() view returns (uint256)",
  "function getPersonalAccount(string) view returns (address)",
  "function getVaults() view returns (uint256[], address[], uint8[])",
  "function directMintingPaymentAddress() view returns (string)",
  "function fAsset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pc = createPublicClient({ chain: flareTestnet, transport: http("https://coston2-api.flare.network/ext/C/rpc") });
const read = <T>(address: Hex, functionName: string, args: unknown[] = []) =>
  pc.readContract({ address, abi, functionName: functionName as never, args: args as never }) as Promise<T>;
const x = new XrplHttp();

const [operator] = await read<string[]>(MAC, "getXrplProviderWallets");
const fee = await read<bigint>(MAC, "getDefaultInstructionFee");
const coreVault = await read<string>(AM, "directMintingPaymentAddress");
const fxrp = await read<Hex>(AM, "fAsset");
const [ids, addrs, types] = await read<[bigint[], Hex[], number[]]>(MAC, "getVaults");
const firelight = ids.findIndex((id, i) => types[i] === 1);
const vaultId = Number(ids[firelight]), vault = addrs[firelight];
log("operator", operator, "| core vault", coreVault, "| firelight vault", vaultId, vault);

const acct = await x.fund();
const master = Wallet.fromSeed(acct.seed);
const [principal, agent, guard] = [Wallet.generate(), Wallet.generate(), Wallet.generate()];
const sl = await x.autofill<SignerListSet>({ TransactionType: "SignerListSet", Account: acct.address, SignerQuorum: 2, SignerEntries: [
  { SignerEntry: { Account: principal.address, SignerWeight: 2 } },
  { SignerEntry: { Account: agent.address, SignerWeight: 1 } },
  { SignerEntry: { Account: guard.address, SignerWeight: 1 } }] });
log("SignerListSet", (await x.submitAndWait(master.sign(sl).tx_blob)).result);
log("master key off", (await x.submitAndWait(master.sign(await x.autofill<AccountSet>({ TransactionType: "AccountSet", Account: acct.address, SetFlag: 4 })).tx_blob)).result);

const pa = await read<Hex>(MAC, "getPersonalAccount", [acct.address]);
log("guarded account", acct.address, "→ personal account", pa);
const sa: SmartAccountsConfig = { operators: [operator], coreVault, policy: { vaults: [vaultId], personalAccount: pa } };

/** The agent proposes, the guard judges with Lancea's own verdict, and only then co-signs. */
async function propose(label: string, tx: Payment): Promise<string | undefined> {
  const filled = await x.autofill<Payment>(tx, 2);
  const why = Guard.smartAccountVerdict(filled, sa);
  if (why) { log(`${label}: REFUSED by the guard: ${why}`); return undefined; }
  const res = await x.submitAndWait(multisign([agent.sign(filled, true).tx_blob, guard.sign(filled, true).tx_blob]));
  log(`${label}: co-signed`, res.result, res.hash);
  return res.result === "tesSUCCESS" ? res.hash : undefined;
}
const recipientMemo = (to: string) => ("4642505266410018" + "00000000" + to.slice(2).toLowerCase()).toUpperCase();
const instruction = (id: number, value: bigint, vid: number) =>
  (id.toString(16).padStart(2, "0") + "00" + value.toString(16).padStart(20, "0") + "0000" + vid.toString(16).padStart(4, "0") + "00".repeat(16)).toUpperCase();

await propose("mint to a stranger", { TransactionType: "Payment", Account: acct.address, Destination: coreVault, Amount: "20000000",
  Memos: [{ Memo: { MemoData: recipientMemo("0x000000000000000000000000000000000000bEEF") } }] });
if (!(await propose("1. mint 20 XRP to own personal account", { TransactionType: "Payment", Account: acct.address, Destination: coreVault, Amount: "20000000",
  Memos: [{ Memo: { MemoData: recipientMemo(pa) } }] }))) process.exit(1);

let minted = 0n;
for (let i = 0; i < 90 && minted === 0n; i++) {
  await sleep(10_000);
  minted = await read<bigint>(fxrp, "balanceOf", [pa]);
  if (i % 6 === 5 && minted === 0n) log(`waiting for the direct mint… ${(i + 1) * 10}s`);
}
if (minted === 0n) { log("RESULT: the mint was not executed within 15 min"); process.exit(2); }
log("FXRP in the personal account:", Number(minted) / 1e6);

const upshift = ids.findIndex((_, i) => types[i] === 2);
await propose("deposit into an unlisted Upshift vault", { TransactionType: "Payment", Account: acct.address, Destination: operator, Amount: fee.toString(),
  Memos: [{ Memo: { MemoData: instruction(0x21, minted, Number(ids[upshift])) } }] });
const amount = (minted / 1_000_000n) * 1_000_000n; // whole FXRP
if (!(await propose(`2. deposit ${amount / 1_000_000n} FXRP into Firelight vault ${vaultId}`, { TransactionType: "Payment", Account: acct.address,
  Destination: operator, Amount: fee.toString(), Memos: [{ Memo: { MemoData: instruction(0x11, amount, vaultId) } }] }))) process.exit(1);

for (let i = 0; i < 90; i++) {
  await sleep(10_000);
  const shares = await read<bigint>(vault, "balanceOf", [pa]);
  if (shares > 0n) {
    log("stXRP shares held by the personal account:", Number(shares) / 1e6, "| FXRP left:", Number(await read<bigint>(fxrp, "balanceOf", [pa])) / 1e6);
    log("RESULT: XRP → FXRP → Firelight, every step co-signed by the guard; the two off-policy asks were never signed");
    process.exit(0);
  }
  if (i % 6 === 5) log(`waiting for the deposit… ${(i + 1) * 10}s`);
}
log("RESULT: the deposit did not land within 15 min");
process.exit(3);
