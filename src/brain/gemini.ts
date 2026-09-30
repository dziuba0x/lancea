/**
 * Google's Gemini, over plain REST (v1beta generateContent), free tier only. A call names a chain of
 * models: when one answers 429 (its free quota is spent) or 5xx, the next one is asked. Nothing here
 * knows a key's value beyond sending it in the x-goog-api-key header; nothing here signs anything.
 *
 * The free tier is counted per model: requests a minute (RPM) and a day (RPD, reset at midnight Pacific
 * time). The brain keeps its own count, so a model whose day is spent is not asked again until its quota
 * resets, and a model at its minute's limit is passed over for the next one instead of being refused.
 * A 429 is the final word: it says which quota said no (a day's: the model rests until midnight Pacific,
 * and its limit is learned; a minute's: it rests as long as Google asks). The count survives restarts.
 *
 * Gemini 3 models return thought signatures on their parts: the model's turn is always sent back
 * exactly as it came (`content` verbatim), also to another model of the chain, as Google asks.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface Part { text?: string; functionCall?: { name: string; args?: Record<string, unknown>; id?: string }; functionResponse?: { name: string; response: unknown; id?: string }; thoughtSignature?: string; thought?: boolean }
export interface Content { role: "user" | "model"; parts: Part[] }
export interface FunctionDeclaration { name: string; description: string; parameters?: Record<string, unknown> }

export interface GenerateRequest {
  system: string;
  contents: Content[];
  tools?: FunctionDeclaration[];
  /** Ask for JSON that follows this schema (OpenAPI subset) instead of free text. */
  json?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Gemini 3 models only: how hard to think ("minimal", "low", "medium", "high"); left to the model when absent. */
  thinking?: string;
  /** No model is asked after this moment (ms since the epoch): a caller with a deadline of its own. */
  deadline?: number;
}
export interface GenerateResult { model: string; content: Content; text: string; calls: { name: string; args: Record<string, unknown>; id?: string }[]; usage?: { input?: number; output?: number } }

export interface GenerateOptions {
  /** A caller that is not a visitor (the pilot, the Sentinel) may use at most this share of a model's day. */
  share?: number;
  /** Asked first when it can answer: the model that answered the previous round of the same conversation. */
  prefer?: string;
  /** Aborted: the model's answer is not waited for, and no other model is asked. */
  signal?: AbortSignal;
}

export class GeminiError extends Error {
  constructor(message: string, readonly status: number, readonly model: string, readonly quota?: { perDay: boolean; limit?: number; retryMs?: number }) { super(message); }
}

type Fetch = typeof fetch;

/** The free tier's limits, as the key's AI Studio page shows them (September 2026). A model that is not
 *  listed is asked until Google says no, and its day's limit is learned from that 429. */
export const FREE_TIER: Record<string, { rpm: number; rpd: number }> = {
  "gemini-3.8-flash": { rpm: 5, rpd: 20 },
  "gemini-3.7-flash": { rpm: 5, rpd: 20 },
  "gemini-3-flash-preview": { rpm: 5, rpd: 20 },
  "gemini-2.5-flash": { rpm: 5, rpd: 20 },
  "gemini-3.5-flash-lite": { rpm: 15, rpd: 500 },
  "gemini-2.5-flash-lite": { rpm: 10, rpd: 20 },
};

