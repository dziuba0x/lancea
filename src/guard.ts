/**
 * Lancea's guard: a co-signer on the XRP Ledger that will not sign past a DELICTI budget.
 *
 * The agent's XRPL account holds the money, and its master key is disabled. Its SignerList:
 *
 *   principal  weight 2   ← can always act alone (recovery, revocation)
 *   agent key  weight 1   ┐ quorum 2: the agent needs the guard,
 *   guard key  weight 1   ┘ the guard needs the agent
 *
 * Before it co-signs, the guard asks DELICTI's SummaMeter on Flare whether this payment would take
 * the umbrella past its dollar budget. That budget counts every rail the agent spends on, so a
 * payment on the XRP Ledger can be refused because of what the agent already spent on Flare. If
 * the answer is no, the guard first writes the payment into the tally (`note`: the reservation, an
 * efference copy made before the act), then signs, combines and submits.
 *
 * What the guard can do: refuse. What it cannot do: move funds. Weight 1 < quorum 2, so its key alone
 * signs nothing valid. That makes the failure mode liveness, never theft, and the principal can
 * always act alone.
 */
import { Wallet, multisign, decode, type Payment } from "xrpl";
import { XrplHttp } from "./xrpl-http.js";
import { createPublicClient, createWalletClient, http, type Address, type Hex, type Chain, stringToHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const summaMeterAbi = [
  { type: "function", name: "wouldExceed", stateMutability: "nonpayable",
    inputs: [{ name: "umbrellaId", type: "uint256" }, { name: "sourceId", type: "bytes32" }, { name: "assetKey", type: "bytes32" },
      { name: "amount", type: "uint256" }, { name: "slackBps", type: "uint16" }],
    outputs: [{ type: "bool" }, { name: "usd6", type: "uint256" }] },
  { type: "function", name: "note", stateMutability: "nonpayable",
    inputs: [{ name: "umbrellaId", type: "uint256" }, { name: "sourceId", type: "bytes32" }, { name: "assetKey", type: "bytes32" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "usd6", type: "uint256" }] },
  { type: "function", name: "spentUsd6", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const b32 = (s: string) => pad(stringToHex(s), { dir: "right", size: 32 });

export interface GuardConfig {
  /** The agent's XRPL account: holds the funds, master key disabled, this guard in its SignerList. */
  account: string;
  /** The guard's XRPL signing key (a SignerList entry of weight 1). */
  guardSeed: string;
  /** The guard's Flare key: a declared effector on SummaMeter for this umbrella. */
  flareKey: Hex;
  chain: Chain;
  rpcUrl: string;
  meter: Address;
  umbrellaId: bigint;
  /** FDC source of the XRPL rail: "testXRP" on testnet, "XRP" on mainnet. */
  xrplSource: string;
  /** Brake this many basis points before the budget: the live price read now vs the anchor price a verdict uses. */
  slackBps?: number;
}

export type Decision =
  | { signed: true; hash: string; usd6: bigint; reservation: Hex; tallyUsd6: bigint }
  | { signed: false; reason: string; usd6?: bigint };

export class Guard {
  readonly wallet: Wallet;
  private readonly pc;
  private readonly fw;

  constructor(private readonly cfg: GuardConfig, private readonly xrpl: XrplHttp) {
    this.wallet = Wallet.fromSeed(cfg.guardSeed);
    this.pc = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    this.fw = createWalletClient({ account: privateKeyToAccount(cfg.flareKey), chain: cfg.chain, transport: http(cfg.rpcUrl) });
  }

  /** What a payment takes out of the account, in drops: Amount + Fee (gross outflow, SPEC §6.10). */
  static outflow(tx: Payment): bigint {
    if (typeof tx.Amount !== "string") throw new Error("MVP: XRP payments only (issued currencies are outside DELICTI's sight)");
    return BigInt(tx.Amount) + BigInt(tx.Fee ?? "0");
  }

  /**
   * Co-sign a payment the agent has already multisigned (`agentBlob`), or refuse it.
   * Order: check → reserve on Flare → sign → combine → submit. A reservation for a payment that
   * then fails on XRPL over-counts, which is the safe direction for a brake.
   */
  async cosign(agentBlob: string): Promise<Decision> {
    const tx = decode(agentBlob) as unknown as Payment;
    if (tx.TransactionType !== "Payment") return { signed: false, reason: `MVP co-signs Payments only, not ${tx.TransactionType}` };
    if (tx.Account !== this.cfg.account) return { signed: false, reason: `not the guarded account: ${tx.Account}` };
    let drops: bigint;
    try { drops = Guard.outflow(tx); } catch (e) { return { signed: false, reason: (e as Error).message }; }

    const args = [this.cfg.umbrellaId, b32(this.cfg.xrplSource), b32("XRP/outflow"), drops] as const;
    const { result } = await this.pc.simulateContract({
      account: this.fw.account, address: this.cfg.meter, abi: summaMeterAbi, functionName: "wouldExceed",
      args: [...args, this.cfg.slackBps ?? 0],
    });
    const [stop, usd6] = result as readonly [boolean, bigint];
    if (stop) return { signed: false, reason: "SummaMeter: the umbrella's dollar budget would be crossed", usd6 };

    // the reservation: written on Flare BEFORE the signature exists
    const reservation = await this.fw.writeContract({ address: this.cfg.meter, abi: summaMeterAbi, functionName: "note", args: [...args] });
    const rc = await this.pc.waitForTransactionReceipt({ hash: reservation });
    if (rc.status !== "success") return { signed: false, reason: `reservation reverted ${reservation}` };

    // sign the transaction itself, not the agent's signature over it
    const { Signers: _theirs, TxnSignature: _none, ...unsigned } = tx as Payment & { Signers?: unknown; TxnSignature?: unknown };
    const mine = this.wallet.sign(unsigned as Payment, true).tx_blob;
    const combined = multisign([agentBlob, mine]);
    const sub = await this.xrpl.submitAndWait(combined);
    if (sub.result !== "tesSUCCESS") return { signed: false, reason: `XRPL: ${sub.result}`, usd6 };
    const tallyUsd6 = (await this.pc.readContract({ address: this.cfg.meter, abi: summaMeterAbi, functionName: "spentUsd6", args: [this.cfg.umbrellaId] })) as bigint;
    return { signed: true, hash: sub.hash, usd6, reservation, tallyUsd6 };
  }
}
