/**
 * Lancea's brain, as a service on the demo's server. It thinks with Google's Gemini on the free tier and
 * holds no key of the live demo: it reads the demo's feed, it answers people, it acts in the playground
 * (whose agent key it holds, half of what a payment needs), and it advises the live autopilot, whose
 * every step the guard still prices and co-signs or refuses.
 *
 *   public    127.0.0.1:8790, reached through a Cloudflare quick tunnel (https://….trycloudflare.com, no
 *             account, no open port): /api/health, /api/state, POST /api/chat → a job, GET /api/job/:id
 *             (polled: quick tunnels carry no event streams)
 *   internal  127.0.0.1:8791, for the autopilot only: POST /decide
 *   loops     the Sentinel (every minute: an hourly note, or an early one after an incident), the
 *             playground (every 20 s: re-arm after a trip, faucet top-ups), brain.json (every 20 s)
 *
 * The Gemini key is $LANCEA_KEYS/gemini (mode 600). Everything a visitor types goes to Google's free tier,
 * which may use it to improve Google's products: the page says so.
 *
 *   LANCEA_CONFIG=… LANCEA_KEYS=… node --import tsx src/brain/server.ts           run
 *   LANCEA_CONFIG=… LANCEA_KEYS=… node --import tsx src/brain/server.ts --check   test the key and the models
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { COSTON2, coston2 } from "../flare.js";
import { short } from "../guard.js";
import { XrplHttp } from "../xrpl-http.js";
import { Journal } from "../service/journal.js";
import { loadConfig, loadSecret, type BrainConfig, type LanceaConfig } from "../service/config.js";
import { Assistant, type ChatEvent, type Mode, type Turn } from "./assistant.js";
import { ChainTools, printable } from "./chain-tools.js";
import { Gemini, jsonOf, listModels, modelName, resolveChain } from "./gemini.js";
import { brief, Library, type BriefFacts } from "./knowledge.js";
import { Limits, visitor } from "./limits.js";
import { PILOT_SCHEMA, PILOT_SYSTEM, type PilotAnswer } from "./pilot.js";
import { Playground } from "./playground.js";
import { Sentinel } from "./sentinel.js";

/**
 * Free-tier models only (Flash and Flash-Lite; Pro is not free). A spent quota hands over to the next.
 * The Flash models think better and allow ~20 requests a day each: they answer the deep questions. The
 * Flash-Lite ones allow hundreds: quick answers, the pilot and the Sentinel, which may use half a day's
 * quota at most, so visitors always find some left.
 */
export const BRAIN_DEFAULTS = {
  port: 8790,
  internalPort: 8791,
  models: {
    quick: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"],
    deep: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-flash-latest"],
    pilot: ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"],
    sentinel: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"],
  },
  thinking: { quick: "low", deep: "medium", pilot: "low" } as { quick?: string; deep?: string; pilot?: string; sentinel?: string },
  origins: ["https://dziuba0x.github.io"],
  reflectEveryS: 3600,
  knowledge: [
    ["Lancea · README", "README.md"], ["Lancea · live runs", "docs/runs.md"], ["Flare, for Lancea", "docs/knowledge/flare.md"],
    ["DELICTI · overview", "../delicti/llms.txt"], ["DELICTI · README", "../delicti/README.md"], ["DELICTI · SPEC", "../delicti/SPEC.md"],
    ["DELICTI · deployments", "../delicti/docs/DEPLOYMENTS.md"], ["DELICTI · SUMMA (amendment v1.1)", "../delicti/docs/amendments/v1.1-summa.md"],
    ["DELICTI · the tripwire (amendment v1.2)", "../delicti/docs/amendments/v1.2-conatus.md"], ["DELICTI · watch pool v2", "../delicti/docs/v2/watch-pool.md"],
  ] as [string, string][],
  limits: {
    chatPerIp: [10, 600] as [number, number], chatPerIpDay: 60, chatGlobal: [8, 60] as [number, number], chatGlobalDay: 900,
    actPerIp: [1, 90] as [number, number], actPerIpDay: 12, actGlobal: [20, 3600] as [number, number],
  },
};

export type Chains = { quick: string[]; deep: string[]; pilot: string[]; sentinel: string[] };

