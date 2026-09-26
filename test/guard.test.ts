/**
 * The guard fails closed. A mock Flare node answers the way Coston2 answered on 2026-09-26, when the
 * guard's key ran out of gas in the live run: eth_fillTransaction → "gas required exceeds allowance".
 * Every failure must come back as a refusal: no crash, no signature, and no strike forgotten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Wallet, type Payment } from "xrpl";
import { defineChain, decodeFunctionData, encodeFunctionResult, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { Guard, summaMeterAbi, registryAbi } from "../src/guard.js";
import type { XrplHttp } from "../src/xrpl-http.js";

const Z = `0x${"0".repeat(64)}` as Hex;
const METER = "0x61764cca60262f5ee2799e79f6fa6762c67ce18b" as Address;
const REGISTRY = "0x2c58fb0504377fef325DceB66219bC6302263AA3" as Address;
const OUT_OF_GAS = { error: { code: -32000, message: "gas required exceeds allowance (178813)" } };
const abi = [...summaMeterAbi, ...registryAbi];

type Answer = { result?: unknown; error?: { code: number; message: string } };

/** A JSON-RPC node that answers what `on` says. `asked` lists every method it was asked. */
async function mockNode(on: (method: string, params: any[]) => Answer | undefined) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const one = (m: any) => {
        asked.push(m.method);
        const a = on(m.method, m.params ?? []) ?? { error: { code: -32601, message: `the mock has no ${m.method}` } };
        return { jsonrpc: "2.0", id: m.id, ...a };
      };
      const msg = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, asked, close: () => server.close() };
}

/** The meter and registry as the mock sees them; `fill` decides whether a write can pay its gas. */
function flare(s: { stop: boolean; usd6: bigint; tripped: boolean; spentAt: bigint; budget: bigint; fill: "out-of-gas" | "ok" }) {
  const block = { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: Z, timestamp: "0x68000000", baseFeePerGas: "0x746a528800",
    gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], difficulty: "0x0", miner: `0x${"0".repeat(40)}`, extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", receiptsRoot: Z, sha3Uncles: Z, size: "0x0", stateRoot: Z,
    totalDifficulty: "0x0", transactionsRoot: Z, uncles: [], mixHash: Z };
  const sent = new Map<Hex, Hex>(); // tx hash → sender
  const call = (data: Hex): Hex => {
    const { functionName } = decodeFunctionData({ abi, data });
    const result = {
      wouldExceed: [s.stop || s.tripped, s.usd6], tripped: s.tripped, registry: REGISTRY, spentAt: s.spentAt, spentUsd6: s.spentAt,
      get: { principal: REGISTRY, agent: REGISTRY, mandateHash: Z, authorityRef: Z, parentId: 0n, budget: s.budget, validFrom: 0n,
        validUntil: 2n ** 63n, revoked: false, sourceId: Z, assetKey: Z, agentRef: Z, bond: REGISTRY },
    }[functionName];
    return encodeFunctionResult({ abi, functionName, result } as never);
  };
  return (method: string, params: any[]): Answer | undefined => {
    switch (method) {
      case "eth_chainId": return { result: "0x72" };
      case "eth_blockNumber": return { result: "0x10" };
      case "eth_getBlockByNumber": return { result: block };
      case "eth_call": return { result: call(params[0].data ?? params[0].input) };
      case "eth_fillTransaction": {
        if (s.fill === "out-of-gas") return OUT_OF_GAS;
        const t = params[0];
        return { result: { raw: "0x", tx: { type: "0x2", chainId: "0x72", nonce: "0x0", from: t.from, to: t.to, gas: "0x30000", value: "0x0",
          input: t.data ?? t.input, maxFeePerGas: "0x174876e800", maxPriorityFeePerGas: "0x1", accessList: [], hash: Z } } };
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const { functionName } = decodeFunctionData({ abi, data: parseTransaction(raw).data! });
        if (functionName === "strike") s.tripped = true; // tripwire 1
        const hash = keccak256(raw);
        sent.set(hash, raw);
        return { result: hash };
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0] as Hex;
        if (!sent.has(hash)) return { result: null };
        return { result: { transactionHash: hash, blockHash: block.hash, blockNumber: "0x10", transactionIndex: "0x0", from: REGISTRY, to: METER,
          cumulativeGasUsed: "0xc8c9", gasUsed: "0xc8c9", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: block.logsBloom,
          status: "0x1", type: "0x2" } };
      }
    }
    return undefined;
  };
}

