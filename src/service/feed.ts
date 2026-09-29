/**
 * What the dashboard reads: the services' journals and the chains' state, in one public JSON. It holds
 * nothing secret: the guard's journal keeps what a blob does and what the agent said, never the blob.
 * docs/index.html renders it; dashboard/sample-feed.json is one, from the rehearsal of 2026-09-27.
 */
import { readQueue, readVault } from "../firelight.js";
import type { PublicClient } from "viem";
import { registryAbi as registryReadAbi, summaMeterAbi } from "../guard.js";
import { b32, meterAbi, smartAccountsAbi } from "../flare.js";
import { decodeReference } from "../smart-accounts.js";
import { DAY_S, RIPPLE_EPOCH } from "../policy.js";
import type { XrplHttp } from "../xrpl-http.js";
import type { Entry } from "./journal.js";
import type { LanceaConfig } from "./config.js";
import { LEDGER_RESERVE_DROPS } from "./autopilot-daemon.js";

export const TESTNET_EXPLORERS = {
  xrplTx: "https://testnet.xrpl.org/transactions/",
  xrplAccount: "https://testnet.xrpl.org/accounts/",
  flareTx: "https://coston2-explorer.flare.network/tx/",
  flareAddress: "https://coston2-explorer.flare.network/address/",
};

export interface ChainSnapshot {
  /** `pendingFxrp`: asked back from the vault, not claimed yet (the wheel's Firelight queue). */
  account: { xrpDrops: string; fxrp: string; shares: string; pendingFxrp?: string };
  /** `spentTodayUsd6`: spent since `dayStart` (00:00 UTC), the day the principal's daily cap counts. */
  umbrella: { budgetUsd6: string; spentUsd6: string; tripwire: string; strikes: string; tripped: boolean; validFrom?: string; validUntil?: string;
    spentTodayUsd6?: string; dayStart?: string };
  /** The SignerList's weight-2 entry. */
  owner?: string;
  /** C2FLR (wei) on the Flare keys that pay gas: the guard, for each decision's record; the agent. */
  fuel?: { guardWei?: string; agentWei?: string };
  /** One XRP in µUSD, as the meter prices it (FTSO). */
  xrpUsd6?: string;
  /** The vault: its period clock, what a share is worth, what it holds, and this account's withdrawals on their way. */
  vault?: { address: string; period: string; periodEnd: string; periodSeconds: string; sharePrice6: string; totalAssets: string;
    queue: { period: string; assets: string; unlocksAt: string; claimable: boolean }[] };
  /** The account's latest payments on the ledger, in and out, each named by what it was. */
  ledger?: { hash: string; at: string; dir: "in" | "out"; drops: string; feeDrops?: string; counterparty: string; what: string }[];
}

/** What a payment on the ledger was, from its counterparty and memo. */
export function nameOf(row: { dir: "in" | "out"; counterparty: string; memo?: string; hash: string }, c: LanceaConfig, topups: Set<string>): string {
  const sa = c.smartAccounts;
  if (row.dir === "out") {
    if (row.counterparty === sa.coreVault) return "Core Vault · a mint";
    if (sa.operators.includes(row.counterparty)) {
      const d = row.memo ? decodeReference(row.memo) : undefined;
      const what = d && d.kind === "vault" ? { deposit: "a deposit", redeem: "a withdrawal", claim: "a claim" }[d.action] : d && d.kind === "fxrp-redeem" ? "a redemption" : "an instruction";
      return `Operator · ${what}`;
    }
    return "A payment";
  }
  if (topups.has(row.hash)) return "XRPL testnet faucet";
  if ((row.memo ?? "").toUpperCase().startsWith("4642505266410002")) return "FAssets agent · a redemption paid";
  return "A payment in";
}

/** From the services themselves: the journals' totals, pinned examples, and what a decision costs the guard. */
export interface FeedExtras {
  stats?: unknown;
  exemplars?: Record<string, unknown>;
  perDecisionWei?: string;
}