/** What each mode would answer with now, for the page: the model, and about how many answers are left today. */
export function modesOf(gemini: Gemini, chains: Chains) {
  const one = (models: string[]) => { const s = gemini.status(models); return { model: s.model, name: s.model ? modelName(s.model) : undefined, left: s.left, approx: s.approx, until: s.until }; };
  return { quick: one(chains.quick), deep: one(chains.deep) };
}
const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));

// ------------------------------------------------------------------------------------------------ http

async function readBody(req: IncomingMessage, max = 8192): Promise<string> {
  let n = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    n += (chunk as Buffer).length;
    if (n > max) throw Object.assign(new Error("too large"), { status: 413 });
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

/** The visitor, as Cloudflare saw them (the server listens on 127.0.0.1: every request comes through the tunnel),
 *  counted by address, or by /64 for IPv6. */
const ipOf = (req: IncomingMessage) => visitor(String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?").slice(0, 64));

interface Job { events: ChatEvent[]; done: boolean; at: number; ctl: AbortController; turn: Turn }

export interface PublicApiOptions {
  assistant?: Assistant;
  limits: Limits;
  origins: string[];
  limitsCfg: typeof BRAIN_DEFAULTS.limits;
  health: () => Record<string, unknown>;
  state: () => Promise<Record<string, unknown>>;
  /** What each mode would answer with now (shown above the conversation). */
  modes?: () => Record<string, unknown>;
  journal?: Journal;
  /** Conversations thinking at the same time, at most. */
  maxRunning?: number;
}

/** The public API. Every answer is JSON; CORS only for the dashboard's origins. */
export function publicApi(o: PublicApiOptions): Server {
  const jobs = new Map<string, Job>();
  let running = 0;
  const L = o.limitsCfg;
  const sweep = () => { const old = Date.now() - 10 * 60_000; for (const [id, j] of jobs) if (j.at < old) jobs.delete(id); };

  const note = (kind: string, fields: Record<string, unknown>) => { try { o.journal?.append(kind, fields); } catch { /* a full disk is not the visitor's problem */ } };
  return createServer(async (req, res) => {
    const origin = String(req.headers.origin ?? "");
    const allowed = o.origins.includes(origin);
    const cors: Record<string, string> = allowed
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "Origin" }
      : { vary: "Origin" };
    try {
      const url = new URL(req.url ?? "/", "http://brain");
      const ip = ipOf(req);
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (req.method === "GET" && url.pathname === "/api/health") return reply(res, 200, o.health(), cors);
      if (req.method === "GET" && url.pathname === "/api/state") {
        if (!o.limits.take(`state:${ip}`, 30, 60_000) || !o.limits.take("state:all", 240, 60_000)) return reply(res, 429, { error: "slow down", retryInS: 10 }, cors);
        return reply(res, 200, { ...(await o.state()), modes: o.modes?.() }, cors);
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        // only the dashboard talks to the brain: another site cannot spend its free thinking from its visitors' browsers
        if (!allowed) return reply(res, 403, { error: "the agent talks on its own page: https://dziuba0x.github.io/lancea/#agent" }, cors);
        if (!o.assistant) return reply(res, 503, { error: "the assistant is resting" }, cors);
        let b: { session?: unknown; message?: unknown; mode?: unknown };
        try { b = JSON.parse(await readBody(req)); } catch (e) { return reply(res, (e as { status?: number }).status ?? 400, { error: "a JSON body: {session, message, mode}" }, cors); }
        const message = typeof b.message === "string" ? b.message.trim() : "";
        const mode: Mode = b.mode === "quick" || b.mode === "deep" ? b.mode : "auto";
        if (!message || message.length > 1200) return reply(res, 400, { error: "a message of 1 to 1200 characters" }, cors);
        const session = typeof b.session === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.session) ? b.session : randomUUID();
        const [n, s] = L.chatPerIp, [gn, gs] = L.chatGlobal;
        const waits = [o.limits.wait(`chat:${ip}`, n, s * 1000), o.limits.wait(`chatday:${ip}`, L.chatPerIpDay, 86_400_000),
          o.limits.wait("chat:all", gn, gs * 1000), o.limits.wait("chatday:all", L.chatGlobalDay, 86_400_000)];
        const wait = Math.max(...waits);
        if (wait > 0) {
          const why = waits[1] > 0 ? "that is today's share of conversations for you" : waits[3] > 0 ? "the brain has used today's free thinking" : waits[2] > 0 ? "many people are talking to the agent right now" : "a few questions at a time, please";
          return reply(res, 429, { error: why, retryInS: wait }, cors);
        }
        if (running >= (o.maxRunning ?? 4)) return reply(res, 429, { error: "the agent is answering others right now", retryInS: 5 }, cors);
        o.limits.take(`chat:${ip}`, n, s * 1000); o.limits.take(`chatday:${ip}`, L.chatPerIpDay, 86_400_000);
        o.limits.take("chat:all", gn, gs * 1000); o.limits.take("chatday:all", L.chatGlobalDay, 86_400_000);
        sweep();
        const id = randomUUID(), ctl = new AbortController(), job: Job = { events: [], done: false, at: Date.now(), ctl, turn: { signal: ctl.signal } };
        jobs.set(id, job);
        running++;
        const t0 = Date.now(), tools: string[] = [];
        let model = "", depth = "";
        o.assistant.chat(session, message, ip, (e) => {
          if (e.t === "tool") tools.push(e.name);
          if (e.t === "answer") model = e.model;
          if (e.t === "route") depth = e.mode;
          job.events.push(e);
          if (e.t === "done") job.done = true;
        }, mode, job.turn).catch((e) => { job.events.push({ t: "error", text: "Something went wrong on my side. Try again in a moment." }, { t: "done" }); job.done = true; note("error", { where: "chat", error: short(e) }); })
          .finally(() => { running--; note("chat", { ms: Date.now() - t0, model, mode, depth, tools, answered: job.events.some((e) => e.t === "answer"), stopped: job.events.some((e) => e.t === "stopped") }); });
        return reply(res, 202, { job: id, session }, cors);
      }
      // stop a conversation that is still thinking: only between its steps, never once a proposal has left
      const c = /^\/api\/job\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
      if (req.method === "POST" && c) {
        if (!allowed) return reply(res, 403, { error: "the agent talks on its own page" }, cors);
        const job = jobs.get(c[1]);
        if (!job) return reply(res, 404, { error: "no such job (they last ten minutes)" }, cors);
        if (job.done) return reply(res, 409, { stopped: false, why: "it has already answered" }, cors);
        if (job.turn.committed) return reply(res, 409, { stopped: false, why: "a proposal is already with the guard: it cannot be taken back" }, cors);
        job.ctl.abort();
        return reply(res, 200, { stopped: true }, cors);
      }
      const m = /^\/api\/job\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const job = jobs.get(m[1]);
        if (!job) return reply(res, 404, { error: "no such job (they last ten minutes)" }, cors);
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        return reply(res, 200, { events: job.events.slice(after), next: job.events.length, done: job.done }, cors);
      }
      return reply(res, 404, { error: "not here" }, cors);
    } catch (e) {
      return reply(res, 500, { error: "the brain tripped over that one" }, cors);
    }
  });
}

