/**
 * What the services need from Flare, without DELICTI's build output: Coston2's addresses and the
 * few functions the guard, the autopilot and provisioning call. The live scripts read full ABIs
 * from delicti/out; a server only ever needs these.
 */
import { defineChain, pad, parseAbi, stringToHex, type Address, type Hex } from "viem";

export const coston2 = (rpcUrl = "https://coston2-api.flare.network/ext/C/rpc") =>
  defineChain({ id: 114, name: "coston2", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

/** DELICTI v0.16 and Flare's own contracts on Coston2 (docs/DEPLOYMENTS.md in delicti). */
export const COSTON2 = {
  registry: "0x2c58fb0504377fef325DceB66219bC6302263AA3" as Address, // MandateRegistry, shared by every version
  summaVault: "0x274e8aa149C0904E10b99c79017EB7EE74184E54" as Address, // VaultSumma (v0.16)
  summaMeter: "0x39aa9b12CDe7bFc936456247DFb3eb78aA1FaB1D" as Address, // SummaMeter v1.2 (v0.16)
  masterAccountController: "0x434936d47503353f06750Db1A444DBDC5F0AD37c" as Address,
  assetManagerFxrp: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA" as Address,
};

export const b32 = (s: string): Hex => pad(stringToHex(s), { dir: "right", size: 32 });

export const registryAbi = parseAbi([
  "struct Terms { bytes32 sourceId; bytes32 assetKey; bytes32 agentRef; address bond; }",
  "function commit(address agent, bytes32 mandateHash, bytes32 authorityRef, uint256 parentId, uint256 budget, uint64 validFrom, uint64 validUntil, Terms terms) returns (uint256 id)",
  "function acknowledge(uint256 id)",
  "function acknowledged(uint256) view returns (bool)",
]);

/** The principal's side of amendment v1.2, and what anyone may read. */
export const meterAbi = parseAbi([
  "function declareEffector(uint256 umbrellaId, address e)",
  "function setTripwire(uint256 umbrellaId, uint256 strikesToTrip)",
  "function rearm(uint256 umbrellaId)",
  "function spentUsd6(uint256) view returns (uint256)",
  "function tripwire(uint256) view returns (uint256)",
  "function strikes(uint256) view returns (uint256)",
  "function tripped(uint256 umbrellaId) view returns (bool)",
]);

/** Flare Smart Accounts and FAssets, as the autopilot sees them. */
export const smartAccountsAbi = parseAbi([
  "function getXrplProviderWallets() view returns (string[])",
  "function getDefaultInstructionFee() view returns (uint256)",
  "function getPersonalAccount(string) view returns (address)",
  "function getVaults() view returns (uint256[], address[], uint8[])",
  "function directMintingPaymentAddress() view returns (string)",
  "function fAsset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
