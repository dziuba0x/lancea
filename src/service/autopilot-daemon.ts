/**
 * The autopilot as a service. Every tick it looks at the account, asks its brain for one step, has the
 * agent sign it, and sends it to the guard. The agent's key alone is below the account's quorum: nothing
 * it signs reaches the ledger unless the guard co-signs. What it saw, proposed and got back goes into
 * its journal, next to the guard's.
 *
 *   in flight   a co-signed step waits until the chain shows it (FXRP arrived, shares moved) or a timeout
 *               passes: a deposit the operator has not executed yet must not be proposed twice
 *   back-off    after a refusal, no proposal for `backoffS`
 *   paused      a tripped umbrella: nothing is proposed until the principal re-arms it
 *
 * Run:  LANCEA_CONFIG=… LANCEA_KEYS=… npx tsx src/service/autopilot-daemon.ts
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet, type Payment } from "xrpl";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toPayment, type State, type Step, type Strategy, type Venue } from "../autopilot.js";
import { RulesBrain, type Brain } from "../brain.js";
import { short, summaMeterAbi } from "../guard.js";
import { XrplHttp } from "../xrpl-http.js";
import { b32, coston2, meterAbi, registryAbi, smartAccountsAbi } from "../flare.js";
import { Journal, toJson } from "./journal.js";
import { loadAgentKeys, loadConfig, loadToken, strategyOf, venueOf, type LanceaConfig } from "./config.js";

/** XRP the ledger keeps back from an account with a SignerList, rounded up: never proposed as idle. */
export const LEDGER_RESERVE_DROPS = 2_000_000n;

export interface Observer {
  state(): Promise<State>;
  /** undefined when the meter cannot say (a meter from before the tripwire, or unreachable). */
  tripped(): Promise<boolean | undefined>;
}
export interface Verdict { signed: boolean; reason?: string; hash?: string; struck?: string; usd6?: string | bigint }
export interface GuardClient { cosign(r: { blob: string; intent: Step; why: string; by: string }): Promise<Verdict> }

/** Has the chain shown the step's effect? */
export function settled(kind: Step["kind"], before: State, now: State, vaultId: number): boolean {
  const shares = (s: State) => s.shares[vaultId] ?? 0n;
  switch (kind) {
    case "mint": return now.fxrp > before.fxrp;
    case "deposit": return now.fxrp < before.fxrp || shares(now) > shares(before);
    case "redeem": return shares(now) < shares(before);
  }
}

export interface AutopilotOptions {
  brain: Brain;
  strategy: Strategy;
  venue: Venue;
  observer: Observer;
  guard: GuardClient;
  /** Autofill and sign as one signer of the account's multisig: the agent's half. */
  sign: (tx: Payment) => Promise<string>;
  /** Would this payment cross the umbrella's budget? Asked before the guard is: an agent that proposes what
   *  its budget refuses would, ten minutes on, be struck for an attempt and trip its own umbrella. */
  budget?: (tx: Payment) => Promise<{ stop: boolean; usd6: bigint }>;
  journal: Journal;
  executionTimeoutS: number;
  backoffS: number;
  now?: () => number;
}

export class Autopilot {
  private inflight?: { step: Step; since: number; before: State };
  private backoffUntil = 0;
  private last = ""; // the last repeating note written (idle, paused), so a quiet day is one line, not 288

  constructor(private readonly o: AutopilotOptions) {}

  private now = () => (this.o.now ?? Date.now)() / 1000;

  private once(kind: string, fields: Record<string, unknown>, key: string) {
    if (this.last === key) return;
    this.last = key;
    this.o.journal.append(kind, fields);
  }