/** The autopilot's door: 127.0.0.1 only, never tunnelled. */
export function internalApi(o: { decide: (ctx: Record<string, unknown>) => Promise<PilotAnswer> }): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/decide") {
        const ctx = JSON.parse(await readBody(req, 64 * 1024));
        return reply(res, 200, await o.decide(ctx));
      }
      return reply(res, 404, { error: "not here" });
    } catch (e) {
      return reply(res, 503, { error: short(e) });
    }
  });
}

// ------------------------------------------------------------------------------------------------ the pilot

/** What the live demo's feed adds to a step's context: the price, the leash, the fuel, the latest verdicts, the Sentinel. */
export function pilotExtras(f: any) {
  if (!f || typeof f !== "object") return {};
  const u6 = (x: unknown) => (x === undefined || x === null ? undefined : Number(x) / 1e6);
  const u = f.umbrella ?? {};
  const wei = (x: unknown) => (x ? Number(BigInt(String(x)) / 10n ** 14n) / 1e4 : undefined);
  return {
    market: { xrpUsd: u6(f.xrpUsd6) },
    leash: {
      spentTodayUsd: u6(u.spentTodayUsd6), dailyCapUsd: u6(u.dailyCapUsd6),
      budgetLeftUsd: u.budgetUsd6 !== undefined ? (Number(u.budgetUsd6) - Number(u.spentUsd6 ?? 0)) / 1e6 : undefined,
      tripped: u.tripped, strikes: u.strikes,
    },
    fuel: { guardC2flr: wei(f.fuel?.guardWei), perDecisionC2flr: wei(f.fuel?.perDecisionWei), pacing: f.fuel?.pacing },
    recentVerdicts: (f.guard ?? []).filter((e: any) => e.kind === "decision").slice(0, 5).map((e: any) => ({
      at: e.at, step: e.claim?.intent?.kind, verdict: e.decision?.signed ? "co-signed" : e.decision?.struck ? "struck" : "refused",
      ...(e.decision?.signed ? {} : { reason: String(e.decision?.reason ?? "").slice(0, 160) }),
    })),
    sentinel: f.brain?.reflections?.[0] ? { mood: f.brain.reflections[0].mood, headline: f.brain.reflections[0].headline, watch: f.brain.reflections[0].watch } : undefined,
  };
}

