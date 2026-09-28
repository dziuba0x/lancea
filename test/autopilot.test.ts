import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, toPayment, type State, type Strategy, type Venue } from "../src/autopilot.ts";
import { Guard } from "../src/guard.ts";
import { decodeReference } from "../src/smart-accounts.ts";

const k: Strategy = { vaultId: 1, keepDrops: 10_000_000n, maxMintDrops: 20_000_000n, minMintDrops: 5_000_000n };
const v: Venue = { account: "rGuarded", operator: "rOperator", fee: 1000n, coreVault: "rCoreVault", personalAccount: "0x678ee1C63386724b9Cc0ffDC185e0b28c99e4902" };

test("the autopilot plans one step at a time: withdrawals, then deposits, then mints", () => {
  assert.deepEqual(plan({ xrpDrops: 90_000_000n, fxrp: 0n, shares: {} }, k), { kind: "mint", drops: 20_000_000n }); // capped per step
  assert.deepEqual(plan({ xrpDrops: 18_000_000n, fxrp: 0n, shares: {} }, k), { kind: "mint", drops: 8_000_000n });
  assert.equal(plan({ xrpDrops: 14_000_000n, fxrp: 0n, shares: {} }, k), undefined); // 4 XRP idle: not worth the fees
  assert.deepEqual(plan({ xrpDrops: 90_000_000n, fxrp: 19_800_000n, shares: {} }, k), { kind: "deposit", amount: 19_000_000n, vaultId: 1 });
  assert.deepEqual(plan({ xrpDrops: 90_000_000n, fxrp: 800_000n, shares: {} }, k), { kind: "mint", drops: 20_000_000n }); // dust waits
  assert.deepEqual(plan({ xrpDrops: 0n, fxrp: 5_000_000n, shares: { 1: 3_000_000n } }, { ...k, withdrawShares: 9_000_000n }),
    { kind: "withdraw", amount: 3_000_000n, vaultId: 1 });
});

test("the wheel: withdraw once a period, claim when it unlocks, redeem whole lots, mint and deposit again", () => {
  const X = 1_000_000n, lot = 10n * X;
  const w: Strategy = { ...k, keepDrops: 20n * X, maxMintDrops: 5n * X, minMintDrops: 5n * X, loop: { lotDrops: lot, lots: 5, marginDrops: 10_000n } };
  const q = (over: Partial<NonNullable<State["vault"]>> = {}) => ({ period: 400n, requested: 0n, claimable: [], pending: 0n, ...over });
  const at = (s: Partial<State>): State => ({ xrpDrops: 20n * X, fxrp: 0n, shares: { 1: 126n * X }, vault: q(), ...s });
  // nothing asked for this period: start withdrawing 5 lots (+ the margin)
  assert.deepEqual(plan(at({}), w), { kind: "withdraw", amount: 50_010_000n, vaultId: 1 });
  // asked for already: the XRP above the reserve is minted instead, 5 at a time
  assert.deepEqual(plan(at({ xrpDrops: 69n * X, vault: q({ requested: 50n * X }) }), w), { kind: "mint", drops: 5n * X });
  assert.equal(plan(at({ vault: q({ requested: 50n * X }) }), w), undefined);
  // a withdrawal unlocked: claim it first, the oldest period first
  const ready = q({ claimable: [{ period: 398n, assets: 50_010_000n }, { period: 399n, assets: 1n }] });
  assert.deepEqual(plan(at({ xrpDrops: 69n * X, fxrp: 3n * X, vault: ready }), w), { kind: "claim", period: 398n, amount: 50_010_000n, vaultId: 1 });
  // a lot or more of FXRP is a claim coming home: redeem the whole lots; less is a mint going to the vault
  assert.deepEqual(plan(at({ fxrp: 50_010_000n }), w), { kind: "redeem", lots: 5n, drops: 50n * X });
  assert.deepEqual(plan(at({ fxrp: 9_800_000n }), w), { kind: "deposit", amount: 9n * X, vaultId: 1 });
  // shares for fewer lots than asked: whole lots only; less than a lot: no withdrawal
  assert.deepEqual(plan(at({ shares: { 1: 23n * X } }), w), { kind: "withdraw", amount: 20_010_000n, vaultId: 1 });
  assert.equal(plan(at({ shares: { 1: 9n * X } }), w), undefined);
  // a step of the wheel resting after a timeout is skipped; the rest goes on
  assert.deepEqual(plan(at({ fxrp: 50_010_000n }), w, new Set(["redeem"])), { kind: "deposit", amount: 50n * X, vaultId: 1 });
  assert.deepEqual(plan(at({ xrpDrops: 69n * X }), w, new Set(["withdraw"])), { kind: "mint", drops: 5n * X });
  // without the wheel, the same state only fills the vault
  assert.deepEqual(plan(at({ fxrp: 50_010_000n }), { ...w, loop: undefined }), { kind: "deposit", amount: 50n * X, vaultId: 1 });
});

test("the wheel's instructions are the ones Flare documents: Firelight redeem 0x12 and claim 0x13, FXRP redeem 0x02 in lots", () => {
  const memo = (step: Parameters<typeof toPayment>[0]) => toPayment(step, v).Memos![0].Memo.MemoData!;
  // dev.flare.network/smart-accounts: encode firelight-claim-withdraw --value 123456789 --vault-id 1
  assert.equal(memo({ kind: "claim", period: 123_456_789n, amount: 0n, vaultId: 1 }), "1300000000000000075BCD150000000100000000000000000000000000000000");
  assert.equal(memo({ kind: "withdraw", amount: 1n, vaultId: 1 }), "1200000000000000000000010000000100000000000000000000000000000000");
  assert.deepEqual(decodeReference(memo({ kind: "redeem", lots: 3n, drops: 30_000_000n })), { flow: "reference", kind: "fxrp-redeem", walletId: 0, value: 3n });
  for (const step of [{ kind: "withdraw", amount: 5n, vaultId: 1 }, { kind: "claim", period: 7n, amount: 5n, vaultId: 1 }, { kind: "redeem", lots: 1n, drops: 10n }] as const) {
    const pay = toPayment(step, v);
    assert.equal(pay.Destination, v.operator);
    assert.equal(pay.Amount, "1000"); // the operator's fee: the only XRP that leaves
  }
});

test("every step it proposes is one the guard's policy can read and allow", () => {
  const sa = { operators: [v.operator], coreVault: v.coreVault, policy: { vaults: [1], personalAccount: v.personalAccount } };
  for (const step of [{ kind: "mint", drops: 20_000_000n }, { kind: "deposit", amount: 19_000_000n, vaultId: 1 }, { kind: "withdraw", amount: 1_000_000n, vaultId: 1 },
    { kind: "claim", period: 401n, amount: 1n, vaultId: 1 }, { kind: "redeem", lots: 2n, drops: 20_000_000n }] as const) {
    const pay = toPayment(step, v);
    assert.equal(Guard.isSmartAccountPayment(pay, sa), true);
    assert.equal(Guard.smartAccountVerdict(pay, sa), undefined, step.kind);
  }
  assert.match(Guard.smartAccountVerdict(toPayment({ kind: "deposit", amount: 1n, vaultId: 4 }, v), sa)!, /vault 4 is not an allowed vault/);
  assert.match(Guard.smartAccountVerdict(toPayment({ kind: "mint", drops: 5_000_000n }, { ...v, personalAccount: "0x000000000000000000000000000000000000bEEF" }), sa)!,
    /would mint FXRP to 0x000000000000000000000000000000000000beef/);
});
