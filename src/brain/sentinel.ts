/**
 * The Sentinel: the part of the brain that keeps thinking about the flows. Every hour, and soon after
 * anything unusual (a strike, a refusal, a step Flare did not execute, the agent holding at a cap, the
 * guard's gas running low), it reads the live demo's feed and its own journal and writes a short note:
 * how things stand, what to watch, what comes next. When no model can answer, the rules write it.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Gemini } from "./gemini.js";
import { jsonOf } from "./gemini.js";
import type { Journal } from "../service/journal.js";

export const SENTINEL_SCHEMA = {
  type: "OBJECT",
  properties: {
    mood: { type: "STRING", enum: ["calm", "watch", "alert"] },
    headline: { type: "STRING", description: "at most 90 characters" },
    body: { type: "STRING", description: "two to four sentences" },
    watch: { type: "ARRAY", items: { type: "STRING" }, description: "up to three short things to watch next" },
  },
  required: ["mood", "headline", "body"],
} as const;

export const SENTINEL_SYSTEM = `You are the Sentinel in Lancea's brain. Lancea is an AI agent that runs an XRP Ledger treasury through a Flare vault on a leash: every step is co-signed by a guard that prices it on Flare against the owner's dollar budget (DELICTI's SummaMeter, FTSO prices), under a daily cap and a tripwire. Your job is to watch the flows and say, for the public dashboard, how things stand.

From the METRICS and EVENTS below, write a short note: the mood (calm, watch or alert), a headline (at most 90 characters), a body of two to four sentences, and up to three things to watch next (a withdrawal unlocking, the day's cap, the guard's gas runway). Use only the numbers given; say "about" for estimates. Plain, precise, calm; no hype, no emoji. A drill (a staged hijack) is a test that worked, not an attack. Answer with JSON only.`;

const N = (x: unknown) => Number(x ?? 0);
const u6 = (x: unknown) => N(x) / 1e6;
const since = (iso: string, ms: number) => Date.parse(iso) > Date.now() - ms;

/** The numbers and events the note is written from, out of the live demo's feed. */
export function metrics(feed: any) {
  const u = feed.umbrella ?? {}, a = feed.account ?? {}, fuel = feed.fuel ?? {};
  const hour = 3_600_000;
  const decisions = (feed.guard ?? []).filter((e: any) => e.kind === "decision");
  const lastHour = decisions.filter((e: any) => since(e.at, hour));
  const gas = u6(N(fuel.guardWei) / 1e12), per = fuel.perDecisionWei ? N(fuel.perDecisionWei) / 1e18 : 0.12;
  const signed24 = N(feed.stats?.decisions?.signed24h);
  const events = [
    ...lastHour.filter((e: any) => !e.decision?.signed).map((e: any) => ({ at: e.at, what: e.decision?.struck ? "refused and struck" : "refused", why: e.claim?.why, reason: e.decision?.reason, by: e.claim?.by })),
    ...(feed.autopilot ?? []).filter((e: any) => since(e.at, hour) && ["holding", "timeout", "pacing", "topped-up", "error", "paused"].includes(e.kind))
      .map((e: any) => ({ at: e.at, what: e.kind, reason: e.reason ?? e.error ?? e.mode, step: e.step?.kind })),
  ];
  return {
    at: feed.generatedAt,
    feedAgeMin: Math.round((Date.now() - Date.parse(feed.generatedAt)) / 60000),
    umbrella: { id: u.id, spentUsd: u6(u.spentUsd6), budgetUsd: u6(u.budgetUsd6), spentTodayUsd: u6(u.spentTodayUsd6), dailyCapUsd: u.dailyCapUsd6 ? u6(u.dailyCapUsd6) : undefined, tripped: !!u.tripped, strikes: N(u.strikes) },
    balances: { xrp: u6(a.xrpDrops), fxrp: u6(a.fxrp), shares: u6(a.shares), pendingFxrp: u6(a.pendingFxrp) },
    vault: feed.vault ? { period: N(feed.vault.period), queue: (feed.vault.queue ?? []).map((w: any) => ({ fxrp: u6(w.assets), claimable: w.claimable, unlocksInMin: Math.max(0, Math.round((N(w.unlocksAt) * 1000 - Date.now()) / 60000)) })) } : undefined,
    guardGas: { c2flr: +gas.toFixed(2), perDecision: +per.toFixed(4), signedLast24h: signed24, runwayDays: signed24 ? +(gas / (signed24 * per)).toFixed(1) : undefined },
    lastHour: { decisions: lastHour.length, cosigned: lastHour.filter((e: any) => e.decision?.signed).length, usd: +lastHour.reduce((n: number, e: any) => n + (e.decision?.signed ? u6(e.decision?.usd6) : 0), 0).toFixed(2) },
    xrpUsd: feed.xrpUsd6 ? u6(feed.xrpUsd6) : undefined,
    events,
  };
}