/** Text that strangers attached to payments into an account: shown to the pilot as untrusted NOTES. */
export function ledgerNotes(xrpl: XrplHttp, account: string, everyMs = 120_000) {
  let cache: { at: number; notes: { from: string; text: string; at?: string }[] } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < everyMs) return cache.notes;
    const notes: { from: string; text: string; at?: string }[] = [];
    try {
      // a busy node must not hold the pilot up: six seconds, or no notes this time
      const r: any = await Promise.race([
        xrpl.rpc("account_tx", { account, ledger_index_min: -1, ledger_index_max: -1, limit: 40, forward: false }),
        new Promise((_, no) => setTimeout(() => no(new Error("slow")), 5000).unref()),
      ]);
      for (const w of r.transactions ?? []) {
        const tx = w.tx ?? w.tx_json ?? {};
        if (tx.TransactionType !== "Payment" || tx.Destination !== account || tx.Account === account) continue;
        for (const m of tx.Memos ?? []) {
          const text = m.Memo?.MemoData ? printable(m.Memo.MemoData) : undefined;
          if (text && /[A-Za-z]{3}/.test(text)) notes.push({ from: tx.Account, text: text.slice(0, 140), at: w.close_time_iso });
        }
        if (notes.length >= 5) break;
      }
    } catch { /* a busy node: no notes this time */ }
    cache = { at: Date.now(), notes };
    return notes;
  };
}

export interface PilotStats { asked: number; answered: number; failed: number; model?: string; at?: string }

/** The autopilot's advisor: the model picks a step from the candidates it is shown, as JSON. */
export function pilotDecider(o: { gemini: Gemini; models: () => string[]; thinking?: string; feed: () => any; notes: () => Promise<unknown[]>; stats: PilotStats; minGapMs?: number; perModelMs?: number; budgetMs?: number }) {
  let last = 0;
  return async (ctx: Record<string, unknown>): Promise<PilotAnswer> => {
    if (Date.now() - last < (o.minGapMs ?? 20_000)) throw new Error("asked again too soon"); // the autopilot ticks every five minutes
    last = Date.now();
    o.stats.asked++;
    try {
      const t0 = Date.now();
      const context = { ...ctx, ...pilotExtras(o.feed()), NOTES: await o.notes() };
      // the autopilot waits 45 s: every model the chain tries must fit inside that
      const r = await o.gemini.generate(o.models(), {
        system: PILOT_SYSTEM, contents: [{ role: "user", parts: [{ text: JSON.stringify(context) }] }], json: PILOT_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 2048, thinking: o.thinking,
        deadline: t0 + (o.budgetMs ?? 36_000),
      }, o.perModelMs ?? 12_000, { share: 0.5 });
      const a = jsonOf<PilotAnswer>(r.text);
      if (!a || typeof a.action !== "string") throw new Error("no action in the answer");
      o.stats.answered++; o.stats.model = r.model; o.stats.at = new Date().toISOString();
      return { action: a.action, amount: typeof a.amount === "number" ? a.amount : undefined, why: String(a.why ?? ""), model: r.model };
    } catch (e) {
      o.stats.failed++;
      throw e;
    }
  };
}

// ------------------------------------------------------------------------------------------------ the tunnel

