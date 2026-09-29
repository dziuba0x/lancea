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
    vaultName?: string;
  };
  /** The services' public addresses, for the dashboard (scripts/keys-init.ts printed them). */
  keys?: { agentXrpl: string; guardXrpl: string; guardFlare: Address };
  /** Where src/service/feed-publisher.ts pushes the dashboard's feed. */
  feed?: { repo: string; branch?: string; publishSeconds?: number; heartbeatSeconds?: number };
  /** `loopLots`: turn the wheel (src/autopilot.ts), this many FAssets lots a vault period. */
  strategy: { keepDrops: string; maxMintDrops: string; minMintDrops: string; loopLots?: number; loopMarginDrops?: string };
  autopilot: { tickSeconds: number; executionTimeoutS: number; backoffS: number; cooldownS?: number };
  /** Testnet only: top the account up from the XRPL faucet when everything it holds falls below `targetDrops`. */
  keeper?: { targetDrops: string; refillDrops: string; everyS: number };
  /** Every co-signature costs the guard gas on Flare: below `slowBelowC2flr` the agent asks at most once per
   *  `slowEveryS`; below `restBelowC2flr` it asks nothing, so the guard keeps enough to strike. */
  pacing?: { slowBelowC2flr: number; restBelowC2flr: number; slowEveryS: number };
  /** `dailyCapUsd6`: at most this many µUSD per UTC day across every rail (a refusal, never a strike). */
  /** `coolingS`: how long a payee stays new (default a day); `knownPayees`: never new. */
  guard: { host: string; port: number; strikeOnPolicy: boolean; hourlyCapUsd6?: string; newPayeeCapUsd6?: string; dailyCapUsd6?: string; coolingS?: number; knownPayees?: string[] };
  dataDir: string;
  /** The brain (src/brain/server.ts): Gemini on its free tier, on this server, holding no key of this account. */
  brain?: BrainConfig;
}

export interface BrainConfig {
  /** The public API (127.0.0.1, the tunnel's target) and the autopilot's (127.0.0.1 only). */
  port: number;
  internalPort: number;
  /** The autopilot asks the model for each step (the rules decide whenever it cannot). */
  pilot?: boolean;
  /** Model chains, first choice first: a model whose free quota is spent hands over to the next. */
  models?: { chat?: string[]; pilot?: string[]; sentinel?: string[] };
  /** How hard Gemini 3 models think, per job ("minimal", "low", "medium", "high"); the model's default when absent. */
  thinking?: { chat?: string; pilot?: string; sentinel?: string };
  /** Pages that may call the public API (CORS). */
  origins?: string[];
  /** "quick": a Cloudflare quick tunnel (a random https://….trycloudflare.com, no account); "off": none. */
  tunnel?: "quick" | "off";
  cloudflared?: string;
  /** The Sentinel's rhythm: a note this often, and early after an incident. */
  reflectEveryS?: number;
  /** [label, path] of the documents the assistant can search (paths relative to the working directory). */
  knowledge?: [string, string][];
  /** The playground: its own config and keys directory (guard.json, agent.json, token, principal). */
  playground?: { config: string; keys: string; rearmAfterS?: number; keepXrp?: number; refillXrp?: number; minGuardC2flr?: number };
  /** Rate limits: [count, window in seconds]. */
  limits?: { chatPerIp?: [number, number]; chatPerIpDay?: number; chatGlobal?: [number, number]; chatGlobalDay?: number; actPerIp?: [number, number]; actPerIpDay?: number; actGlobal?: [number, number] };
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

/** `lotDrops`: AssetManager.lotSize(), read on start (the wheel redeems in whole lots). */
export const strategyOf = (c: LanceaConfig, lotDrops = 10_000_000n): Strategy => {
  const s = c.strategy;
  const maxMint = BigInt(s.maxMintDrops);
  const loop = s.loopLots && s.loopLots > 0 ? { lotDrops, lots: s.loopLots, marginDrops: BigInt(s.loopMarginDrops ?? "10000") } : undefined;
  // with the wheel on, a mint must stay below a lot: FXRP of a lot or more is taken for a claim and redeemed
  if (loop && maxMint >= lotDrops) throw new Error(`lancea config: strategy.maxMintDrops must stay below a lot (${lotDrops}) when loopLots is set`);
  return { vaultId: c.smartAccounts.vaultId, keepDrops: BigInt(s.keepDrops), maxMintDrops: maxMint, minMintDrops: BigInt(s.minMintDrops), loop };
};

export const venueOf = (c: LanceaConfig): Venue => ({
  account: c.account,
  operator: c.smartAccounts.operators[0],
  fee: BigInt(c.smartAccounts.operatorFeeDrops),
  coreVault: c.smartAccounts.coreVault,
  personalAccount: c.smartAccounts.personalAccount,
});

const keysDir = () => process.env.LANCEA_KEYS ?? "keys";

/** A key file's contents, if only its owner can read it. */
function secret(name: string, dir = keysDir()): string {
  const path = join(dir, name);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}): chmod 600 it first`);
  return readFileSync(path, "utf8").trim();
}

/** A secret by name from $LANCEA_KEYS, only if its owner alone can read it (the brain's Gemini key: "gemini"). */
export const loadSecret = (name: string, dir?: string): string => secret(name, dir);

export const loadGuardKeys = (): GuardKeys => JSON.parse(secret("guard.json"));
export const loadAgentKeys = (): AgentKeys => JSON.parse(secret("agent.json"));
/** The bearer token the autopilot shows the guard: a second process on the machine cannot ask for signatures. */
export const loadToken = (): string => secret("token");
