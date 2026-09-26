/**
 * The autopilot: an agent that puts an account's idle XRP to work in a Flare vault, one step at a
 * time, and never holds the keys to it alone. It only proposes. Every proposal is an XRPL Payment
 * that the guard reads, prices against the umbrella's dollar budget, and co-signs or refuses.
 *
 *   idle XRP above the reserve   → mint FXRP to the account's own personal account (Core Vault)
 *   FXRP in the personal account → deposit it into the target vault (operator instruction)
 *   the principal wants liquidity → redeem vault shares (operator instruction)
 *
 * Pure planning; the proposals are ordinary payments, so the guard needs no autopilot-specific code.
 */
import type { Payment } from "xrpl";

export interface State {
  /** Spendable XRP on the guarded account, in drops (balance minus the ledger reserve). */
  xrpDrops: bigint;
  /** FXRP held by the personal account, in its smallest unit (6 decimals, like drops). */
  fxrp: bigint;
  /** Vault shares held by the personal account, by vault id. */
  shares: Record<number, bigint>;
}

export interface Strategy {
  /** The vault the autopilot works in (MasterAccountController id). */
  vaultId: number;
  /** XRP left untouched on the ledger, in drops. */
  keepDrops: bigint;
  /** The most one step may mint, in drops: a step is also a unit of risk for the guard. */
  maxMintDrops: bigint;
  /** Below this, a mint is not worth its fees (0.1 FXRP minimum fee + 0.1 FXRP executor fee on Coston2). */
  minMintDrops: bigint;
  /** Shares the principal asked to have withdrawn; 0 when none. */
  withdrawShares?: bigint;
}

export type Step =
  | { kind: "mint"; drops: bigint }
  | { kind: "deposit"; amount: bigint; vaultId: number }
  | { kind: "redeem"; shares: bigint; vaultId: number };

const WHOLE = 1_000_000n;

/** The next step, or undefined when there is nothing worth doing. Withdrawal requests come first. */
export function plan(s: State, k: Strategy): Step | undefined {
  const held = s.shares[k.vaultId] ?? 0n;
  if (k.withdrawShares && k.withdrawShares > 0n && held > 0n) {
    return { kind: "redeem", shares: k.withdrawShares < held ? k.withdrawShares : held, vaultId: k.vaultId };
  }
  const deposit = (s.fxrp / WHOLE) * WHOLE; // whole FXRP; the remainder waits for the next mint
  if (deposit > 0n) return { kind: "deposit", amount: deposit, vaultId: k.vaultId };
  const idle = s.xrpDrops - k.keepDrops;
  if (idle >= k.minMintDrops) return { kind: "mint", drops: idle < k.maxMintDrops ? idle : k.maxMintDrops };
  return undefined;
}

export interface Venue {
  account: string;
  /** The operator's XRPL wallet and its instruction fee in drops. */
  operator: string;
  fee: bigint;
  /** The FAssets Core Vault's XRPL address. */
  coreVault: string;
  /** The account's personal account on Flare: the only recipient a mint may name. */
  personalAccount: string;
}

/** An operator instruction: id, wallet 0, value (10 bytes), 2 ignored bytes, vault id, zeros. */
export function instruction(id: number, value: bigint, vaultId: number): string {
  return (id.toString(16).padStart(2, "0") + "00" + value.toString(16).padStart(20, "0") + "0000" +
    vaultId.toString(16).padStart(4, "0") + "00".repeat(16)).toUpperCase();
}

/** FAssets direct-minting memo naming the recipient (32 bytes, anyone may execute). */
export function mintMemo(recipient: string): string {
  return ("4642505266410018" + "00000000" + recipient.slice(2).toLowerCase()).toUpperCase();
}

/** The XRPL Payment that carries a step. Unsigned: the agent signs, the guard decides. */
export function toPayment(step: Step, v: Venue): Payment {
  const base = { TransactionType: "Payment" as const, Account: v.account };
  if (step.kind === "mint") {
    return { ...base, Destination: v.coreVault, Amount: step.drops.toString(), Memos: [{ Memo: { MemoData: mintMemo(v.personalAccount) } }] };
  }
  const id = step.kind === "deposit" ? 0x11 : 0x12; // Firelight deposit / redeem (start withdrawal)
  const value = step.kind === "deposit" ? step.amount : step.shares;
  return { ...base, Destination: v.operator, Amount: v.fee.toString(), Memos: [{ Memo: { MemoData: instruction(id, value, step.vaultId) } }] };
}
