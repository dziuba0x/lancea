/**
 * The XRP Ledger over plain JSON-RPC (HTTPS), for places where a websocket is not available.
 * xrpl.js does the signing and encoding offline. This does the four things that need the network:
 * fill a transaction, submit it, wait for validation, and fund a testnet account. It fails over
 * between public nodes (XrplHttp.TESTNET) when one refuses or rate-limits.
 */
import { decode, type Transaction } from "xrpl";

export class XrplHttp {
  /** Public testnet JSON-RPC nodes, tried in turn. XRPL Labs' node answers bursts from one address
   *  with "Contact XRPL Labs for a custom connectivity agreement", so it is not first. */
  static readonly TESTNET = ["https://s.altnet.rippletest.net:51234/", "https://testnet.xrpl-labs.com/", "https://clio.altnet.rippletest.net:51234/"];
  readonly endpoints: string[];
  private at = 0;

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
      this.at = (this.at + 1) % this.endpoints.length;
      await new Promise((s) => setTimeout(s, 1000 * Math.min(attempt + 1, 5)));
    }
    if (j.result?.status === "error") throw Object.assign(new Error(`${method}: ${j.result.error}`), { data: j.result });
    return j.result;
  }

  /** A funded testnet account: { address, seed }. */
  async fund(): Promise<{ address: string; seed: string }> {
    const r = await (await fetch(this.faucet, { method: "POST" })).json();
    const address = r.account?.address ?? r.account?.classicAddress;
    const seed = r.account?.secret ?? r.seed;
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