export function buildFeed(c: LanceaConfig, chain: ChainSnapshot, guard: Entry[], autopilot: Entry[], now = new Date(), x: FeedExtras = {}) {
  const pace = c.pacing ?? { slowBelowC2flr: 25, restBelowC2flr: 5, slowEveryS: 900 };
  return {
    version: 1,
    generatedAt: now.toISOString(),
    networks: { xrpl: "testnet", flare: "coston2", flareFork: false },
    explorers: TESTNET_EXPLORERS,
    account: { address: c.account, personalAccount: c.smartAccounts.personalAccount, vaultName: c.smartAccounts.vaultName ?? "Firelight", ...chain.account },
    keys: { owner: chain.owner, agent: c.keys?.agentXrpl, guard: c.keys?.guardXrpl, guardFlare: c.keys?.guardFlare, agentEvm: c.agentEvm },
    umbrella: { id: c.umbrella.id, meter: c.umbrella.meter, ...chain.umbrella, ...(c.guard?.dailyCapUsd6 ? { dailyCapUsd6: c.guard.dailyCapUsd6 } : {}) },
    fuel: { ...(chain.fuel ?? {}), ...(x.perDecisionWei ? { perDecisionWei: x.perDecisionWei } : {}), pacing: pace },
    ...(chain.xrpUsd6 ? { xrpUsd6: chain.xrpUsd6 } : {}),
    ...(chain.vault ? { vault: chain.vault } : {}),
    ...(chain.ledger ? { ledger: chain.ledger } : {}),
    ...(x.stats ? { stats: x.stats } : {}),
    ...(x.exemplars ? { exemplars: x.exemplars } : {}),
    guard,
    autopilot,
  };
}

