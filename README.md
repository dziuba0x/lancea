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

**Status:** live end to end on 2026-09-26 (XRPL testnet + Coston2), against a `SummaMeter` v1.2 that the run deploys itself. See *Live: the autopilot on a leash* below. Against a meter from before v1.2, the guard refuses exactly as before and strikes nothing.

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

`npm test` runs the rules offline: 5 tests of these rules (18 in all), with no network needed.

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

The guard also caps the transaction fee (`maxFeeDrops`, default 0.01 XRP), because a fee is outflow too.

### Failing closed

The first live run of `leash-live.ts` got as far as the re-arm, then stopped (the rerun with this fix went through all seven steps: see below). The guard's Flare key held 0.5 C2FLR. On Coston2, a write must hold its gas at 2 × base fee + tip up front, about 0.3 C2FLR. So the fourth write could not be paid for (*gas required exceeds allowance*), the guard threw, and the run died.

Every Flare read and write in the guard now fails closed:
- **No reservation, no signature.** A `note` that fails is a refusal.
- **An unreadable meter or policy** is a refusal.
- **A strike that does not land is kept.** The guard signs nothing until it lands, or until the umbrella trips anyway.

`test/guard.test.ts` replays the live failure against a mock Coston2 node. The old guard throws the same error; the new one refuses.

**The live script:**
- funds the guard's key from the day's fee and tops it up before every step;
- writes the run's keys to `.run/` (git-ignored) before anything is funded;
- sends what is left back to the principal at the end;
- logs a failed step and goes on to its summary.

`--sweep .run/<file>` recovers a run that was killed.

**Rehearsing at Coston2's fees.** The earlier rehearsals ran on a bare fork, where gas is nearly free. `scripts/coston2-fork-proxy.mjs` puts Coston2's fee rules in front of an anvil fork: the base fee is held, and `eth_fillTransaction` is capped by the balance. On the fork the script also acts as Coston2's executor, so a rehearsal makes the same writes as the live run.
- With 0.5 C2FLR, the rehearsal fails at the same step as the live run, now as a refusal.
- With today's funding, all seven steps behave as designed, including through a 3× fee spike.


## Live: the autopilot on a leash, 2026-09-26 (XRPL testnet + Flare Coston2)

`scripts/leash-live.ts`, one run.
- **The meter:** a `SummaMeter` v1.2 ([`0x158c200b…9537`](https://coston2-explorer.flare.network/address/0x158c200bc3ffae51610c7b8f7d3a729fa2099537)) and umbrella #26: **$40** across both chains, tripwire 1.
- **The account:** guarded account `rJrP4DJ432xkHuhSw4URJKZApdfPWwBJA7`, personal account `0xFCe88875…5a69f`.
- **Before each co-signature,** the guard reserved the spend on Flare.

| step | the agent asks | the guard | XRPL | Coston2 |
|---|---|---|---|---|
| 2 | mint 20 XRP to its own personal account | co-signed, tally $30.45 of $40 | [`C5594974…37FE1`](https://testnet.xrpl.org/transactions/C55949744C4AAEF4938CFC981E50E876D0DC1743701351C80E85AEE5F2B37FE1) | [`0xd15742ff…6502e08`](https://coston2-explorer.flare.network/tx/0xd15742ffdf0a2c0ea655a3b75b040d91cf742ca1f90456c4c34c5ef2a6502e08): **19.8 FXRP**, ~2 min |
| 3 | deposit 19 FXRP into Firelight | co-signed | [`EF81E538…2FC9B`](https://testnet.xrpl.org/transactions/EF81E5387D3D076539CC36720AC8726E767AC16DC25589C809BD59F02152FC9B) | [`0xe4c9a409…9c44f4`](https://coston2-explorer.flare.network/tx/0xe4c9a409f81e3c054312e55fd64afc03df18e73fe59fb29b29b92b5b059c44f4): **18.985959 stXRP**, ~3 min |
| 4 | mint 5 XRP to `0x…bEEF` (steered) | **refused and struck**: the umbrella trips | nothing signed | strike [`0x0c2370cf…26dfed`](https://coston2-explorer.flare.network/tx/0x0c2370cf42a756ac2bf352928cc6647ff58f6a1b2bd6eebd960857bc9a26dfed) |
| 5 | redeem 1 share | **refused**: tripped, on every rail | nothing signed | — |
| 6 | the principal re-arms; the same redeem | co-signed | [`5AAC8411…4C356`](https://testnet.xrpl.org/transactions/5AAC8411BCC7A7A939E8325B8ED2092855B29E5833A34688D220A3DB4854C356) | [`0x4e745f20…2718af`](https://coston2-explorer.flare.network/tx/0x4e745f20614b1acb0117764493a92a131cbd3ad3ab2d586ad0ade551232718af): 1 stXRP redeem request, ~3 min |
| 7 | mint 20 XRP more | **refused**: past $40 | nothing signed | — |

**Verdict: 6 of 6 decisions as designed.**
- **One co-signer** governed the account on both ledgers.
- **One dollar budget** held across them.
- **One steered request stopped every rail** until the principal looked.

Step 7 was refused but not struck. The first spend was eight minutes old, inside the ten-minute lookback, so the conservative rule did not call it an attempt.

The guard's Flare writes cost 0.42 C2FLR. What was left on the run's keys went back to the principal.

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
DELICTI_OUT=../delicti/out/ npx tsx scripts/live.ts         # needs `forge build` in the delicti repo
DELICTI_OUT=../delicti/out/ npx tsx scripts/leash-live.ts   # the autopilot on a leash: ≥6 C2FLR, about 2 spent
```

It talks to the XRP Ledger over plain JSON-RPC (`src/xrpl-http.ts`), because websockets are not available everywhere. Signing and encoding are offline, done by xrpl.js.

## Status: MVP

- XRP `Payment`s only. Issued currencies (RLUSD) are outside DELICTI's evidence today: the FDC's `Payment` type attests native payments only.
- Smart Accounts: the full loop is proven live on testnets, through the guard: mint, deposit into Firelight, redeem. The dollar budget and the tripwire govern it (see *Live: the autopilot on a leash*).
- One guard. The design allows *k of n* independent guards, each with a bond. XRPL SignerLists hold up to 32 signers, so no single guard can block or collude.
- The guard's key is a local key. It is meant to move into a Flare Confidential Compute machine: TEE identities are secp256k1, which the XRP Ledger accepts as a signer.
- Accountability behind the brake: link the account's XRP-outflow mandate to the umbrella (DELICTI §6.10 + SUMMA). Then even a compromised guard is convicted from FDC proofs.
- A Xaman xApp as the front end.

MIT. Testnets only. Unaudited.
