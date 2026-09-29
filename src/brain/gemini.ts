/**
 * Google's Gemini, over plain REST (v1beta generateContent), free tier only. A call names a chain of
 * models: when one answers 429 (its free quota is spent) or 5xx, the next one is asked. Nothing here
 * knows a key's value beyond sending it in the x-goog-api-key header; nothing here signs anything.
 *
 * Gemini 3 models return thought signatures on their parts: the model's turn is always sent back
 * exactly as it came (`content` verbatim), so multi-turn function calling keeps them.
 */
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

export class GeminiError extends Error {
  constructor(message: string, readonly status: number, readonly model: string) { super(message); }
}

type Fetch = typeof fetch;

export class Gemini {
  /** Calls made per model today (UTC), and when a model's quota said no, so it rests until then. */
  readonly used = new Map<string, number>();
  private readonly resting = new Map<string, number>();
  private readonly noThinking = new Set<string>();
  private day = new Date().toISOString().slice(0, 10);

  constructor(private readonly key: string, private readonly f: Fetch = fetch, private readonly base = "https://generativelanguage.googleapis.com/v1beta") {}

  /** Ask the first model in the chain that is not resting; on 429 / 5xx / a timeout, the next. */
  async generate(models: string[], r: GenerateRequest, timeoutMs = 45_000): Promise<GenerateResult> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used.clear(); }
    let last: unknown;
    for (const model of models) {
      if ((this.resting.get(model) ?? 0) > Date.now()) continue;
      if (r.deadline && Date.now() > r.deadline) break;
      try {
        const out = await this.once(model, r, timeoutMs);
        this.used.set(model, (this.used.get(model) ?? 0) + 1);
        return out;
      } catch (e) {
        last = e;
        const status = e instanceof GeminiError ? e.status : 0;
        if (status === 429) this.resting.set(model, Date.now() + 60_000); // a free quota: rest a minute, then try it again
        else if (status === 422) continue; // this answer came out wrong (a malformed call, cut short): the next model, and nobody rests
        else if (status >= 500 || status === 0) this.resting.set(model, Date.now() + 15_000);
        else if (status === 404) this.resting.set(model, Date.now() + 3_600_000); // a model that is not there today
        else throw e; // a request the API refuses: another model would refuse it too
      }
    }
    throw last instanceof Error ? last : new Error("every model in the chain is resting");
  }

  private async once(model: string, r: GenerateRequest, timeoutMs: number): Promise<GenerateResult> {
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
    let res: Response, raw: string;
    try {
      res = await this.f(`${this.base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
      });
      raw = await res.text(); // the body too, inside the same time limit
    } catch (e) {
      throw new GeminiError(`${model}: ${(e as Error).name === "AbortError" ? "no answer in time" : (e as Error).message}`, 0, model);
    } finally { clearTimeout(t); }
    let j: any;
    try { j = JSON.parse(raw); } catch { j = {}; }
    if (!res.ok) {
      const msg = String(j?.error?.message ?? raw.slice(0, 200));
      // a model that does not take a thinking level: remember it, and ask it again without one
      if (res.status === 400 && r.thinking && /thinking/i.test(msg) && !this.noThinking.has(model)) { this.noThinking.add(model); return this.once(model, r, timeoutMs); }
      throw new GeminiError(`${model}: ${res.status} ${msg}`, res.status, model);
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

/** JSON out of a model's text: fenced or bare. */
export function jsonOf<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const s = (fenced ? fenced[1] : text).trim();
  const start = s.search(/[{[]/);
  return JSON.parse(start > 0 ? s.slice(start) : s) as T;
}
