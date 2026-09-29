/**
 * What the brain knows beyond the live chains: a short brief it always carries (written from the live
 * config, so every address and limit is the deployed one), and the project's own documents, cut at their
 * headings and searched with BM25 when a question needs more (Lancea's README and runs, DELICTI's README
 * and SPEC when the server holds a clone). No embeddings, no network: small, exact and inspectable.
 */
import { existsSync, readFileSync } from "node:fs";

export interface Chunk { id: number; source: string; title: string; text: string }

/** A markdown document cut at its headings into pieces of at most `max` characters, each with its heading path. */
export function chunk(source: string, md: string, max = 1800): Omit<Chunk, "id">[] {
  const out: Omit<Chunk, "id">[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").replace(/<[^>]+>/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    buf = [];
    if (text.length < 40) return;
    for (let i = 0; i < text.length; i += max) out.push({ source, title: path.filter(Boolean).join(" › ") || source, text: text.slice(i, i + max) });
  };
  for (const line of md.split("\n")) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); path.length = h[1].length - 1; path[h[1].length - 1] = h[2].trim(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9ąćęłńóśźż$€.#-]{2,}/g)?.map((w) => w.replace(/[.#-]+$/, "")) ?? [];

/** BM25 over the chunks (k1 1.4, b 0.75). */
export class Library {
  readonly chunks: Chunk[] = [];
  private tf: Map<string, number>[] = [];
  private df = new Map<string, number>();
  private avg = 0;

  add(source: string, md: string) {
    for (const c of chunk(source, md)) {
      const id = this.chunks.length;
      this.chunks.push({ id, ...c });
      const tf = new Map<string, number>();
      for (const w of words(`${c.title} ${c.text}`)) tf.set(w, (tf.get(w) ?? 0) + 1);
      this.tf.push(tf);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    }
    this.avg = this.tf.reduce((n, t) => n + [...t.values()].reduce((a, b) => a + b, 0), 0) / Math.max(1, this.tf.length);
  }

  /** The files that exist, read and added; returns how many were read. */
  addFiles(files: [string, string][]): number {
    let n = 0;
    for (const [source, path] of files) if (existsSync(path)) { this.add(source, readFileSync(path, "utf8")); n++; }
    return n;
  }

  search(q: string, k = 4): Chunk[] {
    const qs = [...new Set(words(q))], N = this.chunks.length;
    const scored = this.tf.map((tf, i) => {
      const len = [...tf.values()].reduce((a, b) => a + b, 0);
      let s = 0;
      for (const w of qs) {
        const f = tf.get(w); if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(w) ?? 0) + 0.5) / ((this.df.get(w) ?? 0) + 0.5));
        s += idf * ((f * 2.4) / (f + 1.4 * (0.25 + (0.75 * len) / (this.avg || 1))));
      }
      return { i, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
    return scored.map((x) => this.chunks[x.i]);
  }
}

export interface BriefFacts {
  account: string; personalAccount: string; umbrella: string; budgetUsd: number; dailyCapUsd?: number;
  guardXrpl?: string; guardFlare?: string; agentXrpl?: string; meter: string; registry: string;
  playground?: { account: string; umbrella: string; dailyCapUsd?: number; newPayeeCapUsd?: number; rearmAfterS: number };
}

/** The brief every conversation starts from: what Lancea and DELICTI are, and the deployment as it runs. */
export function brief(f: BriefFacts): string {
  return `# Lancea, in brief
Lancea is a co-signer that AI agents cannot talk past. An AI agent holds a key to an XRP Ledger account, but only half of what a payment needs. The account's master key is disabled; its SignerList is the owner (weight 2, can always act alone: recover, rotate, remove the guard), the agent (weight 1) and the guard (weight 1), quorum 2. The agent proposes and signs; the guard reads the signed transaction itself (never the agent's words), and co-signs only what the owner allows.

## What the guard checks, in order (any failure is a refusal; a refusal never moves money)
1. An XRP Payment from the guarded account; the fee at most 0.01 XRP (a fee is outflow too).
2. Flare Smart Accounts: a payment to an operator carries a 32-byte instruction (0x11 Firelight deposit, 0x12 start a withdrawal, 0x13 claim a withdrawal by period, 0x02 redeem FXRP in lots); a payment to the FAssets Core Vault mints FXRP to the Flare address its memo names. The guard decodes the memo and allows only the owner's vault and minting to the account's own personal account. Anything else is refused, and struck when the owner opted in.
3. The umbrella's dollar budget across every rail, priced by Flare's FTSO, on DELICTI's SummaMeter (wouldExceed). If a refused payment breaks the budget even against the tally of ten minutes ago, it was an attempt, and the guard strikes it on-chain.
4. Today's cap: at most so many dollars per UTC day across every rail. A refusal, never a strike.
5. The owner's rules: an hourly cap, and a cap for payees never paid before (new-payee cooling).
6. The umbrella is not tripped. With the tripwire at 1, one strike shuts every rail (XRPL and x402 on Flare) until the owner re-arms it.
7. The reservation: before the signature exists, the guard writes the amount into the tally on Flare (SummaMeter.note). No reservation, no signature.

## The live demo (XRPL testnet and Flare Coston2, 24/7 on an Oracle Cloud server)
- Account ${f.account}; its personal account on Flare ${f.personalAccount}.
- Umbrella #${f.umbrella}: $${f.budgetUsd.toLocaleString("en-US")}${f.dailyCapUsd ? `, and at most $${f.dailyCapUsd.toLocaleString("en-US")} a UTC day` : ""}; tripwire 1.
- The guard: XRPL ${f.guardXrpl ?? "?"}, Flare ${f.guardFlare ?? "?"} (its gas pays each reservation, about 0.12 C2FLR). The agent: XRPL ${f.agentXrpl ?? "?"}.
- DELICTI SummaMeter ${f.meter}; MandateRegistry ${f.registry}.
- The wheel: every 5 minutes the agent takes one step: once a Firelight period (4 h) it starts withdrawing five FAssets lots (a lot is 10 FXRP); when the booked period has ended it claims them; it redeems whole lots of FXRP to XRP (FAssets agents pay the XRP out on the ledger); it mints that XRP to FXRP again (at most 9 XRP a step, below a lot) and deposits it again. Every step is an XRPL payment the guard prices and co-signs.
- Pacing: below 25 C2FLR of guard gas the agent asks at most every 15 minutes; below 5 it asks nothing, so the guard keeps enough gas to strike. A keeper tops the account up from the XRPL testnet faucet.
- Every decision, with its links, is on the dashboard (dziuba0x.github.io/lancea) and in the journals.
${f.playground ? `
## The playground (where you, the assistant, act)
A separate guarded account ${f.playground.account} on umbrella #${f.playground.umbrella}${f.playground.dailyCapUsd ? ` ($${f.playground.dailyCapUsd} a day)` : ""}, with its own guard. You hold its agent key; the guard holds the other half. Paying a new payee more than $${f.playground.newPayeeCapUsd ?? 0.5} is refused and struck, and so is minting FXRP to anyone but the playground's own personal account: one strike trips it. Its owner key lives on the server and re-arms it about ${Math.round(f.playground.rearmAfterS / 60)} minutes after a trip, so the next visitor can try.
` : ""}
## DELICTI (github.com/dziuba0x/delicti)
Accountability for autonomous AI agents, on Flare. A principal commits a mandate on-chain (a budget, a time window, an asset, a delegation tree); the agent accepts it and posts a bond. Independent witnesses confirm each deed: witness 1, the effector's receipt; witness 2, the Flare Data Connector (FDC), which attests from consensus what happened on Ethereum, Flare, Songbird or the XRP Ledger. When the sum of the deeds breaks the mandate, a contract slashes the bond in proportion to the breach: no jurors, no votes, no admin key. SUMMA turns umbrellas into dollar budgets across rails, priced by the FTSO (SummaMeter). Amendment v1.2 adds the tripwire; MandateFacilitator records x402 attempts on Flare. DELICTI proves what an agent did, after the act; Lancea stops what it should not do, before the act. Both ask the same meter, so a strike on one rail trips the other.

## Flare
FTSO: prices every few seconds, from ~100 independent providers, on-chain. FDC: proofs of events on other chains. FAssets: XRP bridged 1:1 to FXRP, backed by agents' collateral; minting and redemption in lots. Smart Accounts: an XRPL account acts on Flare through XRPL payments with instructions, via a personal account on Flare. Firelight: a vault for FXRP; withdrawals are booked for the next 4-hour period and claimed after it ends.

## Status
Testnets only (XRPL testnet, Flare Coston2), unaudited, MIT. Nothing here is real money.`;
}