  /** One look, at most one proposal. Returns a line for the service's log. */
  async tick(): Promise<string> {
    const { journal, observer, strategy } = this.o;
    const t = this.now();
    if (t < this.backoffUntil) return `backing off after a refusal (${Math.round(this.backoffUntil - t)} s left)`;
    if ((await observer.tripped()) === true) {
      this.once("paused", { reason: "the umbrella is tripped: the principal must re-arm it" }, "paused");
      return "paused: the umbrella is tripped";
    }
    const s = await observer.state();
    if (this.inflight) {
      const f = this.inflight;
      if (settled(f.step.kind, f.before, s, strategy.vaultId)) {
        journal.append("settled", { step: f.step, afterS: Math.round(t - f.since), state: s });
        this.inflight = undefined;
      } else if (t - f.since < this.o.executionTimeoutS) {
        return `waiting for Flare to execute the ${f.step.kind} (${Math.round(t - f.since)} s)`;
      } else {
        journal.append("timeout", { step: f.step, afterS: Math.round(t - f.since), state: s });
        this.inflight = undefined;
      }
    }
    const p = await this.o.brain.decide(s, strategy);
    if (!p.step) {
      this.once("idle", { state: s, why: p.why, by: p.by }, `idle ${toJson(s)}`);
      return `idle: ${p.why}`;
    }
    const pay = toPayment(p.step, this.o.venue);
    if (this.o.budget) {
      let b: { stop: boolean; usd6: bigint };
      try {
        b = await this.o.budget(pay);
      } catch (e) {
        this.once("holding", { step: p.step, reason: `the budget is unreadable: ${short(e)}` }, "holding unreadable");
        return `holding: the budget is unreadable (${short(e)})`;
      }
      if (b.stop) {
        this.once("holding", { step: p.step, usd6: b.usd6, why: p.why, reason: "the step would cross the umbrella's budget" }, `holding ${toJson(p.step)}`);
        return `holding: the ${p.step.kind} ($${Number(b.usd6) / 1e6}) would cross the umbrella's budget`;
      }
    }
    this.last = "";
    const blob = await this.o.sign(pay);
    journal.append("proposal", { state: s, step: p.step, why: p.why, by: p.by });
    let v: Verdict;
    try {
      v = await this.o.guard.cosign({ blob, intent: p.step, why: p.why, by: p.by });
    } catch (e) {
      v = { signed: false, reason: `guard unreachable: ${short(e)}` }; // no guard, no signature: the safe side
    }
    journal.append("verdict", { step: p.step, verdict: v });
    if (v.signed) {
      this.inflight = { step: p.step, since: this.now(), before: s }; // from the verdict: a co-signature can take half a minute
      return `co-signed ${p.step.kind}: ${v.hash}`;
    }
    this.backoffUntil = t + this.o.backoffS;
    return `refused ${p.step.kind}: ${v.reason}`;
  }
}

/** The account as the chains show it: spendable XRP on the ledger, FXRP and vault shares on Flare. */
export class ChainObserver implements Observer {
  constructor(private readonly c: LanceaConfig, private readonly xrpl: XrplHttp, private readonly pc: ReturnType<typeof createPublicClient>) {}

  async state(): Promise<State> {
    const sa = this.c.smartAccounts;
    const read = (address: Hex) => this.pc.readContract({ address, abi: smartAccountsAbi, functionName: "balanceOf", args: [sa.personalAccount] }) as Promise<bigint>;
    const [info, fxrp, shares] = await Promise.all([
      this.xrpl.rpc("account_info", { account: this.c.account, ledger_index: "validated" }),
      read(sa.fxrp),
      read(sa.vault),
    ]);
    const spendable = BigInt(info.account_data.Balance) - LEDGER_RESERVE_DROPS;
    return { xrpDrops: spendable > 0n ? spendable : 0n, fxrp, shares: { [sa.vaultId]: shares } };
  }

  tripped(): Promise<boolean | undefined> {
    return this.pc.readContract({ address: this.c.umbrella.meter, abi: meterAbi, functionName: "tripped", args: [BigInt(this.c.umbrella.id)] })
      .then((b) => b as boolean, () => undefined);
  }
}

