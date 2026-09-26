import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, toPayment, type Strategy, type Venue } from "../src/autopilot.ts";
import { Guard } from "../src/guard.ts";

const k: Strategy = { vaultId: 1, keepDrops: 10_000_000n, maxMintDrops: 20_000_000n, minMintDrops: 5_000_000n };
const v: Venue = { account: "rGuarded", operator: "rOperator", fee: 1000n, coreVault: "rCoreVault", personalAccount: "0x678ee1C63386724b9Cc0ffDC185e0b28c99e4902" };

test("the autopilot plans one step at a time: withdrawals, then deposits, then mints", () => {
  assert.deepEqual(plan({ xrpDrops: 90_000_000n, fxrp: 0n, shares: {} }, k), { kind: "mint", drops: 20_000_000n }); // capped per step
  assert.deepEqual(plan({ xrpDrops: 18_000_000n, fxrp: 0n, shares: {} }, k), { kind: "mint", drops: 8_000_000n });
  assert.equal(plan({ xrpDrops: 14_000_000n, fxrp: 0n, shares: {} }, k), undefined); // 4 XRP idle: not worth the fees
  assert.deepEqual(plan({ xrpDrops: 90_000_000n, fxrp: 19_800_000n, shares: {} }, k), { kind: "deposit", amount: 19_000_000n, vaultId: 1 });
  assert.deepEqual(plan({ xrpDrops: 90_000_000n, fxrp: 800_000n, shares: {} }, k), { kind: "mint", drops: 20_000_000n }); // dust waits
  assert.deepEqual(plan({ xrpDrops: 0n, fxrp: 5_000_000n, shares: { 1: 3_000_000n } }, { ...k, withdrawShares: 9_000_000n }),
    { kind: "redeem", shares: 3_000_000n, vaultId: 1 });
});

test("every step it proposes is one the guard's policy can read and allow", () => {
  const sa = { operators: [v.operator], coreVault: v.coreVault, policy: { vaults: [1], personalAccount: v.personalAccount } };
  for (const step of [{ kind: "mint", drops: 20_000_000n }, { kind: "deposit", amount: 19_000_000n, vaultId: 1 }, { kind: "redeem", shares: 1_000_000n, vaultId: 1 }] as const) {
    const pay = toPayment(step, v);
    assert.equal(Guard.isSmartAccountPayment(pay, sa), true);
    assert.equal(Guard.smartAccountVerdict(pay, sa), undefined, step.kind);
  }
  assert.match(Guard.smartAccountVerdict(toPayment({ kind: "deposit", amount: 1n, vaultId: 4 }, v), sa)!, /vault 4 is not an allowed vault/);
  assert.match(Guard.smartAccountVerdict(toPayment({ kind: "mint", drops: 5_000_000n }, { ...v, personalAccount: "0x000000000000000000000000000000000000bEEF" }), sa)!,
    /would mint FXRP to 0x000000000000000000000000000000000000beef/);
});
