/**
 * What the dashboard counts, kept from the journals themselves: read once on start, then only the lines
 * appended since, so a journal of months costs a minute's worth of reading. Nothing here reaches a chain.
 *
 *   steps       every step Flare executed, by kind (the autopilot's "settled" entries), with its total
 *   decisions   the guard's verdicts: co-signed, refused, struck; co-signatures in the last 24 hours
 *   top-ups     what the testnet faucet sent, and its transaction hashes (to name them on the ledger)
 *   exemplars   the latest real decision of each kind, pinned, so the page can replay one of each even
 *               when it has scrolled out of the journals' tail; a co-signed one carries its settlement
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { Entry } from "./journal.js";

/** A JSON-lines file read forward: each call returns the whole lines appended since the last. */
export class Follow {
  private pos = 0;
  private rest = "";
  constructor(readonly path: string) {}
  next(): Entry[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.pos) { this.pos = 0; this.rest = ""; } // the file was replaced
    if (size === this.pos) return [];
    const buf = Buffer.alloc(size - this.pos);
    const fd = openSync(this.path, "r");
    try { readSync(fd, buf, 0, buf.length, this.pos); } finally { closeSync(fd); }
    this.pos = size;
    const lines = (this.rest + buf.toString("utf8")).split("\n");
    this.rest = lines.pop() ?? "";
    return lines.filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Entry]; } catch { return []; } });
  }
}

/** Which of the page's examples a guard decision is. */
export function exemplarKind(e: Entry): string | undefined {
  const d = (e as any).decision ?? {}, a = (e as any).tx?.action ?? {};
  if (d.struck) return "hijack";
  if (!d.signed) return "refused";
  if (a.kind === "mint-to") return "mint";
  if (a.kind === "vault") return a.action === "deposit" ? "deposit" : a.action === "redeem" ? "withdraw" : "claim";
  if (a.kind === "fxrp-redeem") return "redeem";
  return "payment";
}

/** The amount a settled step moved, in its smallest unit (drops of XRP or FXRP). */
const unitsOf = (step: any): bigint => {
  try { return BigInt(step?.drops ?? step?.amount ?? 0); } catch { return 0n; }
};

export class JournalStats {
  readonly steps: Record<string, { count: number; units: bigint }> = {};
  readonly decisions = { signed: 0, refused: 0, struck: 0 };
  readonly topups = { count: 0, drops: 0n, hashes: new Set<string>() };
  readonly exemplars: Record<string, any> = {};
  private signedAt: number[] = [];
  private reservations: string[] = [];
  private pending: Record<string, { kind: string; e: any }> = {}; // step kind → a co-signed decision waiting for Flare
  private readonly g: Follow;
  private readonly a: Follow;

  constructor(guardPath: string, autopilotPath: string) {
    this.g = new Follow(guardPath);
    this.a = new Follow(autopilotPath);
  }

  update(now = Date.now()): this {
    for (const e of this.g.next()) if (e.kind === "decision") this.decision(e);
    for (const e of this.a.next()) this.autopilot(e);
    this.signedAt = this.signedAt.filter((t) => t > now - 86_400_000);
    return this;
  }

  private decision(e: Entry) {
    const d = (e as any).decision ?? {};
    if (d.signed) {
      this.decisions.signed++;
      this.signedAt.push(Date.parse(e.at));
      if (d.reservation) this.reservations = [...this.reservations.slice(-4), String(d.reservation)];
    } else if (d.struck) this.decisions.struck++;
    else this.decisions.refused++;
    const kind = exemplarKind(e);
    if (!kind) return;
    const step = (e as any).claim?.intent?.kind;
    if (d.signed && step) {
      // a co-signed step is shown once Flare has executed it: until then the last one that did stays pinned
      this.pending[step] = { kind, e: { ...e } };
      if (!this.exemplars[kind]) this.exemplars[kind] = { ...e };
    } else this.exemplars[kind] = { ...e };
  }