/** A quick tunnel's address in cloudflared's log (never the API it asks for one). */
export const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/**
 * cloudflared, kept running: a new quick tunnel (and a new address) whenever it exits or stops answering.
 * The address goes into brain.json; the feed carries it to the dashboard within a minute.
 */
export class Tunnel {
  url?: string;
  since?: string;
  private child?: ChildProcess;
  private backoff = 15_000;
  private fails = 0;
  private stopped = false;
  constructor(private readonly bin: string, private readonly port: number, private readonly log: (s: string) => void,
    private readonly f: typeof fetch = fetch, private readonly spawnFn: typeof spawn = spawn) {}

  start() {
    if (this.stopped) return;
    const child = this.spawnFn(this.bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const scan = (buf: Buffer) => {
      const m = TUNNEL_URL.exec(buf.toString("utf8"));
      if (m && m[0] !== this.url) { this.url = m[0]; this.since = new Date().toISOString(); this.fails = 0; this.backoff = 15_000; this.log(`tunnel: ${this.url}`); }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (e) => this.log(`tunnel: cloudflared did not start (${e.message})`));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.url = undefined; this.child = undefined;
      if (this.stopped) return;
      this.log(`tunnel: cloudflared exited (${code}); again in ${this.backoff / 1000} s`);
      setTimeout(() => this.start(), this.backoff).unref();
      this.backoff = Math.min(this.backoff * 2, 300_000);
    });
  }

  /** From outside, through Cloudflare: three misses in a row and the tunnel starts over (with a new address). */
  async check(): Promise<void> {
    if (!this.url || !this.child) return;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await this.f(`${this.url}/api/health`, { signal: ctl.signal });
      if (!r.ok) throw new Error(String(r.status));
      this.fails = 0;
    } catch (e) {
      if (++this.fails >= 3) { this.log(`tunnel: ${this.url} stopped answering; a new one`); this.fails = 0; this.child.kill("SIGTERM"); }
    } finally { clearTimeout(t); }
  }

  stop() { this.stopped = true; this.child?.kill("SIGTERM"); }
}

// ------------------------------------------------------------------------------------------------ the service

/** Who is who, for the assistant's explanations: every address of both setups, named. */
export function labelsOf(c: LanceaConfig, p?: LanceaConfig): Map<string, string> {
  const m = new Map<string, string>();
  const put = (a: string | undefined, name: string) => { if (a) m.set(a.toLowerCase(), name); };
  for (const [cfg, who] of [[c, "the live demo's"], [p, "the playground's"]] as const) {
    if (!cfg) continue;
    put(cfg.account, `${who} guarded XRPL account`);
    put(cfg.smartAccounts.personalAccount, `${who} personal account on Flare`);
    put(cfg.keys?.agentXrpl, `${who} agent key (weight 1)`);
    put(cfg.keys?.guardXrpl, `${who} guard key (weight 1)`);
    put(cfg.keys?.guardFlare, `${who} guard on Flare (it pays for every reservation and strike)`);
    put(cfg.agentEvm, `${who} agent on Flare`);
    put(cfg.smartAccounts.coreVault, "the FAssets Core Vault (direct minting)");
    for (const op of cfg.smartAccounts.operators) put(op, "a Flare Smart Accounts operator wallet");
    put(cfg.smartAccounts.vault, `the ${cfg.smartAccounts.vaultName ?? "Firelight"} vault (FXRP)`);
    put(cfg.smartAccounts.fxrp, "FXRP, the FAsset for XRP");
  }
  put(c.umbrella.meter, "DELICTI's SummaMeter (the dollar tally across rails)");
  put(c.umbrella.registry, "DELICTI's MandateRegistry (umbrellas and mandates)");
  put(COSTON2.summaVault, "DELICTI's VaultSumma (bonds)");
  put(COSTON2.masterAccountController, "Flare Smart Accounts' MasterAccountController");
  put(COSTON2.assetManagerFxrp, "the FAssets AssetManager for FXRP");
  return m;
}

