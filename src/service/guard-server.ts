/**
 * The guard as a service. It holds the guard's keys and answers one question over HTTP, on the
 * machine's loopback only: will you co-sign this? The request carries the agent's multisigned blob
 * and, for the record, what the agent says it is doing and why. The guard reads the blob itself;
 * the agent's words go into the journal next to the verdict, so the dashboard can show both.
 *
 *   POST /cosign   { blob, userOp?, intent?, why?, by? }    Authorization: Bearer <token>
 *   GET  /health   { ok, account, umbrella, guard, busy }
 *
 * One request at a time: a reservation, a signature and a strike must never interleave.
 * Run:  LANCEA_CONFIG=… LANCEA_KEYS=… npx tsx src/service/guard-server.ts
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "xrpl";
import type { Hex } from "viem";
import { Guard, short, type Decision } from "../guard.js";
import { decodeMint, decodeReference } from "../smart-accounts.js";
import { XrplHttp } from "../xrpl-http.js";
import { coston2 } from "../flare.js";
import { Journal, toJson } from "./journal.js";
import { loadConfig, loadGuardKeys, loadToken } from "./config.js";

const MAX_BODY = 64 * 1024;

export interface CosignRequest { blob: string; userOp?: Hex; intent?: unknown; why?: string; by?: string }

/** What a blob does, read from the blob itself: the journal never takes the agent's word for it. */
export function describe(blob: string, operators: string[], coreVault: string): Record<string, unknown> {
  const tx = decode(blob) as Record<string, any>;
  const memo = tx.Memos?.[0]?.Memo?.MemoData as string | undefined;
  let action: unknown;
  try {
    if (memo && operators.includes(tx.Destination)) action = decodeReference(memo);
    else if (memo && tx.Destination === coreVault) action = decodeMint(memo);
  } catch (e) {
    action = { kind: "undecodable", reason: (e as Error).message };
  }
  return { type: tx.TransactionType, account: tx.Account, destination: tx.Destination, amountDrops: tx.Amount,
    feeDrops: tx.Fee, sequence: tx.Sequence, memo, action };
}

/** The body, up to 64 KiB. Past that it is read and dropped, so the 413 still reaches the caller. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = Number(req.headers["content-length"] ?? 0);
    let over = size > MAX_BODY;
    size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) over = true;
      if (!over) chunks.push(c);
    });
    req.on("end", () => (over ? fail(new Error("too large")) : ok(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", fail);
  });
}

export interface GuardServerOptions {
  cosign: (blob: string, userOp?: Hex) => Promise<Decision>;
  token: string;
  journal: Journal;
  describe: (blob: string) => Record<string, unknown>;
  health: Record<string, unknown>;
}

export function guardServer(o: GuardServerOptions): Server & { drained(): Promise<unknown> } {
  let queue: Promise<unknown> = Promise.resolve();
  let busy = 0;
  const token = Buffer.from(o.token);
  const authorized = (h?: string) => {
    const m = /^Bearer (.+)$/.exec(h ?? "");
    const given = Buffer.from(m?.[1] ?? "");
    return m !== null && given.length === token.length && timingSafeEqual(given, token);
  };
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", ...(status === 413 ? { connection: "close" } : {}) });
      res.end(toJson(body));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, busy, ...o.health });
    if (req.method !== "POST" || req.url !== "/cosign") return reply(404, { error: "not found" });
    if (!authorized(req.headers.authorization)) return reply(401, { error: "unauthorized" });
    let r: CosignRequest;
    try {
      r = JSON.parse(await readBody(req));
    } catch (e) {
      return (e as Error).message === "too large" ? reply(413, { error: "body over 64 KiB" }) : reply(400, { error: "body is not JSON" });
    }
    if (typeof r.blob !== "string" || !/^[0-9A-Fa-f]+$/.test(r.blob)) return reply(400, { error: "blob must be a hex string" });
    if (r.userOp !== undefined && (typeof r.userOp !== "string" || !/^0x[0-9a-fA-F]*$/.test(r.userOp))) return reply(400, { error: "userOp must be 0x-hex" });
    let tx: Record<string, unknown>;
    try { tx = o.describe(r.blob); } catch (e) { return reply(400, { error: `blob does not decode: ${short(e)}` }); }

    busy++;
    const run = queue.then(() => o.cosign(r.blob, r.userOp));
    queue = run.catch(() => undefined);
    let d: Decision;
    try {
      d = await run;
    } catch (e) {
      d = { signed: false, reason: `guard error, nothing signed: ${short(e)}` }; // Guard.cosign refuses rather than throws; this is the net
    } finally {
      busy--;
    }
    o.journal.append("decision", { tx, claim: { intent: r.intent, why: r.why, by: r.by }, decision: d });
    return reply(200, d);
  });
  return Object.assign(server, { drained: () => queue });
}

async function main() {
  const c = loadConfig();
  const keys = loadGuardKeys();
  const token = loadToken();
  const xrpl = new XrplHttp(c.network.xrplRpc);
  const policy = c.guard.hourlyCapUsd6 || c.guard.newPayeeCapUsd6
    ? { hourlyCapUsd6: c.guard.hourlyCapUsd6 ? BigInt(c.guard.hourlyCapUsd6) : undefined,
        newPayeeCapUsd6: c.guard.newPayeeCapUsd6 ? BigInt(c.guard.newPayeeCapUsd6) : undefined }
    : undefined;
  const guard = new Guard({
    account: c.account, guardSeed: keys.xrplSeed, flareKey: keys.flareKey, chain: coston2(c.network.rpcUrl), rpcUrl: c.network.rpcUrl,
    meter: c.umbrella.meter, umbrellaId: BigInt(c.umbrella.id), xrplSource: c.network.xrplSource,
    smartAccounts: { operators: c.smartAccounts.operators, coreVault: c.smartAccounts.coreVault,
      policy: { vaults: [c.smartAccounts.vaultId], personalAccount: c.smartAccounts.personalAccount } },
    strikeOnPolicy: c.guard.strikeOnPolicy, policy,
  }, xrpl);
  const journal = new Journal(join(c.dataDir, "guard.jsonl"));
  const server = guardServer({
    cosign: (blob, userOp) => guard.cosign(blob, userOp), token, journal,
    describe: (blob) => describe(blob, c.smartAccounts.operators, c.smartAccounts.coreVault),
    health: { account: c.account, umbrella: c.umbrella.id, guard: guard.wallet.address },
  });
  server.listen(c.guard.port, c.guard.host, () =>
    console.log(`lancea guard ${guard.wallet.address} on http://${c.guard.host}:${c.guard.port} | account ${c.account} | umbrella #${c.umbrella.id}`));
  journal.append("start", { guard: guard.wallet.address, account: c.account, umbrella: c.umbrella.id });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      server.close(); // no new requests; the one in hand finishes (up to a minute), so no reservation is left without its answer
      await Promise.race([server.drained(), new Promise((r) => setTimeout(r, 60_000))]);
      journal.append("stop", { signal });
      process.exit(0);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
