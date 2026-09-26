import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseAbi, toFunctionSelector, type Hex } from "viem";
import type { Payment } from "xrpl";
import { decodeReference, decodeMint, decodeUserOp, judge, type ActionPolicy } from "../src/smart-accounts.ts";
import { Guard } from "../src/guard.ts";

// Vectors from dev.flare.network (smart-accounts CLI) and from the live relay run of 2026-09-26.
test("proof-based instructions decode as the docs encode them", () => {
  const t = decodeReference("01000000000000000000000af5488132432118596fa13800b68df4c0ff25131d");
  assert.deepEqual(t, { flow: "reference", kind: "fxrp-transfer", walletId: 0, value: 10n, recipient: "0xf5488132432118596fa13800b68df4c0ff25131d" });
  const d = decodeReference("0x1100000000000000000000010000000100000000000000000000000000000000");
  assert.deepEqual(d, { flow: "reference", kind: "vault", vault: "firelight", action: "deposit", walletId: 0, value: 1n, vaultId: 1 });
  const c = decodeReference("1300000000000000075bcd150000000100000000000000000000000000000000");
  assert.equal(c.kind === "vault" && c.action === "claim" && c.value, 123456789n);
  const legacy = decodeReference("1000000000000000000000010001000100000000000000000000000000000000");
  assert.deepEqual(legacy, { flow: "reference", kind: "legacy-mint", walletId: 0, value: 1n, agentVaultId: 1, vault: "firelight", vaultId: 1 });
  const live = decodeReference("0100" + "00".repeat(10) + "000000000000000000000000000000000000dead");
  assert.equal(live.kind === "fxrp-transfer" && live.value, 0n); // the controller answered ValueZero()
  assert.equal(decodeReference("33" + "00".repeat(31)).kind, "refused");
  assert.equal(decodeReference("1100").kind, "refused");
});

const policy: ActionPolicy = { vaults: [1], fxrpRecipients: ["0x1111111111111111111111111111111111111111"] };

test("the principal's policy: own vaults and listed recipients only", () => {
  assert.equal(judge(decodeReference("1100000000000000000000010000000100000000000000000000000000000000"), policy), undefined);
  assert.match(judge(decodeReference("2100000000000000000000010000000200000000000000000000000000000000"), policy)!, /upshift vault 2/);
  assert.match(judge(decodeReference("01000000000000000000000af5488132432118596fa13800b68df4c0ff25131d"), policy)!, /not a listed recipient/);
  assert.equal(judge(decodeReference("01000000000000000000000a1111111111111111111111111111111111111111"), policy), undefined);
  assert.equal(judge(decodeReference("0200000000000000000000010000000000000000000000000000000000000000"), policy), undefined); // redeem returns to this account
  assert.match(judge(decodeReference("0200000000000000000000010000000000000000000000000000000000000000"), { ...policy, redeem: false })!, /redeem/);
});

const ATTACKER = "000000000000000000000000000000000000beef";
const PA = "0x2222222222222222222222222222222222222222" as Hex;

