/**
 * The drill (scripts/drill.ts) stages what a hijacked agent would ask for: an ordinary-looking mint
 * whose memo names a stranger. Offline: it must be exactly what the guard's policy refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drillPayment, STRANGER, PLANTED_NOTE } from "../scripts/drill.js";
import { decodeMint, judge } from "../src/smart-accounts.js";
import { toPayment } from "../src/autopilot.js";

const venue = {
  account: "rhtCafinfGVX6QZQYDGztLFL8qNt5LWcTn", operator: "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq", fee: 1030n,
  coreVault: "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p", personalAccount: "0x953E5e9DAC303918fCa12e2a67743ae2157e04F5",
};

test("the drill looks like an ordinary mint, and its memo names a stranger the policy refuses", () => {
  const p = drillPayment(venue);
  assert.equal(p.Destination, venue.coreVault);
  assert.equal(p.Amount, "5000000");
  const d = decodeMint(p.Memos![0].Memo.MemoData!);
  assert.equal(d.kind, "mint-to");
  assert.equal((d as { recipient: string }).recipient.toLowerCase(), STRANGER.toLowerCase());
  assert.match(judge(d, { vaults: [1], personalAccount: venue.personalAccount }) ?? "", /would mint FXRP to 0x0+beef/i);
  // the same mint to the account's own personal account is allowed: only the recipient differs
  const own = decodeMint(toPayment({ kind: "mint", drops: 5_000_000n }, venue).Memos![0].Memo.MemoData!);
  assert.equal(judge(own, { vaults: [1], personalAccount: venue.personalAccount }), undefined);
  assert.match(PLANTED_NOTE, /0x…bEEF/);
});
