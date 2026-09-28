/**
 * The autopilot: an agent that runs an account's XRP through a Flare vault, one step at a time, and
 * never holds the keys to it alone. It only proposes. Every proposal is an XRPL Payment that the guard
 * reads, prices against the umbrella's dollar budget, and co-signs or refuses.
 *
 *   idle XRP above the reserve   → mint FXRP to the account's own personal account (Core Vault)
 *   FXRP in the personal account → deposit it into the target vault (operator instruction)
 *   the principal wants liquidity → start a withdrawal from the vault (operator instruction)
 *
 * With `loop` set, the XRP goes round (the wheel), so the account stays busy on the same coins:
 *
 *   once a vault period   start withdrawing `lots` lots' worth of FXRP (Firelight books it for later)
 *   when it unlocks       claim it back into the personal account
 *   a lot or more of FXRP  redeem it to XRP on the ledger (FAssets agents pay it out)
 *   that XRP              is minted again, and deposited again
 *
 * Mints stay below a lot, so FXRP from a mint goes to the vault and FXRP from a claim goes home.
 * Pure planning; the proposals are ordinary payments, so the guard needs no autopilot-specific code.
 */
import type { Payment } from "xrpl";
import type { VaultQueue } from "./firelight.js";

export interface State {
  /** Spendable XRP on the guarded account, in drops (balance minus the ledger reserve). */
  xrpDrops: bigint;
  /** FXRP held by the personal account, in its smallest unit (6 decimals, like drops). */
  fxrp: bigint;
  /** Vault shares held by the personal account, by vault id. */
  shares: Record<number, bigint>;
  /** The vault's withdrawal queue for this account (read only when the wheel is on). */
  vault?: VaultQueue;
}

export interface Loop {
  /** FXRP per FAssets lot (AssetManager.lotSize(): 10 FXRP on Coston2). Redemptions come in lots. */
  lotDrops: bigint;
  /** Lots to start withdrawing once a vault period. */
  lots: number;
  /** Asked for on top of the lots, so rounding in the vault never leaves a claim a drop short of them. */
  marginDrops: bigint;
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
  /** FXRP the principal asked to have withdrawn; 0 when none. */
  withdrawShares?: bigint;
  /** The wheel: absent, the autopilot only fills the vault. */
  loop?: Loop;
}

export type Step =
  | { kind: "mint"; drops: bigint }
  | { kind: "deposit"; amount: bigint; vaultId: number }
  | { kind: "withdraw"; amount: bigint; vaultId: number }
  | { kind: "claim"; period: bigint; amount: bigint; vaultId: number }
  | { kind: "redeem"; lots: bigint; drops: bigint };

export type StepKind = Step["kind"];

const WHOLE = 1_000_000n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The next step, or undefined when there is nothing worth doing. `skip`: kinds resting after a timeout. */
export function plan(s: State, k: Strategy, skip: ReadonlySet<StepKind> = new Set()): Step | undefined {
  const held = s.shares[k.vaultId] ?? 0n;
  if (k.withdrawShares && k.withdrawShares > 0n && held > 0n && !skip.has("withdraw")) {
    return { kind: "withdraw", amount: min(k.withdrawShares, held), vaultId: k.vaultId };
  }
  const loop = k.loop, q = s.vault;
  if (loop && q) {
    const ready = q.claimable[0];
    if (ready && !skip.has("claim")) return { kind: "claim", period: ready.period, amount: ready.assets, vaultId: k.vaultId };
    const lots = s.fxrp / loop.lotDrops;
    if (lots > 0n && !skip.has("redeem")) return { kind: "redeem", lots, drops: lots * loop.lotDrops };
  }
  const deposit = (s.fxrp / WHOLE) * WHOLE; // whole FXRP; the remainder waits for the next mint
  if (deposit > 0n) return { kind: "deposit", amount: deposit, vaultId: k.vaultId };
  if (loop && q && q.requested === 0n && !skip.has("withdraw")) {
    // whole lots (plus the margin) that the shares held can cover, at most `lots`
    const fit = held > loop.marginDrops ? (held - loop.marginDrops) / loop.lotDrops : 0n;
    const lots = min(BigInt(loop.lots), fit);
    if (lots > 0n) return { kind: "withdraw", amount: lots * loop.lotDrops + loop.marginDrops, vaultId: k.vaultId };
  }
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

/** Operator instruction ids (dev.flare.network/smart-accounts): type nibble, command nibble. */
const OP = { redeem: 0x02, deposit: 0x11, withdraw: 0x12, claim: 0x13 } as const; // FXRP redeem; Firelight deposit / redeem / claimWithdraw

/** The XRPL Payment that carries a step. Unsigned: the agent signs, the guard decides. */
export function toPayment(step: Step, v: Venue): Payment {
  const base = { TransactionType: "Payment" as const, Account: v.account };
  if (step.kind === "mint") {
    return { ...base, Destination: v.coreVault, Amount: step.drops.toString(), Memos: [{ Memo: { MemoData: mintMemo(v.personalAccount) } }] };
  }
  const [id, value, vaultId] =
    step.kind === "deposit" ? [OP.deposit, step.amount, step.vaultId]
    : step.kind === "withdraw" ? [OP.withdraw, step.amount, step.vaultId]
    : step.kind === "claim" ? [OP.claim, step.period, step.vaultId]
    : [OP.redeem, step.lots, 0]; // FXRP redeem: value in lots, no vault
  return { ...base, Destination: v.operator, Amount: v.fee.toString(), Memos: [{ Memo: { MemoData: instruction(id, value, vaultId) } }] };
}
