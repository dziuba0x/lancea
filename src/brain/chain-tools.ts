/**
 * What the assistant can read on the two chains, for anyone who asks: live FTSO prices, any testnet
 * address, and any transaction explained (an XRPL payment's Smart Accounts instruction decoded, its
 * signers named; a Flare transaction's call decoded). Read-only: nothing here signs or sends.
 */
import { decodeFunctionData, formatEther, hexToString, isAddress, isHex, parseAbi, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { decodeMint, decodeReference } from "../smart-accounts.js";
import { meterAbi, registryAbi } from "../flare.js";
import { summaMeterAbi } from "../guard.js";
import type { XrplHttp } from "../xrpl-http.js";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as Address; // the same on every Flare network
const ftsoAbi = parseAbi(["function getFeedsById(bytes21[] _feedIds) payable returns (uint256[] _values, int8[] _decimals, uint64 _timestamp)"]);
const EXPLORER = { xrplTx: "https://testnet.xrpl.org/transactions/", xrplAcct: "https://testnet.xrpl.org/accounts/", flareTx: "https://coston2-explorer.flare.network/tx/", flareAddr: "https://coston2-explorer.flare.network/address/" };

/** An FTSO feed id: category 01 (crypto) and the name, in 21 bytes. */
export const feedId = (name: string): Hex => `0x01${stringToHex(name).slice(2).padEnd(40, "0")}` as Hex;

export class ChainTools {
  private ftso?: Address;
  constructor(private readonly pc: PublicClient, private readonly xrpl: XrplHttp, readonly labels: Map<string, string>) {}

  label(a?: string): string | undefined { return a ? this.labels.get(a.toLowerCase()) : undefined; }

  /** Prices from FTSOv2 on Coston2, as the guard's meter sees them: value, and the time of the last update. */
  async prices(symbols: string[]) {
    const names = [...new Set(symbols.map((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")).filter((s) => s.length >= 2 && s.length <= 10))].slice(0, 8);
    if (!names.length) return { error: "name a symbol or two, like XRP, FLR, BTC" };
    this.ftso ??= (await this.pc.readContract({ address: CONTRACT_REGISTRY, abi: parseAbi(["function getContractAddressByName(string) view returns (address)"]), functionName: "getContractAddressByName", args: ["FtsoV2"] })) as Address;
    const out: { feed: string; usd?: number; error?: string }[] = [];
    let at: number | undefined;
    for (const n of names) { // one at a time: a feed that does not exist reverts only its own call
      try {
        const { result } = await this.pc.simulateContract({ address: this.ftso, abi: ftsoAbi, functionName: "getFeedsById", args: [[feedId(`${n}/USD`)]], value: 0n });
        const [values, decimals, ts] = result as readonly [readonly bigint[], readonly number[], bigint];
        out.push({ feed: `${n}/USD`, usd: Number(values[0]) / 10 ** Number(decimals[0]) });
        at = Number(ts);
      } catch { out.push({ feed: `${n}/USD`, error: "no such FTSO feed" }); }
    }
    return { source: "FTSOv2 on Flare Coston2 (≈100 data providers, a new value every block-latency round)", updatedAt: at ? new Date(at * 1000).toISOString() : undefined, prices: out };
  }

  async address(addr: string) {
    if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) {
      const [info, txs] = await Promise.all([
        this.xrpl.rpc("account_info", { account: addr, ledger_index: "validated", signer_lists: true }).catch(() => undefined),
        this.xrpl.rpc("account_tx", { account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 6, forward: false }).catch(() => undefined),
      ]);
      if (!info) return { address: addr, found: false, note: "no such account on the XRPL testnet (never funded)" };
      const d = info.account_data ?? {};
      const list = (info.signer_lists ?? d.signer_lists ?? [])[0];
      return {
        address: addr, network: "XRPL testnet", is: this.label(addr), xrp: Number(d.Balance) / 1e6, explorer: EXPLORER.xrplAcct + addr,
        masterKeyDisabled: Boolean(Number(d.Flags ?? 0) & 0x00100000),
        signerList: list ? { quorum: list.SignerQuorum, signers: (list.SignerEntries ?? []).map((e: any) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight,
          is: this.label(e.SignerEntry.Account) ?? (e.SignerEntry.SignerWeight >= list.SignerQuorum ? "an owner key (can act alone)" : undefined) })) } : undefined,
        latest: ((txs as any)?.transactions ?? []).map((w: any) => { const tx = w.tx ?? w.tx_json ?? {}; return { type: tx.TransactionType, from: tx.Account, to: tx.Destination, xrp: typeof (tx.Amount ?? tx.DeliverMax) === "string" ? Number(tx.Amount ?? tx.DeliverMax) / 1e6 : undefined, hash: w.hash ?? tx.hash, result: w.meta?.TransactionResult }; }),
      };
    }
    if (isAddress(addr)) {
      const [wei, code] = await Promise.all([this.pc.getBalance({ address: addr as Address }), this.pc.getCode({ address: addr as Address }).catch(() => undefined)]);
      return { address: addr, network: "Flare Coston2", is: this.label(addr), c2flr: Number(formatEther(wei)), contract: Boolean(code && code !== "0x"), explorer: EXPLORER.flareAddr + addr };
    }
    return { error: "that is neither an XRP Ledger address (r…) nor a Flare address (0x…)" };
  }

  /** A transaction explained: an XRPL hash (64 hex) or a Flare one (0x + 64 hex). */
  async tx(hash: string, venue?: { operators: string[]; coreVault: string }[]) {
    const h = hash.trim();
    if (/^[0-9A-Fa-f]{64}$/.test(h)) return this.xrplTx(h.toUpperCase(), venue ?? []);
    if (/^0x[0-9a-fA-F]{64}$/.test(h)) return this.flareTx(h as Hex);
    return { error: "a transaction hash is 64 hex characters (XRPL) or 0x and 64 (Flare)" };
  }

  private async xrplTx(hash: string, venues: { operators: string[]; coreVault: string }[]) {
    let r: any;
    try { r = await this.xrpl.rpc("tx", { transaction: hash }); } catch { return { hash, found: false, note: "not on the XRPL testnet (or not validated yet)" }; }
    const tx = r.tx_json ?? r, meta = r.meta ?? {};
    const memo = tx.Memos?.[0]?.Memo?.MemoData as string | undefined;
    const toOperator = venues.some((v) => v.operators.includes(tx.Destination)), toCoreVault = venues.some((v) => v.coreVault === tx.Destination);
    let instruction: unknown;
    if (memo && toOperator) instruction = plain(decodeReference(memo));
    else if (memo && toCoreVault) instruction = plain(decodeMint(memo));
    else if (memo) instruction = { note: printable(memo) ?? "binary memo" };
    const amount = tx.Amount ?? tx.DeliverMax;
    return {
      hash, network: "XRPL testnet", type: tx.TransactionType, result: meta.TransactionResult, validated: r.validated,
      from: tx.Account, fromIs: this.label(tx.Account), to: tx.Destination, toIs: this.label(tx.Destination) ?? (toOperator ? "a Flare Smart Accounts operator wallet" : toCoreVault ? "the FAssets Core Vault (direct minting)" : undefined),
      xrp: typeof amount === "string" ? Number(amount) / 1e6 : undefined, feeXrp: tx.Fee ? Number(tx.Fee) / 1e6 : undefined,
      signers: (tx.Signers ?? []).map((s: any) => ({ account: s.Signer.Account, is: this.label(s.Signer.Account) })),
      instruction, when: r.close_time_iso ?? (tx.date !== undefined ? new Date((Number(tx.date) + 946_684_800) * 1000).toISOString() : undefined), explorer: EXPLORER.xrplTx + hash,
    };
  }

  private async flareTx(hash: Hex) {
    let t, rc;
    try { [t, rc] = await Promise.all([this.pc.getTransaction({ hash }), this.pc.getTransactionReceipt({ hash })]); } catch { return { hash, found: false, note: "not on Flare Coston2 (or not mined yet)" }; }
    let call: unknown;
    try {
      const d = decodeFunctionData({ abi: [...meterAbi, ...registryAbi, ...summaMeterAbi] as any, data: t.input });
      call = { function: d.functionName, args: plain(d.args) };
    } catch { call = t.input === "0x" ? "a plain C2FLR transfer" : `a call (selector ${t.input.slice(0, 10)})`; }
    return {
      hash, network: "Flare Coston2", status: rc.status, block: Number(rc.blockNumber),
      from: t.from, fromIs: this.label(t.from), to: t.to, toIs: this.label(t.to ?? undefined), c2flr: Number(formatEther(t.value)),
      call, gasUsed: Number(rc.gasUsed), feeC2flr: Number(formatEther(rc.gasUsed * rc.effectiveGasPrice)), events: rc.logs.length,
      explorer: EXPLORER.flareTx + hash,
    };
  }
}

/** bigints as strings, bytes32 text decoded where it is text: something a model can read. */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  if (typeof v === "string" && isHex(v) && v.length === 66) { const s = printable(v.slice(2)); if (s && s.length >= 3) return `${v} ("${s}")`; }
  return v;
}

/** A memo's text when it is text (printable, trimmed of padding), else undefined. */
export function printable(hex: string): string | undefined {
  try {
    const s = hexToString(`0x${hex.replace(/^0x/, "")}` as Hex).replace(/\0+$/g, "");
    if (!s || /[\u0000-\u0008\u000e-\u001f\u007f�]/.test(s)) return undefined;
    return s.slice(0, 160);
  } catch { return undefined; }
}