export function factsOf(c: LanceaConfig, p: LanceaConfig | undefined, feed: any, rearmAfterS: number): BriefFacts {
  const u = feed?.umbrella ?? {};
  return {
    account: c.account, personalAccount: c.smartAccounts.personalAccount, umbrella: c.umbrella.id,
    budgetUsd: u.budgetUsd6 ? Number(u.budgetUsd6) / 1e6 : 30_000,
    dailyCapUsd: c.guard.dailyCapUsd6 ? Number(c.guard.dailyCapUsd6) / 1e6 : undefined,
    guardXrpl: c.keys?.guardXrpl, guardFlare: c.keys?.guardFlare, agentXrpl: c.keys?.agentXrpl,
    meter: c.umbrella.meter, registry: c.umbrella.registry,
    playground: p ? {
      account: p.account, umbrella: p.umbrella.id, rearmAfterS,
      dailyCapUsd: p.guard.dailyCapUsd6 ? Number(p.guard.dailyCapUsd6) / 1e6 : undefined,
      newPayeeCapUsd: p.guard.newPayeeCapUsd6 ? Number(p.guard.newPayeeCapUsd6) / 1e6 : undefined,
    } : undefined,
  };
}

export function brainConfig(c: LanceaConfig) {
  const b: BrainConfig = c.brain ?? { port: BRAIN_DEFAULTS.port, internalPort: BRAIN_DEFAULTS.internalPort };
  const D = BRAIN_DEFAULTS;
  return {
    port: b.port ?? D.port, internalPort: b.internalPort ?? D.internalPort, pilot: b.pilot ?? false,
    models: { quick: b.models?.quick ?? D.models.quick, deep: b.models?.deep ?? b.models?.chat ?? D.models.deep, pilot: b.models?.pilot ?? D.models.pilot, sentinel: b.models?.sentinel ?? D.models.sentinel },
    thinking: { ...D.thinking, ...(b.thinking ?? {}) },
    origins: b.origins ?? D.origins, tunnel: b.tunnel ?? "quick", cloudflared: expand(b.cloudflared ?? "~/bin/cloudflared"),
    reflectEveryS: b.reflectEveryS ?? D.reflectEveryS, knowledge: b.knowledge ?? D.knowledge,
    playground: b.playground, limits: { ...D.limits, ...(b.limits ?? {}) },
  };
}

function readJson(path: string): any {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}

function writeAtomic(path: string, body: string) {
  writeFileSync(`${path}.tmp`, body);
  renameSync(`${path}.tmp`, path);
}

