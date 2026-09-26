/**
 * Lancea's own rules, on top of DELICTI's budget. They can only ever refuse more.
 *
 *   hourly cap   at most this many µUSD in any rolling hour, across every rail of the umbrella,
 *                read from SummaMeter's own history (`spentAt`), so an x402 payment on Flare
 *                counts against an XRPL payment here
 *   new payee    a destination this account has not paid for at least `coolingS` (default 24 h),
 *                and that the principal has not vouched for, may receive at most this many µUSD in
 *                total until it cools. An agent steered into paying someone it never paid before
 *                meets this rule first
 *
 * Pure functions, so the rules can be read and tested without a network.
 */
export interface Policy {
  hourlyCapUsd6?: bigint;
  newPayeeCapUsd6?: bigint;
  coolingS?: number;
  /** Destinations the principal vouches for: never new. */
  knownPayees?: string[];
}

export const HOUR_S = 3_600n;
export const DEFAULT_COOLING_S = 86_400n;
/** XRPL dates count seconds from 2000-01-01. */
export const RIPPLE_EPOCH = 946_684_800n;

/** Spend in the last hour across every rail, from the meter's history, plus this payment. */
export function overHourlyCap(spentNow: bigint, spentHourAgo: bigint, usd6: bigint, cap: bigint): boolean {
  return spentNow - spentHourAgo + usd6 > cap;
}

export interface PayeeHistory {
  /** Unix time of this account's first successful payment to the destination, if any was seen. */
  firstPaidAt?: bigint;
  /** Drops the destination received from this account inside the cooling period. */
  recentDrops: bigint;
}

/** One `account_tx` row's time, in unix seconds (API v1 `tx.date`, API v2 `close_time_iso`). */
function rowTime(row: any, tx: any): bigint | undefined {
  const date = tx.date ?? row.date;
  if (date !== undefined) return BigInt(date) + RIPPLE_EPOCH;
  if (typeof row.close_time_iso === "string") return BigInt(Math.floor(Date.parse(row.close_time_iso) / 1000));
  return undefined;
}

/** What this account has paid `destination` in XRP, from `account_tx` rows (successful payments only). */
export function payeeHistory(rows: any[], account: string, destination: string, now: bigint, coolingS: bigint): PayeeHistory {
  let firstPaidAt: bigint | undefined;
  let recentDrops = 0n;
  for (const row of rows) {
    const tx = row.tx ?? row.tx_json;
    const meta = row.meta;
    if (!tx || tx.TransactionType !== "Payment" || tx.Account !== account || tx.Destination !== destination) continue;
    if (typeof meta !== "object" || meta.TransactionResult !== "tesSUCCESS") continue;
    const amount = typeof meta.delivered_amount === "string" ? meta.delivered_amount : (tx.Amount ?? tx.DeliverMax);
    if (typeof amount !== "string") continue; // issued currencies are outside DELICTI's sight
    const at = rowTime(row, tx);
    if (at === undefined) continue;
    if (firstPaidAt === undefined || at < firstPaidAt) firstPaidAt = at;
    if (at + coolingS > now) recentDrops += BigInt(amount);
  }
  return { firstPaidAt, recentDrops };
}

/** A payee stays new until its first payment is `coolingS` old. */
export function isNewPayee(h: PayeeHistory, now: bigint, coolingS: bigint): boolean {
  return h.firstPaidAt === undefined || h.firstPaidAt + coolingS > now;
}

/** What a new payee already had during its cooling period, valued at this payment's price, plus this payment. */
export function overNewPayeeCap(recentDrops: bigint, drops: bigint, usd6: bigint, cap: bigint): boolean {
  return (recentDrops * usd6) / drops + usd6 > cap;
}
