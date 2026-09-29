/**
 * The playground: a second guarded account, with its own umbrella and its own guard, where the public
 * can talk the agent into things. The brain holds this account's agent key and signs what a visitor asks
 * for; the playground's guard decides, exactly as the live demo's does. A payment to a stranger past the
 * owner's new-payee cap, or a mint to someone else's address, is refused and struck, and one strike trips
 * it. Its owner key lives here too, for one thing only: to re-arm it a few minutes after a trip, so the
 * next visitor can try. The live demo's account is never touched from here.
 */
import { join } from "node:path";
import { Wallet, type Payment } from "xrpl";
import { createPublicClient, createWalletClient, http, isAddress, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toPayment, type Step, type Venue } from "../autopilot.js";
import { readQueue } from "../firelight.js";
import { coston2, meterAbi, smartAccountsAbi } from "../flare.js";
import { registryAbi as registryReadAbi, short, summaMeterAbi } from "../guard.js";
import { DAY_S } from "../policy.js";
import { XrplHttp } from "../xrpl-http.js";
import { Journal } from "../service/journal.js";
import { acknowledge, httpGuard, LEDGER_RESERVE_DROPS, testnetFaucet, type Verdict } from "../service/autopilot-daemon.js";
import { venueOf, type LanceaConfig } from "../service/config.js";

export interface PlaygroundKeys { agent: { xrplSeed: string; evmKey: Hex }; token: string; principal: Hex }
export interface PlaygroundOptions {
  rearmAfterS: number; keepXrp: number; refillXrp: number;
  /** Below this much C2FLR on the playground guard, nothing is proposed: its gas pays every reservation and strike. */
  minGuardC2flr?: number;
}

export type Act =
  | { kind: "pay"; destination: string; xrp: number; memo?: string }
  | { kind: "mint"; xrp: number; recipient?: string }
  | { kind: "deposit"; fxrp: number }
  | { kind: "withdraw"; fxrp: number }
  | { kind: "claim" }
  | { kind: "redeem"; lots: number };

export interface ActResult {
  verdict: "co-signed" | "refused" | "struck" | "not sent";
  reason?: string; usd?: number; what: string;
  links: { xrpl?: string; reservation?: string; strike?: string };
  tripped?: boolean; rearmInS?: number;
}

const EXPLORER = { xrpl: "https://testnet.xrpl.org/transactions/", flare: "https://coston2-explorer.flare.network/tx/" };
const drops = (xrp: number) => BigInt(Math.round(xrp * 1e6));

export class Playground {
  readonly xrpl: XrplHttp;
  private readonly pc;
  private readonly agent: Wallet;
  private readonly venue: Venue;
  private readonly guard;
  private cache?: { at: number; v: any };
  private reading?: Promise<any>; // one reading of the chains at a time, however many ask
  private lastGas = 0;
  private trippedSince?: number;
  private lastRefill = 0;
  private busy = Promise.resolve() as Promise<unknown>; // one proposal at a time: sequences never collide

  constructor(readonly c: LanceaConfig, private readonly keys: PlaygroundKeys, private readonly o: PlaygroundOptions, private readonly journal: Journal) {
    this.xrpl = new XrplHttp(c.network.xrplRpc);
    this.pc = createPublicClient({ chain: coston2(c.network.rpcUrl), transport: http(c.network.rpcUrl) });
    this.agent = Wallet.fromSeed(keys.agent.xrplSeed);
    this.venue = venueOf(c);
    this.guard = httpGuard(`http://${c.guard.host}:${c.guard.port}`, keys.token);
  }

  /** The umbrella names the playground's agent; it agrees on Flare once. */
  start() { return acknowledge(this.c, this.keys.agent.evmKey, this.journal).catch((e) => this.journal.append("error", { where: "playground acknowledge", error: short(e) })); }

