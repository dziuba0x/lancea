/**
 * Flare Smart Accounts, read by the guard.
 *
 * An XRPL account acts on Flare in two ways, and both are authorised by nothing but its XRPL
 * signature (dev.flare.network/smart-accounts). For a guarded account that signature needs the
 * guard, so this is the one place those actions can be vetted:
 *
 *   proof-based   a Payment to an operator wallet whose single 32-byte memo is the instruction:
 *                 FXRP transfer / redeem, Firelight and Upshift deposit / redeem / claim
 *   direct mint   a Payment to the FAssets Core Vault; memo opcode 0xFE / 0xFF carries a user
 *                 operation (arbitrary calls from the personal account), 0xE0–0xE2 recover
 *
 * An allowlist of destinations is not enough. The Core Vault also mints FXRP to ANY Flare address
 * named in an FAssets recipient memo (prefix 0x4642505266410018 or …21) or bound to a destination
 * tag, so "may pay the Core Vault" would be "may pay anyone". The guard reads the memo.
 *
 * Pure functions: decode, then judge against the principal's ActionPolicy.
 */
import { decodeAbiParameters, decodeFunctionData, keccak256, type Hex } from "viem";

export type Vault = "firelight" | "upshift";

export type Decoded =
  | { flow: "reference"; kind: "fxrp-transfer"; walletId: number; value: bigint; recipient: Hex }
  | { flow: "reference"; kind: "fxrp-redeem"; walletId: number; value: bigint }
  | { flow: "reference"; kind: "vault"; vault: Vault; action: "deposit" | "redeem" | "claim"; walletId: number; value: bigint; vaultId: number }
  | { flow: "reference"; kind: "legacy-mint"; walletId: number; value: bigint; agentVaultId: number; vault?: Vault; vaultId?: number }
  | { flow: "mint"; kind: "user-op"; opcode: 0xfe | 0xff; walletId: number; executorFee: bigint; userOpHash: Hex; userOp?: Hex }
  | { flow: "mint"; kind: "recovery"; opcode: 0xe0 | 0xe1 | 0xe2 }
  | { flow: "mint"; kind: "executor-pin"; opcode: 0xd0 | 0xd1 }
  | { flow: "mint"; kind: "mint-to"; recipient: Hex }
  | { kind: "refused"; reason: string };

