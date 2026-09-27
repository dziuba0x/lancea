/**
 * A rehearsal proxy: an anvil fork of Coston2 that pays gas the way Coston2 does.
 *
 * The first rehearsals ran on a bare fork, where anvil lets the base fee decay block by block and
 * viem estimates its own fees. Gas there was nearly free, so a guard funded with 0.5 C2FLR looked
 * fine. On Coston2 it ran dry at the fourth write. This proxy restores the two rules that matter:
 *
 *   - the base fee stays at Coston2's (BASE_GWEI, 500 today): it is re-set before every transaction;
 *   - eth_fillTransaction fills like the Coston2 node (go-flare): maxFee = 2 × base fee + tip
 *     (TIP_GWEI, 150 today), and gas is capped by what the balance can pay at that fee. Past the cap
 *     it answers "gas required exceeds allowance (N)", the error the live run died on.
 *
 * And one it can add: SPIKE_AFTER=n SPIKE_GWEI=g raises the base fee to g after the n-th transaction,
 * the way a busy hour does, to rehearse the guard's top-ups.
 *
 *   anvil --fork-url https://rpc.ankr.com/flare_coston2 --chain-id 114 --port 8545
 *   node scripts/coston2-fork-proxy.mjs          # listens on 8546
 *   COSTON2_RPC=http://127.0.0.1:8546 FORK=1 npx tsx scripts/leash-live.ts
 */
import http from "node:http";

const UP = process.env.UP ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? 8546);
const GWEI = 10n ** 9n;
const BASE = BigInt(process.env.BASE_GWEI ?? 500) * GWEI;
const TIP = BigInt(process.env.TIP_GWEI ?? 150) * GWEI;
const SPIKE_AFTER = process.env.SPIKE_AFTER ? Number(process.env.SPIKE_AFTER) : Infinity;
const SPIKE = BigInt(process.env.SPIKE_GWEI ?? 1500) * GWEI;
const hex = (n) => `0x${n.toString(16)}`;
let seq = 1, sent = 0, base = BASE;

async function up(method, params = []) {
  const r = await fetch(UP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method, params }) });
  return r.json();
}

/** go-flare's eth_fillTransaction, as far as fees and the gas allowance go. */
async function fill(tx) {
  // like geth: fees and gas the sender set are kept, and a set gas limit is not estimated (so a
  // transaction built to revert on-chain is still filled and sent)
  const tip = tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : TIP;
  const maxFee = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : 2n * base + tip;
  const balance = BigInt((await up("eth_getBalance", [tx.from, "latest"])).result);
  const value = BigInt(tx.value ?? "0x0");
  const allowance = balance > value ? (balance - value) / maxFee : 0n;
  let gas;
  if (tx.gas) gas = BigInt(tx.gas);
  else {
    const est = await up("eth_estimateGas", [{ from: tx.from, to: tx.to, data: tx.data ?? tx.input, value: tx.value }, "latest"]);
    if (est.error) return { error: est.error };
    gas = BigInt(est.result);
  }
  if (gas > allowance) return { error: { code: -32000, message: `gas required exceeds allowance (${allowance})` } };
  const nonce = tx.nonce ?? (await up("eth_getTransactionCount", [tx.from, "pending"])).result;
  return { result: { raw: "0x", tx: {
    type: "0x2", chainId: "0x72", nonce, from: tx.from, to: tx.to ?? null, gas: hex(gas), value: tx.value ?? "0x0",
    input: tx.data ?? tx.input ?? "0x", maxFeePerGas: hex(maxFee), maxPriorityFeePerGas: hex(tip), accessList: [],
    hash: `0x${"0".repeat(64)}`,
  } } };
}

async function one({ id, method, params }) {
  let out;
  if (method === "eth_fillTransaction") out = await fill(params[0]);
  else if (method === "eth_maxPriorityFeePerGas") out = { result: hex(TIP) };
  else if (method === "eth_sendRawTransaction") {
    await up("anvil_setNextBlockBaseFeePerGas", [hex(base)]);
    out = await up(method, params);
    if (++sent === SPIKE_AFTER) { // every transaction after this one pays the spiked base fee
      base = SPIKE;
      console.log(`fee spike after transaction ${sent}: base ${base / GWEI} gwei`);
    }
  } else out = await up(method, params);
  return { jsonrpc: "2.0", id, ...(out.error ? { error: out.error } : { result: out.result }) };
}

await up("anvil_setNextBlockBaseFeePerGas", [hex(BASE)]);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const msg = JSON.parse(body);
      const out = Array.isArray(msg) ? await Promise.all(msg.map(one)) : await one(msg);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
}).listen(PORT, () => console.log(`coston2-fork-proxy :${PORT} → ${UP} | base ${BASE / GWEI} gwei, tip ${TIP / GWEI} gwei, fill cap 2×base+tip${
  SPIKE_AFTER < Infinity ? ` | spike to ${SPIKE / GWEI} gwei after transaction ${SPIKE_AFTER}` : ""}`));
