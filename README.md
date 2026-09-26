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

`npm test` runs the rules offline: 5 tests of these rules (14 in all), with no network needed.

## One guard for XRPL and Flare (Flare Smart Accounts)

[Flare Smart Accounts](https://dev.flare.network/smart-accounts/overview) give every XRPL address a personal account on Flare. An XRPL `Payment` drives it:
- **deposits, redemptions and claims** in Firelight and Upshift vaults;
- **FXRP transfers and redemptions**;
- **arbitrary calls**, as a user operation.

Flare's docs put it plainly: *"Authorization comes from the XRPL Payment signature itself."* On a guarded account that signature needs the guard, so **every action the agent takes on Flare passes through the guard too**. One co-signer covers the agent's whole footprint on both ledgers.

**Measured on 2026-09-26** (XRPL testnet and Coston2, `npx tsx scripts/sa-multisig-e2e.ts`):
1. A fresh account `raS5RMnwDhZ4bb4mGwNZgbwzb92bhcbPtH` was set up with SignerList 2/1/1 and the master key disabled.
2. The agent alone sent an instruction to the operator (`rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq`): `tefBAD_QUORUM`.
3. Agent and guard together sent it: `tesSUCCESS`.
4. **86 seconds later** the operator had proven the payment with the FDC and called `executeInstruction` for this account on Coston2 ([`0xc93b9809…4706d`](https://coston2-explorer.flare.network/tx/0xc93b980935ab5c515a973597043ae0d37b9be01844b29894eb1f707ad234706d)).
5. The controller reverted `ValueZero()`, because the test moved 0 FXRP: the only instruction that needs no balance. A multi-signed account is relayed and proven like any other. A full success needs FXRP minted first.

**And the full loop, the same day** (`npx tsx scripts/sa-guarded-deposit.ts`). The guarded account is `rGGLyoSLJpg5MFzQCLhx6xb6mz8TCUwCCn`. Every step was vetted by `Guard.smartAccountVerdict`:

| step | what the agent asked | guard | on-chain |
|---|---|---|---|
| — | Core Vault, FAssets memo minting to `0x…bEEF` | **refused**: *an FAssets memo would mint FXRP to 0x…beef* | nothing signed |
| 1 | Core Vault, 20 XRP, memo minting to its own personal account | co-signed | XRPL `470E5F41…0DF43E`; Coston2 [`0x0579dd34…88229b`](https://coston2-explorer.flare.network/tx/0x0579dd3447baf8c87c4b9a7ad21c550d951c749053968e782dc916203188229b): **19.8 FXRP** to `0x678ee1C6…9e4902`, ~2 min |
| — | operator, deposit into Upshift vault 4 | **refused**: *upshift vault 4 is not an allowed vault* | nothing signed |
| 2 | operator, deposit 19 FXRP into Firelight vault 1 | co-signed | XRPL `B45E2ED8…BC2E7E`; Coston2 [`0x8e123383…dda4f0e`](https://coston2-explorer.flare.network/tx/0x8e12338305d0e7e0e3a403c7e00f801ba4bf5f1f11ba04b080e258e20dda4f0e): **18.985959 stXRP**, ~1.5 min |

XRP went to FXRP and then to Firelight, with every step co-signed. The two off-policy requests were never signed. The dollar budget and the tripwire were left out of this run, because they need a Flare key for `SummaMeter`.

**What the guard reads** (`src/smart-accounts.ts`, pure):
- **To an operator:** the 32-byte instruction.
  - Deposit, redeem and claim are allowed only in the principal's vaults.
  - FXRP transfers are allowed only to listed addresses.
  - FXRP redemption is allowed, because it returns XRP to this account.
- **To the FAssets Core Vault:** the minting memo.
  - For user operations (`0xFF` inline, or `0xFE` with the operation shown: `cosign(blob, userOp)`), every call is decoded and must be a listed target and selector, with no FLR attached.
  - Recovery opcodes are allowed. Pinning an executor is the principal's call.
- **The trap an allowlist of destinations would miss:** the Core Vault also mints FXRP to any Flare address named in an FAssets recipient memo (`0x4642505266410018…`), and to whoever holds a destination tag.
  - "May pay the Core Vault" would mean "may pay anyone". The guard refuses both, except a memo that mints to the account's own personal account.
  - One memo per payment, and no destination tag.

```ts
smartAccounts: {
  operators: ["rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq"],       // MasterAccountController.getXrplProviderWallets()
  coreVault: "r…",                                          // AssetManager.directMintingPaymentAddress()
  policy: { vaults: [1], calls: [/* { target, selector } */], personalAccount: "0x…" },
}
```

The decoder and policy have 6 offline tests, built from the vectors in Flare's docs and from the live run.

### The autopilot (`src/autopilot.ts`)

An agent that puts idle XRP to work, one step at a time, and never holds the keys alone. It only **proposes** XRPL payments. The guard reads each one, prices it against the umbrella's dollar budget, and co-signs or refuses. The guard needs no autopilot-specific code.

The order of steps: first any withdrawal the principal asked for (redeem vault shares), then deposit whole FXRP into the target vault, then mint idle XRP above the reserve. Each mint is capped per step.

`scripts/leash-live.ts` runs it live with the dollar budget and the tripwire:
1. It deploys a `SummaMeter` v1.2 and opens a $40 umbrella with tripwire 1.
2. The autopilot mints and deposits.
3. A steered agent tries to mint to a stranger: refused and struck, so the umbrella trips.
4. A legitimate redeem is refused while tripped, and co-signed after the principal re-arms.
5. A mint past $40 is refused.

It was rehearsed end to end on a Coston2 fork.

The guard also caps the transaction fee (`maxFeeDrops`, default 0.01 XRP), because a fee is outflow too.


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

- XRP `Payment`s only. Issued currencies (RLUSD) are outside DELICTI's evidence today: the FDC's `Payment` type attests native payments only.
- Smart Accounts: the full loop is proven live on testnets: mint, then deposit into Firelight, through the guard. The live runs skip the budget and the tripwire, which need a Flare key for `SummaMeter`.
- One guard. The design allows *k of n* independent guards, each with a bond. XRPL SignerLists hold up to 32 signers, so no single guard can block or collude.
- The guard's key is a local key. It is meant to move into a Flare Confidential Compute machine: TEE identities are secp256k1, which the XRP Ledger accepts as a signer.
- Accountability behind the brake: link the account's XRP-outflow mandate to the umbrella (DELICTI §6.10 + SUMMA). Then even a compromised guard is convicted from FDC proofs.
- A Xaman xApp as the front end.

MIT. Testnets only. Unaudited.