  async state(fresh = false): Promise<any> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 10_000) return this.cache.v;
    if (this.reading) return this.reading;
    this.reading = this.read().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async read() {
    const c = this.c, sa = c.smartAccounts, id = BigInt(c.umbrella.id);
    const bal = (t: Hex) => this.pc.readContract({ address: t, abi: smartAccountsAbi, functionName: "balanceOf", args: [sa.personalAccount] }) as Promise<bigint>;
    const meter = (fn: "tripped" | "strikes" | "spentUsd6" | "tripwire") => this.pc.readContract({ address: c.umbrella.meter, abi: meterAbi, functionName: fn, args: [id] });
    const block = await this.pc.getBlock();
    const [info, fxrp, shares, tripped, strikes, spent, m, today, gas] = await Promise.all([
      this.xrpl.rpc("account_info", { account: c.account, ledger_index: "validated" }), bal(sa.fxrp), bal(sa.vault),
      meter("tripped"), meter("strikes"), meter("spentUsd6"),
      this.pc.readContract({ address: c.umbrella.registry, abi: registryReadAbi, functionName: "get", args: [id] }),
      this.pc.readContract({ address: c.umbrella.meter, abi: summaMeterAbi, functionName: "spentAt", args: [id, block.timestamp - (block.timestamp % DAY_S)] }),
      c.keys?.guardFlare ? this.pc.getBalance({ address: c.keys.guardFlare }) : Promise.resolve(undefined),
    ]);
    const xrp = BigInt(info.account_data.Balance) - LEDGER_RESERVE_DROPS;
    const v = {
      account: c.account, personalAccount: sa.personalAccount, umbrella: c.umbrella.id,
      xrp: Number(xrp > 0n ? xrp : 0n) / 1e6, fxrp: Number(fxrp) / 1e6, shares: Number(shares) / 1e6,
      tripped: Boolean(tripped), strikes: Number(strikes),
      spentUsd: Number(spent) / 1e6, budgetUsd: Number((m as { budget: bigint }).budget) / 1e6,
      spentTodayUsd: Number(BigInt(spent as bigint) - (today as bigint)) / 1e6,
      dailyCapUsd: c.guard.dailyCapUsd6 ? Number(c.guard.dailyCapUsd6) / 1e6 : undefined,
      newPayeeCapUsd: c.guard.newPayeeCapUsd6 ? Number(c.guard.newPayeeCapUsd6) / 1e6 : undefined,
      rearmInS: this.trippedSince ? Math.max(0, Math.round(this.trippedSince / 1000 + this.o.rearmAfterS - Date.now() / 1000)) : undefined,
      guardC2flr: gas !== undefined ? Number(gas / 10n ** 14n) / 1e4 : undefined,
      rearmAfterS: this.o.rearmAfterS,
    };
    this.cache = { at: Date.now(), v };
    return v;
  }

  /** The XRPL payment a visitor's request becomes; an error names what cannot be proposed at all. */
  async payment(a: Act): Promise<{ tx: Payment; step: unknown; what: string }> {
    const v = this.venue;
    if (a.kind === "pay") {
      if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a.destination)) throw new Error("that is not an XRP Ledger address (r…)");
      if (!(a.xrp > 0 && a.xrp <= 1000)) throw new Error("an amount between 0 and 1000 XRP");
      const memo = (a.memo ?? "").slice(0, 120);
      const tx: Payment = { TransactionType: "Payment", Account: v.account, Destination: a.destination, Amount: drops(a.xrp).toString(),
        ...(memo ? { Memos: [{ Memo: { MemoData: stringToHex(memo).slice(2).toUpperCase() } }] } : {}) };
      return { tx, step: { kind: "pay", destination: a.destination, drops: drops(a.xrp).toString() }, what: `pay ${a.xrp} XRP to ${a.destination}` };
    }
    if (a.kind === "mint") {
      if (!(a.xrp >= 1 && a.xrp <= 20)) throw new Error("the playground mints 1 to 20 XRP at a time");
      const to = a.recipient ?? v.personalAccount;
      if (!isAddress(to)) throw new Error("that is not a Flare address (0x…)");
      const have = await this.state();
      if (a.xrp > have.xrp - 1) throw new Error(`the playground has ${have.xrp} XRP to spend (a faucet tops it up when it runs low)`);
      const step: Step = { kind: "mint", drops: drops(a.xrp) };
      return { tx: toPayment(step, { ...v, personalAccount: to }), step: { ...step, recipient: to }, what: `mint ${a.xrp} XRP to FXRP for ${to}` };
    }
    const vaultId = this.c.smartAccounts.vaultId;
    // what the account holds: an instruction it cannot fund would be co-signed and then do nothing on Flare
    const have = await this.state();
    if (a.kind === "deposit" && a.fxrp > have.fxrp) throw new Error(`the playground's personal account holds ${have.fxrp} FXRP: mint first, then deposit`);
    if (a.kind === "withdraw" && a.fxrp > have.shares) throw new Error(`the playground holds ${have.shares} vault shares: deposit first, then withdraw`);
    if (a.kind === "redeem" && Math.floor(a.lots) * 10 > have.fxrp) throw new Error(`redemption comes in lots of 10 FXRP and the personal account holds ${have.fxrp} FXRP`);
    if (a.kind === "deposit" || a.kind === "withdraw") {
      if (!(a.fxrp >= 1 && a.fxrp <= 500)) throw new Error("1 to 500 FXRP");
      const step: Step = { kind: a.kind, amount: BigInt(Math.floor(a.fxrp)) * 1_000_000n, vaultId };
      return { tx: toPayment(step, v), step, what: `${a.kind} ${Math.floor(a.fxrp)} FXRP ${a.kind === "deposit" ? "into" : "from"} the vault` };
    }
    if (a.kind === "claim") {
      const q = await readQueue(this.pc as any, this.c.smartAccounts.vault, this.c.smartAccounts.personalAccount);
      const ready = q.claimable[0];
      if (!ready) throw new Error("no withdrawal has unlocked yet");
      const step: Step = { kind: "claim", period: ready.period, amount: ready.assets, vaultId };
      return { tx: toPayment(step, v), step, what: `claim the withdrawal booked for period ${ready.period}` };
    }
    if (!(a.lots >= 1 && a.lots <= 10)) throw new Error("1 to 10 lots");
    const step: Step = { kind: "redeem", lots: BigInt(Math.floor(a.lots)), drops: BigInt(Math.floor(a.lots)) * 10_000_000n };
    return { tx: toPayment(step, v), step, what: `redeem ${Math.floor(a.lots)} lot(s) of FXRP to XRP` };
  }

  /** Sign the visitor's request with the agent's key and ask the playground's guard. */
  act(a: Act, why: string): Promise<ActResult> {
    const run = this.busy.then(() => this.actNow(a, why));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async actNow(a: Act, why: string): Promise<ActResult> {
    let p;
    try { p = await this.payment(a); } catch (e) { return { verdict: "not sent", reason: (e as Error).message, what: a.kind, links: {} }; }
    if (this.o.minGuardC2flr) {
      const s = await this.state().catch(() => undefined);
      if (s?.guardC2flr !== undefined && s.guardC2flr < this.o.minGuardC2flr) {
        return { verdict: "not sent", reason: `the playground's guard is down to ${s.guardC2flr} C2FLR of gas, kept for strikes: it rests until it is topped up`, what: p.what, links: {} };
      }
    }
    let v: Verdict;
    try {
      const blob = this.agent.sign(await this.xrpl.autofill<Payment>(p.tx, 2), true).tx_blob;
      v = await this.guard.cosign({ blob, intent: p.step as Step, why: why.slice(0, 280), by: "chat" });
    } catch (e) {
      return { verdict: "not sent", reason: `the playground could not be reached: ${short(e)}`, what: p.what, links: {} };
    }
    this.cache = undefined;
    const d = v as Verdict & { reservation?: string };
    const r: ActResult = {
      verdict: v.signed ? "co-signed" : v.struck ? "struck" : "refused", reason: v.reason, what: p.what,
      usd: v.usd6 !== undefined ? Number(v.usd6) / 1e6 : undefined,
      links: { ...(v.hash ? { xrpl: EXPLORER.xrpl + v.hash } : {}), ...(d.reservation ? { reservation: EXPLORER.flare + d.reservation } : {}), ...(v.struck ? { strike: EXPLORER.flare + v.struck } : {}) },
    };
    if (v.struck) { this.trippedSince ??= Date.now(); r.tripped = true; r.rearmInS = this.o.rearmAfterS; }
    this.journal.append("action", { act: a, verdict: r.verdict, reason: r.reason, usd: r.usd, links: r.links });
    return r;
  }

  /** Every 20 s: re-arm a tripped playground once its pause is over; top its XRP up from the testnet faucet;
   *  and keep its guard's gas above 3 C2FLR from the owner's own, while the owner has some to spare. */
  async tend(): Promise<void> {
    try {
      const s = await this.state(true);
      if (s.guardC2flr !== undefined && s.guardC2flr < 3 && Date.now() - this.lastGas > 600_000 && this.c.keys?.guardFlare) {
        this.lastGas = Date.now();
        await this.fuel(this.c.keys.guardFlare);
      }
      if (s.tripped) {
        if (!this.trippedSince) { this.trippedSince = Date.now(); this.journal.append("tripped", { umbrella: this.c.umbrella.id }); }
        else if (Date.now() - this.trippedSince >= this.o.rearmAfterS * 1000) await this.rearm();
      } else this.trippedSince = undefined;
      if (s.xrp < this.o.keepXrp && Date.now() - this.lastRefill > 1_800_000 && this.c.network.xrplSource === "testXRP") {
        this.lastRefill = Date.now();
        const tx = await testnetFaucet(this.xrpl.faucet, this.c.account, drops(this.o.refillXrp));
        this.journal.append("topped-up", { drops: drops(this.o.refillXrp), tx, playground: true });
      }
    } catch (e) {
      this.journal.append("error", { where: "playground", error: short(e) });
    }
  }

  /** The owner sends its guard up to 5 C2FLR, keeping 1.5 for re-arming. */
  private async fuel(guard: Hex) {
    const chain = coston2(this.c.network.rpcUrl);
    const w = createWalletClient({ account: privateKeyToAccount(this.keys.principal), chain, transport: http(this.c.network.rpcUrl) });
    const have = await this.pc.getBalance({ address: w.account.address });
    const send = have - 1_500_000_000_000_000_000n;
    const value = send > 5_000_000_000_000_000_000n ? 5_000_000_000_000_000_000n : send;
    if (value < 500_000_000_000_000_000n) { this.journal.append("gas", { guard, sent: "0", note: "the owner has no C2FLR to spare: top up the playground's owner from the Coston2 faucet" }); return; }
    const hash = await w.sendTransaction({ to: guard, value });
    await this.pc.waitForTransactionReceipt({ hash });
    this.cache = undefined;
    this.journal.append("gas", { guard, sent: value.toString(), tx: hash });
  }

  private async rearm() {
    const chain = coston2(this.c.network.rpcUrl);
    const w = createWalletClient({ account: privateKeyToAccount(this.keys.principal), chain, transport: http(this.c.network.rpcUrl) });
    const hash = await w.writeContract({ address: this.c.umbrella.meter, abi: meterAbi, functionName: "rearm", args: [BigInt(this.c.umbrella.id)] });
    const rc = await this.pc.waitForTransactionReceipt({ hash });
    this.trippedSince = undefined;
    this.cache = undefined;
    this.journal.append("rearmed", { umbrella: this.c.umbrella.id, tx: hash, ok: rc.status === "success" });
  }
}

export const playgroundPaths = (conf: string) => ({ config: join(conf, "playground.json"), keys: join(conf, "playground-keys") });
