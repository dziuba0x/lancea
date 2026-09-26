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
 *
 * A refusal is also reported (DELICTI amendment v1.2, the tripwire). When the payment breaks the
 * budget even against the tally of ten minutes ago, at 99 % of its value, it was an attempt and not
 * a lost race, and the guard strikes the umbrella in SummaMeter. Once the principal's tripwire is
 * reached, `wouldExceed` answers yes on every rail: the x402 facilitator on Flare stops too.
 */
import { Wallet, multisign, decode, type Payment } from "xrpl";
import { XrplHttp } from "./xrpl-http.js";
import { createPublicClient, createWalletClient, http, keccak256, type Address, type Hex, type Chain, stringToHex, pad } from "viem";
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
  { type: "function", name: "spentAt", stateMutability: "view", inputs: [{ name: "umbrellaId", type: "uint256" }, { name: "ts", type: "uint64" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  // amendment v1.2: the tripwire (absent from meters deployed before it)
  { type: "function", name: "tripped", stateMutability: "view", inputs: [{ name: "umbrellaId", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "strike", stateMutability: "nonpayable",
    inputs: [{ name: "umbrellaId", type: "uint256" }, { name: "evidence", type: "bytes32" }], outputs: [{ name: "isTripped", type: "bool" }] },
] as const;

export const registryAbi = [
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "principal", type: "address" }, { name: "agent", type: "address" }, { name: "mandateHash", type: "bytes32" },
      { name: "authorityRef", type: "bytes32" }, { name: "parentId", type: "uint256" }, { name: "budget", type: "uint256" },
      { name: "validFrom", type: "uint64" }, { name: "validUntil", type: "uint64" }, { name: "revoked", type: "bool" },
      { name: "sourceId", type: "bytes32" }, { name: "assetKey", type: "bytes32" }, { name: "agentRef", type: "bytes32" },
      { name: "bond", type: "address" }] }] },
] as const;

/** How far back the tally is read when judging a refusal: x402's own window for an authorisation. */
export const LOOKBACK_S = 600n;
/** A refused payment is counted at 99 % of its live value, as DELICTI's facilitator counts one. */
export const PRICE_MARGIN_BPS = 100n;

/**
 * The same test DELICTI's facilitator applies before it records an attempt (amendment v1.2, C.1):
 * the payment breaks the budget against the tally as it stood ten minutes ago. A payment that only
 * breaks it because something else was spent in the meantime lost a race; that is not an attempt.
 */
export function isAttempt(spentBeforeUsd6: bigint, usd6: bigint, budgetUsd6: bigint): boolean {
  return spentBeforeUsd6 + usd6 - (usd6 * PRICE_MARGIN_BPS) / 10_000n > budgetUsd6;
}

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
  /** Strike the umbrella's tripwire when a refusal is an attempt (default true; needs a v1.2 meter). */
  strike?: boolean;
}

export type Decision =
  | { signed: true; hash: string; usd6: bigint; reservation: Hex; tallyUsd6: bigint }
  | { signed: false; reason: string; usd6?: bigint; struck?: Hex };

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
    if (stop) return { signed: false, usd6, ...(await this.refuse(agentBlob, usd6)) };

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

  /**
   * Why the meter said no, and whether that no was an attempt worth a strike. Nothing is struck when
   * the umbrella is already tripped (the refusal is the trip itself), when the payment only lost a
   * race, or when the meter predates the tripwire.
   */
  private async refuse(agentBlob: string, usd6: bigint): Promise<{ reason: string; struck?: Hex }> {
    const budgetSays = "SummaMeter: the umbrella's dollar budget would be crossed";
    const { meter, umbrellaId } = this.cfg;
    let tripped: boolean;
    try {
      tripped = (await this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "tripped", args: [umbrellaId] })) as boolean;
    } catch {
      return { reason: budgetSays }; // a meter from before amendment v1.2
    }
    if (tripped) return { reason: "SummaMeter: the umbrella is tripped; its principal must re-arm it" };
    if (this.cfg.strike === false) return { reason: budgetSays };

    const registry = (await this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "registry" })) as Address;
    const m = await this.pc.readContract({ address: registry, abi: registryAbi, functionName: "get", args: [umbrellaId] });
    const now = (await this.pc.getBlock()).timestamp;
    const before = (await this.pc.readContract({
      address: meter, abi: summaMeterAbi, functionName: "spentAt", args: [umbrellaId, now - LOOKBACK_S],
    })) as bigint;
    if (!isAttempt(before, usd6, m.budget)) return { reason: `${budgetSays} (a lost race, not an attempt)` };

    const struck = await this.fw.writeContract({
      address: meter, abi: summaMeterAbi, functionName: "strike", args: [umbrellaId, keccak256(`0x${agentBlob}`)],
    });
    await this.pc.waitForTransactionReceipt({ hash: struck });
    return { reason: `${budgetSays}; struck as an attempt`, struck };
  }
}
