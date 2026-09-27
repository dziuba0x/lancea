/**
 * The services' configuration and keys, kept apart.
 *
 *   config  $LANCEA_CONFIG (default ./lancea.config.json): addresses, ids, strategy. Public: it names
 *           what is guarded, never how to sign for it. scripts/provision.ts writes it.
 *   keys    $LANCEA_KEYS (default ./keys): guard.json, agent.json and token, one file per holder, made
 *           on the machine that runs the services by scripts/keys-init.ts and never copied off it.
 *           A service refuses to start when a key file can be read by anyone but its owner.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Strategy, Venue } from "../autopilot.js";

export interface LanceaConfig {
  network: { rpcUrl: string; xrplRpc?: string[]; xrplSource: string };
  /** The guarded XRPL account: master key disabled, SignerList owner 2 / agent 1 / guard 1, quorum 2. */
  account: string;
  umbrella: { id: string; meter: Address; registry: Address };
  /** The umbrella's agent on Flare: it acknowledged the umbrella. */
  agentEvm: Address;
  smartAccounts: {
    operators: string[];
    operatorFeeDrops: string;
    coreVault: string;
    personalAccount: Address;
    fxrp: Address;
    vault: Address;
    vaultId: number;
  };
  strategy: { keepDrops: string; maxMintDrops: string; minMintDrops: string };
  autopilot: { tickSeconds: number; executionTimeoutS: number; backoffS: number };
  guard: { host: string; port: number; strikeOnPolicy: boolean; hourlyCapUsd6?: string; newPayeeCapUsd6?: string };
  dataDir: string;
}

export interface GuardKeys { xrplSeed: string; flareKey: Hex }
export interface AgentKeys { xrplSeed: string; evmKey: Hex }

const need = (ok: unknown, what: string) => { if (!ok) throw new Error(`lancea config: ${what}`); };

export function loadConfig(path = process.env.LANCEA_CONFIG ?? "lancea.config.json"): LanceaConfig {
  const c = JSON.parse(readFileSync(path, "utf8")) as LanceaConfig;
  need(c.network?.rpcUrl && c.network?.xrplSource, "network.rpcUrl and network.xrplSource");
  need(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(c.account ?? ""), "account (an XRPL r-address)");
  need(c.umbrella?.id && c.umbrella?.meter && c.umbrella?.registry, "umbrella.id, umbrella.meter, umbrella.registry");
  need(c.smartAccounts?.operators?.length && c.smartAccounts.coreVault && c.smartAccounts.personalAccount, "smartAccounts");
  need(c.strategy?.keepDrops && c.strategy?.maxMintDrops && c.strategy?.minMintDrops, "strategy");
  need(c.autopilot?.tickSeconds > 0, "autopilot.tickSeconds");
  need(c.guard?.port > 0, "guard.port");
  need(c.dataDir, "dataDir");
  return c;
}

export const strategyOf = (c: LanceaConfig): Strategy => ({
  vaultId: c.smartAccounts.vaultId,
  keepDrops: BigInt(c.strategy.keepDrops),
  maxMintDrops: BigInt(c.strategy.maxMintDrops),
  minMintDrops: BigInt(c.strategy.minMintDrops),
});

export const venueOf = (c: LanceaConfig): Venue => ({
  account: c.account,
  operator: c.smartAccounts.operators[0],
  fee: BigInt(c.smartAccounts.operatorFeeDrops),
  coreVault: c.smartAccounts.coreVault,
  personalAccount: c.smartAccounts.personalAccount,
});

const keysDir = () => process.env.LANCEA_KEYS ?? "keys";

/** A key file's contents, if only its owner can read it. */
function secret(name: string): string {
  const path = join(keysDir(), name);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}): chmod 600 it first`);
  return readFileSync(path, "utf8").trim();
}

export const loadGuardKeys = (): GuardKeys => JSON.parse(secret("guard.json"));
export const loadAgentKeys = (): AgentKeys => JSON.parse(secret("agent.json"));
/** The bearer token the autopilot shows the guard: a second process on the machine cannot ask for signatures. */
export const loadToken = (): string => secret("token");