  private autopilot(e: Entry) {
    if (e.kind === "settled") {
      const step = (e as any).step, kind = String(step?.kind ?? "");
      const t = (this.steps[kind] ??= { count: 0, units: 0n });
      t.count++;
      t.units += unitsOf(step);
      const p = this.pending[kind];
      if (p && Date.parse(e.at) >= Date.parse(p.e.at)) {
        this.exemplars[p.kind] = { ...p.e, settled: { at: e.at, afterS: (e as any).afterS } };
        delete this.pending[kind];
      }
    } else if (e.kind === "topped-up") {
      this.topups.count++;
      try { this.topups.drops += BigInt((e as any).drops ?? 0); } catch { /* an odd line is not a total */ }
      if ((e as any).tx) this.topups.hashes.add(String((e as any).tx));
    }
  }

  /** The latest reservations the guard wrote on Flare (its gas is spent there). */
  recentReservations(): string[] { return [...this.reservations]; }

  snapshot() {
    return {
      steps: Object.fromEntries(Object.entries(this.steps).map(([k, v]) => [k, { count: v.count, units: v.units.toString() }])),
      decisions: { ...this.decisions, signed24h: this.signedAt.length },
      topups: { count: this.topups.count, drops: this.topups.drops.toString() },
    };
  }
}

/**
 * The brain's side of the feed, from its own journal (brain.jsonl) and its status file (brain.json): the
 * Sentinel's latest notes, what visitors asked the playground to do and what its guard said, how many
 * conversations it had, and the address its tunnel answers at. Visitors' words are never published:
 * only what they asked for (an amount, an address) and the verdict.
 */
export class BrainLog {
  readonly reflections: any[] = [];
  readonly actions: any[] = [];
  readonly verdicts: Record<string, number> = { "co-signed": 0, refused: 0, struck: 0, "not sent": 0 };
  private chats: number[] = [];
  private pilotAt: number[] = [];
  private readonly f: Follow;
  constructor(readonly dataDir: string) { this.f = new Follow(`${dataDir}/brain.jsonl`); }

  update(now = Date.now()): this {
    for (const e of this.f.next()) {
      const x = e as any;
      if (e.kind === "reflection") {
        this.reflections.unshift({ at: e.at, mood: x.mood, headline: x.headline, body: x.body, watch: x.watch, by: x.by, model: x.model });
        this.reflections.splice(6);
      } else if (e.kind === "action") {
        const a = x.act ?? {};
        this.actions.unshift({
          at: e.at, act: { kind: a.kind, xrp: a.xrp, fxrp: a.fxrp, lots: a.lots, destination: a.destination, recipient: a.recipient },
          verdict: x.verdict, reason: typeof x.reason === "string" ? x.reason.slice(0, 200) : undefined, usd: x.usd, links: x.links,
        });
        this.actions.splice(12);
        if (x.verdict in this.verdicts) this.verdicts[x.verdict]++;
      } else if (e.kind === "chat") this.chats.push(Date.parse(e.at));
      else if (e.kind === "rearmed" || e.kind === "tripped") {
        this.actions.unshift({ at: e.at, event: e.kind, links: x.tx ? { rearm: x.tx } : undefined });
        this.actions.splice(12);
      }
    }
    this.chats = this.chats.filter((t) => t > now - 86_400_000);
    return this;
  }

  /** The feed's `brain`: online when brain.json was written in the last two minutes. */
  section(now = Date.now()) {
    let s: any;
    try { s = JSON.parse(readFileSync(`${this.dataDir}/brain.json`, "utf8")); } catch { s = undefined; }
    if (!s && !this.reflections.length) return undefined;
    const online = !!s && !s.stopped && now - Date.parse(s.updatedAt) < 120_000;
    return {
      // (the per-model call counts stay in brain.json: they change every minute and the page has no use for them)
      online, url: online ? s.url : undefined, since: s?.startedAt, models: s?.models, pilot: s?.pilot, playground: online ? s.playground : undefined,
      reflections: this.reflections, actions: this.actions, counts: { chats24h: this.chats.length, verdicts: { ...this.verdicts } },
    };
  }
}