async function main() {
  const check = process.argv.includes("--check");
  const c = loadConfig();
  const b = brainConfig(c);
  const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
  process.on("unhandledRejection", (e) => log(`unhandled: ${short(e)}`)); // logged, and the brain goes on
  let key: string;
  try { key = loadSecret("gemini"); } catch (e) {
    throw new Error(`no Gemini key: put it in $LANCEA_KEYS/gemini, mode 600 (${short(e)})`);
  }
  const base = process.env.GEMINI_BASE ?? "https://generativelanguage.googleapis.com/v1beta"; // another only for tests
  const gemini = new Gemini(key, fetch, base, { usagePath: check ? undefined : join(c.dataDir, "gemini-usage.json") });
  let available: string[] | undefined;
  try { available = await listModels(key, fetch, base); } catch (e) { log(`models: the listing failed (${short(e)}), the chains stay as configured`); }
  const chains: Chains = {
    quick: resolveChain(b.models.quick, available, true),
    deep: resolveChain(b.models.deep, available),
    pilot: resolveChain(b.models.pilot, available, true),
    sentinel: resolveChain(b.models.sentinel, available, true),
  };
  const journal = new Journal(join(c.dataDir, "brain.jsonl"));
  const feedPath = join(c.dataDir, "feed.json");
  const feed = () => readJson(feedPath);
  const library = new Library();
  const docs = library.addFiles(b.knowledge.map(([label, path]) => [label, expand(path)]));
  const xrpl = new XrplHttp(c.network.xrplRpc);
  const pc = createPublicClient({ chain: coston2(c.network.rpcUrl), transport: http(c.network.rpcUrl) }) as unknown as PublicClient;

  let playground: Playground | undefined, pcfg: LanceaConfig | undefined;
  const rearmAfterS = b.playground?.rearmAfterS ?? 300;
  if (b.playground && existsSync(expand(b.playground.config))) {
    pcfg = loadConfig(expand(b.playground.config));
    const dir = expand(b.playground.keys);
    playground = new Playground(pcfg, {
      agent: JSON.parse(loadSecret("agent.json", dir)), token: loadSecret("token", dir), principal: loadSecret("principal", dir) as Hex,
    }, { rearmAfterS, keepXrp: b.playground.keepXrp ?? 50, refillXrp: b.playground.refillXrp ?? 100, minGuardC2flr: b.playground.minGuardC2flr ?? 1.5 }, journal);
  }
  const briefText = () => brief(factsOf(c, pcfg, feed(), rearmAfterS));
  const chain = new ChainTools(pc, xrpl, labelsOf(c, pcfg));
  const venues = [c, pcfg].filter((x): x is LanceaConfig => !!x).map((x) => ({ operators: x.smartAccounts.operators, coreVault: x.smartAccounts.coreVault }));
  const limits = new Limits();
  const L = b.limits;
  const assistant = new Assistant({
    gemini, models: { quick: chains.quick, deep: chains.deep }, thinking: { quick: b.thinking.quick, deep: b.thinking.deep }, library, playground, feedPath, brief: briefText, chain, venues, journal, limits,
    actionLimit: { perIp: [L.actPerIp[0], L.actPerIp[1] * 1000], perIpDay: L.actPerIpDay, global: [L.actGlobal[0], L.actGlobal[1] * 1000] },
  });
  const pilotStats: PilotStats = { asked: 0, answered: 0, failed: 0 };
  const decide = pilotDecider({ gemini, models: () => chains.pilot, thinking: b.thinking.pilot, feed, notes: ledgerNotes(xrpl, c.account), stats: pilotStats });

  if (check) return runCheck({ key, available, chains, gemini, assistant, decide, playground, docs, library });

  const sentinel = new Sentinel({ gemini, models: chains.sentinel, feedPath, journal, everyS: b.reflectEveryS });
  const startedAt = new Date().toISOString();
  let tunnel: Tunnel | undefined;
  let pgState: Record<string, unknown> | undefined;
  const modes = () => modesOf(gemini, chains);
  const health = () => ({ ok: true, name: "Lancea's brain", since: startedAt, models: chains, modes: modes(), playground: !!playground, docs: library.chunks.length });
  const pub = publicApi({
    assistant, limits, origins: b.origins, limitsCfg: L, health, journal, modes,
    state: async () => ({ playground: playground ? await playground.state().catch(() => pgState) : undefined, at: new Date().toISOString() }),
  });
  const internal = internalApi({ decide });
  await new Promise<void>((r) => pub.listen(b.port, "127.0.0.1", r));
  await new Promise<void>((r) => internal.listen(b.internalPort, "127.0.0.1", r));
  if (playground) await playground.start();
  if (b.tunnel === "quick") {
    if (existsSync(b.cloudflared)) { tunnel = new Tunnel(b.cloudflared, b.port, log); tunnel.start(); }
    else log(`tunnel: no cloudflared at ${b.cloudflared}; the public API stays on 127.0.0.1:${b.port}`);
  }
  journal.append("start", { models: chains, docs: library.chunks.length, playground: pcfg?.account, pilot: b.pilot });
  log(`lancea brain: public 127.0.0.1:${b.port}, internal 127.0.0.1:${b.internalPort} | quick ${chains.quick.join(" > ")} | deep ${chains.deep.join(" > ")} | pilot ${chains.pilot.join(" > ")} | sentinel ${chains.sentinel.join(" > ")} | ${library.chunks.length} passages from ${docs} documents${playground ? ` | playground ${pcfg!.account}` : ""}`);

  const status = () => writeAtomic(join(c.dataDir, "brain.json"), JSON.stringify({
    url: tunnel?.url, tunnelSince: tunnel?.since, startedAt, updatedAt: new Date().toISOString(),
    models: chains, modes: modes(), usage: Object.fromEntries(gemini.used), pilot: { on: b.pilot, ...pilotStats }, playground: pgState,
  }));
  const busy = new Set<string>();
  const loop = (name: string, everyMs: number, f: () => Promise<unknown>) => {
    const run = async () => {
      if (busy.has(name)) return;
      busy.add(name);
      try { await f(); } catch (e) { log(`${name}: ${short(e)}`); } finally { busy.delete(name); }
    };
    void run();
    return setInterval(run, everyMs);
  };
  const timers = [
    loop("status", 20_000, async () => {
      status(); // first: a slow node must not make the page think the brain is gone
      if (playground) pgState = await Promise.race([playground.state().catch(() => pgState), new Promise((r) => setTimeout(() => r(pgState), 15_000))]) as Record<string, unknown> | undefined;
    }),
    loop("sentinel", 60_000, () => sentinel.tick()),
    ...(playground ? [loop("playground", 20_000, () => playground!.tend())] : []),
    ...(tunnel ? [loop("tunnel", 300_000, () => tunnel!.check())] : []),
  ];
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    for (const t of timers) clearInterval(t);
    tunnel?.stop();
    pub.close(); internal.close();
    journal.append("stop", {});
    try { writeAtomic(join(c.dataDir, "brain.json"), JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), stopped: true, models: chains })); } catch { /* the disk is not ours to fix now */ }
    process.exit(0);
  });
}

