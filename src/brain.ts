/**
 * What the autopilot thinks with. A brain proposes one step and says why, in words a person can check
 * against the numbers. It decides nothing: every step is still an XRPL Payment the guard prices,
 * checks and co-signs or refuses, so a brain that is wrong, or steered, costs a refusal, not the funds.
 *
 *   RulesBrain   the autopilot's rules (src/autopilot.ts), with the reason spelled out
 *   (M2)         a hybrid: a model proposes where judgement helps, the rules check every proposal
 */
import { plan, type State, type Step, type Strategy } from "./autopilot.js";

export interface Proposal {
  step?: Step;
  why: string;
  by: "rules" | "ai";
}

export interface Brain {
  decide(s: State, k: Strategy): Promise<Proposal>;
}

const X = (units: bigint) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

/** The reason for a step, from the same numbers the rules used. */
export function explain(step: Step | undefined, s: State, k: Strategy): string {
  const idle = s.xrpDrops - k.keepDrops;
  if (!step) {
    return `nothing worth doing: ${X(s.fxrp)} FXRP waiting, ${X(idle > 0n ? idle : 0n)} XRP idle above the ` +
      `${X(k.keepDrops)} XRP reserve (a mint needs at least ${X(k.minMintDrops)})`;
  }
  switch (step.kind) {
    case "redeem":
      return `the principal asked for liquidity: redeem ${X(step.shares)} shares from vault ${step.vaultId}`;
    case "deposit":
      return `${X(s.fxrp)} FXRP sits idle in my personal account: deposit ${X(step.amount)} into vault ${step.vaultId}`;
    case "mint":
      return `${X(idle)} XRP idle above the ${X(k.keepDrops)} XRP reserve: mint ${X(step.drops)} XRP to my own ` +
        `personal account (at most ${X(k.maxMintDrops)} a step)`;
  }
}

export class RulesBrain implements Brain {
  async decide(s: State, k: Strategy): Promise<Proposal> {
    const step = plan(s, k);
    return { step, why: explain(step, s, k), by: "rules" };
  }
}