const bytes = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("memo is not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const hexOf = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const uint = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

const VAULTS: Record<number, Vault> = { 1: "firelight", 2: "upshift" };
const ACTIONS = { 1: "deposit", 2: "redeem", 3: "claim" } as const;

/** A proof-based instruction: the 32-byte payment reference of a Payment to an operator wallet. */
export function decodeReference(memo: string): Decoded {
  let b: Uint8Array;
  try { b = bytes(memo); } catch (e) { return { kind: "refused", reason: (e as Error).message }; }
  if (b.length !== 32) return { kind: "refused", reason: `an instruction is 32 bytes, this memo is ${b.length}` };
  const id = b[0], type = id >> 4, cmd = id & 0x0f, walletId = b[1], value = uint(b.subarray(2, 12));
  if (type === 0) {
    if (cmd === 0) return { flow: "reference", kind: "legacy-mint", walletId, value, agentVaultId: Number(uint(b.subarray(12, 14))) };
    if (cmd === 1) return { flow: "reference", kind: "fxrp-transfer", walletId, value, recipient: hexOf(b.subarray(12, 32)) };
    if (cmd === 2) return { flow: "reference", kind: "fxrp-redeem", walletId, value };
  }
  const vault = VAULTS[type];
  if (vault) {
    const vaultId = Number(uint(b.subarray(14, 16)));
    if (cmd === 0) return { flow: "reference", kind: "legacy-mint", walletId, value, agentVaultId: Number(uint(b.subarray(12, 14))), vault, vaultId };
    const action = ACTIONS[cmd as 1 | 2 | 3];
    if (action) return { flow: "reference", kind: "vault", vault, action, walletId, value, vaultId };
  }
  return { kind: "refused", reason: `unknown instruction 0x${id.toString(16).padStart(2, "0")}` };
}

const FASSETS_RECIPIENT = "4642505266410018"; // + 4 zero bytes + 20-byte recipient (32 bytes)
const FASSETS_RECIPIENT_EXECUTOR = "4642505266410021"; // + recipient + executor (48 bytes)

/** A direct-minting memo: a Payment to the FAssets Core Vault. */
export function decodeMint(memo: string): Decoded {
  let b: Uint8Array;
  try { b = bytes(memo); } catch (e) { return { kind: "refused", reason: (e as Error).message }; }
  if (b.length === 0) return { kind: "refused", reason: "a Core Vault payment without a memo" };
  const head = hexOf(b.subarray(0, 8)).slice(2);
  if (head === FASSETS_RECIPIENT && b.length === 32) return { flow: "mint", kind: "mint-to", recipient: hexOf(b.subarray(12, 32)) };
  if (head === FASSETS_RECIPIENT_EXECUTOR && b.length === 48) return { flow: "mint", kind: "mint-to", recipient: hexOf(b.subarray(8, 28)) };
  const op = b[0];
  if (op === 0xfe || op === 0xff) {
    if (b.length < 10) return { kind: "refused", reason: "user operation memo shorter than its header" };
    const walletId = b[1], executorFee = uint(b.subarray(2, 10));
    if (op === 0xfe) {
      if (b.length !== 42) return { kind: "refused", reason: "a 0xFE memo is 42 bytes" };
      return { flow: "mint", kind: "user-op", opcode: 0xfe, walletId, executorFee, userOpHash: hexOf(b.subarray(10, 42)) };
    }
    const userOp = hexOf(b.subarray(10));
    return { flow: "mint", kind: "user-op", opcode: 0xff, walletId, executorFee, userOpHash: keccak256(userOp), userOp };
  }
  if (op === 0xe0 || op === 0xe1 || op === 0xe2) return { flow: "mint", kind: "recovery", opcode: op };
  if (op === 0xd0 || op === 0xd1) return { flow: "mint", kind: "executor-pin", opcode: op };
  return { kind: "refused", reason: `unknown Core Vault memo 0x${op.toString(16).padStart(2, "0")}` };
}

export interface Call { target: Hex; value: bigint; data: Hex }

const PACKED_USER_OPERATION = [{
  type: "tuple",
  components: [
    { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" },
  ],
}] as const;
const executeUserOpAbi = [{
  type: "function", name: "executeUserOp", stateMutability: "payable", outputs: [],
  inputs: [{ name: "_calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
}] as const;

/** abi.encode(PackedUserOperation) whose callData is PersonalAccount.executeUserOp(Call[]). */
export function decodeUserOp(userOp: Hex): { sender: Hex; nonce: bigint; calls: Call[] } {
  const [op] = decodeAbiParameters(PACKED_USER_OPERATION, userOp);
  const { functionName, args } = decodeFunctionData({ abi: executeUserOpAbi, data: op.callData });
  if (functionName !== "executeUserOp") throw new Error("callData is not executeUserOp");
  return { sender: op.sender, nonce: op.nonce, calls: args[0].map((c) => ({ target: c.target, value: c.value, data: c.data })) };
}

/** What the principal lets the agent do through its smart account. Everything else is refused. */
export interface ActionPolicy {
  /** Vault ids (MasterAccountController) the agent may deposit to, redeem from and claim from. */
  vaults?: number[];
  /** Redeem FXRP back to XRP. The XRP returns to this account, so it is allowed unless false. */
  redeem?: boolean;
  /** Flare addresses the agent may send FXRP to (0x01). None unless listed. */
  fxrpRecipients?: string[];
  /** Calls a user operation may make: target and 4-byte selector, with no FLR attached. */
  calls?: { target: string; selector: string }[];
  /** The account's own personal account on Flare: an FAssets memo may mint to it and nowhere else. */
  personalAccount?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why this action is refused, or undefined when the policy allows it. `userOp` is required for 0xFE. */
export function judge(d: Decoded, p: ActionPolicy, userOp?: Hex): string | undefined {
  switch (d.kind) {
    case "refused": return d.reason;
    case "fxrp-transfer":
      return (p.fxrpRecipients ?? []).some((r) => same(r, d.recipient)) ? undefined : `FXRP to ${d.recipient}, not a listed recipient`;
    case "fxrp-redeem":
      return p.redeem === false ? "redeeming FXRP is not allowed" : undefined;
    case "vault":
      return (p.vaults ?? []).includes(d.vaultId) ? undefined : `${d.vault} vault ${d.vaultId} is not an allowed vault`;
    case "legacy-mint":
      return d.vaultId === undefined || (p.vaults ?? []).includes(d.vaultId) ? undefined : `${d.vault} vault ${d.vaultId} is not an allowed vault`;
    case "mint-to":
      return p.personalAccount && same(p.personalAccount, d.recipient) ? undefined : `an FAssets memo would mint FXRP to ${d.recipient}`;
    case "recovery": return undefined; // recovers this account's own stuck mint, nonce or fee
    case "executor-pin": return "pinning or unpinning an executor is the principal's call";
    case "user-op": {
      const op = d.opcode === 0xff ? d.userOp : userOp;
      if (!op) return "a 0xFE memo commits only to a hash: the guard must be shown the user operation";
      if (keccak256(op) !== d.userOpHash) return "the user operation shown is not the one the memo commits to";
      let calls: Call[];
      try { calls = decodeUserOp(op).calls; } catch (e) { return `unreadable user operation: ${(e as Error).message}`; }
      for (const c of calls) {
        if (c.value !== 0n) return `a call to ${c.target} carries ${c.value} wei of FLR`;
        const selector = c.data.slice(0, 10);
        if (!(p.calls ?? []).some((a) => same(a.target, c.target) && same(a.selector, selector))) return `call ${selector} on ${c.target} is not allowed`;
      }
      return undefined;
    }
  }
}