/** A note written by the rules, when no model can: honest and short. */
export function rulesNote(m: ReturnType<typeof metrics>) {
  const alert = m.umbrella.tripped || m.feedAgeMin > 30 || (m.guardGas.c2flr > 0 && m.guardGas.c2flr < 5);
  const watch = !alert && (m.events.length > 0 || m.guardGas.c2flr < 25);
  const head = m.umbrella.tripped ? "Tripped: every rail is shut until the owner re-arms." : m.feedAgeMin > 30 ? "The server has been quiet for a while."
    : `${m.lastHour.cosigned} steps co-signed this hour, $${m.lastHour.usd.toFixed(2)} moved.`;
  const next = m.vault?.queue?.find((w: any) => !w.claimable);
  const $ = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  return {
    mood: alert ? "alert" : watch ? "watch" : "calm", headline: head,
    body: `Today ${$(m.umbrella.spentTodayUsd)}${m.umbrella.dailyCapUsd ? ` of a ${$(m.umbrella.dailyCapUsd, 0)} day` : ""}; the umbrella has ${$(m.umbrella.budgetUsd - m.umbrella.spentUsd, 0)} left. The guard has ${m.guardGas.c2flr} C2FLR of gas${m.guardGas.runwayDays ? `, about ${m.guardGas.runwayDays} days at this pace` : ""}.`,
    watch: next ? [`${next.fxrp.toFixed(2)} FXRP unlocks in about ${Math.round(next.unlocksInMin / 6) / 10} h`] : [],
  };
}

export class Sentinel {
  private last = 0;
  private recent: number[] = [];
  private seen = "";
  constructor(private readonly o: { gemini?: Gemini; models: string[]; feedPath: string; journal: Journal; everyS: number }) {
    // a restart does not owe the page a new note: the hour counts from the last one written
    const last = o.journal.tail(300).find((e) => e.kind === "reflection");
    if (last) this.last = Date.parse(last.at) || 0;
  }

  private feed(): any | undefined {
    try { return existsSync(this.o.feedPath) ? JSON.parse(readFileSync(this.o.feedPath, "utf8")) : undefined; } catch { return undefined; }
  }

  /** Called every minute: an hourly note, or an early one after something unusual (at most three an hour). */
  async tick(): Promise<void> {
    const feed = this.feed(); if (!feed) return;
    const m = metrics(feed), now = Date.now();
    const incident = m.events.map((e) => `${e.at}|${e.what}`).join(",");
    const fresh = incident && incident !== this.seen && m.events.some((e: any) => Date.parse(e.at) > this.last);
    this.recent = this.recent.filter((t) => t > now - 3_600_000);
    const due = now - this.last >= this.o.everyS * 1000 || (fresh && now - this.last > 180_000 && this.recent.length < 3);
    if (!due) return;
    this.seen = incident; this.last = now; this.recent.push(now);
    let note: any, by = "rules", model: string | undefined;
    if (this.o.gemini) {
      try {
        const r = await this.o.gemini.generate(this.o.models, { system: SENTINEL_SYSTEM, contents: [{ role: "user", parts: [{ text: JSON.stringify({ METRICS: m, EVENTS: m.events }) }] }], json: SENTINEL_SCHEMA, maxOutputTokens: 2048, thinking: "low" }, 45_000, { share: 0.5 });
        note = jsonOf(r.text); by = "ai"; model = r.model;
      } catch (e) { this.o.journal.append("error", { where: "sentinel", error: String((e as Error).message).slice(0, 240) }); }
    }
    if (!note?.headline) note = rulesNote(m);
    this.o.journal.append("reflection", {
      mood: ["calm", "watch", "alert"].includes(note.mood) ? note.mood : "calm",
      headline: String(note.headline).slice(0, 110), body: String(note.body ?? "").slice(0, 600),
      watch: (Array.isArray(note.watch) ? note.watch : []).slice(0, 3).map((w: unknown) => String(w).slice(0, 120)), by, model,
    });
  }
}
