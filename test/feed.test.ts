/**
 * The dashboard's feed, offline. It is built from the journals and the chains and holds nothing a
 * signer would want; it is published as one commit, replaced each time, to a repo the services' machine
 * can only push to; and a new timestamp alone is not a change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeed } from "../src/service/feed.js";
import { FeedRepo, contentHash } from "../src/service/feed-publisher.js";
import type { LanceaConfig } from "../src/service/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lancea-feed-"));
const sample = JSON.parse(readFileSync(new URL("../dashboard/sample-feed.json", import.meta.url), "utf8"));

const config = {
  account: sample.account.address,
  umbrella: { id: "30", meter: sample.umbrella.meter, registry: "0x2c58fb0504377fef325DceB66219bC6302263AA3" },
  agentEvm: sample.keys.agentEvm,
  smartAccounts: { personalAccount: sample.account.personalAccount, vaultName: "Firelight" },
  keys: { agentXrpl: sample.keys.agent, guardXrpl: sample.keys.guard, guardFlare: sample.keys.guardFlare },
} as unknown as LanceaConfig;
const chain = {
  account: { xrpDrops: "77999950", fxrp: "0", shares: "0" },
  umbrella: { budgetUsd6: "500000000", spentUsd6: "30451685", tripwire: "1", strikes: "0", tripped: false },
  owner: sample.keys.owner,
};

test("the feed carries the journals and the chains' state, and no secret", () => {
  const feed = buildFeed(config, chain, sample.guard, sample.autopilot, new Date("2026-09-28T10:00:00Z"));
  assert.equal(feed.generatedAt, "2026-09-28T10:00:00.000Z");
  assert.equal(feed.umbrella.budgetUsd6, "500000000");
  assert.equal(feed.keys.owner, sample.keys.owner);
  assert.equal(feed.keys.guard, sample.keys.guard);
  assert.equal(feed.guard.length, sample.guard.length);
  const text = JSON.stringify(feed);
  assert.doesNotMatch(text, /seed|privateKey|flareKey|xrplSeed|evmKey|token/i);
  assert.doesNotMatch(text, /"blob"/); // what a blob does, never the blob
});

test("a new timestamp alone is not a change", () => {
  const a = buildFeed(config, chain, sample.guard, sample.autopilot, new Date(0));
  const b = buildFeed(config, chain, sample.guard, sample.autopilot, new Date(60_000));
  assert.equal(contentHash(a), contentHash(b));
  const c = buildFeed(config, { ...chain, umbrella: { ...chain.umbrella, strikes: "1", tripped: true } }, sample.guard, sample.autopilot, new Date(0));
  assert.notEqual(contentHash(a), contentHash(c));
});

test("publishing replaces the one commit on the remote", () => {
  const remote = join(tmp(), "feed.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const repo = new FeedRepo(join(tmp(), "work"), remote);
  repo.publish('{"n":1}');
  repo.publish('{"n":2}');
  const log = execFileSync("git", ["--git-dir", remote, "log", "--oneline", "main"]).toString().trim().split("\n");
  assert.equal(log.length, 1);
  assert.equal(execFileSync("git", ["--git-dir", remote, "show", "main:feed.json"]).toString(), '{"n":2}');
});
