/* Lancea Watch: the page. It reads the demo machine's feed.json (every minute), turns it into five
 * views and hands the sky what belongs in it: where the white star sits, and a star for every decision.
 * Everything a viewer reads is plain HTML; the glass and the sky are drawn by glass.js underneath.
 * Motion follows SwiftUI: springs (smooth, snappy, bouncy), numbers that roll digit by digit, glass that
 * flows from one layout into the next, and a sheet pulled out of the row it describes. */
(() => {
  "use strict";
  const FEED_URL = "https://raw.githubusercontent.com/dziuba0x/lancea-feed/main/feed.json";
  const AWAY_S = 1800; // the machine publishes at least every 10 min; three missed heartbeats means it is off
  const TABS = ["now", "timeline", "budget", "keys", "how"];
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cut = (s, a = 6, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s ?? "");
  const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s ?? "");
  const u6 = (x) => Number(x ?? 0) / 1e6;
  const usd = (x, d = 2) => "$" + u6(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (x, d = 2) => Number(x).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  const xrp = (drops) => num(u6(drops), 6);
  const c2flr = (wei) => (wei == null ? null : Number(BigInt(wei) / 10n ** 14n) / 1e4);
  const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const dayKey = (iso) => new Date(iso).toDateString();
  const dayName = (iso) => {
    const d = new Date(iso), t = new Date(), y = new Date(Date.now() - 864e5);
    if (d.toDateString() === t.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  };
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
  };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; };
  const byReading = (a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return Math.abs(ra.top - rb.top) > 12 ? ra.top - rb.top : ra.left - rb.left; };
  const STAR = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6 0 7.1 4.9 12 6 7.1 7.1 6 12 4.9 7.1 0 6 4.9 4.9Z"/></svg>';
  const COPY = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
  const OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M6 8h4M8 6v4"/></svg>';
  const OUT = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>';

  // ─── Motion: SwiftUI's springs, for CSS and the Web Animations API ────────
  /** Spring(duration:bounce:) as a CSS linear() easing sampled until it settles, and that time. */
  function springEase(duration, bounce, n = 48) {
    const w0 = (2 * Math.PI) / duration, z = 1 - bounce, wd = w0 * Math.sqrt(Math.max(1e-6, 1 - z * z));
    const pos = (t) => (z >= 1 ? 1 - Math.exp(-w0 * t) * (1 + w0 * t) : 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t)));
    const env = (t) => Math.exp(-z * w0 * t) * (z >= 1 ? 1 + w0 * t : w0 / wd);
    let T = 0.1; while (env(T) > 0.0015 && T < 3) T += 0.01;
    const pts = []; for (let i = 0; i <= n; i++) pts.push(i === n ? 1 : +pos((i / n) * T).toFixed(4));
    return { easing: `linear(${pts.join(", ")})`, ms: Math.round(T * 1000) };
  }
  const LINEAR = (() => { try { return CSS.supports("transition-timing-function", "linear(0, 1)"); } catch { return false; } })();
  const EASE = {
    smooth: LINEAR ? springEase(0.5, 0) : { easing: "cubic-bezier(.2,.8,.2,1)", ms: 600 },
    snappy: LINEAR ? springEase(0.5, 0.15) : { easing: "cubic-bezier(.3,1.25,.45,1)", ms: 620 },
    bouncy: LINEAR ? springEase(0.5, 0.3) : { easing: "cubic-bezier(.32,1.45,.42,1)", ms: 700 },
  };
  for (const [k, e] of Object.entries(EASE)) { document.documentElement.style.setProperty(`--e-${k}`, e.easing); document.documentElement.style.setProperty(`--d-${k}`, `${e.ms}ms`); }

  /** Numbers change like SwiftUI's .numericText(): each digit that changes rolls, the others stay put.
   *  dir 1 rolls up (a value that grows), -1 rolls down (a countdown). */
  function numText(el, text, dir = 1) {
    if (!el) return;
    text = String(text);
    const prev = el.__t; el.__t = text;
    if (prev === text) return;
    if (prev == null || Glass.reduced || !el.animate) { el.textContent = text; return; }
    const a = [...prev], b = [...text], off = a.length - b.length, frag = document.createDocumentFragment();
    let k = 0;
    b.forEach((ch, i) => {
      const was = a[i + off];
      if (was === ch || !/\d/.test(ch)) { frag.append(ch); return; }
      const slot = document.createElement("span"); slot.className = "nd";
      const inn = document.createElement("span"); inn.textContent = ch; slot.append(inn);
      const delay = k++ * 26;
      inn.animate([{ transform: `translateY(${dir * 0.62}em)`, opacity: 0, filter: "blur(2px)" }, { transform: "none", opacity: 1, filter: "none" }], { duration: EASE.snappy.ms, easing: EASE.snappy.easing, delay, fill: "backwards" });
      if (was != null && /\d/.test(was)) {
        const out = document.createElement("span"); out.className = "nd-out"; out.textContent = was; out.setAttribute("aria-hidden", "true"); slot.append(out);
        out.animate([{ transform: "none", opacity: 1, filter: "none" }, { transform: `translateY(${-dir * 0.62}em)`, opacity: 0, filter: "blur(2px)" }], { duration: 300, easing: "cubic-bezier(.4,0,1,1)", delay, fill: "forwards" }).onfinish = () => out.remove();
      }
      frag.append(slot);
    });
    el.textContent = ""; el.append(frag);
  }
  const st = { feed: null, sample: null, live: false, away: false, m: null, tab: "now", onScreen: null, filter: "all", q: "", signers: new Set(["agent", "guard"]), table: false, sheet: null, sheetFrom: null, seen: new Set(), booted: false };

  // ─── The model: what the feed says, in the words the page uses ────────────
  function link(kind, hash, text) {
    const f = st.feed, x = f.explorers ?? {};
    if (!hash) return "";
    const label = esc(text ?? cut(hash, 10, 6));
    if ((kind === "flare" || kind === "flareAddress") && f.networks?.flareFork) return `<span title="On the rehearsal fork only: not on the public explorer">${label} (fork)</span>`;
    const base = kind === "xrpl" ? x.xrplTx : kind === "flare" ? x.flareTx : kind === "xrplAccount" ? x.xrplAccount : x.flareAddress;
    return base ? `<a href="${base}${esc(hash)}" target="_blank" rel="noopener">${label}</a>` : label;
  }
  /** What the transaction does, in words, from the guard's own reading of it. */
  function does(tx) {
    const pa = (st.feed.account?.personalAccount ?? "").toLowerCase();
    const a = tx.action ?? {}, amount = `${xrp(tx.amountDrops)} XRP`;
    if (a.kind === "mint-to") {
      const own = (a.recipient ?? "").toLowerCase() === pa;
      return own ? `Mints ${amount} into FXRP for your own personal account <code>${cut(a.recipient, 6, 4)}</code>`
        : `Mints ${amount} into FXRP for <code>${cut(a.recipient, 6, 4)}</code>: <em>not your personal account</em>`;
    }
    if (a.kind === "vault") {
      const v = `${esc(cap(a.vault))} vault ${a.vaultId}`;
      if (a.action === "deposit") return `Deposits ${xrp(a.value)} FXRP into ${v}, for a fee of ${amount}`;
      if (a.action === "redeem") return `Starts withdrawing ${xrp(a.value)} FXRP from ${v}, for a fee of ${amount}`;
      return `Claims the withdrawal booked for period ${esc(a.value)} from ${v}, for a fee of ${amount}`;
    }
    if (a.kind === "fxrp-redeem") return `Redeems ${esc(a.value)} lot${a.value === "1" ? "" : "s"} of FXRP back to XRP on the ledger, for a fee of ${amount}`;
    if (a.kind === "user-op") return `Runs a custom batch of calls from your personal account: <em>arbitrary code</em>`;
    if (a.kind === "refused" || a.kind === "undecodable") return `An instruction the guard cannot read: <em>${esc(a.reason)}</em>`;
    return `Pays ${amount} to <code>${cut(tx.destination, 6, 4)}</code>`;
  }
  /** The same, in a few words (for the island). */
  function doesShort(tx) {
    const a = tx.action ?? {};
    if (a.kind === "mint-to") return `Mints ${num(u6(tx.amountDrops), 2)} XRP into FXRP`;
    if (a.kind === "vault") return a.action === "deposit" ? `Deposits ${num(u6(a.value), 2)} FXRP` : a.action === "redeem" ? `Withdraws ${num(u6(a.value), 2)} FXRP` : `Claims period ${esc(a.value)}`;
    if (a.kind === "fxrp-redeem") return `Redeems ${esc(a.value)} lot${a.value === "1" ? "" : "s"} to XRP`;
    return `Pays ${num(u6(tx.amountDrops), 2)} XRP`;
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

  function build(feed) {
    const u = feed.umbrella ?? {}, a = feed.account ?? {};
    const decisions = (feed.guard ?? []).filter((e) => e.kind === "decision").slice().reverse().map((e, i) => {
      const d = e.decision ?? {}, tx = e.tx ?? {}, act = tx.action ?? {};
      const kind = d.signed ? 0 : d.struck ? 2 : 1;
      return {
        key: `${e.at}|${d.hash ?? d.struck ?? tx.sequence ?? i}`, at: e.at, e, tx, d, claim: e.claim ?? {}, kind,
        usd6: d.usd6 ?? null, tally: d.tallyUsd6 ?? null, why: e.claim?.why ?? "", by: e.claim?.by ?? "",
        rail: act.kind === "mint-to" ? "mint" : act.kind === "vault" ? "vault" : "other",
      };
    });
    const notes = (feed.autopilot ?? []).filter((e) => ["holding", "paused", "settled", "timeout", "acknowledged", "start", "stop", "error", "idle", "topped-up", "pacing"].includes(e.kind)).slice().reverse();
    const proposals = (feed.autopilot ?? []).filter((e) => e.kind === "proposal" && e.state).slice().reverse();
    const start = (feed.autopilot ?? []).find((e) => e.kind === "start");
    const lastAuto = (feed.autopilot ?? [])[0];
    const mints = decisions.filter((d) => d.kind === 0 && d.rail === "mint" && d.usd6 && Number(d.tx.amountDrops) > 0);
    const price = mints.map((d) => ({ at: d.at, p: u6(d.usd6) / u6(d.tx.amountDrops) }));
    // the tally belongs to one umbrella: chart it from the guard's first start under the current one
    let since = null;
    for (const e of (feed.guard ?? []).filter((x) => x.kind === "start").slice().reverse()) since = String(e.umbrella) === String(u.id) ? since ?? e.at : null;
    const series = decisions.filter((d) => d.kind === 0 && d.tally != null && (!since || d.at >= since)).map((d) => ({ at: d.at, v: u6(d.tally), d }));
    const spent = u6(u.spentUsd6), budget = u6(u.budgetUsd6);
    const from = u.validFrom ? Number(u.validFrom) * 1000 : series[0] ? Date.parse(series[0].at) : null;
    const until = u.validUntil ? Number(u.validUntil) * 1000 : null;
    const days = from ? Math.max(1 / 24, (Date.parse(feed.generatedAt) - from) / 864e5) : null;
    return {
      decisions, notes, proposals, start, lastAuto, price, series, spent, budget, from, until, days,
      signed: decisions.filter((d) => d.kind === 0).length, refused: decisions.filter((d) => d.kind > 0).length, struck: decisions.filter((d) => d.kind === 2).length,
      frac: budget ? Math.min(1, spent / budget) : 0,
      gasGuard: c2flr(feed.fuel?.guardWei), gasAgent: c2flr(feed.fuel?.agentWei),
      tick: Number(start?.tickSeconds ?? 300),
      u, a, keys: feed.keys ?? {},
    };
  }

  function stateOf() {
    const m = st.m, u = m.u;
    const lastStrike = m.decisions.slice().reverse().find((d) => d.kind === 2);
    const last = st.feed.autopilot?.find((e) => ["holding", "paused", "idle", "verdict", "settled", "timeout", "start", "stop", "pacing"].includes(e.kind));
    if (u.tripped) {
      const why = lastStrike?.why ? `<q>${esc(lastStrike.why)}</q>` : "";
      return { tone: "coral", pill: "Paused · tripped", head: "The leash held.",
        sub: lastStrike?.by === "drill"
          ? `In a drill, the agent was fed a planted note${why ? `: ${why}` : ""}. It asked the guard to act on it. The guard refused and wrote a strike on Flare. Every rail stays shut until the owner re-arms the umbrella.`
          : `The agent asked to act ${why ? `on ${why}` : "outside its rules"}. The guard refused and wrote a strike on Flare. Every rail stays shut until the owner re-arms the umbrella.` };
    }
    if (st.away) return { tone: "grey", pill: "Offline", head: "Offline, and still on its leash.", sub: "The demo machine is off right now, so the agent proposes nothing until it is back. What you see is its last published state." };
    if (last?.kind === "holding") return { tone: "grey", pill: "Holding", head: "At the edge of its budget.", sub: "The next step would cross the umbrella's budget, so the agent keeps it to itself instead of asking." };
    if (last?.kind === "pacing" && last.mode === "rest") return { tone: "grey", pill: "Resting", head: "Saving the guard's gas.", sub: "Every co-signature costs the guard gas on Flare. It is down to the reserve it keeps for a strike, so the agent proposes nothing until the guard is topped up." };
    if (last?.kind === "stop") return { tone: "grey", pill: "Stopped", head: "The agent is not running.", sub: "Its service was stopped. The account and the umbrella stay as they are." };
    return { tone: "star", pill: "Working", head: "Working inside its leash.", sub: "An AI agent runs XRP through a Flare vault and back, around the clock: mint, deposit, withdraw, claim, redeem. It cannot move a coin alone: every step it proposes is priced against your budget and checked against your rules before the guard adds the second signature." };
  }

  // ─── Rendering: shared pieces ─────────────────────────────────────────────
  function decisionRow(d, compact) {
    const v = d.kind === 0 ? `<span class="v signed">${STAR} Co-signed</span>` : d.kind === 2 ? `<span class="v struck">Refused · struck</span>` : `<span class="v refused">Refused</span>`;
    const by = d.by === "drill" ? `<span class="label"> · drill, a staged hijack</span>` : d.by === "ai" ? `<span class="label"> · by AI</span>` : "";
    return `<li class="decision" tabindex="0" data-key="${esc(d.key)}" aria-label="Open this decision" aria-haspopup="dialog">
      <div class="when">${compact ? clock(d.at) : `${clock(d.at)}<br><span>${ago(d.at)}</span>`}</div>
      <div>
        <div class="witness said"><i></i><p>${d.why ? esc(d.why) : '<span style="color:var(--ink-3)">No reason given</span>'}${by}</p></div>
        <div class="witness does"><i></i><p>${does(d.tx)}</p></div>
      </div>
      <div class="verdict">${v}${d.usd6 ? `<span class="usd">${usd(d.usd6, d.kind === 0 && u6(d.usd6) < 0.01 ? 4 : 2)}</span>` : ""}</div>
    </li>`;
  }
  function noteRow(e) {
    const t = {
      holding: [`<b>Holding.</b> The next ${esc(e.step?.kind ?? "step")} (${e.usd6 ? usd(e.usd6) : "?"}) would cross the umbrella's budget, so the agent does not ask.`, ""],
      paused: ["<b>Paused.</b> The umbrella is tripped. Nothing is proposed until the owner re-arms it.", "coral"],
      acknowledged: [`<b>Agreed to its leash.</b> The agent acknowledged umbrella #${esc(e.umbrella)} on Flare.`, ""],
      settled: [`<b>Done on Flare.</b> The ${esc(e.step?.kind)} arrived after ${e.afterS ?? "?"} s.`, ""],
      timeout: [`<b>Not executed.</b> Flare did not show the ${esc(e.step?.kind)} within ${e.afterS} s, so the agent moved on.`, ""],
      start: ["<b>Started.</b> The service came up and looks every " + Math.round((e.tickSeconds ?? 300) / 60) + " min.", ""],
      stop: ["<b>Stopped.</b> The service was stopped.", ""],
      idle: ["<b>Nothing to do right now.</b> No XRP above the reserve, and nothing to claim yet.", ""],
      "topped-up": [`<b>Topped up.</b> The XRPL testnet faucet sent ${xrp(e.drops)} XRP to the account.`, ""],
      pacing: [e.mode === "rest" ? `<b>Resting.</b> The guard is down to ${num(c2flr(e.fuelWei), 2)} C2FLR, kept for a strike: nothing is proposed until it is topped up.`
        : e.mode === "slow" ? `<b>Slowing down.</b> The guard has ${num(c2flr(e.fuelWei), 2)} C2FLR of gas left, so the agent asks at most every ${Math.round((e.everyS ?? 900) / 60)} min.`
        : `<b>Full speed.</b> The guard's gas is topped up (${num(c2flr(e.fuelWei), 2)} C2FLR).`, e.mode === "rest" ? "coral" : ""],
      error: [`<b>Error.</b> ${esc(e.error)}`, "coral"],
    }[e.kind] ?? [esc(e.kind), ""];
    return `<li class="note ${t[1]}"><div class="when" style="font:400 12px/1.35 var(--mono);color:var(--ink-3)">${clock(e.at)}</div><div>${t[0]}</div></li>`;
  }
  function spark(values, color) {
    if (values.length < 2) return "";
    const w = 200, h = 34, lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - lo) / span) * (h - 6)]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w} ${h}L0 ${h}Z" fill="${color}" opacity=".06"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="${color}"/></svg>`;
  }

  // ─── Now ──────────────────────────────────────────────────────────────────
  function renderNow() {
    const m = st.m, s = stateOf(), u = m.u, ds = shownDecisions(), replay = rp.t != null;
    const spent = replay ? spentAt(ds) : u6(u.spentUsd6), frac = m.budget ? Math.min(1, spent / m.budget) : 0;
    const at = replay ? (ds.length ? `at ${clock(ds[ds.length - 1].at)}` : "before the first step") : "";
    const pill = $("#now-pill"); pill.classList.remove("coral", "grey", "star"); pill.classList.add(replay ? "grey" : s.tone); $("span", pill).textContent = replay ? "Replay" : s.pill;
    $("#now-head").textContent = s.head; $("#now-sub").innerHTML = s.sub;
    const prev = Number($("#now-spent").dataset.v ?? 0); $("#now-spent").dataset.v = spent;
    numText($("#now-spent"), money(spent), spent < prev ? -1 : 1);
    $("#now-of").innerHTML = `spent of ${usd(u.budgetUsd6, 0)} across XRPL and Flare · ${Math.round(frac * 100)}%${at ? ` · ${at}` : ""}`;
    const left = m.until ? Math.max(0, Math.ceil((m.until - Date.now()) / 864e5)) : null;
    $("#now-facts").innerHTML = [
      `<span class="label">Umbrella <b>#${esc(u.id)}</b></span>`,
      `<span class="label">Tripwire <b>${esc(u.strikes)} of ${esc(u.tripwire)}</b></span>`,
      left != null && !replay ? `<span class="label">Window <b>${left} days left</b></span>` : `<span class="label">Decisions <b>${ds.length}</b></span>`,
    ].join("");
    // stats with their history (from what the agent saw at each proposal)
    const hist = (f) => m.proposals.map((p) => f(p.state)).filter((v) => Number.isFinite(v));
    const xrpNow = u6(m.a.xrpDrops), fx = u6(m.a.fxrp), sh = u6(m.a.shares);
    stat("#stat-xrp", "XRP on the ledger", `${num(xrpNow, 2)}`, "spendable, above the 2 XRP reserve", spark([...hist((x) => u6(x.xrpDrops)), xrpNow], "#f5f5f7"));
    stat("#stat-fxrp", "FXRP on Flare", `${num(fx, 2)}`, "in your personal account", spark([...hist((x) => u6(x.fxrp)), fx], "#f5f5f7"));
    const out = u6(m.a.pendingFxrp ?? 0);
    stat("#stat-shares", `${cap(m.a.vaultName ?? "Firelight")} shares`, `${num(sh, 2)}`, out > 0 ? `+ ${num(out, 2)} FXRP on its way out of the vault` : "the vault's receipt for deposits", spark([...hist((x) => u6(x.shares?.["1"] ?? x.shares)), sh], "#f5f5f7"));
    const low = m.gasGuard != null && m.gasGuard < 25;
    stat("#stat-gas", "The guard's gas", m.gasGuard != null ? `${num(m.gasGuard, 2)}` : "?", m.gasGuard != null ? (low ? `C2FLR · low: about ${Math.floor(m.gasGuard / 0.12)} decisions, top it up` : `C2FLR · about ${Math.floor(m.gasGuard / 0.12)} decisions`) : "C2FLR · not in this feed", "");
    $("#stat-gas").classList.toggle("low", low);
    const list = ds.slice(-4).reverse();
    $("#now-list").innerHTML = list.length ? list.map((d) => decisionRow(d, false)).join("") : `<li class="empty">No decisions yet. The agent looks every ${Math.round(m.tick / 60)} minutes.</li>`;
    const lastP = m.proposals[m.proposals.length - 1];
    const planEl = $("#now-plan");
    if (u.tripped) planEl.innerHTML = "<b>Nothing, until you re-arm.</b> The tripwire has cut every rail. The agent asks again after the owner re-arms the umbrella.";
    else if (st.away) planEl.innerHTML = "<b>Nothing while the machine is off.</b> When it is back, the agent looks at the account and proposes the next step.";
    else planEl.innerHTML = lastP ? `<b>Last it said:</b> ${esc(lastP.why)}` : "<b>Waiting for its first look.</b>";
  }
  /** A stat pane, built once and then updated in place, so its figure can roll. */
  function stat(sel, label, value, small, sparkSvg) {
    const el = $(sel);
    if (!el.__built) { el.innerHTML = `<span class="label"></span><b></b><small></small><div class="sp"></div>`; el.__built = true; }
    $(".label", el).textContent = label; numText($("b", el), value, 1); $("small", el).innerHTML = small; $(".sp", el).innerHTML = sparkSvg;
  }
  function nextLeft() {
    if (!st.m) return null;
    const m = st.m, tick = m.tick * 1000;
    const last = m.lastAuto ? Date.parse(m.lastAuto.at) : Date.parse(st.feed.generatedAt);
    let next = last + tick; while (next < Date.now() - 1000) next += tick;
    return Math.max(0, (next - Date.now()) / 1000);
  }
  function tickNext() {
    if (!st.m) return;
    const m = st.m, left = nextLeft(), frac = 1 - left / m.tick;
    const on = !st.away && !m.u.tripped && st.live;
    numText($("#next-time"), on ? mmss(left) : "—", -1);
    $("#next-cap").textContent = on ? "until it looks again" : st.live ? "paused" : "sample data";
    const c = 2 * Math.PI * 32;
    $("#next-arc").setAttribute("stroke-dasharray", `${(on ? frac : 0) * c} ${c}`);
  }

  // ─── Replay: step through the agent's history (Apple Watch's Time Travel) ──
  // One step on the track per decision (a white tick for a co-signature, a coral one for a refusal),
  // from before the first to now at the far right. The ring, the stars, the figure and the list follow.
  const rp = { i: null, t: null, drag: false };
  const shownDecisions = () => (rp.t == null ? st.m.decisions : st.m.decisions.filter((d) => Date.parse(d.at) <= rp.t));
  const spentAt = (ds) => { const last = ds.filter((d) => d.kind === 0 && d.tally != null).pop(); return last ? u6(last.tally) : 0; };
  function renderReplay() {
    if (!st.m) return;
    const n = st.m.decisions.length, pos = (i) => (i + 1) / (n + 1);
    if (rp.i != null && rp.i >= n) { rp.i = null; rp.t = null; }
    $("#rp-ticks").innerHTML = st.m.decisions.map((d, i) => `<i class="${d.kind ? "coral" : ""}${rp.i != null && i > rp.i ? " later" : ""}" style="left:${(pos(i) * 100).toFixed(2)}%"></i>`).join("");
    const f = rp.i == null ? 1 : pos(rp.i);
    $("#rp-track").style.setProperty("--f", f.toFixed(4));
    const d = rp.i != null && rp.i >= 0 ? st.m.decisions[rp.i] : null;
    const label = rp.i == null ? "Now" : d ? `${dayName(d.at)} ${clock(d.at)}` : "Before the first";
    const k = $("#rp-knob"); k.setAttribute("aria-valuenow", String(Math.round(f * 100))); k.setAttribute("aria-valuetext", label);
    $("#rp-time").textContent = label;
    document.documentElement.classList.toggle("replaying", rp.i != null);
  }
  /** The ring and the stars show what was true at the replay's moment (or now). */
  function skyNow(animate) {
    const ds = shownDecisions(), frac = rp.t != null ? Math.min(1, spentAt(ds) / (st.m.budget || 1)) : st.m.frac;
    Glass.setFill($("#ring"), frac); $("#ring").style.setProperty("--frac", frac);
    Glass.setDecisions(ds.map((d) => ({ key: d.key, kind: d.kind, d })), animate);
  }
  /** i: a decision's index, -1 for before the first, null for now. */
  function setReplay(i) {
    if (!st.m) return;
    const n = st.m.decisions.length;
    if (i != null) i = Math.max(-1, Math.min(n, Math.round(i)));
    if (i === n) i = null;
    if (i === rp.i) return;
    rp.i = i;
    rp.t = i == null ? null : i < 0 ? (n ? Date.parse(st.m.decisions[0].at) - 1 : 0) : Date.parse(st.m.decisions[i].at);
    renderReplay(); renderNow(); skyNow("soft");
  }

  // ─── Timeline ─────────────────────────────────────────────────────────────
  /** o.flow: the day panes flow from their old layout into the new one; o.keep: their words stay put. */
  function renderTimeline(o = {}) {
    const m = st.m, q = st.q.trim().toLowerCase();
    const counts = { all: m.decisions.length + m.notes.length, signed: m.signed, refused: m.refused, notes: m.notes.length };
    $$("#filters button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.f === st.filter)); numText($("small", b), String(counts[b.dataset.f]), 1); });
    let items = [];
    if (st.filter !== "notes") items.push(...m.decisions.filter((d) => st.filter === "all" || (st.filter === "signed" ? d.kind === 0 : d.kind > 0)).map((d) => ({ at: d.at, html: decisionRow(d, true), text: `${d.why} ${d.tx.action?.kind ?? ""} ${d.d.hash ?? ""} ${d.d.reason ?? ""} ${xrp(d.tx.amountDrops)}` })));
    if (st.filter === "all" || st.filter === "notes") items.push(...m.notes.map((e) => ({ at: e.at, html: noteRow(e), text: `${e.kind} ${e.step?.kind ?? ""} ${e.error ?? ""}` })));
    if (q) items = items.filter((it) => it.text.toLowerCase().includes(q));
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const days = new Map();
    for (const it of items) { const k = dayKey(it.at); if (!days.has(k)) days.set(k, { name: dayName(it.at), items: [] }); days.get(k).items.push(it); }
    const host = $("#days");
    const here = st.onScreen === "timeline" && st.booted;
    const from = here && o.flow && Glass.ok ? Glass.snapshot(host) : null;
    $$(".day", host).forEach((el) => Glass.remove(el));
    host.innerHTML = days.size ? [...days.values()].map((d) => `<div class="glass pane day rise"><h3>${esc(d.name)}<span class="label">${d.items.length} ${d.items.length === 1 ? "event" : "events"}</span></h3><ul class="decisions">${d.items.map((i) => i.html).join("")}</ul></div>`).join("")
      : `<div class="glass pane day rise"><p class="empty">Nothing matches${q ? ` “${esc(st.q)}”` : ""}.</p></div>`;
    const els = $$(".day", host);
    els.forEach((el) => Glass.add(el, { kind: "pane", shown: false }));
    if (!here) return;
    if (o.keep) els.forEach((el) => el.classList.add("shown"));
    if (from) {
      const vis = els.filter(inView);
      els.filter((el) => !vis.includes(el)).forEach((el) => { Glass.show(el, true, 0, { instant: true }); el.classList.add("shown"); });
      Glass.flow(from, vis, { onLand: (el) => el.classList.add("shown") });
    } else els.forEach((el, i) => { Glass.show(el, true, 0.04 * i); reveal(el, i); });
  }
  function setFilter(f) { if (f === st.filter) return; st.filter = f; renderTimeline({ flow: true }); }

  // ─── Budget ───────────────────────────────────────────────────────────────
  function renderBudget() {
    const m = st.m, u = m.u;
    numText($("#b-spent"), money(u6(u.spentUsd6)), 1);
    $("#b-of").textContent = `of ${usd(u.budgetUsd6, 0)} · ${(m.frac * 100).toFixed(1)}% used`;
    $("#b-meter").style.transform = `scaleX(${m.frac})`;
    const rate = m.days ? m.spent / m.days : null;
    const leftUsd = Math.max(0, m.budget - m.spent);
    const winLeft = m.until ? Math.max(0, (m.until - Date.now()) / 864e5) : null;
    const exhaust = rate > 0 ? leftUsd / rate : null;
    const lastPrice = m.price[m.price.length - 1];
    const rows = [
      ["Budget", usd(u.budgetUsd6, 0)], ["Spent", usd(u.spentUsd6)], ["Left", "$" + num(leftUsd, 2)],
      ["Window", m.until ? `${new Date(m.from).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} to ${new Date(m.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "90 days"],
      winLeft != null ? ["Days left", `${Math.ceil(winLeft)}`] : null,
      rate != null ? ["Pace", m.days >= 1 ? `$${num(rate, 2)} a day` : "too early to tell"] : null,
      exhaust != null && m.days >= 1 ? ["At this pace", winLeft != null && exhaust > winLeft ? "lasts the whole window" : `spent in ${Math.round(exhaust)} days`] : null,
      lastPrice ? ["XRP, priced by FTSO", `$${lastPrice.p.toFixed(4)}`] : null,
    ].filter(Boolean);
    $("#b-kv").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    chart();
    // by action
    const sum = (f) => m.decisions.filter(f).reduce((s, d) => s + u6(d.usd6), 0);
    const mint = sum((d) => d.kind === 0 && d.rail === "mint"), vault = sum((d) => d.kind === 0 && d.rail === "vault"), other = sum((d) => d.kind === 0 && d.rail === "other");
    const refused = sum((d) => d.kind > 0);
    const max = Math.max(mint, vault, other, refused, 0.0001);
    const bar = (label, v, cls = "") => `<div class="bar-row ${cls}"><span>${label}</span><b>$${num(v, v < 1 ? 4 : 2)}</b><div class="track"><i style="transform:scaleX(${v / max})"></i></div></div>`;
    $("#b-actions").innerHTML = bar(`Mints into FXRP · ${m.decisions.filter((d) => d.kind === 0 && d.rail === "mint").length}`, mint)
      + bar(`Vault instructions (their fee) · ${m.decisions.filter((d) => d.kind === 0 && d.rail === "vault").length}`, vault)
      + (other ? bar("Other payments", other) : "")
      + bar(`Refused: never spent · ${m.refused}`, refused, "none");
    // price witness
    const pr = m.price.map((x) => x.p);
    $("#b-price").innerHTML = pr.length
      ? `<div class="figure" style="margin-top:4px"><b style="font-size:40px">$${pr[pr.length - 1].toFixed(4)}</b><span>per XRP at the last mint</span></div>${spark(pr.length > 1 ? pr : [pr[0], pr[0]], "#ffae45")}<p style="color:var(--ink-2);margin:14px 0 0;font-size:14px">The guard prices every step with Flare's FTSO before it signs, so one dollar budget covers every rail. ${pr.length} ${pr.length === 1 ? "mint" : "mints"} so far, from $${Math.min(...pr).toFixed(4)} to $${Math.max(...pr).toFixed(4)}.</p>`
      : `<p class="empty">No mint yet: the price appears with the first one.</p>`;
  }
  function chart() {
    const m = st.m, host = $("#b-chartbox"), W = Math.max(300, Math.round(host.clientWidth || 760)), H = W < 520 ? 230 : 280, pl = 54, pr = 18, pt = 16, pb = 30;
    const pts = m.series.slice();
    if (!pts.length) { host.innerHTML = `<p class="empty">The line starts with the first co-signed step.</p>`; $("#b-table").innerHTML = ""; return; }
    const t0 = m.from ?? Date.parse(pts[0].at), t1 = Math.max(Date.parse(st.feed.generatedAt), Date.parse(pts[pts.length - 1].at) + 60e3);
    const ymax = Math.max(m.budget, ...pts.map((p) => p.v)) * 1.04;
    const X = (t) => pl + ((t - t0) / (t1 - t0 || 1)) * (W - pl - pr), Y = (v) => pt + (1 - v / ymax) * (H - pt - pb);
    let d = `M${X(t0).toFixed(1)} ${Y(0).toFixed(1)}`;
    for (const p of pts) { const x = X(Date.parse(p.at)); d += `H${x.toFixed(1)}V${Y(p.v).toFixed(1)}`; }
    d += `H${X(t1).toFixed(1)}`;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * m.budget);
    const grid = ticks.map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(245,245,247,.08)"/><text x="${pl - 10}" y="${Y(v) + 4}" text-anchor="end" fill="#6e6e73" font-family="Geist Mono, monospace" font-size="11">$${num(v, 0)}</text>`).join("");
    const tl = (t) => new Date(t).toLocaleString("en-GB", t1 - t0 > 2 * 864e5 ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit" });
    const xt = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text x="${X(t)}" y="${H - 8}" text-anchor="${["start", "middle", "end"][i]}" fill="#6e6e73" font-family="Geist Mono, monospace" font-size="11">${tl(t)}</text>`).join("");
    const last = pts[pts.length - 1];
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spent over time, ${usd(m.u.spentUsd6)} of ${usd(m.u.budgetUsd6, 0)}">
      ${grid}${xt}
      <line x1="${pl}" x2="${W - pr}" y1="${Y(m.budget)}" y2="${Y(m.budget)}" stroke="rgba(245,245,247,.5)"/>
      <text x="${W - pr}" y="${Y(m.budget) - 8}" text-anchor="end" fill="#a1a1a6" font-family="Geist Mono, monospace" font-size="11" letter-spacing="1.4">BUDGET ${usd(m.u.budgetUsd6, 0)}</text>
      <path d="${d}V${Y(0)}H${X(t0)}Z" fill="#ffae45" opacity=".1"/>
      <path class="line" d="${d}" fill="none" stroke="#ffae45" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(t1)}" cy="${Y(last.v)}" r="4.5" fill="#ffae45" stroke="#07080f" stroke-width="2"/>
      <text x="${X(t1) - 10}" y="${Y(last.v) - 12}" text-anchor="end" fill="#f5f5f7" font-family="Geist, sans-serif" font-size="13" font-weight="600">${usd(m.u.spentUsd6)}</text>
      <line id="b-cross" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="rgba(245,245,247,.35)" opacity="0"/>
      <circle id="b-dot" r="4.5" fill="#ffae45" stroke="#07080f" stroke-width="2" opacity="0"/>
    </svg><div class="tip" id="b-tip" style="opacity:0"></div>`;
    const svg = $("svg", host), tip = $("#b-tip"), cross = $("#b-cross"), dot = $("#b-dot");
    // the line draws itself in, the first time it is seen
    const line = $("path.line", host);
    if (!Glass.reduced && !chart.drawn && line.getTotalLength && st.onScreen === "budget") {
      chart.drawn = true; const L = line.getTotalLength();
      line.animate([{ strokeDasharray: `0 ${L}` }, { strokeDasharray: `${L} 0` }], { duration: 1100, easing: EASE.smooth.easing, delay: 250, fill: "backwards" });
    }
    const move = (clientX) => {
      const r = svg.getBoundingClientRect(), x = ((clientX - r.left) / r.width) * W;
      const t = t0 + ((x - pl) / (W - pl - pr)) * (t1 - t0);
      let p = null; for (const q of pts) if (Date.parse(q.at) <= t) p = q;
      if (!p || x < pl || x > W - pr) { tip.style.opacity = 0; cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); return; }
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 1);
      dot.setAttribute("cx", x); dot.setAttribute("cy", Y(p.v)); dot.setAttribute("opacity", 1);
      tip.style.left = `${(x / W) * 100}%`; tip.style.top = `${(Y(p.v) / H) * r.height}px`; tip.style.opacity = 1;
      tip.innerHTML = `<b>${usd(Math.round(p.v * 1e6))}</b>spent after the ${esc(p.d.rail === "mint" ? "mint" : p.d.rail === "vault" ? "vault instruction" : "payment")} at ${clock(p.at)}<br><span class="label">${esc(dayName(p.at))}</span>`;
    };
    svg.addEventListener("pointermove", (e) => move(e.clientX));
    svg.addEventListener("pointerleave", () => { tip.style.opacity = 0; cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); });
    $("#b-table").innerHTML = `<table class="data"><thead><tr><th>When</th><th>Step</th><th>Priced</th><th>Spent after</th></tr></thead><tbody>${pts.slice().reverse().map((p) => `<tr><td>${esc(dayName(p.at))} ${clock(p.at)}</td><td>${p.d.rail === "mint" ? "Mint" : p.d.rail === "vault" ? "Vault" : "Payment"}</td><td>${usd(p.d.usd6, u6(p.d.usd6) < 0.01 ? 4 : 2)}</td><td>${usd(Math.round(p.v * 1e6))}</td></tr>`).join("")}</tbody></table>`;
  }

  // ─── Keys ─────────────────────────────────────────────────────────────────
  function renderKeys() {
    const m = st.m, k = m.keys, a = m.a;
    const row = (label, kind, value, full) => value ? `<div class="addr"><span class="k">${label}</span><span class="v">${link(kind, value, cut(value, 10, 6)).replace(/>([^<]*)<\/a>$/, "><code>$1</code></a>") || `<code>${esc(cut(value, 10, 6))}</code>`}<button class="copy" data-copy="${esc(full ?? value)}" aria-label="Copy ${esc(label)}">${COPY}</button></span></div>` : "";
    const gas = (v, what, guard) => v == null ? "" : `<div style="margin-top:14px"><span class="label">${what}</span><div style="display:flex;justify-content:space-between;gap:10px;margin-top:8px"><b style="font:600 22px/1 var(--sans);letter-spacing:-.02em">${num(v, 2)} <span style="font-size:13px;color:var(--ink-2);font-weight:500">C2FLR</span></b><span style="color:var(--ink-3);font-size:13px;text-align:right">${guard ? (v < 0.5 ? "low: top it up" : `≈ ${Math.floor(v / 0.13)} decisions`) : "it paid for its one acknowledgement"}</span></div>${guard ? `<div class="gauge ${v < 0.5 ? "low" : ""}"><i style="width:${Math.min(100, (v / 5) * 100)}%"></i></div>` : ""}</div>`;
    $("#k-owner").innerHTML = `<span class="label">Weight 2 · you</span><h2 style="margin:10px 0 6px;font:600 20px/1.2 var(--sans)">The owner</h2><p style="margin:0 0 12px;color:var(--ink-2);font-size:14px">Your key alone can do anything. It stays on your computer, never on the machine that runs the agent.</p>${row("XRPL key", "xrplAccount", k.owner)}`;
    $("#k-agent").innerHTML = `<span class="label">Weight 1</span><h2 style="margin:10px 0 6px;font:600 20px/1.2 var(--sans)">The agent</h2><p style="margin:0 0 12px;color:var(--ink-2);font-size:14px">Proposes every step and signs it first. Alone, it moves nothing.</p>${row("XRPL key", "xrplAccount", k.agent)}${row("Flare key", "flareAddress", k.agentEvm)}${gas(m.gasAgent, "Gas on Flare", false)}`;
    $("#k-guard").innerHTML = `<span class="label">Weight 1</span><h2 style="margin:10px 0 6px;font:600 20px/1.2 var(--sans)">The guard</h2><p style="margin:0 0 12px;color:var(--ink-2);font-size:14px">Reads each transaction itself, prices it with FTSO and adds the second signature only inside your budget and rules.</p>${row("XRPL key", "xrplAccount", k.guard)}${row("Flare key", "flareAddress", k.guardFlare)}${gas(m.gasGuard, "Gas for its records", true)}`;
    $("#k-chain").innerHTML = `<div class="pane-head"><h2>On-chain</h2><span class="label">Every address opens in a public explorer</span></div>
      ${row("The account on the XRP Ledger", "xrplAccount", a.address)}
      ${row("Its personal account on Flare", "flareAddress", a.personalAccount)}
      ${row(`Umbrella #${esc(m.u.id)} on SummaMeter`, "flareAddress", m.u.meter)}`;
    quorum();
  }
  function quorum() {
    const w = { owner: 2, agent: 1, guard: 1 };
    const sum = [...st.signers].reduce((s, k) => s + w[k], 0);
    $$(".signer").forEach((b) => b.setAttribute("aria-pressed", String(st.signers.has(b.dataset.k))));
    $$(".quorum .q i").forEach((i, n) => i.classList.toggle("on", sum > n));
    const has = (k) => st.signers.has(k);
    let text;
    if (!sum) text = ["Nothing moves.", "No signature, no transaction."];
    else if (has("owner")) text = ["It moves. Anything.", "The owner's key carries weight 2, the whole quorum. That is why it stays with you."];
    else if (has("agent") && has("guard")) text = ["It moves, but only what the guard co-signs.", "2 of 2: the guard adds its signature only inside your budget and rules, priced by FTSO."];
    else if (has("agent")) text = ["Nothing moves.", "The agent alone is weight 1 of the 2 needed. A hijacked agent cannot spend."];
    else text = ["Nothing moves.", "The guard alone is weight 1. It never starts a transaction; it only co-signs the agent's."];
    const el = $("#k-verdict"), html = `${esc(text[0])}<small>${esc(text[1])}</small>`;
    if (el.innerHTML === html) return;
    el.innerHTML = html;
    if (!Glass.reduced && el.animate && st.booted) el.animate([{ opacity: 0, transform: "translateY(6px)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "none" }], { duration: EASE.snappy.ms, easing: EASE.snappy.easing });
  }

  // ─── Sheet: one decision in full, pulled out of the glass it came from ─────
  const rowOf = (key) => $$(`.decision[data-key="${CSS.escape(key)}"]`).find((el) => el.offsetParent && inView(el)) ?? null;
  function sourceRect(from) {
    if (!from) return null;
    if (from.nodeType) { const r = from.getBoundingClientRect(); return r.width ? r : null; }
    return { left: from.x - 9, right: from.x + 9, top: from.y - 9, bottom: from.y + 9 };
  }
  const radiusFor = (from) => (!from?.nodeType ? 9 : from.id === "status" ? from.getBoundingClientRect().height / 2 : 16);
  /** from: the element it grows out of (a row, the island) or a point (a star). */
  function openSheet(key, from) {
    const d = st.m.decisions.find((x) => x.key === key); if (!d) return;
    const again = st.sheet != null;
    st.sheet = key;
    const tx = d.tx, dec = d.d;
    const v = d.kind === 0 ? `<span class="pill" style="height:28px;box-shadow:inset 0 0 0 1px rgba(245,245,247,.22)"><i></i><span>Co-signed</span></span>` : `<span class="pill coral" style="height:28px;box-shadow:inset 0 0 0 1px rgba(255,107,107,.4)"><i></i><span>${d.kind === 2 ? "Refused · struck" : "Refused"}</span></span>`;
    $("#sheet-body").innerHTML = `${v}
      <h2 id="sheet-title">${d.kind === 0 ? "The guard added the second signature." : "The guard refused to sign."}</h2>
      <div class="witness said"><i></i><p>${esc(d.why || "No reason given")}${d.by ? `<span class="label"> · ${d.by === "drill" ? "drill, a staged hijack" : `by ${esc(d.by)}`}</span>` : ""}</p></div>
      <div class="witness does"><i></i><p>${does(tx)}</p></div>
      ${dec.reason ? `<p style="color:var(--coral);margin:6px 0 0">${esc(dec.reason)}</p>` : ""}
      <dl class="fields">
        <dt>When</dt><dd>${new Date(d.at).toLocaleString("en-GB")}</dd>
        ${d.usd6 ? `<dt>Priced</dt><dd>${usd(d.usd6, u6(d.usd6) < 0.01 ? 6 : 2)} by FTSO</dd>` : ""}
        ${d.tally ? `<dt>Spent after</dt><dd>${usd(d.tally)} of ${usd(st.m.u.budgetUsd6, 0)}</dd>` : ""}
        <dt>Transaction</dt><dd>${esc(tx.type ?? "Payment")} of ${xrp(tx.amountDrops)} XRP, fee ${xrp(tx.feeDrops)} XRP, sequence ${esc(tx.sequence)}</dd>
        <dt>To</dt><dd><code>${esc(tx.destination)}</code></dd>
        ${tx.memo ? `<dt>Memo</dt><dd><code>${esc(tx.memo)}</code></dd>` : ""}
        ${dec.hash ? `<dt>On XRPL</dt><dd>${link("xrpl", dec.hash)}</dd>` : ""}
        ${dec.reservation ? `<dt>Reserved on Flare</dt><dd>${link("flare", dec.reservation)}</dd>` : ""}
        ${dec.struck ? `<dt>Strike on Flare</dt><dd>${link("flare", dec.struck)}</dd>` : ""}
      </dl>`;
    if (again) return;
    const sh = $("#sheet");
    sh.classList.add("open"); sh.setAttribute("aria-hidden", "false"); $("#scrim").classList.add("open");
    document.documentElement.classList.add("sheet-open"); Glass.backdrop(true);
    if (innerWidth <= 760) Glass.show($("#tabs"), false, 0, { fast: true }); // a sheet covers the phone's tab bar
    st.sheetFrom = from ? (from.nodeType ? { el: from } : { pt: from }) : null;
    if (Glass.ok && !Glass.reduced) {
      sh.style.setProperty("--p", "0");
      const src = sourceRect(from);
      Glass.overlay(sh, { kind: "sheet", from: src, fromRadius: src ? radiusFor(from) : undefined, onFrame: (p) => sh.style.setProperty("--p", p.toFixed(3)) });
    } else { sh.style.setProperty("--p", "1"); Glass.overlay(sh, { kind: "sheet" }); }
    const viaKey = st.viaKey; st.viaKey = false;
    setTimeout(() => $("#sheet .close").focus({ preventScroll: true, focusVisible: viaKey }), 80);
  }
  function closeSheet() {
    if (!st.sheet) return;
    const key = st.sheet, sh = $("#sheet"), f = st.sheetFrom;
    let to = null, toR = 16;
    if (f?.pt) { const p = Glass.markPos(key); if (p) { to = { left: p.x - 8, right: p.x + 8, top: p.y - 8, bottom: p.y + 8 }; toR = 8; } }
    else if (f?.el?.id === "status") { const r = f.el.getBoundingClientRect(); to = r; toR = r.height / 2; }
    if (!to) { const row = rowOf(key); if (row) to = row.getBoundingClientRect(); }
    st.sheet = null; st.sheetFrom = null;
    sh.classList.remove("open"); sh.setAttribute("aria-hidden", "true"); $("#scrim").classList.remove("open");
    document.documentElement.classList.remove("sheet-open"); Glass.backdrop(false);
    Glass.show($("#tabs"), true, 0.12);
    Glass.overlayOut(sh, { to, toRadius: toR });
  }

  // ─── Tabs and segments: a lens that you can press, lift and drag ───────────
  // iOS 26's tab bar: under a finger the selection lifts into a larger, clearer lens that follows it
  // between the tabs; let go and it settles on the nearest one with a bounce.
  function liquidControl(host, o) {
    const drag = { on: false, x: 0, x0: 0, moved: false };
    Glass.lens(o.key, () => {
      const sel = o.current(); if (!sel || !sel.offsetParent) return null;
      const r = sel.getBoundingClientRect(); if (r.width < 1) return null;
      if (!drag.on) return { rect: r, radius: r.height / 2, lift: 0 };
      const hr = host.getBoundingClientRect(), w = r.width, pad = 4;
      const cx = Math.min(Math.max(drag.x, hr.left + pad + w / 2), hr.right - pad - w / 2);
      return { rect: { left: cx - w / 2, right: cx + w / 2, top: r.top, bottom: r.bottom }, radius: r.height / 2, lift: 1 };
    }, o.lens);
    const nearest = (x) => { let best = null, bd = 1e9; for (const b of o.items()) { const r = b.getBoundingClientRect(); const d = Math.abs(x - (r.left + r.width / 2)); if (r.width && d < bd) { bd = d; best = b; } } return best; };
    host.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !Glass.ok || !e.target.closest("button")) return;
      drag.on = true; drag.x = drag.x0 = e.clientX; drag.moved = false;
      const move = (ev) => { drag.x = ev.clientX; if (Math.abs(drag.x - drag.x0) > 6) drag.moved = true; };
      const end = (ev) => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", end); removeEventListener("pointercancel", end);
        drag.on = false;
        if (ev.type === "pointerup" && drag.moved) { const b = nearest(drag.x); if (b) { o.pick(b); swallowClick(host); } }
      };
      addEventListener("pointermove", move, { passive: true }); addEventListener("pointerup", end); addEventListener("pointercancel", end);
    });
  }
  function swallowClick(host) {
    const f = (e) => { e.stopPropagation(); e.preventDefault(); };
    host.addEventListener("click", f, { capture: true, once: true });
    setTimeout(() => host.removeEventListener("click", f, { capture: true }), 350);
  }
  /** SF Symbols' effects, one for each tab's icon, when it is chosen. */
  function tabFx(tab) {
    if (Glass.reduced) return;
    const svg = $(`#tab-${tab} svg`); if (!svg?.animate) return;
    const B = { duration: EASE.bouncy.ms, easing: EASE.bouncy.easing }, N = { duration: EASE.snappy.ms, easing: EASE.snappy.easing };
    const kids = [...svg.children];
    if (tab === "now") svg.animate([{ transform: "rotate(-45deg) scale(.6)" }, { transform: "none" }], B);
    if (tab === "timeline") kids.forEach((k, i) => k.animate([{ transform: i ? "scale(.2)" : "translateX(-5px)", opacity: 0 }, { transform: "none", opacity: 1 }], { ...N, delay: i * 50, fill: "backwards" }));
    if (tab === "budget") kids[1]?.animate([{ transform: "rotate(-100deg)" }, { transform: "none" }], B);
    if (tab === "keys") svg.animate([{ transform: "rotate(0)" }, { transform: "rotate(-16deg)", offset: 0.22 }, { transform: "rotate(12deg)", offset: 0.48 }, { transform: "rotate(-6deg)", offset: 0.74 }, { transform: "rotate(0)" }], { duration: 640, easing: "ease-in-out" });
    if (tab === "how") { kids[0]?.animate([{ transform: "translateX(-4px)" }, { transform: "none" }], B); kids[1]?.animate([{ transform: "translateX(4px)" }, { transform: "none" }], B); }
  }
  function reveal(el, i = 0) { el.style.transitionDelay = `${Math.min(i, 10) * 50}ms`; el.classList.add("shown"); setTimeout(() => { el.style.transitionDelay = ""; }, 1400); }
  function go(tab, opts = {}) {
    if (!TABS.includes(tab)) tab = "now";
    if (st.booted && tab === st.tab) return;
    st.tab = tab;
    TABS.forEach((t) => { const b = $(`#tab-${t}`); b.setAttribute("aria-selected", String(t === tab)); b.tabIndex = t === tab ? 0 : -1; });
    if (!opts.silent) try { history.replaceState(null, "", `#${tab}`); } catch {}
    closeMenu();
    if (rp.t != null && tab !== "now") setReplay(null);
    const next = $(`#view-${tab}`);
    clearTimeout(st.swapT);
    if (!st.booted || !Glass.ok || Glass.reduced || !st.onScreen) { tabFx(tab); showView(next, tab); return; }
    tabFx(tab);
    const old = $(`#view-${st.onScreen}`);
    if (st.onScreen === tab) { old.classList.remove("leaving"); if (tab === "now") Glass.show($("#ring"), true); return; }
    // the words leave first, quickly; then the glass flows into the new layout and the new words land with it
    old.classList.add("leaving");
    if (st.onScreen === "now") Glass.show($("#ring"), false, 0, { fast: true });
    st.swapT = setTimeout(() => swap(old, next, tab), 110);
  }
  function hideView(v) {
    v.hidden = true; v.classList.remove("in", "leaving");
    $$(".rise", v).forEach((el) => el.classList.remove("shown"));
  }
  function showView(next, tab) {
    TABS.forEach((t) => { const v = $(`#view-${t}`); if (v !== next) { hideView(v); $$(".glass", v).forEach((el) => Glass.show(el, false, 0, { instant: true })); } });
    next.hidden = false; st.onScreen = tab;
    $("#scroller").scrollTop = 0; syncScroll();
    $$(".glass", next).forEach((el, i) => Glass.show(el, true, 0.05 + i * 0.045));
    if (tab === "budget" && st.m) chart();
    void next.offsetWidth; next.classList.add("in");
    $$(".rise", next).forEach((el, i) => reveal(el, i));
  }
  function swap(old, next, tab) {
    const from = Glass.snapshot(old);
    $$(".glass", old).forEach((el) => Glass.show(el, false, 0, { instant: el.id !== "ring" }));
    hideView(old);
    next.hidden = false; st.onScreen = tab;
    $("#scroller").scrollTop = 0; syncScroll();
    if (tab === "budget" && st.m) chart();
    void next.offsetWidth;
    const glass = $$(".glass", next).filter((el) => el.id !== "ring");
    const vis = glass.filter(inView).sort(byReading);
    glass.filter((el) => !vis.includes(el)).forEach((el) => { Glass.show(el, true, 0, { instant: true }); el.classList.add("shown"); });
    Glass.flow(from, vis, { onLand: (el) => el.classList.add("shown") });
    $$(".rise", next).filter((el) => !el.classList.contains("glass")).forEach((el, i) => setTimeout(() => { if (!next.hidden) el.classList.add("shown"); }, 140 + i * 55));
    if (tab === "now") Glass.show($("#ring"), true, 0.22);
    next.classList.add("in");
  }

  // ─── The island: the status capsule opens up when something happens ──────
  const isl = { key: null, t: 0 };
  function islandFit() {
    const s = $("#status"), part = s.classList.contains("wide") ? $("#island-wide") : $("#island-compact");
    const max = innerWidth - (innerWidth <= 760 ? 32 : 64);
    s.style.width = `${Math.min(max, Math.ceil(part.scrollWidth))}px`;
  }
  function islandShow(html, tone, key, ms = 6500) {
    const s = $("#status");
    $("#island-wide").innerHTML = html; s.dataset.tone = tone; isl.key = key;
    s.classList.add("wide"); islandFit(); Glass.sweep(s);
    document.documentElement.classList.add("island-wide");
    clearTimeout(isl.t); isl.t = setTimeout(islandHide, ms);
  }
  function islandHide() {
    const s = $("#status"); clearTimeout(isl.t); isl.key = null;
    s.classList.remove("wide"); document.documentElement.classList.remove("island-wide"); islandFit();
  }
  function islandEvent(d) {
    const verdict = d.kind === 0 ? `${STAR}<b>Co-signed</b>` : `<b>${d.kind === 2 ? "Refused · struck" : "Refused"}</b>`;
    const what = d.kind === 0 ? doesShort(d.tx) : d.why ? `“${esc(clip(d.why, 46))}”` : "The guard would not sign";
    return `${verdict}<span class="ev-what">${what}</span>${d.usd6 && d.kind === 0 ? `<span class="ev-usd">${usd(d.usd6, u6(d.usd6) < 0.01 ? 4 : 2)}</span>` : ""}<span class="ev-open" aria-hidden="true">›</span>`;
  }
  function feedInfo() {
    if (!st.feed) return "<b>Loading</b>";
    if (!st.live) return `<b>Sample data</b><span class="ev-what">the live feed could not be reached</span>`;
    const left = nextLeft(), on = !st.away && !st.m?.u.tripped;
    return `<b>${st.away ? "Offline" : "Live"}</b><span class="ev-what">published ${ago(st.feed.generatedAt)}${on && left != null ? ` · the agent looks again in ${mmss(left)}` : ""}</span>`;
  }

  // ─── Status, feed and live updates ────────────────────────────────────────
  function renderStatus() {
    const s = $("#status");
    s.classList.remove("live", "away", "sample");
    if (!st.live) { s.classList.add("sample"); $("#status-text").textContent = "Sample data"; }
    else {
      s.classList.add(st.away ? "away" : "live");
      $("#status-text").textContent = st.away ? `Offline · last seen ${ago(st.feed.generatedAt)}` : `Live · ${ago(st.feed.generatedAt)}`;
      $("#foot-source").textContent = st.away ? `The demo machine was last seen ${ago(st.feed.generatedAt)}. This is its last state.` : `Published by the demo machine ${ago(st.feed.generatedAt)}.`;
    }
    if (!s.classList.contains("wide")) islandFit();
  }
  function apply(feed, live) {
    const animate = st.live && live; // stars are born only for what arrives while you watch
    st.feed = feed; st.live = live;
    st.away = live && (Date.now() - Date.parse(feed.generatedAt)) / 1000 > AWAY_S;
    st.m = build(feed);
    const fresh = animate ? st.m.decisions.filter((d) => !st.seen.has(d.key)) : [];
    st.m.decisions.forEach((d) => st.seen.add(d.key));
    renderStatus(); renderNow(); renderTimeline({ flow: true, keep: true }); renderBudget(); renderKeys();
    Glass.ringState($("#ring"), st.m.u.tripped); $("#ring").classList.toggle("coral", !!st.m.u.tripped);
    Glass.asleep(st.away);
    if (live) Glass.sweep($("#status"));
    renderReplay(); skyNow(rp.t != null ? "soft" : animate);
    if (!live) $("#foot-source").textContent = feed.note ?? "Sample data from a rehearsal: the live feed could not be reached.";
    if (st.sheet) openSheet(st.sheet);
    if (fresh.length) { const d = fresh[fresh.length - 1]; islandShow(islandEvent(d), d.kind === 0 ? "star" : "coral", d.key, 7000); }
    tickNext();
  }
  async function load() {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`${FEED_URL}?t=${Math.floor(Date.now() / 60000)}`, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!r.ok) throw new Error(String(r.status));
      const f = await r.json();
      if (!st.feed || f.generatedAt !== st.feed.generatedAt || !st.live) apply(f, true);
      else renderStatus();
    } catch { if (!st.feed) apply(st.sample, false); }
    clearTimeout(st.fallback);
    setTimeout(load, 60000);
  }

  // ─── Small confirmations and the context menu, in the overlay's glass ─────
  function toast(text, fromEl) {
    const el = $("#toast"); $("span", el).textContent = text;
    el.classList.add("show");
    el.style.setProperty("--p", Glass.ok && !Glass.reduced ? "0" : "1");
    if (Glass.ok) Glass.overlay(el, { kind: "chip", from: fromEl && inView(fromEl) ? fromEl.getBoundingClientRect() : null, fromRadius: 14, onFrame: (p) => el.style.setProperty("--p", p.toFixed(3)) });
    clearTimeout(st.toastT);
    st.toastT = setTimeout(() => { el.classList.remove("show"); Glass.overlayOut(el, {}); }, 1500);
  }
  function copy(text, fromEl) {
    navigator.clipboard?.writeText(text).then(() => toast("Copied", fromEl)).catch(() => {
      const code = fromEl?.parentElement?.querySelector("code");
      if (code) { const r = document.createRange(); r.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selected: press ⌘C to copy", fromEl); }
    });
  }
  let menuAt = null;
  function openMenu(x, y, d) {
    const m = $("#menu"), ex = st.feed.explorers ?? {}, fork = !!st.feed.networks?.flareFork;
    if (menuAt) { menuAt = null; Glass.overlayOut(m, {}); }
    const items = [
      ["open", "Open the decision", OPEN],
      d.d.hash && ["copy-hash", "Copy the XRPL hash", COPY],
      d.d.hash && ex.xrplTx && ["xrpl", "View it on the XRPL explorer", OUT],
      d.d.struck && ex.flareTx && !fork && ["strike", "View the strike on Flare", OUT],
      d.why && ["copy-why", "Copy what the agent said", COPY],
    ].filter(Boolean);
    m.innerHTML = items.map(([k, t, ic]) => `<button role="menuitem" data-m="${k}">${ic}<span>${t}</span></button>`).join("");
    m.hidden = false; m.classList.add("open");
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.max(12, Math.min(x, innerWidth - w - 12))}px`;
    m.style.top = `${y + h + 12 > innerHeight ? Math.max(12, y - h) : y}px`;
    menuAt = { x, y, d };
    m.style.setProperty("--p", Glass.ok && !Glass.reduced ? "0" : "1");
    if (Glass.ok) Glass.overlay(m, { kind: "sheet", from: { left: x - 5, right: x + 5, top: y - 5, bottom: y + 5 }, fromRadius: 5, onFrame: (p) => m.style.setProperty("--p", p.toFixed(3)) });
    m.querySelector("button")?.focus({ preventScroll: true });
  }
  function closeMenu() {
    const m = $("#menu"); if (!menuAt) return;
    const { x, y } = menuAt; menuAt = null;
    m.classList.remove("open");
    if (!Glass.ok) { m.hidden = true; return; }
    Glass.overlayOut(m, { to: { left: x - 3, right: x + 3, top: y - 3, bottom: y + 3 }, toRadius: 3, onDone: () => { if (!menuAt) m.hidden = true; } });
  }
  function menuFor(key, x, y) { const d = st.m?.decisions.find((q) => q.key === key); if (d) openMenu(x, y, d); }

  // ─── The pointer: its drop becomes the highlight of the control beneath ───
  const HOVER = ".tab, #filters button, .linkbtn, .copy, .close, .signer, .faq summary, .decision, #status, .menu button";
  const LIFT = ".tab, #filters button, .copy, .close, .linkbtn";
  function hoverOpts(el) {
    const layer = el.closest(".sheet, .menu") ? 1 : 0;
    if (el.matches(".tab, #filters button, #status, .copy, .close")) return { radius: "capsule", layer };
    if (el.matches(".linkbtn")) return { radius: "capsule", inset: [12, 2], layer };
    if (el.matches(".signer")) return { radius: 22, layer };
    if (el.matches(".faq summary")) return { radius: 14, inset: [12, 0], layer };
    if (el.matches(".menu button")) return { radius: 11, layer };
    return { radius: 16, layer };
  }
  let hovEl = null;
  function onHover(e) {
    if (e.pointerType !== "mouse") return;
    const el = e.target.closest?.(HOVER) ?? null;
    if (el !== hovEl) {
      if (hovEl?.matches(LIFT)) hovEl.style.translate = "";
      hovEl = el;
      Glass.hover(el, el ? hoverOpts(el) : null);
      Glass.markHover(el?.matches(".decision") ? el.dataset.key : null);
    }
    // small controls lean toward the pointer (iPadOS's lift)
    if (el && el.matches(LIFT) && !Glass.reduced) {
      const r = el.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      el.style.translate = `${(dx * 0.07).toFixed(2)}px ${(dy * 0.12).toFixed(2)}px`;
    }
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  function wire() {
    $$(".tab").forEach((b) => b.addEventListener("click", () => go(b.id.slice(4))));
    $("#tabs").addEventListener("keydown", (e) => {
      const i = TABS.indexOf(st.tab);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]; go(n); $(`#tab-${n}`).focus(); }
    });
    let press = null; // a long press on a row opens its menu (touch)
    document.addEventListener("click", (e) => {
      if (press?.fired) { press = null; e.preventDefault(); return; }
      const goEl = e.target.closest("[data-go]"); if (goEl) { go(goEl.dataset.go); return; }
      const row = e.target.closest(".decision[data-key]"); if (row && !e.target.closest("a")) { openSheet(row.dataset.key, row); return; }
      const cp = e.target.closest("[data-copy]"); if (cp) { copy(cp.dataset.copy, cp); return; }
      const sg = e.target.closest(".signer");
      if (sg) { const k = sg.dataset.k; st.signers.has(k) ? st.signers.delete(k) : st.signers.add(k); quorum(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (menuAt) closeMenu(); else if (st.sheet) closeSheet(); else if (rp.t != null) setReplay(null); return; }
      const typing = e.target.closest?.("input, textarea");
      if (/^[1-5]$/.test(e.key) && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) go(TABS[Number(e.key) - 1]);
      if (e.key === "/" && !typing) { e.preventDefault(); const was = st.onScreen; go("timeline"); setTimeout(() => $("#q").focus({ preventScroll: true }), was === "timeline" ? 0 : 420); }
      if (e.key === "Enter" && e.target.matches?.(".decision[data-key]")) { st.viaKey = true; openSheet(e.target.dataset.key, e.target); }
      if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && e.target.matches?.(".decision[data-key]")) { e.preventDefault(); const r = e.target.getBoundingClientRect(); menuFor(e.target.dataset.key, r.left + 40, r.top + r.height / 2); }
    });
    $("#scrim").addEventListener("click", closeSheet);
    $("#sheet .close").addEventListener("click", closeSheet);
    $$("#filters button").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.f)));
    $("#q").addEventListener("input", (e) => { st.q = e.target.value; renderTimeline({ flow: true, keep: true }); });
    $("#b-tabletoggle").addEventListener("click", () => {
      st.table = !st.table; $("#b-table").hidden = !st.table; $("#b-chartbox").hidden = st.table;
      $("#b-tabletoggle").textContent = st.table ? "Chart" : "Table";
    });
    // the island: tap it for the feed, or for the decision it is showing
    $("#status").addEventListener("click", () => {
      if (isl.key) { const k = isl.key; openSheet(k, $("#status")); islandHide(); return; }
      if ($("#status").classList.contains("wide")) { islandHide(); return; }
      islandShow(feedInfo(), "info", null, 5200);
    });
    $("#status").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#status").click(); } });
    // the context menu: right click, the menu key, or a long press
    document.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".decision[data-key]");
      if (!row || e.target.closest("a") || !st.m) return;
      e.preventDefault(); menuFor(row.dataset.key, e.clientX, e.clientY);
    });
    document.addEventListener("pointerdown", (e) => {
      if (menuAt && !e.target.closest("#menu")) closeMenu();
      if (e.pointerType === "mouse") return;
      const row = e.target.closest(".decision[data-key]"); if (!row) return;
      const x = e.clientX, y = e.clientY;
      press = { x, y, fired: false, t: setTimeout(() => { if (!press) return; press.fired = true; menuFor(row.dataset.key, x, y); }, 520) };
    }, { passive: true });
    document.addEventListener("pointermove", (e) => { if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) { clearTimeout(press.t); press = null; } onHover(e); }, { passive: true });
    document.addEventListener("pointerup", () => { if (press && !press.fired) { clearTimeout(press.t); press = null; } }, { passive: true });
    $("#menu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-m]"); if (!b || !menuAt) return;
      const d = menuAt.d, k = b.dataset.m, ex = st.feed.explorers ?? {};
      if (k === "copy-hash") copy(d.d.hash, b);
      if (k === "copy-why") copy(d.why, b);
      closeMenu();
      if (k === "open") openSheet(d.key, rowOf(d.key));
      if (k === "xrpl") window.open(`${ex.xrplTx}${d.d.hash}`, "_blank", "noopener");
      if (k === "strike") window.open(`${ex.flareTx}${d.d.struck}`, "_blank", "noopener");
    });
    $("#menu").addEventListener("keydown", (e) => {
      const bs = $$("#menu button"), i = bs.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus(); }
    });
    // questions open and close on a spring. The <details> itself is animated: its answer lives in a
    // slot the browser keeps hidden while closed, where an animation would not run.
    $$(".faq details").forEach((d) => {
      const sum = $("summary", d);
      sum.addEventListener("click", (e) => {
        if (Glass.reduced || !d.animate) return;
        e.preventDefault();
        d.getAnimations().forEach((a) => a.cancel());
        const from = d.offsetHeight;
        if (d.open && !d.classList.contains("closing")) {
          d.classList.add("closing");
          const to = sum.offsetHeight + 8;
          d.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 380, easing: EASE.smooth.easing }).onfinish = () => { d.open = false; d.classList.remove("closing"); };
        } else {
          d.classList.remove("closing"); d.open = true;
          // (the details' own height is not updated yet here; its answer's is)
          const ans = $("p", d), to = sum.offsetHeight + 8 + (ans ? ans.offsetHeight + (parseFloat(getComputedStyle(ans).marginBottom) || 0) : 0);
          d.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: EASE.snappy.ms, easing: EASE.snappy.easing });
        }
      });
    });
    // replay: drag along the track, or use the arrow keys on its knob; double-click returns to now
    const tr = $("#rp-track");
    const scrub = (x) => { const r = tr.getBoundingClientRect(), n = st.m?.decisions.length ?? 0; setReplay(Math.round(Math.min(1, Math.max(0, (x - r.left) / r.width)) * (n + 1)) - 1); };
    tr.addEventListener("pointerdown", (e) => { if (e.button) return; rp.drag = true; try { tr.setPointerCapture(e.pointerId); } catch {} $("#rp").classList.add("drag"); scrub(e.clientX); });
    tr.addEventListener("pointermove", (e) => { if (rp.drag) scrub(e.clientX); });
    const endScrub = () => { if (!rp.drag) return; rp.drag = false; $("#rp").classList.remove("drag"); };
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) tr.addEventListener(ev, endScrub);
    tr.addEventListener("dblclick", () => setReplay(null));
    $("#rp-knob").addEventListener("keydown", (e) => {
      const n = st.m?.decisions.length ?? 0, cur = rp.i ?? n;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); setReplay(cur - 1); }
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); setReplay(cur + 1); }
      if (e.key === "Home") { e.preventDefault(); setReplay(-1); }
      if (e.key === "End") { e.preventDefault(); setReplay(null); }
    });
    // the sky's stars answer the pointer
    const hit = $("#orbit-hit"), tip = $("#startip");
    hit.addEventListener("pointermove", (e) => {
      const mk = Glass.markAt(e.clientX, e.clientY);
      if (!mk) { tip.classList.remove("show"); hit.style.cursor = "crosshair"; return; }
      const d = mk.data.d; hit.style.cursor = "pointer";
      tip.innerHTML = `<span class="label">${d.kind === 0 ? "Co-signed" : d.kind === 2 ? "Refused · struck" : "Refused"} · ${clock(d.at)}</span><br><b>${esc(d.why || "No reason given")}</b>${d.usd6 ? `<br>${usd(d.usd6, u6(d.usd6) < 0.01 ? 4 : 2)} priced by FTSO` : ""}`;
      tip.style.left = `${mk.x}px`; tip.style.top = `${mk.y}px`; tip.classList.add("show");
    });
    hit.addEventListener("pointerleave", () => { tip.classList.remove("show"); Glass.markAt(-1e4, -1e4); });
    hit.addEventListener("click", (e) => { const mk = Glass.markAt(e.clientX, e.clientY); if (mk) { tip.classList.remove("show"); openSheet(mk.data.d.key, { x: mk.x, y: mk.y }); } });
    hit.addEventListener("contextmenu", (e) => { const mk = Glass.markAt(e.clientX, e.clientY); if (mk) { e.preventDefault(); tip.classList.remove("show"); menuFor(mk.data.d.key, e.clientX, e.clientY); } });
    // scroll: the sky follows a little, the phone's tab bar steps aside
    const sc = $("#scroller"); let lastY = 0;
    sc.addEventListener("scroll", () => {
      const y = sc.scrollTop, tabs = $("#tabs");
      if (innerWidth <= 760) { if (y > lastY + 6 && y > 80) tabs.classList.add("mini"); else if (y < lastY - 6) tabs.classList.remove("mini"); }
      lastY = y; syncScroll(); if (menuAt) closeMenu();
    }, { passive: true });
    addEventListener("resize", () => { syncScroll(); islandFit(); closeMenu(); clearTimeout(st.rs); st.rs = setTimeout(() => st.m && st.onScreen === "budget" && chart(), 150); });
    addEventListener("hashchange", () => go(location.hash.slice(1), { silent: true }));
  }
  function syncScroll() {
    const sc = $("#scroller"), top = parseFloat(getComputedStyle(sc).paddingTop) || 104;
    const mobile = innerWidth <= 760;
    Glass.setScroll(sc.scrollTop, top - 34, innerHeight - (mobile ? 86 : 0));
  }
  // the white star (and its spiral of decisions) sits inside the budget ring on Now, and high in the sky elsewhere
  function anchor() {
    requestAnimationFrame(anchor);
    const ring = $("#ring");
    if (st.onScreen === "now" && st.tab === "now" && ring && !ring.closest("[hidden]")) {
      const r = ring.getBoundingClientRect(), cy = r.top + r.height / 2, top = innerWidth <= 760 ? 84 : 104;
      // the spiral belongs to the ring: when the ring slides under the top bar, its stars go with it
      Glass.focus(r.left + r.width / 2, cy, r.width / 2, cy > top + 30 && cy < innerHeight - (innerWidth <= 760 ? 110 : 20));
    }
    else Glass.focus(innerWidth * 0.5, innerHeight * (innerWidth <= 760 ? 0.2 : 0.3), 0, false);
  }

  function boot() {
    const gl = Glass.init($("#sky"));
    if (!gl) document.documentElement.classList.add("no-gl");
    if (Glass.solid) document.documentElement.classList.add("solid");
    Glass.setScroller($("#scroller"));
    st.sample = JSON.parse($("#sample").textContent);
    // glass: navigation (fixed) and content (scrolls); the sheet, menus and toasts are the overlay's
    Glass.add($("#tabs"), { kind: "bar", scroll: false, delay: 0.25 });
    Glass.add($("#status"), { kind: "bar", scroll: false, delay: 0.35 });
    Glass.add($("#ring"), { kind: "ring", tube: innerWidth <= 760 ? 11 : 13, shown: false });
    $$(".view .glass").forEach((el) => { if (!el.closest("#days")) Glass.add(el, { kind: el.matches(".pill, .segment, .search") ? "chip" : "pane", shown: false }); });
    liquidControl($("#tabs"), { key: "tabs", items: () => $$(".tab"), current: () => $(`#tab-${st.tab}`), pick: (b) => go(b.id.slice(4)) });
    liquidControl($("#filters"), { key: "filters", items: () => $$("#filters button"), current: () => (Glass.flowing ? null : $(`#filters button[aria-pressed="true"]`)), pick: (b) => setFilter(b.dataset.f), lens: { height: 0.24 } });
    wire();
    $("#now-spent").__t = "$0.00"; // the first figure rolls in
    const h = location.hash.slice(1);
    st.tab = TABS.includes(h) ? h : "now";
    // the live feed first; the rehearsal sample only if it cannot be reached in time
    st.fallback = setTimeout(() => { if (!st.feed) apply(st.sample, false); }, 1500);
    go(st.tab, { silent: true });
    st.booted = true;
    syncScroll(); anchor();
    load();
    setInterval(() => { if (st.feed) { renderStatus(); tickNext(); } }, 1000);
    // for tests: feed the page by hand
    window.__lanceaApply = (f, live = true) => apply(f, live);
  }
  boot();
})();
