/**
 * Rate limits the free tier and the guards' gas can live with: sliding windows per key. Idle keys are
 * forgotten (at most once a minute, a sweep of what has not been seen for a day), and the map never
 * holds more than `max` keys: past it, the oldest go first.
 */
export class Limits {
  private readonly hits = new Map<string, number[]>();
  private swept = 0;
  constructor(private readonly max = 50_000) {}

  /** true when `key` may go now (and counts it): at most `n` in `windowMs`. */
  take(key: string, n: number, windowMs: number, now = Date.now()): boolean {
    this.sweep(now);
    const t = (this.hits.get(key) ?? []).filter((x) => x > now - windowMs);
    if (t.length >= n) { this.hits.delete(key); this.hits.set(key, t); return false; }
    t.push(now);
    this.hits.delete(key); this.hits.set(key, t); // the newest last: the map's order is its age
    return true;
  }

  /** Seconds until `key` may go again (0 when it may). */
  wait(key: string, n: number, windowMs: number, now = Date.now()): number {
    const t = (this.hits.get(key) ?? []).filter((x) => x > now - windowMs);
    return t.length < n ? 0 : Math.ceil((t[t.length - n] + windowMs - now) / 1000);
  }

  get size() { return this.hits.size; }

  private sweep(now: number) {
    if (now - this.swept > 60_000) {
      this.swept = now;
      for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] < now - 86_400_000) this.hits.delete(k);
    }
    while (this.hits.size >= this.max) this.hits.delete(this.hits.keys().next().value!);
  }
}

/** A visitor, for counting: an IPv6 address by its /64 (one household, one phone), an IPv4 address as it is. */
export function visitor(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (!a.includes(":")) return a;
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
