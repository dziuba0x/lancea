# Lancea

**A co-signer on the XRP Ledger that will not sign past a [DELICTI](https://github.com/dziuba0x/delicti) budget, counted across chains.**

Give an AI agent an XRPL account, disable its master key, and put three keys in its SignerList:

| signer | weight | what it can do |
|---|---|---|
| principal | 2 | everything, alone: recovery never depends on anyone else |
| agent key | 1 | nothing alone |
| **Lancea guard** | 1 | nothing alone; with the agent, exactly what the budget allows |

Quorum 2. The agent proposes a payment and signs it. Before the guard co-signs, it asks DELICTI's `SummaMeter` on Flare one question: *would this take the agent's umbrella past its dollar budget?* The budget counts every rail the agent spends on: XRP on the Ledger, USD₮0 through x402 on Flare. Each amount is priced by Flare's FTSO. If the answer is no, the guard **reserves** the amount on Flare first (the tally records the intent before the act), then signs, combines and submits. If the answer is yes, there is no signature, and the payment cannot happen. The agent's key alone is weight 1 of 2.

The guard can refuse. It cannot move funds. Its failure mode is liveness, never theft, and the principal can always act alone.

This is the XRP Ledger's missing piece. Permission delegation (XLS-75) is all-or-nothing per transaction type: it has no amount limits, and it is not enabled on mainnet. Multisig has existed since 2016. Lancea makes it a spending limit that holds across chains.

## One attempt, every rail (DELICTI amendment v1.2)

A refusal is not only a no. When the refused payment breaks the budget even against the tally of ten minutes ago, at 99 % of its value, it was an **attempt**, not a lost race. The guard then **strikes** the umbrella in `SummaMeter`, with the hash of the agent's own signed blob as evidence.

Once the principal's tripwire is reached (`setTripwire`, one strike if they like), the meter answers *no* to everything, on every rail:
- the guard refuses every XRPL payment;
- DELICTI's x402 facilitator refuses every payment on Flare.

It stays that way until the principal looks and re-arms. It works in reverse too: an attempt recorded on Flare (`MandateFacilitator.recordAttempt`) trips the guard here without a line of Lancea code, because both ask the same meter.

**Status:** typechecked, and the attempt rule is checked against DELICTI's own test numbers. It is **not run live**, because the meter with the tripwire ships with DELICTI v0.16, which is not deployed yet. Against an older meter the guard refuses exactly as before and strikes nothing.

## The principal's rules

Two rules on top of the budget (`src/policy.ts`). They only ever refuse more, and both work against the DELICTI contracts live today.

- **An hourly cap across every rail** (`policy.hourlyCapUsd6`). It is read from `SummaMeter`'s own history (`spentAt`), so an x402 payment on Flare counts against an XRPL payment here.
- **New-payee cooling** (`policy.newPayeeCapUsd6`, `coolingS` with a 24 h default, `knownPayees`).
  - A destination this account has not paid for at least the cooling period gets at most the cap in total until it cools. Splitting does not reset it.
  - An agent steered into paying someone it never paid before meets this rule first.
  - With `strikeOnPolicy: true`, such a refusal is also a strike. With a tripwire of 1, it freezes the agent on every rail.
- **Where the payee history comes from:** the node's `account_tx`, plus every payment this guard co-signed itself.
  - Measured 2026-09-26: `testnet.xrpl-labs.com` keeps about 1,600 ledgers, roughly an hour and a half. On a node like that, the guard's own memory carries the rule.
  - After a restart, a payee paid before the node's range looks new again. That refuses more, never less.
  - Use a full-history node in production.

`npm test` runs the rules offline: 5 tests, with no network needed.

## Live, 2026-09-25 (XRPL testnet + Flare Coston2)

`npx tsx scripts/live.ts`, one run:

1. **XRPL.** Account `rfT9pw839NsV2STxkraMdNEyAU6Ny54qUX`: SignerList as above, master key disabled.
2. **Flare.** DELICTI umbrella #23: **$5** across both chains, bonded in VaultSumma. The guard and the x402 `MandateFacilitator` are its declared effectors.
3. **Flare, x402.** 1 mUSDT0 settled through the facilitator (`0x25c6ad16…`). Tally **$0.999652**.
4. **XRPL.** 2 XRP. The agent signs, the guard checks, reserves on Flare (`0xf6a01957…`) and co-signs. Tx `183E53AD…`, **tesSUCCESS**. Tally **$4.085854**.
5. **XRPL.** 2 XRP more: **refused**. It would reach about $7.17 of $5, counting the Flare spend.
6. **XRPL.** The agent submits it alone anyway: **`tefBAD_QUORUM`**.
7. **XRPL.** The principal alone, weight 2: `7432C479…` **tesSUCCESS**.

## Run it

```sh
npm ci
PRIVATE_KEY=0x…   # a Coston2 key with C2FLR (principal and gas)
DELICTI_OUT=../delicti/out/ npx tsx scripts/live.ts   # needs `forge build` in the delicti repo
```

It talks to the XRP Ledger over plain JSON-RPC (`src/xrpl-http.ts`), because websockets are not available everywhere. Signing and encoding are offline, done by xrpl.js.

## Status: MVP

- XRP `Payment`s only. Issued currencies (RLUSD) are outside DELICTI's evidence today.
- One guard. The design allows *k of n* independent guards, each with a bond. XRPL SignerLists hold up to 32 signers, so no single guard can block or collude.
- The guard's key is a local key. It is meant to move into a Flare Confidential Compute machine: TEE identities are secp256k1, which the XRP Ledger accepts as a signer.
- Accountability behind the brake: link the account's XRP-outflow mandate to the umbrella (DELICTI §6.10 + SUMMA). Then even a compromised guard is convicted from FDC proofs.
- A Xaman xApp as the front end.

MIT. Testnets only. Unaudited.