test("the Core Vault trap: an FAssets memo or a tag mints to anyone, so the guard reads it", () => {
  const to = decodeMint("4642505266410018" + "00000000" + ATTACKER);
  assert.deepEqual(to, { flow: "mint", kind: "mint-to", recipient: `0x${ATTACKER}` });
  assert.match(judge(to, policy)!, /would mint FXRP to/);
  assert.equal(judge(decodeMint("4642505266410018" + "00000000" + PA.slice(2)), { ...policy, personalAccount: PA }), undefined);
  assert.match(judge(decodeMint("4642505266410021" + ATTACKER + "00".repeat(20)), policy)!, /would mint FXRP to/);
  assert.equal(judge(decodeMint("e0" + "00".repeat(41)), policy), undefined); // recovery of its own stuck mint
  assert.match(judge(decodeMint("d0" + "00".repeat(41)), policy)!, /principal's call/);
  assert.match(judge(decodeMint("77"), policy)!, /unknown Core Vault memo/);
  assert.match(judge(decodeMint(""), policy)!, /without a memo/);
});

const FXRP = "0x3333333333333333333333333333333333333333" as Hex;
const VAULT = "0x4444444444444444444444444444444444444444" as Hex;
const ASSET_MANAGER = "0x5555555555555555555555555555555555555555" as Hex;
const executeUserOp = parseAbi(["function executeUserOp((address target, uint256 value, bytes data)[] _calls) payable"]);
const PACKED = [{ type: "tuple", components: [
  { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
  { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
  { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }] }] as const;
const Z = `0x${"00".repeat(32)}` as Hex;
const userOp = (calls: { target: Hex; value: bigint; data: Hex }[]): Hex =>
  encodeAbiParameters(PACKED, [{ sender: PA, nonce: 7n, initCode: "0x", callData: encodeFunctionData({ abi: executeUserOp, functionName: "executeUserOp", args: [calls] }),
    accountGasLimits: Z, preVerificationGas: 0n, gasFees: Z, paymasterAndData: "0x", signature: "0x" }]);
const approve = { target: FXRP, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 10n] }) };
const deposit = { target: VAULT, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function deposit(uint256,address)"]), functionName: "deposit", args: [10n, PA] }) };
const redeemAway = { target: ASSET_MANAGER, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function redeem(uint256,string,address)"]), functionName: "redeem", args: [1n, "rAttacker", PA] }) };
const withCalls: ActionPolicy = { ...policy, calls: [
  { target: FXRP, selector: toFunctionSelector("approve(address,uint256)") },
  { target: VAULT, selector: toFunctionSelector("deposit(uint256,address)") }] };

test("user operations: the guard decodes every call and allows only listed ones", () => {
  const op = userOp([approve, deposit]);
  assert.deepEqual(decodeUserOp(op).calls.map((c) => c.target), [FXRP, VAULT]);
  const inline = decodeMint("ff00" + "00".repeat(8) + op.slice(2));
  assert.equal(judge(inline, withCalls), undefined);
  assert.match(judge(inline, policy)!, /is not allowed/);
  const away = decodeMint("ff00" + "00".repeat(8) + userOp([approve, redeemAway]).slice(2));
  assert.match(judge(away, withCalls)!, /on 0x5555/); // FAssets redeem to a foreign XRPL address
  const paid = decodeMint("ff00" + "00".repeat(8) + userOp([{ ...deposit, value: 1n }]).slice(2));
  assert.match(judge(paid, withCalls)!, /wei of FLR/);
});

test("0xFE commits to a hash: no user operation shown, or the wrong one, is refused", () => {
  const op = userOp([approve, deposit]);
  const memo = decodeMint("fe00" + "0000000000000064" + keccak256(op).slice(2));
  assert.equal(memo.kind === "user-op" && memo.executorFee, 100n);
  assert.match(judge(memo, withCalls)!, /must be shown the user operation/);
  assert.match(judge(memo, withCalls, userOp([approve]))!, /not the one the memo commits to/);
  assert.equal(judge(memo, withCalls, op), undefined);
});

const OPERATOR = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
const CORE = "rCoreVaultXXXXXXXXXXXXXXXXXXXXXXXX";
const sa = { operators: [OPERATOR], coreVault: CORE, policy: withCalls };
const pay = (Destination: string, memos: string[], tag?: number): Payment => ({
  TransactionType: "Payment", Account: "rGuarded", Destination, Amount: "1000",
  Memos: memos.map((m) => ({ Memo: { MemoData: m } })), ...(tag === undefined ? {} : { DestinationTag: tag }) }) as Payment;

test("the guard's verdict on a whole payment: one memo, no tag, and a permitted action", () => {
  const dep = "1100000000000000000000010000000100000000000000000000000000000000";
  assert.equal(Guard.isSmartAccountPayment(pay(OPERATOR, [dep]), sa), true);
  assert.equal(Guard.isSmartAccountPayment(pay("rSomeoneElse", [dep]), sa), false);
  assert.equal(Guard.smartAccountVerdict(pay(OPERATOR, [dep]), sa), undefined);
  assert.match(Guard.smartAccountVerdict(pay(CORE, ["ff00" + "00".repeat(8) + userOp([approve]).slice(2)], 42), sa)!, /destination tag/);
  assert.match(Guard.smartAccountVerdict(pay(OPERATOR, [dep, dep]), sa)!, /exactly one memo/);
  assert.match(Guard.smartAccountVerdict(pay(CORE, ["4642505266410018" + "00000000" + ATTACKER]), sa)!, /would mint FXRP/);
});
