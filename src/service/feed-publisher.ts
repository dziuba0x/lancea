/**
 * The dashboard's feed, published without opening a port. Every minute this process builds feed.json
 * from the journals and the chains, and pushes it to a GitHub repo (config.feed.repo) with a deploy key
 * that can write to that one repo only ($LANCEA_KEYS/feed_deploy_key). It holds no signing key.
 * The repo keeps one commit, amended and force-pushed: a feed, not a history (the journals are that).
 * It pushes when something changed, and at least every `heartbeatSeconds`, so the page can tell a quiet
 * agent from a stopped machine.
 *
 * Run:  LANCEA_CONFIG=… LANCEA_KEYS=… npx tsx src/service/feed-publisher.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { short } from "../guard.js";
import { coston2 } from "../flare.js";
import { XrplHttp } from "../xrpl-http.js";
import { Journal, toJson } from "./journal.js";
import { loadConfig } from "./config.js";
import { buildFeed, readChain } from "./feed.js";

export class FeedRepo {
  constructor(readonly dir: string, readonly remote: string, readonly branch = "main", readonly sshCommand?: string) {}

  private git(args: string[]): string {
    const env = this.sshCommand ? { ...process.env, GIT_SSH_COMMAND: this.sshCommand } : process.env;
    return execFileSync("git", ["-C", this.dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }).toString();
  }

  private ensure() {
    if (existsSync(join(this.dir, ".git"))) return;
    mkdirSync(this.dir, { recursive: true });
    this.git(["init", "-q", "-b", this.branch]);
    this.git(["remote", "add", "origin", this.remote]);
    this.git(["config", "user.name", "Lancea demo feed"]);
    this.git(["config", "user.email", "feed@lancea.invalid"]);
  }

  /** Write feed.json and replace the remote branch with one commit holding it. */
  publish(json: string) {
    this.ensure();
    writeFileSync(join(this.dir, "feed.json"), json);
    this.git(["add", "feed.json"]);
    let hasHead = true;
    try { this.git(["rev-parse", "--verify", "-q", "HEAD"]); } catch { hasHead = false; }
    this.git(hasHead ? ["commit", "-q", "--amend", "-m", "feed"] : ["commit", "-q", "-m", "feed"]);
    this.git(["push", "-q", "--force", "origin", `HEAD:${this.branch}`]);
  }
}

/** A feed's content without its timestamp: what decides whether it changed. */
export const contentHash = (feed: Record<string, unknown>) => createHash("sha256").update(toJson({ ...feed, generatedAt: undefined })).digest("hex");

async function main() {
  const c = loadConfig();
  if (!c.feed?.repo) throw new Error("config.feed.repo is not set: there is nowhere to publish");
  const keys = process.env.LANCEA_KEYS ?? "keys";
  const repo = new FeedRepo(join(c.dataDir, "feed"), c.feed.repo, c.feed.branch ?? "main",
    `ssh -i ${join(keys, "feed_deploy_key")} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${join(c.dataDir, "known_hosts")}`);
  const guardJournal = new Journal(join(c.dataDir, "guard.jsonl"));
  const autopilotJournal = new Journal(join(c.dataDir, "autopilot.jsonl"));
  const xrpl = new XrplHttp(c.network.xrplRpc);
  const pc = createPublicClient({ chain: coston2(c.network.rpcUrl), transport: http(c.network.rpcUrl) });
  const every = (c.feed.publishSeconds ?? 60) * 1000, heartbeat = (c.feed.heartbeatSeconds ?? 600) * 1000;
  let lastHash = "", lastPush = 0, stopping = false, wake: () => void = () => {};
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; wake(); });
  console.log(`lancea feed → ${c.feed.repo} (${c.feed.branch ?? "main"}) every ${every / 1000} s`);
  while (!stopping) {
    try {
      const feed = buildFeed(c, await readChain(c, xrpl, pc as any), guardJournal.tail(100), autopilotJournal.tail(100));
      const h = contentHash(feed);
      if (h !== lastHash || Date.now() - lastPush >= heartbeat) {
        repo.publish(toJson(feed));
        lastHash = h; lastPush = Date.now();
        console.log(new Date().toISOString(), "published", h.slice(0, 12));
      }
    } catch (e) {
      console.error(new Date().toISOString(), "feed not published:", short(e)); // the next minute tries again
    }
    await new Promise<void>((r) => { wake = r; setTimeout(r, every); });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
