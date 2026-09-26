/**
 * The XRP Ledger over plain JSON-RPC (HTTPS), for places where a websocket is not available.
 * xrpl.js does the signing and encoding offline. This does the four things that need the network:
 * fill a transaction, submit it, wait for validation, and fund a testnet account. It fails over
 * between public nodes (XrplHttp.TESTNET) when one refuses or rate-limits.
 */
import { decode, type Transaction } from "xrpl";

export class XrplHttp {
  /** Public testnet JSON-RPC nodes, tried in turn: Ripple's rippled, Ripple's Clio (on 443, which
   *  networks that close port 51234 still reach; it forwards submit to rippled), then XRPL Labs, last
   *  because it answers bursts from one address with "Contact XRPL Labs for a custom connectivity agreement". */
  static readonly TESTNET = ["https://s.altnet.rippletest.net:51234/", "https://clio.altnet.rippletest.net/", "https://testnet.xrpl-labs.com/"];
  readonly endpoints: string[];
  private at = 0;
  /** Told when a node did not answer and the request moves on: a live run's log should show it. */
  onRetry?: (note: string) => void;

  constructor(endpoint?: string | string[], readonly faucet = "https://faucet.altnet.rippletest.net/accounts") {
    this.endpoints = Array.isArray(endpoint) ? endpoint : endpoint ? [endpoint] : XrplHttp.TESTNET;
  }

  /** The node in use now. */
  get endpoint(): string { return this.endpoints[this.at]; }

  /**
   * One JSON-RPC call. A node that is unreachable, or that answers with text instead of JSON (a
   * rate-limit or connectivity notice), did not process the request, so the same request goes to
   * the next node, with a short back-off. A JSON error (actNotFound, …) is an answer: it is thrown.
   */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    let j: any, last = "";
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
        const text = await r.text();
        try { j = JSON.parse(text); break; } catch { last = text; }
      } catch (e) { last = (e as Error).message; }
      if (attempt >= 3 * this.endpoints.length) throw new Error(`${method}: ${last.slice(0, 80)} (tried ${this.endpoints.join(", ")})`);
      const from = this.endpoint;
      this.at = (this.at + 1) % this.endpoints.length;
      this.onRetry?.(`${method} at ${from}: ${last.replace(/\s+/g, " ").slice(0, 80)} → ${this.endpoint}`);
      await new Promise((s) => setTimeout(s, 1000 * Math.min(attempt + 1, 5)));
    }
    if (j.result?.status === "error") throw Object.assign(new Error(`${method}: ${j.result.error}`), { data: j.result });
    return j.result;
  }

  /** A funded testnet account: { address, seed }. */
  async fund(): Promise<{ address: string; seed: string }> {
    let address: string | undefined, seed: string | undefined, last = "";
    for (let i = 0; i < 4 && !(address && seed); i++) { // the faucet refuses bursts too
      if (i) { this.onRetry?.(`faucet: ${last.slice(0, 80)} → again`); await new Promise((s) => setTimeout(s, 5000 * i)); }
      try {
        const text = await (await fetch(this.faucet, { method: "POST" })).text();
        const r = JSON.parse(text);
        address = r.account?.address ?? r.account?.classicAddress;
        seed = r.account?.secret ?? r.seed;
        last = text;
      } catch (e) { last = (e as Error).message; }
    }
    if (!address || !seed) throw new Error(`faucet: no account (${last.slice(0, 80)})`);
    for (let i = 0; i < 20; i++) { // wait until the funding payment is validated
      try { await this.rpc("account_info", { account: address, ledger_index: "validated" }); return { address, seed }; } catch { await new Promise((s) => setTimeout(s, 4000)); }
    }
    throw new Error(`faucet account ${address} never appeared`);
  }

  /** Sequence, Fee (× signers + 1 for multisig) and LastLedgerSequence. */
  async autofill<T extends Transaction>(tx: T, signers = 0): Promise<T> {
    const info = await this.rpc("account_info", { account: tx.Account, ledger_index: "current" });
    const cur = await this.rpc("ledger_current");
    const fee = await this.rpc("fee");
    const base = BigInt(fee.drops?.open_ledger_fee ?? fee.drops?.base_fee ?? "12");
    return { ...tx, Sequence: info.account_data.Sequence, Fee: (base * BigInt(signers + 1)).toString(), LastLedgerSequence: cur.ledger_current_index + 20 };
  }

  /** Submit a signed blob (single- or multi-signed) and wait until it is validated. */
  async submitAndWait(blob: string): Promise<{ hash: string; result: string }> {
    const s = await this.rpc("submit", { tx_blob: blob });
    const hash: string = s.tx_json?.hash;
    if (!["tesSUCCESS", "terQUEUED"].includes(s.engine_result)) return { hash, result: s.engine_result };
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3500));
      try {
        const t = await this.rpc("tx", { transaction: hash });
        if (t.validated) return { hash, result: t.meta?.TransactionResult };
      } catch { /* not found yet */ }
    }
    return { hash, result: "timeout" };
  }

  static decode(blob: string) {
    return decode(blob);
  }
}