function setup(url: string) {
  const account = Wallet.generate(), agent = Wallet.generate();
  const xrpl = { submitted: 0, async submitAndWait() { this.submitted++; return { hash: "CAFE", result: "tesSUCCESS" }; }, async rpc() { return {}; } };
  const chain = defineChain({ id: 114, name: "mock", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const guard = new Guard({ account: account.address, guardSeed: Wallet.generate().seed!, flareKey: generatePrivateKey(), chain, rpcUrl: url,
    meter: METER, umbrellaId: 25n, xrplSource: "testXRP" }, xrpl as unknown as XrplHttp);
  const pay = (sequence: number): string => agent.sign({ TransactionType: "Payment", Account: account.address, Destination: Wallet.generate().address,
    Amount: "20000000", Fee: "36", Sequence: sequence, LastLedgerSequence: 1000, SigningPubKey: "" } as Payment, true).tx_blob;
  return { guard, xrpl, pay };
}

test("the live failure: the reservation cannot pay its gas → a refusal, nothing signed, no crash", async () => {
  const node = await mockNode(flare({ stop: false, usd6: 30_000_000n, tripped: false, spentAt: 0n, budget: 40_000_000n, fill: "out-of-gas" }));
  try {
    const { guard, xrpl, pay } = setup(node.url);
    const d = await guard.cosign(pay(1));
    assert.equal(d.signed, false);
    assert.match(d.signed ? "" : d.reason, /^reservation failed, nothing signed: note: .*gas required exceeds allowance \(178813\)/);
    assert.equal(xrpl.submitted, 0, "nothing reached the XRP Ledger");
    assert.ok(!node.asked.includes("eth_sendRawTransaction"));
  } finally { node.close(); }
});

test("Flare unreachable → a refusal, nothing signed", async () => {
  const { guard, xrpl, pay } = setup("http://127.0.0.1:9"); // nothing listens there
  const d = await guard.cosign(pay(1));
  assert.equal(d.signed, false);
  assert.match(d.signed ? "" : d.reason, /^SummaMeter unreadable, nothing signed/);
  assert.equal(xrpl.submitted, 0);
});

test("a strike that does not land blocks every signature until it lands", async () => {
  const s = { stop: true, usd6: 30_000_000n, tripped: false, spentAt: 30_000_000n, budget: 40_000_000n, fill: "out-of-gas" as "out-of-gas" | "ok" };
  const node = await mockNode(flare(s));
  try {
    const { guard, xrpl, pay } = setup(node.url);
    // 1. an attempt past the budget: refused, and the strike cannot pay its gas
    const d1 = await guard.cosign(pay(1));
    assert.equal(d1.signed, false);
    assert.match(d1.signed ? "" : d1.reason, /struck as an attempt; the strike did not land \(strike: .*gas required exceeds allowance.*\), so nothing is signed until it does/);
    // 2. a payment that fits the budget: still refused, the pending strike comes first
    s.stop = false;
    const d2 = await guard.cosign(pay(2));
    assert.equal(d2.signed, false);
    assert.match(d2.signed ? "" : d2.reason, /^an earlier strike has not landed/);
    // 3. the key is topped up: the strike lands first, the umbrella trips, the payment is refused as tripped
    s.fill = "ok";
    const d3 = await guard.cosign(pay(3));
    assert.equal(d3.signed, false);
    assert.equal(s.tripped, true);
    assert.match(d3.signed ? "" : d3.reason, /tripped; its principal must re-arm it/);
    assert.equal(xrpl.submitted, 0, "nothing reached the XRP Ledger in all three");
  } finally { node.close(); }
});

test("within the budget and the key can pay: reserved, then co-signed", async () => {
  const s = { stop: false, usd6: 1_000_000n, tripped: false, spentAt: 0n, budget: 40_000_000n, fill: "ok" as const };
  const node = await mockNode(flare(s));
  try {
    const { guard, xrpl, pay } = setup(node.url);
    const d = await guard.cosign(pay(1));
    assert.equal(d.signed, true);
    assert.equal(xrpl.submitted, 1);
  } finally { node.close(); }
});