const PT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const ptParts = (t: number) => Object.fromEntries(PT.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
/** The free tier's day: the date in Pacific time. */
export const ptDay = (t = Date.now()) => { const p = ptParts(t); return `${p.year}-${p.month}-${p.day}`; };
/** When the free tier's day starts again: the next midnight, Pacific time. */
export function nextPtMidnight(t = Date.now()): number {
  const p = ptParts(t);
  const into = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + (t % 1000);
  return t - into + 86_400_000;
}

/** What a 429 says: which quota (a day's or a minute's), its limit, and how long Google asks to wait. */
export function quotaOf(body: any): { perDay: boolean; limit?: number; retryMs?: number } {
  let perDay = false, limit: number | undefined, retryMs: number | undefined;
  for (const d of body?.error?.details ?? []) {
    const type = String(d?.["@type"] ?? "");
    if (type.endsWith("QuotaFailure")) for (const v of d.violations ?? []) {
      const id = String(v.quotaId ?? v.quotaMetric ?? "");
      if (/PerDay/i.test(id)) { perDay = true; const n = Number(v.quotaValue); if (Number.isFinite(n) && n > 0) limit = n; }
    }
    if (type.endsWith("RetryInfo")) { const m = /^([\d.]+)s$/.exec(String(d.retryDelay ?? "")); if (m) retryMs = Math.round(Number(m[1]) * 1000); }
  }
  if (!perDay && /per ?day|daily/i.test(String(body?.error?.message ?? ""))) perDay = true;
  return { perDay, limit, retryMs };
}

interface Usage { day: string; used: Record<string, number>; rest: Record<string, number>; learned: Record<string, number> }

export class Gemini {
  /** Calls answered per model in the free tier's day (Pacific time). */
  readonly used = new Map<string, number>();
  private readonly resting = new Map<string, number>();
  private readonly learned = new Map<string, number>();
  private readonly minute = new Map<string, number[]>();
  private readonly noThinking = new Set<string>();
  private day: string;
  private saveT?: NodeJS.Timeout;

  constructor(private readonly key: string, private readonly f: Fetch = fetch, private readonly base = "https://generativelanguage.googleapis.com/v1beta",
    private readonly o: { usagePath?: string; limits?: Record<string, { rpm?: number; rpd?: number }>; now?: () => number } = {}) {
    this.day = ptDay(this.now());
    this.load();
  }

  private now() { return this.o.now?.() ?? Date.now(); }
  /** A model's limits: what Google said in a 429, else the table. */
  limits(model: string): { rpm?: number; rpd?: number } {
    const t = this.o.limits?.[model] ?? FREE_TIER[model] ?? {};
    return { rpm: t.rpm, rpd: this.learned.get(model) ?? t.rpd };
  }
  private rollDay() {
    const d = ptDay(this.now());
    if (d === this.day) return;
    this.day = d; this.used.clear();
    for (const [m, until] of this.resting) if (until <= this.now()) this.resting.delete(m);
    this.save();
  }
  /** Why a model is not asked now, or undefined when it can be. */
  why(model: string, share = 1): string | undefined {
    this.rollDay();
    const now = this.now();
    if ((this.resting.get(model) ?? 0) > now) return "resting";
    const L = this.limits(model), used = this.used.get(model) ?? 0;
    if (L.rpd !== undefined && used >= Math.floor(L.rpd * share)) return share < 1 ? "its share of the day is used" : "its day is used";
    if (L.rpm !== undefined && (this.minute.get(model) ?? []).filter((t) => t > now - 60_000).length >= L.rpm) return "its minute is full";
    return undefined;
  }
  /** What a chain can still do today: the model that would answer now, and about how many answers are left. */
  status(models: string[], share = 1): { model?: string; left: number; approx: boolean; until?: string } {
    let left = 0, approx = false;
    const now = this.now();
    for (const m of models) {
      if ((this.resting.get(m) ?? 0) > now) continue;
      const L = this.limits(m), used = this.used.get(m) ?? 0;
      if (L.rpd === undefined) { approx = true; left += Math.max(0, 20 - used); } else left += Math.max(0, Math.floor(L.rpd * share) - used);
    }
    const model = models.find((m) => !this.why(m, share));
    const soonest = Math.min(...models.map((m) => this.resting.get(m) ?? Infinity));
    return { model, left, approx, ...(model ? {} : { until: new Date(Number.isFinite(soonest) ? Math.max(soonest, now + 60_000) : nextPtMidnight(now)).toISOString() }) };
  }

  /** Ask the first model in the chain that can answer now; on 429 / 5xx / a timeout, the next. */
  async generate(models: string[], r: GenerateRequest, timeoutMs = 45_000, o: GenerateOptions = {}): Promise<GenerateResult> {
    const order = o.prefer && models.includes(o.prefer) ? [o.prefer, ...models.filter((m) => m !== o.prefer)] : models;
    let last: unknown;
    const passed: string[] = [];
    for (const model of order) {
      if (o.signal?.aborted) throw new GeminiError("stopped", 499, model);
      const why = this.why(model, o.share ?? 1);
      if (why) { passed.push(`${model} (${why})`); continue; }
      if (r.deadline && this.now() > r.deadline) { last ??= new GeminiError("no time left to ask another model", 0, model); break; }
      this.stamp(model);
      try {
        const out = await this.once(model, r, timeoutMs, o.signal);
        this.count(model);
        return out;
      } catch (e) {
        last = e;
        if (o.signal?.aborted) throw new GeminiError("stopped", 499, model);
        const g = e instanceof GeminiError ? e : undefined, status = g?.status ?? 0;
        if (status === 429) {
          const q = g?.quota;
          if (q?.perDay) {
            this.resting.set(model, nextPtMidnight(this.now()));
            if (q.limit) this.learned.set(model, q.limit);
            this.used.set(model, Math.max(this.used.get(model) ?? 0, q.limit ?? this.limits(model).rpd ?? 0));
          } else this.resting.set(model, this.now() + Math.min(120_000, Math.max(5_000, q?.retryMs ?? 60_000)));
          this.save();
        } else if (status === 422) { this.count(model); continue; } // this answer came out wrong (a malformed call, cut short): the next model, and nobody rests
        else if (status >= 500 || status === 0) this.resting.set(model, this.now() + 15_000);
        else if (status === 404) this.resting.set(model, this.now() + 3_600_000); // a model that is not there today
        else { this.count(model); throw e; } // a request the API refuses: another model would refuse it too
      }
    }
    throw last instanceof Error ? last : new GeminiError(`every model in the chain is resting: ${passed.join(", ") || "none asked"}`, 429, "", { perDay: false });
  }

  private stamp(model: string) {
    const now = this.now(), ts = (this.minute.get(model) ?? []).filter((t) => t > now - 60_000);
    ts.push(now); this.minute.set(model, ts);
  }
  private count(model: string) { this.rollDay(); this.used.set(model, (this.used.get(model) ?? 0) + 1); this.save(); }

  private load() {
    const p = this.o.usagePath;
    if (!p || !existsSync(p)) return;
    try {
      const u = JSON.parse(readFileSync(p, "utf8")) as Usage;
      if (u.day === this.day) for (const [m, n] of Object.entries(u.used ?? {})) this.used.set(m, Number(n) || 0);
      for (const [m, t] of Object.entries(u.rest ?? {})) if (Number(t) > this.now()) this.resting.set(m, Number(t));
      for (const [m, n] of Object.entries(u.learned ?? {})) if (Number(n) > 0) this.learned.set(m, Number(n));
    } catch { /* a torn file: counted afresh, and Google's 429s correct it */ }
  }
  private save() {
    const p = this.o.usagePath;
    if (!p || this.saveT) return;
    this.saveT = setTimeout(() => {
      this.saveT = undefined;
      const u: Usage = { day: this.day, used: Object.fromEntries(this.used), rest: Object.fromEntries(this.resting), learned: Object.fromEntries(this.learned) };
      try { writeFileSync(`${p}.tmp`, JSON.stringify(u)); renameSync(`${p}.tmp`, p); } catch { /* the count lives on in memory */ }
    }, 1000);
    this.saveT.unref?.();
  }

  private async once(model: string, r: GenerateRequest, timeoutMs: number, signal?: AbortSignal): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: r.system }] },
      contents: r.contents,
      generationConfig: {
        maxOutputTokens: r.maxOutputTokens ?? 4096,
        ...(r.json ? { responseMimeType: "application/json", responseSchema: r.json } : {}),
        ...(r.thinking && /^gemini-3/.test(model) && !this.noThinking.has(model) ? { thinkingConfig: { thinkingLevel: r.thinking } } : {}),
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      ],
    };
    if (r.tools?.length) {
      body.tools = [{ functionDeclarations: r.tools }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    const stop = () => ctl.abort();
    signal?.addEventListener("abort", stop, { once: true });
    let res: Response, raw: string;
    try {
      res = await this.f(`${this.base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
      });
      raw = await res.text(); // the body too, inside the same time limit
    } catch (e) {
      throw new GeminiError(`${model}: ${signal?.aborted ? "stopped" : (e as Error).name === "AbortError" ? "no answer in time" : (e as Error).message}`, signal?.aborted ? 499 : 0, model);
    } finally { clearTimeout(t); signal?.removeEventListener("abort", stop); }
    let j: any;
    try { j = JSON.parse(raw); } catch { j = {}; }
    if (!res.ok) {
      const msg = String(j?.error?.message ?? raw.slice(0, 200));
      // a model that does not take this thinking level: remember it, and ask it again without one
      if (res.status === 400 && r.thinking && /thinking/i.test(msg) && !this.noThinking.has(model)) { this.noThinking.add(model); return this.once(model, r, timeoutMs, signal); }
      throw new GeminiError(`${model}: ${res.status} ${msg.slice(0, 300)}`, res.status, model, res.status === 429 ? quotaOf(j) : undefined);
    }
    const cand = j.candidates?.[0];
    const content: Content = cand?.content?.parts ? { role: "model", parts: cand.content.parts } : { role: "model", parts: [{ text: "" }] };
    if (!cand?.content?.parts) {
      // what was asked is refused (a block, a safety or recitation stop): no other model is asked either (400).
      // An answer that came out wrong (a malformed call, cut short, empty): the next model is (422).
      const why = String(j.promptFeedback?.blockReason ?? cand?.finishReason ?? "EMPTY");
      const refused = !!j.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "LANGUAGE"].includes(why);
      throw new GeminiError(`${model}: ${why}`, refused ? 400 : 422, model);
    }
    const text = content.parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
    const calls = content.parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {}, id: p.functionCall!.id }));
    return { model, content, text, calls, usage: { input: j.usageMetadata?.promptTokenCount, output: j.usageMetadata?.candidatesTokenCount } };
  }
}

/** The models this key may call for text (generateContent), without the "models/" prefix. */
export async function listModels(key: string, f: Fetch = fetch, base = "https://generativelanguage.googleapis.com/v1beta"): Promise<string[]> {
  const out: string[] = [];
  let page = "";
  for (let i = 0; i < 10; i++) {
    const res = await f(`${base}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: { "x-goog-api-key": key } });
    const j = (await res.json().catch(() => ({}))) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string; error?: { message?: string } };
    if (!res.ok) throw new GeminiError(`listing models: ${res.status} ${j.error?.message ?? ""}`, res.status, "");
    for (const m of j.models ?? []) if (m.supportedGenerationMethods?.includes("generateContent")) out.push(m.name.replace(/^models\//, ""));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return out;
}

/** Text models the free tier serves: Flash and Flash-Lite, stable names only (no Pro, no previews, no media models). */
export const freeTextModel = (m: string) => /^gemini-(\d+(\.\d+)?-)?flash(-lite)?(-latest)?$/.test(m);

const version = (m: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(m)?.[1] ?? 0);

/**
 * A chain made of what this key can call: the models asked for that exist, in their order; when none
 * does, the newest free Flash models it has (`lite` first when `preferLite`), so a renamed model never
 * leaves the brain without one. `available` undefined (the listing failed): the chain as asked.
 */
export function resolveChain(wanted: string[], available: string[] | undefined, preferLite = false): string[] {
  if (!available) return wanted;
  const have = new Set(available);
  const kept = wanted.filter((m) => have.has(m));
  if (kept.length) return kept;
  const lite = (m: string) => (m.includes("lite") ? 1 : 0);
  return available.filter(freeTextModel)
    .sort((a, b) => (preferLite ? lite(b) - lite(a) : lite(a) - lite(b)) || version(b) - version(a) || (a.includes("latest") ? 1 : 0) - (b.includes("latest") ? 1 : 0))
    .slice(0, 3);
}

/** A model's name for people: "gemini-3.5-flash-lite" → "3.5 Flash-Lite". */
export const modelName = (m: string) => m.replace(/^gemini-/, "").replace(/-preview$/, "").replace(/-latest$/, " (latest)")
  .replace(/^(\d+(?:\.\d+)?)-/, "$1 ").replace(/flash-lite/, "Flash-Lite").replace(/flash/, "Flash");

/** JSON out of a model's text: fenced or bare. */
export function jsonOf<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const s = (fenced ? fenced[1] : text).trim();
  const start = s.search(/[{[]/);
  return JSON.parse(start > 0 ? s.slice(start) : s) as T;
}
