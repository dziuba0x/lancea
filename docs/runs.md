# Live runs

Each run below happened on public testnets (XRPL testnet and Flare Coston2), and every transaction in it can be opened in an explorer. They are kept here as they were written on the day. The README describes what Lancea is now.

## Live: the autopilot on a leash, 2026-09-27 (XRPL testnet + Flare Coston2)

`scripts/leash-live.ts`, one run, on DELICTI's deployed meter.
- **The meter:** `SummaMeter` v1.2 ([`0x39aa9b12…1FaB1D`](https://coston2-explorer.flare.network/address/0x39aa9b12CDe7bFc936456247DFb3eb78aA1FaB1D), DELICTI v0.16, source verified) and umbrella #28: **$40** across both chains, tripwire 1.
- **The account:** guarded account `r3PbVz5eztnFEMipt7HDzWMFw451jBqrNB`, personal account `0xb5000A4f…42f20`.
- **Before each co-signature,** the guard reserved the spend on Flare. Its Flare key is the umbrella's declared effector.

| step | the agent asks | the guard | XRPL | Coston2 |
|---|---|---|---|---|
| 2 | mint 20 XRP to its own personal account | co-signed, tally $30.33 of $40 | [`2A599C1B…BA4019`](https://testnet.xrpl.org/transactions/2A599C1B3B5493D74323E777BF3C78474547ADBDFDFBE1BCB2B77C1436BA4019) | [`0x0879fede…ab413bc`](https://coston2-explorer.flare.network/tx/0x0879fede39e3a73afecb6538fbe402b206182a3d12b653d8899dcd58bab413bc): **19.8 FXRP**, ~2 min |
| 3 | deposit 19 FXRP into Firelight | co-signed | [`60A165C3…BD366C`](https://testnet.xrpl.org/transactions/60A165C31248A40774483DEAA9366D50F9B57B235D494A165719D606A3BD366C) | [`0x6913df12…e18e7637`](https://coston2-explorer.flare.network/tx/0x6913df12b882fdc8275dc37fb3b36deb2329c3d08d4f479e83f924abe18e7637): **18.985959 stXRP**, ~3 min |
| 4 | mint 5 XRP to `0x…bEEF` (steered) | **refused and struck**: the umbrella trips | nothing signed | strike [`0xa9c305e4…e214b9f5`](https://coston2-explorer.flare.network/tx/0xa9c305e42bfdc4ff1f4ac0e222295d0eb7e1467701ae42ab01fdea33e214b9f5) |
| 5 | redeem 1 share | **refused**: tripped, on every rail | nothing signed | — |
| 6 | the principal re-arms; the same redeem | co-signed | [`78201163…32CD8C`](https://testnet.xrpl.org/transactions/7820116359E74C6DB8748423C26B7A8CC9A39A0F856FF94F69C2FA296C32CD8C) | [`0x67021199…607f9506`](https://coston2-explorer.flare.network/tx/0x67021199300e19c02db7a10b6dda3734a7cadd32f4497b399c2360a0607f9506): 1 stXRP redeem request, ~2.5 min |
| 7 | mint 20 XRP more | **refused**: past $40 | nothing signed | — |

**Verdict: 6 of 6 decisions as designed.**
- **One co-signer** governed the account on both ledgers.
- **One dollar budget** held across them, on the meter DELICTI deployed for every rail.
- **One steered request stopped every rail** until the principal looked.

Step 7 was refused but not struck. The first spend was eight minutes old, inside the ten-minute lookback, so the conservative rule did not call it an attempt.

The guard's Flare writes cost 0.42 C2FLR. What was left on the run's keys went back to the principal.

The first run, on 2026-09-26, used a meter it deployed itself ([`0x158c200b…9537`](https://coston2-explorer.flare.network/address/0x158c200bc3ffae51610c7b8f7d3a729fa2099537), umbrella #26) and made the same six decisions; its transactions are listed in [this README as of that run](https://github.com/dziuba0x/lancea/blob/c6a7ead/README.md#live-the-autopilot-on-a-leash-2026-09-26-xrpl-testnet--flare-coston2).

## Live, 2026-09-25 (XRPL testnet + Flare Coston2)

`npx tsx scripts/live.ts`, one run:

1. **XRPL.** Account `rfT9pw839NsV2STxkraMdNEyAU6Ny54qUX`: SignerList as above, master key disabled.
2. **Flare.** DELICTI umbrella #23: **$5** across both chains, bonded in VaultSumma. The guard and the x402 `MandateFacilitator` are its declared effectors.
3. **Flare, x402.** 1 mUSDT0 settled through the facilitator (`0x25c6ad16…`). Tally **$0.999652**.
4. **XRPL.** 2 XRP. The agent signs, the guard checks, reserves on Flare (`0xf6a01957…`) and co-signs. Tx `183E53AD…`, **tesSUCCESS**. Tally **$4.085854**.
5. **XRPL.** 2 XRP more: **refused**. It would reach about $7.17 of $5, counting the Flare spend.
6. **XRPL.** The agent submits it alone anyway: **`tefBAD_QUORUM`**.
7. **XRPL.** The principal alone, weight 2: `7432C479…` **tesSUCCESS**.