/** The chains, read now: the umbrella on the meter, the account on the ledger, FXRP and shares on Flare. */
export async function readChain(c: LanceaConfig, xrpl: XrplHttp, pc: PublicClient, topups: Set<string> = new Set()): Promise<ChainSnapshot> {
  const id = BigInt(c.umbrella.id);
  const meter = (functionName: "spentUsd6" | "tripwire" | "strikes" | "tripped") =>
    pc.readContract({ address: c.umbrella.meter, abi: meterAbi, functionName, args: [id] });
  const balance = (token: `0x${string}`) =>
    pc.readContract({ address: token, abi: smartAccountsAbi, functionName: "balanceOf", args: [c.smartAccounts.personalAccount] }) as Promise<bigint>;
  const wei = (a?: string) => (a ? pc.getBalance({ address: a as `0x${string}` }).then(String) : Promise.resolve(undefined));
  const [m, spent, tripwire, strikes, tripped, info, objects, fxrp, shares, guardWei, agentWei, queue] = await Promise.all([
    pc.readContract({ address: c.umbrella.registry, abi: registryReadAbi, functionName: "get", args: [id] }),
    meter("spentUsd6"), meter("tripwire"), meter("strikes"), meter("tripped"),
    xrpl.rpc("account_info", { account: c.account, ledger_index: "validated" }),
    xrpl.rpc("account_objects", { account: c.account, type: "signer_list", ledger_index: "validated" }),
    balance(c.smartAccounts.fxrp),
    balance(c.smartAccounts.vault),
    wei(c.keys?.guardFlare), wei(c.agentEvm),
    c.strategy.loopLots ? readQueue(pc, c.smartAccounts.vault, c.smartAccounts.personalAccount).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // what the page adds on top: each is best effort, and a miss leaves the rest of the feed intact
  const optional = <T>(p: Promise<T>) => p.catch(() => undefined);
  const nowS = await optional(pc.getBlock().then((b) => b.timestamp));
  const dayStart = nowS !== undefined ? nowS - (nowS % DAY_S) : undefined;
  const [today, price, vaultInfo, txs] = await Promise.all([
    dayStart !== undefined ? optional(pc.readContract({ address: c.umbrella.meter, abi: summaMeterAbi, functionName: "spentAt", args: [id, dayStart] }) as Promise<bigint>) : undefined,
    optional(pc.simulateContract({ account: c.agentEvm, address: c.umbrella.meter, abi: summaMeterAbi, functionName: "wouldExceed",
      args: [id, b32(c.network.xrplSource), b32("XRP/outflow"), 1_000_000n, 0] }).then((r) => (r.result as readonly [boolean, bigint])[1])),
    c.strategy.loopLots ? optional(readVault(pc, c.smartAccounts.vault)) : undefined,
    optional(xrpl.rpc("account_tx", { account: c.account, ledger_index_min: -1, ledger_index_max: -1, limit: 30, forward: false })),
  ]);
  const ledger = ((txs as any)?.transactions ?? []).flatMap((row: any) => {
    const tx = row.tx ?? row.tx_json, meta = row.meta;
    if (!tx || tx.TransactionType !== "Payment" || typeof meta !== "object" || meta.TransactionResult !== "tesSUCCESS") return [];
    const amount = typeof meta.delivered_amount === "string" ? meta.delivered_amount : tx.Amount ?? tx.DeliverMax;
    if (typeof amount !== "string") return [];
    const dir = tx.Account === c.account ? "out" as const : "in" as const;
    const hash = String(row.hash ?? tx.hash ?? "");
    const at = tx.date !== undefined ? new Date(Number((BigInt(tx.date) + RIPPLE_EPOCH) * 1000n)).toISOString() : String(row.close_time_iso ?? "");
    const memo = tx.Memos?.[0]?.Memo?.MemoData as string | undefined;
    const counterparty = dir === "out" ? String(tx.Destination) : String(tx.Account);
    return [{ hash, at, dir, drops: amount, ...(dir === "out" ? { feeDrops: String(tx.Fee ?? "") } : {}), counterparty,
      what: nameOf({ dir, counterparty, memo, hash }, c, topups) }];
  });
  const spendable = BigInt(info.account_data.Balance) - LEDGER_RESERVE_DROPS;
  const entries: { SignerEntry: { Account: string; SignerWeight: number } }[] = objects.account_objects?.[0]?.SignerEntries ?? [];
  return {
    account: { xrpDrops: (spendable > 0n ? spendable : 0n).toString(), fxrp: fxrp.toString(), shares: shares.toString(),
      ...(queue ? { pendingFxrp: queue.pending.toString() } : {}) },
    umbrella: { budgetUsd6: (m as { budget: bigint }).budget.toString(), spentUsd6: String(spent), tripwire: String(tripwire), strikes: String(strikes), tripped: Boolean(tripped),
      validFrom: String((m as { validFrom: bigint }).validFrom), validUntil: String((m as { validUntil: bigint }).validUntil),
      ...(today !== undefined && dayStart !== undefined ? { spentTodayUsd6: String(BigInt(spent as bigint) - today), dayStart: dayStart.toString() } : {}) },
    owner: entries.find((e) => e.SignerEntry.SignerWeight >= 2)?.SignerEntry.Account,
    fuel: { guardWei, agentWei },
    ...(price !== undefined ? { xrpUsd6: price.toString() } : {}),
    ...(queue?.queue && vaultInfo ? { vault: {
      address: c.smartAccounts.vault, period: queue.period.toString(), periodEnd: String(queue.periodEnd), periodSeconds: String(queue.periodSeconds),
      sharePrice6: vaultInfo.sharePrice6.toString(), totalAssets: vaultInfo.totalAssets.toString(),
      queue: queue.queue.map((w) => ({ period: w.period.toString(), assets: w.assets.toString(), unlocksAt: w.unlocksAt.toString(), claimable: w.claimable })),
    } } : {}),
    ...(ledger.length ? { ledger } : {}),
  };
}
