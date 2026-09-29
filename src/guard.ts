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
 *
 * Flare Smart Accounts: an XRPL Payment to the operator or the FAssets Core Vault acts on Flare,
 * authorised by the XRPL signature alone. The guard reads what it would do there and applies the
 * principal's ActionPolicy (src/smart-accounts.ts), so one co-signer covers both ledgers.
 *
 * Failing closed. Every read and write on Flare can fail: a node is down, the guard's key has run
 * out of gas. A failure is a refusal, never a signature and never a crash. No reservation, no
 * signature. A strike that does not land is kept, and the guard signs nothing until it lands (or
 * the umbrella trips anyway). The failure mode stays liveness.
 */
import { Wallet, multisign, decode, type Payment } from "xrpl";
import { XrplHttp } from "./xrpl-http.js";
import { createPublicClient, createWalletClient, http, keccak256, type Address, type Hex, type Chain, stringToHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Policy, HOUR_S, DEFAULT_COOLING_S, RIPPLE_EPOCH, dayStart, overDailyCap, overHourlyCap, payeeHistory, isNewPayee, overNewPayeeCap } from "./policy.js";
import { type ActionPolicy, decodeReference, decodeMint, judge } from "./smart-accounts.js";

/** Where a guarded account meets Flare Smart Accounts (src/smart-accounts.ts). */
export interface SmartAccountsConfig {
  /** Operator XRPL wallets: MasterAccountController.getXrplProviderWallets(). */
  operators: string[];
  /** The FAssets Core Vault's XRPL address: AssetManager.directMintingPaymentAddress(). */
  coreVault: string;
  policy: ActionPolicy;
}

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

/** A node's error in one line: viem's short message and the node's own words when they differ. */
export function short(e: unknown): string {
  const x = e as { shortMessage?: string; details?: string; message?: string } | undefined;
  const head = x?.shortMessage ?? x?.message ?? String(e);
  const tail = x?.details && !head.includes(x.details) ? ` (${x.details})` : "";
  return `${head}${tail}`.split("\n")[0].slice(0, 240);
}

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
  /** Lancea's own rules on top of the budget: an hourly cap across rails, and new-payee cooling (src/policy.ts). */
  policy?: Policy;
  /** The most a transaction may burn in fees, in drops (default 10 000 = 0.01 XRP). A fee is outflow too:
   *  an agent could otherwise spend its budget on nothing. */
  maxFeeDrops?: bigint;
  /** Lancea's daily cap: at most this many µUSD per UTC day across every rail. Crossing it is a refusal, never a
   *  strike: an allowance used up is not an attack (the agent checks it before it asks). */
  dailyCapUsd6?: bigint;
  /** Also strike when a payment breaks `policy` or `smartAccounts.policy` (default false: the principal opts in). */
  strikeOnPolicy?: boolean;
  /** What the account may do on Flare through its smart account. Without it, payments to the
   *  operator or the Core Vault are ordinary payments to strangers. */
  smartAccounts?: SmartAccountsConfig;
}

export type Decision =
  | { signed: true; hash: string; usd6: bigint; reservation: Hex; tallyUsd6?: bigint }
  | { signed: false; reason: string; usd6?: bigint; struck?: Hex };

