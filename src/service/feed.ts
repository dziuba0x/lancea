/**
 * What the dashboard reads: the services' journals and the chains' state, in one public JSON. It holds
 * nothing secret: the guard's journal keeps what a blob does and what the agent said, never the blob.
 * docs/index.html renders it; dashboard/sample-feed.json is one, from the rehearsal of 2026-09-27.
 */
import type { PublicClient } from "viem";
import { registryAbi as registryReadAbi } from "../guard.js";
import { meterAbi, smartAccountsAbi } from "../flare.js";
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
  account: { xrpDrops: string; fxrp: string; shares: string };
  umbrella: { budgetUsd6: string; spentUsd6: string; tripwire: string; strikes: string; tripped: boolean };
  /** The SignerList's weight-2 entry. */
  owner?: string;
}

export function buildFeed(c: LanceaConfig, chain: ChainSnapshot, guard: Entry[], autopilot: Entry[], now = new Date()) {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    networks: { xrpl: "testnet", flare: "coston2", flareFork: false },
    explorers: TESTNET_EXPLORERS,
    account: { address: c.account, personalAccount: c.smartAccounts.personalAccount, vaultName: c.smartAccounts.vaultName ?? "Firelight", ...chain.account },
    keys: { owner: chain.owner, agent: c.keys?.agentXrpl, guard: c.keys?.guardXrpl, guardFlare: c.keys?.guardFlare, agentEvm: c.agentEvm },
    umbrella: { id: c.umbrella.id, meter: c.umbrella.meter, ...chain.umbrella },
    guard,
    autopilot,
  };
}

/** The chains, read now: the umbrella on the meter, the account on the ledger, FXRP and shares on Flare. */
export async function readChain(c: LanceaConfig, xrpl: XrplHttp, pc: PublicClient): Promise<ChainSnapshot> {
  const id = BigInt(c.umbrella.id);
  const meter = (functionName: "spentUsd6" | "tripwire" | "strikes" | "tripped") =>
    pc.readContract({ address: c.umbrella.meter, abi: meterAbi, functionName, args: [id] });
  const balance = (token: `0x${string}`) =>
    pc.readContract({ address: token, abi: smartAccountsAbi, functionName: "balanceOf", args: [c.smartAccounts.personalAccount] }) as Promise<bigint>;
  const [m, spent, tripwire, strikes, tripped, info, objects, fxrp, shares] = await Promise.all([
    pc.readContract({ address: c.umbrella.registry, abi: registryReadAbi, functionName: "get", args: [id] }),
    meter("spentUsd6"), meter("tripwire"), meter("strikes"), meter("tripped"),
    xrpl.rpc("account_info", { account: c.account, ledger_index: "validated" }),
    xrpl.rpc("account_objects", { account: c.account, type: "signer_list", ledger_index: "validated" }),
    balance(c.smartAccounts.fxrp),
    balance(c.smartAccounts.vault),
  ]);
  const spendable = BigInt(info.account_data.Balance) - LEDGER_RESERVE_DROPS;
  const entries: { SignerEntry: { Account: string; SignerWeight: number } }[] = objects.account_objects?.[0]?.SignerEntries ?? [];
  return {
    account: { xrpDrops: (spendable > 0n ? spendable : 0n).toString(), fxrp: fxrp.toString(), shares: shares.toString() },
    umbrella: { budgetUsd6: (m as { budget: bigint }).budget.toString(), spentUsd6: String(spent), tripwire: String(tripwire), strikes: String(strikes), tripped: Boolean(tripped) },
    owner: entries.find((e) => e.SignerEntry.SignerWeight >= 2)?.SignerEntry.Account,
  };
}
