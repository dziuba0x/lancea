/**
 * The feed's own counting: journals read forward (only new lines), totals by step, the guard's verdicts,
 * the faucet's top-ups, and one real decision of each kind pinned with its settlement. And the names the
 * ledger's payments get on the page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStats, exemplarKind } from "../src/service/stats.js";
import { nameOf } from "../src/service/feed.js";

const line = (path: string, e: object) => appendFileSync(path, JSON.stringify(e) + "\n");

test("the journals' totals, read forward, with one real decision of each kind pinned", () => {
  const dir = mkdtempSync(join(tmpdir(), "lancea-stats-")), g = join(dir, "guard.jsonl"), a = join(dir, "autopilot.jsonl");
  const mint = { at: "2026-09-29T00:43:00.000Z", kind: "decision", tx: { action: { kind: "mint-to" } }, claim: { intent: { kind: "mint", drops: "5000000" } },
    decision: { signed: true, hash: "AB", reservation: "0x01" } };
  line(g, mint);
  line(g, { at: "2026-09-29T00:44:00.000Z", kind: "decision", tx: { action: { kind: "mint-to" } }, claim: { by: "drill" }, decision: { signed: false, struck: "0x02" } });
  const s = new JournalStats(g, a).update(Date.parse("2026-09-29T01:00:00Z"));
  assert.deepEqual(s.snapshot().decisions, { signed: 1, refused: 0, struck: 1, signed24h: 1 });
  assert.equal(s.exemplars.mint.settled, undefined);
  line(a, { at: "2026-09-29T00:48:00.000Z", kind: "settled", step: { kind: "mint", drops: "5000000" }, afterS: 300 });
  line(a, { at: "2026-09-29T00:50:00.000Z", kind: "topped-up", drops: "100000000", tx: "F00D" });
  s.update(Date.parse("2026-09-29T01:00:00Z"));
  assert.deepEqual(s.snapshot().steps, { mint: { count: 1, units: "5000000" } });
  assert.deepEqual(s.snapshot().topups, { count: 1, drops: "100000000" });
  assert.deepEqual(s.exemplars.mint.settled, { at: "2026-09-29T00:48:00.000Z", afterS: 300 });
  assert.equal(exemplarKind(s.exemplars.hijack), "hijack");
  assert.deepEqual(s.recentReservations(), ["0x01"]);
  assert.ok(s.topups.hashes.has("F00D"));
  s.update(Date.parse("2026-09-30T02:00:00Z")); // a day on, nothing new: the count of the last 24 h empties
  assert.equal(s.snapshot().decisions.signed24h, 0);
});

test("a payment on the ledger is named by its counterparty and memo", () => {
  const c = { smartAccounts: { coreVault: "rCore", operators: ["rOp"] } } as any;
  const deposit = "1100000000000000007A12000000000100000000000000000000000000000000";
  assert.equal(nameOf({ dir: "out", counterparty: "rCore", hash: "1" }, c, new Set()), "Core Vault · a mint");
  assert.equal(nameOf({ dir: "out", counterparty: "rOp", memo: deposit, hash: "2" }, c, new Set()), "Operator · a deposit");
  assert.equal(nameOf({ dir: "in", counterparty: "rFaucet", hash: "F00D" }, c, new Set(["F00D"])), "XRPL testnet faucet");
  assert.equal(nameOf({ dir: "in", counterparty: "rAgent", memo: "46425052664100020000000000000000000000000000000000000000000004D2", hash: "3" }, c, new Set()),
    "FAssets agent · a redemption paid");
});
