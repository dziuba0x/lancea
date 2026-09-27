/**
 * The services' memory: one JSON object per line, appended, never rewritten. The guard writes what it
 * decided and why; the autopilot writes what it saw, what it proposed and what came back. The
 * dashboard reads the tail. Plain files, so anyone holding them can check every line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** JSON with bigints as decimal strings: every number a chain returns survives the trip. */
export const toJson = (v: unknown, space?: number): string =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), space);

export type Entry = Record<string, unknown> & { at: string; kind: string };

export class Journal {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(kind: string, fields: Record<string, unknown> = {}): Entry {
    const entry = { at: new Date().toISOString(), kind, ...fields } as Entry;
    appendFileSync(this.path, toJson(entry) + "\n");
    return entry;
  }

  /** The last `n` entries, newest first. A line that does not parse is shown as such, not dropped. */
  tail(n = 50): Entry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean).slice(-n);
    return lines.reverse().map((l) => {
      try { return JSON.parse(l) as Entry; } catch { return { at: "", kind: "unreadable", line: l.slice(0, 200) }; }
    });
  }
}