export const httpGuard = (url: string, token: string): GuardClient => ({
  async cosign(r) {
    const res = await fetch(`${url}/cosign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: toJson(r),
    });
    const body = (await res.json().catch(() => ({}))) as Verdict & { error?: string };
    return res.ok ? body : { signed: false, reason: `guard answered ${res.status}: ${body.error ?? "?"}` };
  },
});

/** The umbrella names its agent; the agent's consent is on-chain before anything is bonded against it. */
async function acknowledge(c: LanceaConfig, evmKey: Hex, journal: Journal): Promise<void> {
  const chain = coston2(c.network.rpcUrl);
  const pc = createPublicClient({ chain, transport: http(c.network.rpcUrl) });
  const id = BigInt(c.umbrella.id);
  if (await pc.readContract({ address: c.umbrella.registry, abi: registryAbi, functionName: "acknowledged", args: [id] })) return;
  const w = createWalletClient({ account: privateKeyToAccount(evmKey), chain, transport: http(c.network.rpcUrl) });
  const hash = await w.writeContract({ address: c.umbrella.registry, abi: registryAbi, functionName: "acknowledge", args: [id] });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`acknowledge reverted: ${hash}`);
  journal.append("acknowledged", { umbrella: c.umbrella.id, tx: hash });
}

async function main() {
  const c = loadConfig();
  const keys = loadAgentKeys();
  const token = loadToken();
  const journal = new Journal(join(c.dataDir, "autopilot.jsonl"));
  const evm = privateKeyToAccount(keys.evmKey).address;
  if (evm.toLowerCase() !== c.agentEvm.toLowerCase()) throw new Error(`agent.json's Flare key is ${evm}, but the umbrella names ${c.agentEvm}`);
  await acknowledge(c, keys.evmKey, journal);

  const xrpl = new XrplHttp(c.network.xrplRpc);
  const pc = createPublicClient({ chain: coston2(c.network.rpcUrl), transport: http(c.network.rpcUrl) });
  const agent = Wallet.fromSeed(keys.xrplSeed);
  const pilot = new Autopilot({
    brain: new RulesBrain(), strategy: strategyOf(c), venue: venueOf(c),
    observer: new ChainObserver(c, xrpl, pc), guard: httpGuard(`http://${c.guard.host}:${c.guard.port}`, token),
    sign: async (tx) => agent.sign(await xrpl.autofill<Payment>(tx, 2), true).tx_blob,
    budget: async (tx) => {
      const drops = BigInt(tx.Amount as string) + 1_000n; // + more than a multisig fee: the guard counts the fee as outflow too
      const { result } = await pc.simulateContract({
        account: c.agentEvm, address: c.umbrella.meter, abi: summaMeterAbi, functionName: "wouldExceed",
        args: [BigInt(c.umbrella.id), b32(c.network.xrplSource), b32("XRP/outflow"), drops, 0],
      });
      const [stop, usd6] = result as readonly [boolean, bigint];
      return { stop, usd6 };
    },
    journal, executionTimeoutS: c.autopilot.executionTimeoutS, backoffS: c.autopilot.backoffS,
  });
  journal.append("start", { agent: agent.address, account: c.account, umbrella: c.umbrella.id, brain: "rules", tickSeconds: c.autopilot.tickSeconds });
  console.log(`lancea autopilot ${agent.address} | account ${c.account} | a tick every ${c.autopilot.tickSeconds} s`);

  let stopping = false;
  let wake: () => void = () => {};
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; wake(); });
  while (!stopping) {
    try {
      console.log(new Date().toISOString(), await pilot.tick());
    } catch (e) {
      journal.append("error", { error: short(e) });
      console.error(new Date().toISOString(), "tick failed:", short(e));
    }
    await new Promise<void>((r) => { wake = r; setTimeout(r, c.autopilot.tickSeconds * 1000); });
  }
  journal.append("stop", {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
