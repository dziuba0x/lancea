/**
 * The services, offline. The guard's HTTP face: who may ask, what it accepts, one request at a time,
 * and a journal that records what a blob does next to what the agent says it does. The autopilot's
 * loop: a step in flight is not proposed twice, a refusal backs off, a tripped umbrella pauses it,
 * and an unreachable guard is a refusal. And keys that others can read stop a service from starting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Wallet, type Payment } from "xrpl";
import { toPayment, type State, type Strategy, type Venue } from "../src/autopilot.js";
import { RulesBrain, explain } from "../src/brain.js";
import type { Decision } from "../src/guard.js";
import { Journal } from "../src/service/journal.js";
import { describe, guardServer } from "../src/service/guard-server.js";
import { Autopilot, settled, type Observer, type Verdict } from "../src/service/autopilot-daemon.js";
import { loadGuardKeys } from "../src/service/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lancea-"));
const XRP = 1_000_000n;
const account = Wallet.generate(), agent = Wallet.generate(), operator = Wallet.generate(), coreVault = Wallet.generate();
const venue: Venue = { account: account.address, operator: operator.address, fee: 100_000n, coreVault: coreVault.address,
  personalAccount: "0x1111111111111111111111111111111111111111" };
const strategy: Strategy = { vaultId: 1, keepDrops: 70n * XRP, maxMintDrops: 20n * XRP, minMintDrops: 5n * XRP };
const agentBlob = (tx: Payment) => agent.sign({ ...tx, Fee: "36", Sequence: 7, LastLedgerSequence: 1000 }, true).tx_blob;

test("the brain says why, from the same numbers the rules used", async () => {
  const s: State = { xrpDrops: 98n * XRP, fxrp: 0n, shares: {} };
  const p = await new RulesBrain().decide(s, strategy);
  assert.deepEqual(p.step, { kind: "mint", drops: 20n * XRP });
  assert.equal(p.by, "rules");
  assert.match(p.why, /28 XRP idle above the 70 XRP reserve: mint 20 XRP to my own personal account/);
  assert.match(explain(undefined, { xrpDrops: 72n * XRP, fxrp: 0n, shares: {} }, strategy), /nothing worth doing: 0 FXRP waiting, 2 XRP idle/);
});

test("the journal keeps bigints and reads newest first", () => {
  const j = new Journal(join(tmp(), "j.jsonl"));
  j.append("a", { n: 1n << 70n });
  j.append("b", {});
  const [b, a] = j.tail();
  assert.equal(b.kind, "b");
  assert.equal(a.n, (1n << 70n).toString());
});

test("describe reads the blob, not the agent's claim", () => {
  const blob = agentBlob(toPayment({ kind: "deposit", amount: 19n * XRP, vaultId: 1 }, venue));
  const d = describe(blob, [operator.address], coreVault.address) as any;
  assert.equal(d.destination, operator.address);
  assert.equal(d.amountDrops, "100000");
  assert.equal(d.action.kind, "vault");
  assert.equal(d.action.action, "deposit");
  assert.equal(d.action.value, 19n * XRP);
});

async function serve(cosign: (blob: string) => Promise<Decision>) {
  const journal = new Journal(join(tmp(), "guard.jsonl"));
  const server = guardServer({ cosign, token: "t0ken", journal, health: { account: account.address },
    describe: (blob) => describe(blob, [operator.address], coreVault.address) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, token = "t0ken") => fetch(`${url}/cosign`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { server, journal, url, post };
}

test("the guard's HTTP face: only the token holder, only a decodable blob", async () => {
  const blob = agentBlob(toPayment({ kind: "mint", drops: 20n * XRP }, venue));
  const { server, journal, url, post } = await serve(async () => ({ signed: true, hash: "AB", usd6: 30_330_065n, reservation: "0x01" }));
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await post({ blob }, "wrong")).status, 401);
    assert.equal((await post({ blob }, "t0ken-and-more")).status, 401);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post({ blob: "0xZZ" })).status, 400);
    assert.equal((await post({ blob: "DEADBEEF" })).status, 400); // hex, but not a transaction
    assert.equal((await post({ blob: "AB".repeat(40_000) })).status, 413);
    assert.equal((await fetch(`${url}/cosign`)).status, 404);
    const r = await post({ blob, intent: { kind: "mint" }, why: "idle XRP", by: "rules" });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.signed, true);
    assert.equal(d.usd6, "30330065"); // bigints travel as strings
    const [entry] = journal.tail(1) as any[];
    assert.equal(entry.kind, "decision");
    assert.equal(entry.tx.destination, coreVault.address); // from the blob
    assert.equal(entry.claim.why, "idle XRP"); // the agent's words, beside it
    assert.equal(entry.decision.signed, true);
  } finally {
    server.close();
  }
});

test("the guard answers one request at a time, and a thrown error is a refusal", async () => {
  let inside = 0, most = 0, calls = 0;
  const blob = agentBlob(toPayment({ kind: "mint", drops: 20n * XRP }, venue));
  const { server, post } = await serve(async () => {
    inside++; most = Math.max(most, inside); calls++;
    await new Promise((r) => setTimeout(r, 30));
    inside--;
    if (calls === 3) throw new Error("boom");
    return { signed: false, reason: "no" };
  });
  try {
    const answers = await Promise.all([post({ blob }), post({ blob }), post({ blob })].map(async (p) => (await p).json()));
    assert.equal(most, 1);
    assert.ok(answers.some((a) => /guard error, nothing signed: boom/.test(a.reason)));
  } finally {
    server.close();
  }
});

test("settled: the chain shows the step", () => {
  const before: State = { xrpDrops: 90n * XRP, fxrp: 0n, shares: { 1: 0n } };
  assert.equal(settled("mint", before, { ...before, fxrp: 1n }, 1), true);
  assert.equal(settled("mint", before, before, 1), false);
  assert.equal(settled("deposit", { ...before, fxrp: 19n * XRP }, { ...before, fxrp: 0n }, 1), true);
  assert.equal(settled("redeem", { ...before, shares: { 1: 5n } }, { ...before, shares: { 1: 4n } }, 1), true);
});

function pilot(states: State[], verdicts: (Verdict | Error)[], trippedAt: boolean[] = [], budget?: () => Promise<{ stop: boolean; usd6: bigint }>) {
  let t = 0, i = 0, asked = 0, looked = 0;
  const journal = new Journal(join(tmp(), "autopilot.jsonl"));
  const observer: Observer = {
    state: async () => states[Math.min(i++, states.length - 1)],
    tripped: async () => trippedAt[looked++] ?? false,
  };
  const p = new Autopilot({
    brain: new RulesBrain(), strategy, venue, observer, journal, executionTimeoutS: 1800, backoffS: 600, now: () => t * 1000,
    guard: { cosign: async () => { const v = verdicts[asked++]; if (v instanceof Error) throw v; return v; } },
    sign: async (tx) => agentBlob(tx),
    budget,
  });
  return { p, journal, advance: (s: number) => { t += s; }, asked: () => asked };
}

test("the autopilot holds a step its budget would refuse, and never asks the guard: no self-inflicted strike", async () => {
  const idle: State = { xrpDrops: 78n * XRP, fxrp: 0n, shares: { 1: 0n } };
  let answer: "stop" | "go" | "error" = "stop";
  const budget = async () => {
    if (answer === "error") throw new Error("rpc down");
    return { stop: answer === "stop", usd6: 12_000_000n };
  };
  const { p, journal, asked } = pilot([idle], [{ signed: true, hash: "M" }], [], budget);
  assert.match(await p.tick(), /holding: the mint \(\$12\) would cross the umbrella's budget/);
  assert.match(await p.tick(), /holding/);
  answer = "error";
  assert.match(await p.tick(), /holding: the budget is unreadable \(rpc down\)/);
  assert.equal(asked(), 0);
  answer = "go";
  assert.match(await p.tick(), /co-signed mint: M/);
  assert.deepEqual(journal.tail(10).map((e) => e.kind).reverse(), ["holding", "holding", "proposal", "verdict"]);
});

test("the autopilot: a step in flight is not proposed twice; settled, the next step follows", async () => {
  const idle: State = { xrpDrops: 98n * XRP, fxrp: 0n, shares: { 1: 0n } };
  const sent: State = { xrpDrops: 78n * XRP, fxrp: 0n, shares: { 1: 0n } };
  const minted: State = { xrpDrops: 78n * XRP, fxrp: 19_800_000n, shares: { 1: 0n } };
  const { p, journal, advance, asked } = pilot([idle, sent, minted], [{ signed: true, hash: "M" }, { signed: true, hash: "D" }]);
  assert.match(await p.tick(), /co-signed mint: M/);
  advance(300);
  assert.match(await p.tick(), /waiting for Flare to execute the mint/);
  assert.equal(asked(), 1);
  advance(300);
  assert.match(await p.tick(), /co-signed deposit: D/);
  const kinds = journal.tail(10).map((e) => e.kind).reverse();
  assert.deepEqual(kinds, ["proposal", "verdict", "settled", "proposal", "verdict"]);
});

test("the autopilot: a refusal backs off; an unreachable guard is a refusal; a timeout frees the step", async () => {
  const idle: State = { xrpDrops: 98n * XRP, fxrp: 0n, shares: { 1: 0n } };
  const { p, advance, asked } = pilot([idle], [{ signed: false, reason: "budget" }, new Error("ECONNREFUSED"), { signed: true, hash: "M" }, { signed: true, hash: "M2" }]);
  assert.match(await p.tick(), /refused mint: budget/);
  advance(300);
  assert.match(await p.tick(), /backing off/);
  assert.equal(asked(), 1);
  advance(301);
  assert.match(await p.tick(), /refused mint: guard unreachable: ECONNREFUSED/);
  advance(601);
  assert.match(await p.tick(), /co-signed mint: M/);
  advance(1801); // the executor never delivered: the step is let go, and proposed again
  assert.match(await p.tick(), /co-signed mint: M2/);
});

test("the autopilot: a tripped umbrella pauses it, noted once; a quiet account is one line", async () => {
  const quiet: State = { xrpDrops: 72n * XRP, fxrp: 0n, shares: { 1: 0n } };
  const { p, journal, asked } = pilot([quiet], [], [true, true, false, false]);
  assert.match(await p.tick(), /paused/);
  assert.match(await p.tick(), /paused/);
  assert.match(await p.tick(), /idle/);
  assert.match(await p.tick(), /idle/);
  assert.equal(asked(), 0);
  assert.deepEqual(journal.tail(10).map((e) => e.kind).reverse(), ["paused", "idle"]);
});

test("a key file others can read stops the service", () => {
  const dir = tmp();
  writeFileSync(join(dir, "guard.json"), JSON.stringify({ xrplSeed: "s", flareKey: "0x" }));
  chmodSync(join(dir, "guard.json"), 0o644);
  process.env.LANCEA_KEYS = dir;
  try {
    assert.throws(() => loadGuardKeys(), /readable by others/);
    chmodSync(join(dir, "guard.json"), 0o600);
    assert.equal(loadGuardKeys().xrplSeed, "s");
    assert.ok(readFileSync(join(dir, "guard.json"), "utf8").length > 0);
  } finally {
    delete process.env.LANCEA_KEYS;
  }
});