/** `--check`: the key works, the models answer (text, JSON, tools), the playground reads. Prints no secret. */
async function runCheck(o: {
  key: string; available?: string[]; chains: Chains; gemini: Gemini; assistant: Assistant; decide: (ctx: Record<string, unknown>) => Promise<PilotAnswer>;
  playground?: Playground; docs: number; library: Library;
}) {
  const say = (s: string) => console.log(s);
  say(`== the key: ${o.available ? `${o.available.length} models, the free text ones: ${o.available.filter((m) => /flash/.test(m) && !/image|tts|audio|live|embed/.test(m)).join(", ")}` : "the model listing failed"}`);
  say(`== the chains\n   quick     ${o.chains.quick.join(" > ")}\n   deep      ${o.chains.deep.join(" > ")}\n   pilot     ${o.chains.pilot.join(" > ")}\n   sentinel  ${o.chains.sentinel.join(" > ")}`);
  say(`== knowledge: ${o.library.chunks.length} passages from ${o.docs} documents`);
  let ok = true;
  for (const [name, models] of Object.entries(o.chains)) {
    const t0 = Date.now();
    try {
      const r = await o.gemini.generate(models, { system: "Answer in one short line.", contents: [{ role: "user", parts: [{ text: "Say hello to Lancea's server." }] }], maxOutputTokens: 1024 });
      say(`   ${name.padEnd(9)} ${r.model}: "${r.text.slice(0, 70)}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) { ok = false; say(`   ${name.padEnd(9)} FAILED: ${short(e)}`); }
  }
  try {
    const t0 = Date.now();
    const a = await o.decide({ now: new Date().toISOString(), balances: { xrpSpendable: 40, xrpReserveKept: 20, fxrp: 0, vaultShares: 80 }, candidates: [{ kind: "mint", minDrops: "5000000", maxDrops: "9000000" }], rulesWouldDo: { kind: "mint", drops: "9000000" }, rulesReason: "40 XRP idle above the 20 XRP reserve: mint 9 XRP" });
    say(`== the pilot (JSON): ${a.model} → ${a.action} ${a.amount ?? ""} "${a.why.slice(0, 90)}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { ok = false; say(`== the pilot FAILED: ${short(e)}`); }
  const t0 = Date.now(), events: ChatEvent[] = [];
  await o.assistant.chat("check-session-0001", "What is XRP's price on Flare's FTSO right now? One sentence.", "check", (e) => events.push(e));
  const answer = events.find((e) => e.t === "answer") as { text: string; model: string } | undefined;
  const tools = events.filter((e) => e.t === "tool").map((e) => (e as { name: string }).name);
  if (answer) say(`== the assistant (tools: ${tools.join(", ") || "none"}): ${answer.model} "${answer.text.slice(0, 160).replace(/\s+/g, " ")}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  else { ok = false; say(`== the assistant FAILED: ${JSON.stringify(events.filter((e) => e.t === "error")).slice(0, 200)}`); }
  if (o.playground) {
    try {
      const s = await o.playground.state(true);
      say(`== the playground: ${s.account}, umbrella #${s.umbrella}, ${s.xrp} XRP, ${s.tripped ? "TRIPPED" : "armed"}, guard gas ${s.guardC2flr} C2FLR`);
    } catch (e) { say(`== the playground FAILED to read: ${short(e)}`); }
  } else say("== the playground: not configured");
  say(ok ? "== all good" : "== something failed (above)");
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
