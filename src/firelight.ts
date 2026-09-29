/**
 * Firelight's withdrawal queue, read from the chain. A withdrawal is two steps: `redeem` burns the
 * shares now and books the FXRP under the NEXT period (currentPeriod() + 1); `claimWithdraw(p)` pays
 * it out once period p has ended. So FXRP asked for now unlocks between one and two periods later
 * (4 to 8 hours on Coston2, where a period is 14 400 s). Nothing here signs anything.
 */
import { parseAbi, type Address, type PublicClient } from "viem";

export const firelightAbi = parseAbi([
  "function currentPeriod() view returns (uint256)",
  "function currentPeriodStart() view returns (uint48)",
  "function currentPeriodEnd() view returns (uint48)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function withdrawalsOf(uint256 period, address account) view returns (uint256)",
  "function isWithdrawClaimed(uint256 period, address account) view returns (bool)",
]);

/** How far back unclaimed withdrawals are looked for: a day of 4-hour periods. */
export const LOOKBACK_PERIODS = 6n;

export interface VaultQueue {
  /** The vault's current period. */
  period: bigint;
  /** FXRP already asked for in this period (booked under period + 1): 0 when none. */
  requested: bigint;
  /** Withdrawals whose period has ended and that are not claimed yet, oldest first. */
  claimable: { period: bigint; assets: bigint }[];
  /** All FXRP on its way out: asked for, not claimed yet (claimable included). */
  pending: bigint;
  /** Every unclaimed withdrawal, oldest first, with the unix time its period ends (when it can be claimed). */
  queue?: { period: bigint; assets: bigint; unlocksAt: bigint; claimable: boolean }[];
  /** When the current period ends, and how long a period is (s). */
  periodEnd?: bigint;
  periodSeconds?: bigint;
}

/** The queue as it stands for `account` (the personal account). */
export async function readQueue(pc: PublicClient, vault: Address, account: Address, lookback = LOOKBACK_PERIODS): Promise<VaultQueue> {
  const read = (functionName: "currentPeriod" | "currentPeriodStart" | "currentPeriodEnd") =>
    pc.readContract({ address: vault, abi: firelightAbi, functionName }) as Promise<bigint | number>;
  const [p, start, end] = await Promise.all([read("currentPeriod"), read("currentPeriodStart"), read("currentPeriodEnd")]);
  const period = BigInt(p), periodEnd = BigInt(end), periodSeconds = periodEnd - BigInt(start);
  const periods: bigint[] = [];
  for (let p = period + 1n; p >= 0n && p >= period - lookback; p--) periods.push(p);
  const booked = await Promise.all(periods.map((p) =>
    pc.readContract({ address: vault, abi: firelightAbi, functionName: "withdrawalsOf", args: [p, account] }) as Promise<bigint>));
  const open = periods.map((p, i) => ({ period: p, assets: booked[i] })).filter((w) => w.assets > 0n);
  const claimed = await Promise.all(open.map((w) =>
    pc.readContract({ address: vault, abi: firelightAbi, functionName: "isWithdrawClaimed", args: [w.period, account] }) as Promise<boolean>));
  const unclaimed = open.filter((_, i) => !claimed[i]).sort((a, b) => (a.period < b.period ? -1 : 1));
  return {
    period,
    requested: unclaimed.find((w) => w.period === period + 1n)?.assets ?? 0n,
    claimable: unclaimed.filter((w) => w.period < period),
    pending: unclaimed.reduce((n, w) => n + w.assets, 0n),
    queue: unclaimed.map((w) => ({ ...w, unlocksAt: periodEnd + (w.period - period) * periodSeconds, claimable: w.period < period })),
    periodEnd, periodSeconds,
  };
}

/** The vault itself: what a share is worth (FXRP per 1 000 000 shares) and everything it holds. */
export async function readVault(pc: PublicClient, vault: Address): Promise<{ sharePrice6: bigint; totalAssets: bigint }> {
  const [sharePrice6, totalAssets] = await Promise.all([
    pc.readContract({ address: vault, abi: firelightAbi, functionName: "convertToAssets", args: [1_000_000n] }) as Promise<bigint>,
    pc.readContract({ address: vault, abi: firelightAbi, functionName: "totalAssets" }) as Promise<bigint>,
  ]);
  return { sharePrice6, totalAssets };
}
