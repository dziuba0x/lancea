import { test } from "node:test";
import assert from "node:assert/strict";
import { isAttempt } from "../src/guard.ts";
import { overHourlyCap, payeeHistory, isNewPayee, overNewPayeeCap, RIPPLE_EPOCH } from "../src/policy.ts";

const A = "rAgentAccount";
const SHOP = "rKnownShop";
const NEW = "rNeverPaid";
const now = 1_790_400_000n;
const day = 86_400n;
const row = (dest: string, drops: string, unix: bigint, result = "tesSUCCESS", v2 = false) =>
  v2
    ? { hash: `${dest}${unix}`, tx_json: { TransactionType: "Payment", Account: A, Destination: dest, DeliverMax: drops },
        meta: { TransactionResult: result, delivered_amount: drops }, close_time_iso: new Date(Number(unix) * 1000).toISOString() }
    : { tx: { TransactionType: "Payment", Account: A, Destination: dest, Amount: drops, date: Number(unix - RIPPLE_EPOCH), hash: `${dest}${unix}` },
        meta: { TransactionResult: result, delivered_amount: drops } };

test("the attempt rule matches DELICTI's own test numbers", () => {
  assert.equal(isAttempt(2_998_980n, 999_660n, 3_000_000n), true); // test_conatus_aRefusedAttemptIsRecorded
  assert.equal(isAttempt(1_999_320n, 999_660n, 3_000_000n), false); // …ThatLostARaceIsNotAnAttempt
  assert.equal(isAttempt(0n, 4_998_300n, 3_000_000n), true); // more than the whole budget
});

test("hourly cap counts every rail, from the meter's history", () => {
  // $4.00 noted in total, $1.00 of it more than an hour ago: $3.00 this hour
  assert.equal(overHourlyCap(4_000_000n, 1_000_000n, 2_100_000n, 5_000_000n), true);
  assert.equal(overHourlyCap(4_000_000n, 1_000_000n, 1_000_000n, 5_000_000n), false);
});

test("a payee paid more than a cooling period ago is known; a never-paid one is new", () => {
  const rows = [row(SHOP, "2000000", now - 3n * day), row(NEW, "1", now - 3n * day, "tecNO_DST")];
  assert.equal(isNewPayee(payeeHistory(rows, A, SHOP, now, day), now, day), false);
  assert.equal(isNewPayee(payeeHistory(rows, A, NEW, now, day), now, day), true); // a failed payment does not count
});

test("a first payment an hour ago keeps the payee new, and its amount counts toward the cap", () => {
  const rows = [row(NEW, "500000", now - 3_600n, "tesSUCCESS", true)]; // API v2 row shape
  const h = payeeHistory(rows, A, NEW, now, day);
  assert.equal(isNewPayee(h, now, day), true);
  assert.equal(h.recentDrops, 500_000n);
  // 0.5 XRP already + 1 XRP now at $1.52/XRP = $2.28 against a $2 cap
  assert.equal(overNewPayeeCap(h.recentDrops, 1_000_000n, 1_520_000n, 2_000_000n), true);
  assert.equal(overNewPayeeCap(h.recentDrops, 1_000_000n, 1_520_000n, 2_500_000n), false);
});

test("splitting does not reset the cap inside the cooling period", () => {
  const rows = [row(NEW, "400000", now - 7_200n), row(NEW, "400000", now - 3_600n)];
  const h = payeeHistory(rows, A, NEW, now, day);
  assert.equal(h.recentDrops, 800_000n);
  assert.equal(overNewPayeeCap(h.recentDrops, 400_000n, 608_000n, 1_520_000n), true); // 1.2 XRP ≈ $1.824 > $1.52
});
