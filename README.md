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