export class Guard {
  readonly wallet: Wallet;
  /** Every payment this guard co-signed, as account_tx rows: the payee rule does not depend on a node's history depth. */
  private readonly cosigned: any[] = [];
  /** A strike that did not land: the agent's blob, and the transaction if one was sent. It blocks every signature. */
  private pending?: { blob: string; hash?: Hex };
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
  async cosign(agentBlob: string, userOp?: Hex): Promise<Decision> {
    // A strike that did not land goes first: nothing is signed past an attempt the meter has not heard of.
    if (this.pending) {
      const still = await this.landPending();
      if (still) return { signed: false, reason: still };
    }
    const tx = decode(agentBlob) as unknown as Payment;
    if (tx.TransactionType !== "Payment") return { signed: false, reason: `MVP co-signs Payments only, not ${tx.TransactionType}` };
    if (tx.Account !== this.cfg.account) return { signed: false, reason: `not the guarded account: ${tx.Account}` };
    const maxFee = this.cfg.maxFeeDrops ?? 10_000n;
    if (BigInt(tx.Fee ?? "0") > maxFee) return { signed: false, reason: `fee ${tx.Fee} drops is above the ${maxFee}-drop cap` };
    const sa = this.cfg.smartAccounts;
    if (sa && Guard.isSmartAccountPayment(tx, sa)) {
      const why = Guard.smartAccountVerdict(tx, sa, userOp);
      if (why) return this.policyRefusal(agentBlob, `smart account: ${why}`);
    }
    let drops: bigint;
    try { drops = Guard.outflow(tx); } catch (e) { return { signed: false, reason: (e as Error).message }; }

    const args = [this.cfg.umbrellaId, b32(this.cfg.xrplSource), b32("XRP/outflow"), drops] as const;
    let stop: boolean, usd6: bigint;
    try {
      const { result } = await this.pc.simulateContract({
        account: this.fw.account, address: this.cfg.meter, abi: summaMeterAbi, functionName: "wouldExceed",
        args: [...args, this.cfg.slackBps ?? 0],
      });
      [stop, usd6] = result as readonly [boolean, bigint];
    } catch (e) {
      return { signed: false, reason: `SummaMeter unreadable, nothing signed: ${short(e)}` };
    }
    if (stop) return this.refuse(agentBlob, usd6);

    if (this.cfg.dailyCapUsd6 !== undefined) {
      let over: string | undefined;
      try { over = await this.overDaily(usd6, this.cfg.dailyCapUsd6); } catch (e) {
        return { signed: false, usd6, reason: `the daily cap is unreadable, nothing signed: ${short(e)}` };
      }
      if (over) return { signed: false, usd6, reason: over };
    }

    let broken: string | undefined;
    try { broken = await this.checkPolicy(tx, drops, usd6); } catch (e) {
      return { signed: false, usd6, reason: `policy unreadable, nothing signed: ${short(e)}` };
    }
    if (broken) return this.policyRefusal(agentBlob, broken, usd6);

    // the reservation: written on Flare BEFORE the signature exists. No reservation, no signature.
    const r = await this.write("note", () => this.fw.writeContract({ address: this.cfg.meter, abi: summaMeterAbi, functionName: "note", args: [...args] }));
    if (!r.ok) return { signed: false, usd6, reason: `reservation failed, nothing signed: ${r.error}` };
    const reservation = r.hash;

    // sign the transaction itself, not the agent's signature over it
    const { Signers: _theirs, TxnSignature: _none, ...unsigned } = tx as Payment & { Signers?: unknown; TxnSignature?: unknown };
    const mine = this.wallet.sign(unsigned as Payment, true).tx_blob;
    const combined = multisign([agentBlob, mine]);
    let sub: { hash: string; result: string };
    try { sub = await this.xrpl.submitAndWait(combined); } catch (e) {
      return { signed: false, usd6, reason: `XRPL: ${short(e)} (the reservation stands: an over-count, the safe side)` };
    }
    if (sub.result !== "tesSUCCESS") return { signed: false, reason: `XRPL: ${sub.result}`, usd6 };
    this.cosigned.push({
      hash: sub.hash,
      tx: { TransactionType: "Payment", Account: tx.Account, Destination: tx.Destination, Amount: tx.Amount,
        date: Number(BigInt(Math.floor(Date.now() / 1000)) - RIPPLE_EPOCH) },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: tx.Amount },
    });
    const tallyUsd6 = await this.pc.readContract({ address: this.cfg.meter, abi: summaMeterAbi, functionName: "spentUsd6", args: [this.cfg.umbrellaId] })
      .then((t) => t as bigint, () => undefined); // informative only: the payment is done either way
    return { signed: true, hash: sub.hash, usd6, reservation, tallyUsd6 };
  }

  /**
   * Why the meter said no, and whether that no was an attempt worth a strike. Nothing is struck when
   * the umbrella is already tripped (the refusal is the trip itself), when the payment only lost a
   * race, when the earlier tally cannot be read (a strike accuses), or when the meter predates the tripwire.
   */
  private async refuse(agentBlob: string, usd6: bigint): Promise<Decision> {
    const budgetSays = "SummaMeter: the umbrella's dollar budget would be crossed";
    const no = (reason: string): Decision => ({ signed: false, usd6, reason });
    const tripped = await this.tripped();
    if (tripped === undefined) return no(budgetSays); // a meter from before amendment v1.2
    if (tripped) return no("SummaMeter: the umbrella is tripped; its principal must re-arm it");
    if (this.cfg.strike === false) return no(budgetSays);
    let attempt: boolean;
    try { attempt = await this.wasAttempt(usd6); } catch (e) {
      return no(`${budgetSays} (the earlier tally is unreadable, so no strike: ${short(e)})`);
    }
    if (!attempt) return no(`${budgetSays} (not an attempt: against the tally of ten minutes ago it fits)`);
    return this.struckRefusal(agentBlob, `${budgetSays}; struck as an attempt`, usd6);
  }

  /** Amendment v1.2, C.1: the payment breaks the budget against the tally of ten minutes ago. */
  private async wasAttempt(usd6: bigint): Promise<boolean> {
    const { meter, umbrellaId } = this.cfg;
    const registry = (await this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "registry" })) as Address;
    const m = await this.pc.readContract({ address: registry, abi: registryAbi, functionName: "get", args: [umbrellaId] });
    const now = (await this.pc.getBlock()).timestamp;
    const before = (await this.pc.readContract({
      address: meter, abi: summaMeterAbi, functionName: "spentAt", args: [umbrellaId, now - LOOKBACK_S],
    })) as bigint;
    return isAttempt(before, usd6, m.budget);
  }

  /** A refusal under the principal's rules. It strikes only when the principal opted in (strikeOnPolicy). */
  private async policyRefusal(agentBlob: string, reason: string, usd6?: bigint): Promise<Decision> {
    if (!this.cfg.strikeOnPolicy || (await this.tripped()) !== false) return { signed: false, reason, usd6 };
    return this.struckRefusal(agentBlob, reason, usd6);
  }

  /** A refusal that strikes. A strike that does not land is kept, and blocks every signature until it lands. */
  private async struckRefusal(agentBlob: string, reason: string, usd6?: bigint): Promise<Decision> {
    const s = await this.strike(agentBlob);
    return s.struck
      ? { signed: false, reason, usd6, struck: s.struck }
      : { signed: false, reason: `${reason}; the strike did not land (${s.error}), so nothing is signed until it does`, usd6 };
  }

  static isSmartAccountPayment(tx: Payment, sa: SmartAccountsConfig): boolean {
    return sa.operators.includes(tx.Destination) || tx.Destination === sa.coreVault;
  }

  /**
   * A payment that acts on Flare, judged by what it does there. One memo, no destination tag
   * (at the Core Vault a tag mints to whoever holds it). To an operator: the 32-byte instruction.
   * To the Core Vault: the minting memo, and for 0xFE the user operation the agent shows.
   */
  static smartAccountVerdict(tx: Payment, sa: SmartAccountsConfig, userOp?: Hex): string | undefined {
    if (tx.DestinationTag !== undefined) return "a destination tag here would credit whoever holds the tag";
    const memos = tx.Memos ?? [];
    if (memos.length !== 1 || !memos[0].Memo.MemoData) return `exactly one memo with data, not ${memos.length}`;
    const data = memos[0].Memo.MemoData;
    const d = sa.operators.includes(tx.Destination) ? decodeReference(data) : decodeMint(data);
    return judge(d, sa.policy, userOp);
  }

  /** undefined when the meter predates amendment v1.2 and has no tripwire. */
  private async tripped(): Promise<boolean | undefined> {
    try {
      return (await this.pc.readContract({ address: this.cfg.meter, abi: summaMeterAbi, functionName: "tripped", args: [this.cfg.umbrellaId] })) as boolean;
    } catch {
      return undefined;
    }
  }

  /** Report a refused payment to the tripwire; the evidence is the hash of the agent's own signed blob. */
  private async strike(agentBlob: string): Promise<{ struck?: Hex; error?: string }> {
    const r = await this.write("strike", () => this.fw.writeContract({
      address: this.cfg.meter, abi: summaMeterAbi, functionName: "strike", args: [this.cfg.umbrellaId, keccak256(`0x${agentBlob}`)],
    }));
    if (r.ok) { this.pending = undefined; return { struck: r.hash }; }
    this.pending = { blob: agentBlob, hash: r.hash };
    return { error: r.error };
  }

  /**
   * Land a strike that did not land before. It may have landed late (its receipt is checked first),
   * or be moot (the umbrella tripped anyway). Returns why the guard still refuses, if it does.
   * A strike stuck in a mempool and then sent again can count twice: the conservative side.
   */
  private async landPending(): Promise<string | undefined> {
    const p = this.pending!;
    if (p.hash) {
      const rc = await this.pc.getTransactionReceipt({ hash: p.hash }).catch(() => undefined);
      if (rc?.status === "success") { this.pending = undefined; return undefined; }
    }
    if ((await this.tripped()) === true) { this.pending = undefined; return undefined; }
    const s = await this.strike(p.blob);
    return s.struck ? undefined : `an earlier strike has not landed (${s.error}); nothing is signed until it does`;
  }

  /** One write to the meter, waited for. A failure comes back as text: the caller refuses, it never throws. */
  private async write(what: string, send: () => Promise<Hex>): Promise<{ ok: true; hash: Hex } | { ok: false; error: string; hash?: Hex }> {
    let hash: Hex | undefined;
    try {
      hash = await send();
      const rc = await this.pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return rc.status === "success" ? { ok: true, hash } : { ok: false, error: `${what} reverted in ${hash}`, hash };
    } catch (e) {
      return { ok: false, error: `${what}: ${short(e)}`, hash };
    }
  }

  /** Today's spend (since 00:00 UTC, by the chain's clock) plus this payment, against the daily cap. */
  private async overDaily(usd6: bigint, cap: bigint): Promise<string | undefined> {
    const { meter, umbrellaId } = this.cfg;
    const start = dayStart((await this.pc.getBlock()).timestamp);
    const [spent, atStart] = await Promise.all([
      this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "spentUsd6", args: [umbrellaId] }) as Promise<bigint>,
      this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "spentAt", args: [umbrellaId, start] }) as Promise<bigint>,
    ]);
    if (!overDailyCap(spent, atStart, usd6, cap)) return undefined;
    return `today's cap: ${Number(cap) / 1e6} USD a day across every rail, ${(Number(spent - atStart) / 1e6).toFixed(2)} spent since 00:00 UTC`;
  }

  /** The principal's own rules (src/policy.ts). Both work against the meter deployed today. */
  private async checkPolicy(tx: Payment, drops: bigint, usd6: bigint): Promise<string | undefined> {
    const p = this.cfg.policy;
    if (!p) return undefined;
    const { meter, umbrellaId, account } = this.cfg;
    const now = (await this.pc.getBlock()).timestamp;

    if (p.hourlyCapUsd6 !== undefined) {
      const [spent, hourAgo] = await Promise.all([
        this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "spentUsd6", args: [umbrellaId] }) as Promise<bigint>,
        this.pc.readContract({ address: meter, abi: summaMeterAbi, functionName: "spentAt", args: [umbrellaId, now - HOUR_S] }) as Promise<bigint>,
      ]);
      if (overHourlyCap(spent, hourAgo, usd6, p.hourlyCapUsd6)) {
        return `policy: more than ${p.hourlyCapUsd6} µUSD in one hour across every rail (${spent - hourAgo} already)`;
      }
    }

    const vetted = this.cfg.smartAccounts !== undefined && Guard.isSmartAccountPayment(tx, this.cfg.smartAccounts); // judged by instruction
    if (p.newPayeeCapUsd6 !== undefined && !vetted && !(p.knownPayees ?? []).includes(tx.Destination)) {
      const cooling = p.coolingS === undefined ? DEFAULT_COOLING_S : BigInt(p.coolingS);
      // The node's history (the latest 400 transactions it holds) plus what this guard co-signed itself.
      // A payee first paid before both counts as new: the safe direction.
      const r = await this.xrpl.rpc("account_tx", { account, ledger_index_min: -1, ledger_index_max: -1, limit: 400, forward: false });
      const seen: any[] = r.transactions ?? [];
      const hashes = new Set(seen.map((w) => w.hash ?? (w.tx ?? w.tx_json)?.hash));
      const rows = seen.concat(this.cosigned.filter((w) => !hashes.has(w.hash)));
      const h = payeeHistory(rows, account, tx.Destination, now, cooling);
      if (isNewPayee(h, now, cooling) && overNewPayeeCap(h.recentDrops, drops, usd6, p.newPayeeCapUsd6)) {
        return `policy: ${tx.Destination} is a new payee, capped at ${p.newPayeeCapUsd6} µUSD until it cools`;
      }
    }
    return undefined;
  }
}
