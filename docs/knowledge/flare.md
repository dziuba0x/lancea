# Flare, for Lancea

What the parts of Flare that Lancea and DELICTI stand on do, in short, with where to read more. The
brain's assistant searches this file; the numbers are Flare's own (dev.flare.network), and the
Coston2 addresses are the ones this demo uses.

## Flare in one paragraph

Flare is an EVM layer 1 whose validators also run two data protocols, enshrined in the network
itself: the FTSO (prices) and the FDC (facts from other chains and the web). Blocks come about every
1.8 seconds. The native token is FLR (C2FLR on the Coston2 testnet, chain id 114, free from
https://faucet.flare.network/coston2). Contracts find each other through the FlareContractRegistry
at `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`, the same address on every Flare network.

## FTSO: prices, from about 100 independent providers

- **FTSOv2 block-latency feeds** update with every block (about every 1.8 s) and are read on-chain
  through `FtsoV2Interface` (`getFeedById`, `getFeedsById`: value, decimals, timestamp). A feed id is
  21 bytes: a category byte (`01` for crypto) and the name, for example XRP/USD is
  `0x015852502f55534400000000000000000000000000`. Reading may cost a fee (IFeeCalculator); on
  Coston2 it is zero.
- **Anchor feeds (Scaling)** come from a full commit-reveal round across all data providers every
  voting epoch, 90 seconds, weighted by stake, with an inter-quartile band. Providers are rewarded
  when their block-latency values stay within ±0.25% of the anchor. Up to about 1,000 feeds (crypto,
  equities, commodities), with two weeks of history.
- **In Lancea**: DELICTI's SummaMeter prices every payment in dollars with the FTSO at the moment the
  guard reserves it, so one dollar budget covers XRP on the ledger and stablecoins on Flare alike.
  More: https://dev.flare.network/ftso/overview

## FDC: facts from elsewhere, attested by consensus

- The Flare Data Connector lets anyone request an attestation of an external event; Flare's data
  providers check it and publish a Merkle root every voting round (90 s) in the Relay contract. A
  contract then verifies a proof against that root.
- Seven attestation types: **AddressValidity**, **EVMTransaction** (Ethereum, Flare, Songbird),
  **Payment** (Bitcoin, Dogecoin, XRP Ledger), **JsonApi / Web2Json** (any Web2 API through a JQ
  transformation; testnets), **ConfirmedBlockHeightExists**, **BalanceDecreasingTransaction** and
  **ReferencedPaymentNonexistence** (the last three mostly for FAssets).
- **In DELICTI**: the FDC is witness 2. What the agent did on the XRP Ledger or an EVM chain is proven
  from consensus, not from the agent's own logs, and that proof can slash a bond. The XRPL verifier
  sees about 14 days back, which is why DELICTI files deeds in a docket while they are provable.
  More: https://dev.flare.network/fdc/overview

## FAssets: XRP on Flare, over-collateralized

- FAssets bridge assets of chains without smart contracts (XRP, BTC, DOGE) to Flare as ERC-20
  tokens: FXRP for XRP. They are trustless and over-collateralized, built on the FTSO (prices) and
  the FDC (proof that the underlying payment happened).
- **Agents** hold the underlying XRP and back it with two kinds of collateral: vault collateral
  (a stablecoin or ETH) and pool collateral (FLR from a community collateral pool, whose providers
  earn a share of minting fees). Agents are approved by governance.
- **Minting**: a minter reserves an agent's collateral for a fee, pays the XRP, the FDC proves the
  payment, and FXRP is minted. Minting and redemption come in **lots** (10 FXRP on Coston2, read from
  `AssetManager.lotSize()`). **Direct minting** pays the **Core Vault** with a memo naming the Flare
  recipient; anyone may execute it.
- **Redemption**: FXRP is burned and an agent pays the XRP out on the ledger. If the agent does not
  pay in time, the redeemer is paid from the agent's collateral instead, with a premium.
- **Core Vault**: a governance-controlled multisig on the XRP Ledger that holds pooled XRP, so agents
  can free collateral; it also supports redemptions.
- **Liquidation**: when an agent's collateral ratio falls too low, anyone may burn FXRP for its
  collateral at a premium. **Challengers** who prove an illegal payment by an agent trigger a full
  liquidation and are rewarded.
- **In Lancea**: the agent mints XRP into FXRP by paying the Core Vault, and the guard reads the
  memo: a mint may only name the account's own personal account, because the Core Vault would mint
  to any address the memo names. More: https://dev.flare.network/fassets/overview

## Smart Accounts: an XRP Ledger account that acts on Flare

- Every XRPL address has a **personal account** on Flare, a smart-contract wallet that only that XRPL
  address controls, through ordinary XRPL Payments. No FLR is needed.
- An instruction rides in the payment's memo as a 32-byte payment reference, sent to an operator
  wallet. The operator gets a Payment proof from the FDC and calls `executeTransaction` on the
  **MasterAccountController** (`0x434936d47503353f06750Db1A444DBDC5F0AD37c`, the same on every Flare
  network), and the personal account does what the instruction says.
- Instruction ids used here: `0x02` FXRP redeem (value in lots), `0x11` Firelight deposit, `0x12`
  Firelight redeem (start a withdrawal), `0x13` Firelight claim (value is the period). Custom
  instructions (`0xFF`) run registered calls; direct-minting memos `0xFE`/`0xFF` carry user operations.
- **In Lancea**: because an XRPL signature alone authorizes all of this, the guard is the one place it
  can be vetted: it decodes every instruction and allows only the owner's vault and the account's own
  personal account. More: https://dev.flare.network/smart-accounts/overview

## Firelight: a vault for FXRP

- An ERC-4626 vault: deposit FXRP for shares, or mint shares for FXRP. Withdrawals are period based:
  `withdraw` or `redeem` burns the shares and books the FXRP for the **next** period; `claimWithdraw`
  pays it out once that period has ended. On Coston2 a period is 14,400 s (4 hours), so FXRP asked for
  now unlocks in 4 to 8 hours.
- **In Lancea**: the live agent's wheel deposits minted FXRP, starts withdrawing five lots once a
  period, claims them when they unlock and redeems them back to XRP, round and round.
  More: https://dev.flare.network/fxrp/firelight

## Where things are (Coston2, this demo)

- DELICTI SummaMeter (v1.2, the dollar tally and the tripwire): `0x39aa9b12CDe7bFc936456247DFb3eb78aA1FaB1D`
- DELICTI MandateRegistry (umbrellas and mandates): `0x2c58fb0504377fef325DceB66219bC6302263AA3`
- DELICTI VaultSumma (bonds): `0x274e8aa149C0904E10b99c79017EB7EE74184E54`
- FAssets AssetManager for FXRP: `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`
- Smart Accounts MasterAccountController: `0x434936d47503353f06750Db1A444DBDC5F0AD37c`
- Firelight vault (FXRP), vault id 1: `0xC90D6847747b85d1fa2E07859869fb9fB72c0361`
- Explorers: https://coston2-explorer.flare.network and https://testnet.xrpl.org
