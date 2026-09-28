/* Lancea Watch: the page. It reads the demo machine's feed.json (every minute), turns it into five
 * views and hands the sky what belongs in it: where the white star sits, and a star for every decision.
 * Everything a viewer reads is plain HTML; the glass and the sky are drawn by glass.js underneath. */
(() => {
  "use strict";
  const FEED_URL = "https://raw.githubusercontent.com/dziuba0x/lancea-feed/main/feed.json";
  const AWAY_S = 1800; // the machine publishes at least every 10 min; three missed heartbeats means it is off
  const TABS = ["now", "timeline", "budget", "keys", "how"];
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cut = (s, a = 6, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s ?? "");
  const u6 = (x) => Number(x ?? 0) / 1e6;
  const usd = (x, d = 2) => "$" + u6(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (x, d = 2) => Number(x).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  const xrp = (drops) => num(u6(drops), 6);
  const c2flr = (wei) => (wei == null ? null : Number(BigInt(wei) / 10n ** 14n) / 1e4);
  const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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
  const STAR = '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6 0 7.1 4.9 12 6 7.1 7.1 6 12 4.9 7.1 0 6 4.9 4.9Z"/></svg>';
  const X_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const COPY = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';

  /** Numbers roll to a new value (the digits settle like a counter), and never on reduced motion. */
  function roll(el, to, fmt) {
    if (!el) return;
    const from = Number(el.dataset.v ?? NaN); el.dataset.v = to;
    if (!Number.isFinite(from) || from === to || Glass.reduced) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4); el.textContent = fmt(from + (to - from) * e); if (k < 1 && el.dataset.v == to) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const st = { feed: null, sample: null, live: false, away: false, m: null, tab: "now", filter: "all", q: "", signers: new Set(["agent", "guard"]), table: false, sheet: null, seen: new Set(), booted: false };

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
    if (a.kind === "vault") return `${a.action === "deposit" ? "Deposits" : a.action === "redeem" ? "Redeems" : "Claims"} ${xrp(a.value)} ${a.action === "deposit" ? "FXRP into" : "shares from"} ${esc(cap(a.vault))} vault ${a.vaultId}, for a fee of ${amount}`;
    if (a.kind === "fxrp-redeem") return `Redeems ${xrp(a.value)} FXRP back to XRP, for a fee of ${amount}`;
    if (a.kind === "user-op") return `Runs a custom batch of calls from your personal account: <em>arbitrary code</em>`;
    if (a.kind === "refused" || a.kind === "undecodable") return `An instruction the guard cannot read: <em>${esc(a.reason)}</em>`;
    return `Pays ${amount} to <code>${cut(tx.destination, 6, 4)}</code>`;
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
    const notes = (feed.autopilot ?? []).filter((e) => ["holding", "paused", "settled", "timeout", "acknowledged", "start", "stop", "error", "idle"].includes(e.kind)).slice().reverse();
    const proposals = (feed.autopilot ?? []).filter((e) => e.kind === "proposal" && e.state).slice().reverse();
    const start = (feed.autopilot ?? []).find((e) => e.kind === "start");
    const lastAuto = (feed.autopilot ?? [])[0];
    const mints = decisions.filter((d) => d.kind === 0 && d.rail === "mint" && d.usd6 && Number(d.tx.amountDrops) > 0);
    const price = mints.map((d) => ({ at: d.at, p: u6(d.usd6) / u6(d.tx.amountDrops) }));
    const series = decisions.filter((d) => d.kind === 0 && d.tally != null).map((d) => ({ at: d.at, v: u6(d.tally), d }));
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
    const last = st.feed.autopilot?.find((e) => ["holding", "paused", "idle", "verdict", "settled", "timeout", "start", "stop"].includes(e.kind));
    if (u.tripped) {
      const why = lastStrike?.why ? `<q>${esc(lastStrike.why)}</q>` : "";
      return { tone: "coral", pill: "Paused · tripped", head: "The leash held.",
        sub: lastStrike?.by === "drill"
          ? `In a drill, the agent was fed a planted note${why ? `: ${why}` : ""}. It asked the guard to act on it. The guard refused and wrote a strike on Flare. Every rail stays shut until the owner re-arms the umbrella.`
          : `The agent asked to act ${why ? `on ${why}` : "outside its rules"}. The guard refused and wrote a strike on Flare. Every rail stays shut until the owner re-arms the umbrella.` };
    }
    if (st.away) return { tone: "grey", pill: "Offline", head: "Offline, and still on its leash.", sub: "The demo machine is off right now, so the agent proposes nothing until it is back. What you see is its last published state." };
    if (last?.kind === "holding") return { tone: "grey", pill: "Holding", head: "At the edge of its budget.", sub: "The next step would cross the umbrella's budget, so the agent keeps it to itself instead of asking." };
    if (last?.kind === "stop") return { tone: "grey", pill: "Stopped", head: "The agent is not running.", sub: "Its service was stopped. The account and the umbrella stay as they are." };
    return { tone: "star", pill: "Working", head: "Working inside its leash.", sub: "An AI agent puts idle XRP to work in a Flare vault. It cannot move a coin alone: every step it proposes is priced against your budget and checked against your rules before the guard adds the second signature." };
  }

  // ─── Rendering: shared pieces ─────────────────────────────────────────────
  function decisionRow(d, compact) {
    const v = d.kind === 0 ? `<span class="v signed">${STAR} Co-signed</span>` : d.kind === 2 ? `<span class="v struck">Refused · struck</span>` : `<span class="v refused">Refused</span>`;
    const by = d.by === "drill" ? `<span class="label"> · drill, a staged hijack</span>` : d.by === "ai" ? `<span class="label"> · by AI</span>` : "";
    return `<li class="decision" tabindex="0" data-key="${esc(d.key)}" aria-label="Open this decision">
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
      idle: ["<b>Nothing to do.</b> No idle XRP above the reserve.", ""],
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
    const m = st.m, s = stateOf(), u = m.u;
    const pill = $("#now-pill"); pill.className = `pill glass rise ${s.tone}`; $("span", pill).textContent = s.pill;
    $("#now-head").textContent = s.head; $("#now-sub").innerHTML = s.sub;
    roll($("#now-spent"), u6(u.spentUsd6), (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    $("#now-of").innerHTML = `spent of ${usd(u.budgetUsd6, 0)} across XRPL and Flare · ${Math.round(m.frac * 100)}%`;
    const left = m.until ? Math.max(0, Math.ceil((m.until - Date.now()) / 864e5)) : null;
    $("#now-facts").innerHTML = [
      `<span class="label">Umbrella <b>#${esc(u.id)}</b></span>`,
      `<span class="label">Tripwire <b>${esc(u.strikes)} of ${esc(u.tripwire)}</b></span>`,
      left != null ? `<span class="label">Window <b>${left} days left</b></span>` : `<span class="label">Decisions <b>${m.decisions.length}</b></span>`,
    ].join("");
    // stats with their history (from what the agent saw at each proposal)
    const hist = (f) => m.proposals.map((p) => f(p.state)).filter((v) => Number.isFinite(v));
    const xrpNow = u6(m.a.xrpDrops), fx = u6(m.a.fxrp), sh = u6(m.a.shares);
    stat("#stat-xrp", "XRP on the ledger", `${num(xrpNow, 2)}`, "spendable, above the 2 XRP reserve", spark([...hist((x) => u6(x.xrpDrops)), xrpNow], "#f5f5f7"));
    stat("#stat-fxrp", "FXRP on Flare", `${num(fx, 2)}`, "in your personal account", spark([...hist((x) => u6(x.fxrp)), fx], "#f5f5f7"));
    stat("#stat-shares", `${cap(m.a.vaultName ?? "Firelight")} shares`, `${num(sh, 2)}`, "the vault's receipt for deposits", spark([...hist((x) => u6(x.shares?.["1"] ?? x.shares)), sh], "#f5f5f7"));
    const low = m.gasGuard != null && m.gasGuard < 0.5;
    stat("#stat-gas", "The guard's gas", m.gasGuard != null ? `${num(m.gasGuard, 2)}` : "?", m.gasGuard != null ? (low ? "C2FLR · low: top it up from the Coston2 faucet" : `C2FLR · about ${Math.floor(m.gasGuard / 0.13)} decisions`) : "C2FLR · not in this feed", "");
    $("#stat-gas").classList.toggle("low", low);
    const list = m.decisions.slice(-4).reverse();
    $("#now-list").innerHTML = list.length ? list.map((d) => decisionRow(d, false)).join("") : `<li class="empty">No decisions yet. The agent looks every ${Math.round(m.tick / 60)} minutes.</li>`;
    const lastP = m.proposals[m.proposals.length - 1];
    const planEl = $("#now-plan");
    if (u.tripped) planEl.innerHTML = "<b>Nothing, until you re-arm.</b> The tripwire has cut every rail. The agent asks again after the owner re-arms the umbrella.";
    else if (st.away) planEl.innerHTML = "<b>Nothing while the machine is off.</b> When it is back, the agent looks at the account and proposes the next step.";
    else planEl.innerHTML = lastP ? `<b>Last it said:</b> ${esc(lastP.why)}` : "<b>Waiting for its first look.</b>";
  }
  function stat(sel, label, value, small, sparkSvg) {
    const el = $(sel);
    el.innerHTML = `<span class="label">${esc(label)}</span><b>${value}</b><small>${small}</small>${sparkSvg}`;
  }
  function tickNext() {
    if (!st.m) return;
    const m = st.m, tick = m.tick * 1000;
    const last = m.lastAuto ? Date.parse(m.lastAuto.at) : Date.parse(st.feed.generatedAt);
    let next = last + tick; while (next < Date.now() - 1000) next += tick;
    const left = Math.max(0, (next - Date.now()) / 1000), frac = 1 - left / m.tick;
    const on = !st.away && !m.u.tripped && st.live;
    $("#next-time").textContent = on ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}` : "—";
    $("#next-cap").textContent = on ? "until it looks again" : st.live ? "paused" : "sample data";
    const c = 2 * Math.PI * 32;
    $("#next-arc").setAttribute("stroke-dasharray", `${(on ? frac : 0) * c} ${c}`);
  }

  // ─── Timeline ─────────────────────────────────────────────────────────────
  function renderTimeline() {
    const m = st.m, q = st.q.trim().toLowerCase();
    const counts = { all: m.decisions.length + m.notes.length, signed: m.signed, refused: m.refused, notes: m.notes.length };
    $$("#filters button").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.f === st.filter)); $("small", b).textContent = counts[b.dataset.f]; });
    let items = [];
    if (st.filter !== "notes") items.push(...m.decisions.filter((d) => st.filter === "all" || (st.filter === "signed" ? d.kind === 0 : d.kind > 0)).map((d) => ({ at: d.at, html: decisionRow(d, true), text: `${d.why} ${d.tx.action?.kind ?? ""} ${d.d.hash ?? ""} ${d.d.reason ?? ""} ${xrp(d.tx.amountDrops)}` })));
    if (st.filter === "all" || st.filter === "notes") items.push(...m.notes.map((e) => ({ at: e.at, html: noteRow(e), text: `${e.kind} ${e.step?.kind ?? ""} ${e.error ?? ""}` })));
    if (q) items = items.filter((it) => it.text.toLowerCase().includes(q));
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const days = new Map();
    for (const it of items) { const k = dayKey(it.at); if (!days.has(k)) days.set(k, { name: dayName(it.at), items: [] }); days.get(k).items.push(it); }
    const host = $("#days");
    const old = $$(".day", host); old.forEach((el) => Glass.remove(el));
    host.innerHTML = days.size ? [...days.values()].map((d) => `<div class="glass pane day rise"><h3>${esc(d.name)}<span class="label">${d.items.length} ${d.items.length === 1 ? "event" : "events"}</span></h3><ul class="decisions">${d.items.map((i) => i.html).join("")}</ul></div>`).join("")
      : `<div class="glass pane day rise"><p class="empty">Nothing matches${q ? ` “${esc(st.q)}”` : ""}.</p></div>`;
    $$(".day", host).forEach((el, i) => Glass.add(el, { kind: "pane", delay: 0.04 * i, shown: st.tab === "timeline" }));
  }

  // ─── Budget ───────────────────────────────────────────────────────────────
  function renderBudget() {
    const m = st.m, u = m.u;
    roll($("#b-spent"), u6(u.spentUsd6), (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
      <path d="${d}" fill="none" stroke="#ffae45" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(t1)}" cy="${Y(last.v)}" r="4.5" fill="#ffae45" stroke="#07080f" stroke-width="2"/>
      <text x="${X(t1) - 10}" y="${Y(last.v) - 12}" text-anchor="end" fill="#f5f5f7" font-family="Geist, sans-serif" font-size="13" font-weight="600">${usd(m.u.spentUsd6)}</text>
      <line id="b-cross" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="rgba(245,245,247,.35)" opacity="0"/>
      <circle id="b-dot" r="4.5" fill="#ffae45" stroke="#07080f" stroke-width="2" opacity="0"/>
    </svg><div class="tip" id="b-tip" style="opacity:0"></div>`;
    const svg = $("svg", host), tip = $("#b-tip"), cross = $("#b-cross"), dot = $("#b-dot");
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
    $("#k-verdict").innerHTML = `${esc(text[0])}<small>${esc(text[1])}</small>`;
  }

  // ─── Sheet: one decision, in full ─────────────────────────────────────────
  let sheetFrom = null;
  function openSheet(key, fromEl) {
    const d = st.m.decisions.find((x) => x.key === key); if (!d) return;
    st.sheet = key;
    const tx = d.tx, dec = d.d;
    const v = d.kind === 0 ? `<span class="pill" style="height:28px;box-shadow:inset 0 0 0 1px rgba(245,245,247,.22)">${"<i></i>"}<span>Co-signed</span></span>` : `<span class="pill coral" style="height:28px;box-shadow:inset 0 0 0 1px rgba(255,107,107,.4)"><i></i><span>${d.kind === 2 ? "Refused · struck" : "Refused"}</span></span>`;
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
    sheetFrom = fromEl?.getBoundingClientRect() ?? null;
    morph.t = 0; morph.v = 0; morph.target = 1;
    $("#sheet").classList.add("open"); $("#sheet").setAttribute("aria-hidden", "false"); $("#scrim").classList.add("open");
    document.documentElement.classList.add("sheet-open"); Glass.backdrop(true);
    Glass.show($("#sheet"), true);
    setTimeout(() => $("#sheet .close").focus({ preventScroll: true }), 60);
  }
  function closeSheet() {
    if (!st.sheet) return;
    const row = $(`.decision[data-key="${CSS.escape(st.sheet)}"]`);
    sheetFrom = row && row.offsetParent ? row.getBoundingClientRect() : null;
    st.sheet = null; morph.target = 0;
    $("#sheet").classList.remove("open"); $("#sheet").setAttribute("aria-hidden", "true"); $("#scrim").classList.remove("open");
    document.documentElement.classList.remove("sheet-open"); Glass.backdrop(false);
    Glass.show($("#sheet"), false);
  }
  // the sheet's glass grows out of the row it came from (a matched-geometry morph)
  const morph = { t: 0, v: 0, target: 0, last: 0 };
  function sheetRect() {
    const el = $("#sheet"), r = el.getBoundingClientRect();
    const now = Glass.now, dt = Math.min(0.05, Math.max(0.001, now - (morph.last || now))); morph.last = now;
    if (Glass.reduced) morph.t = morph.target; else { const f = -170 * (morph.t - morph.target) - 24 * morph.v; morph.v += f * dt; morph.t += morph.v * dt; }
    if (!sheetFrom) return r;
    const k = Math.max(0, Math.min(1.08, morph.t)), l = (a, b) => a + (b - a) * k;
    const left = l(sheetFrom.left, r.left), top = l(sheetFrom.top, r.top), right = l(sheetFrom.right, r.right), bottom = l(sheetFrom.bottom, r.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // ─── Tabs, with a lens that slides and stretches between them ─────────────
  const ind = { lead: 0, trail: 0, lv: 0, tv: 0, w: 0, wv: 0, last: 0, init: false };
  function indicatorRect() {
    const bar = $("#tabs"), tab = $(`#tab-${st.tab}`); if (!tab) return null;
    const br = bar.getBoundingClientRect(), tr = tab.getBoundingClientRect();
    const goalL = tr.left, goalR = tr.right;
    const now = Glass.now, dt = Math.min(0.05, Math.max(0.001, now - (ind.last || now))); ind.last = now;
    if (!ind.init || Glass.reduced) { ind.lead = goalL; ind.trail = goalR; ind.init = true; }
    else {
      const moveRight = goalL > ind.lead;
      const fastK = 240, slowK = 120;
      const kL = moveRight ? slowK : fastK, kR = moveRight ? fastK : slowK;
      const fL = -kL * (ind.lead - goalL) - 2 * Math.sqrt(kL) * 0.9 * ind.lv, fR = -kR * (ind.trail - goalR) - 2 * Math.sqrt(kR) * 0.9 * ind.tv;
      ind.lv += fL * dt; ind.lead += ind.lv * dt; ind.tv += fR * dt; ind.trail += ind.tv * dt;
    }
    const top = tr.top + 1, bottom = tr.bottom - 1;
    return { left: ind.lead, right: ind.trail, top, bottom, width: ind.trail - ind.lead, height: bottom - top, _bar: br };
  }
  function go(tab, opts = {}) {
    if (!TABS.includes(tab)) tab = "now";
    const prev = st.tab; st.tab = tab;
    TABS.forEach((t) => { const b = $(`#tab-${t}`); b.setAttribute("aria-selected", String(t === tab)); b.tabIndex = t === tab ? 0 : -1; });
    if (!opts.silent) try { history.replaceState(null, "", `#${tab}`); } catch {}
    const show = () => {
      TABS.forEach((t) => { const v = $(`#view-${t}`); if (t !== tab) { v.hidden = true; v.classList.remove("in"); } });
      const v = $(`#view-${tab}`); v.hidden = false;
      $("#scroller").scrollTop = 0;
      $$(".glass", v).forEach((el, i) => Glass.show(el, true, 0.05 + i * 0.045));
      if (tab === "budget" && st.m) chart();
      void v.offsetWidth; v.classList.add("in");
    };
    if (prev === tab || !st.booted) { show(); return; }
    $$(".glass", $(`#view-${prev}`)).forEach((el) => Glass.show(el, false));
    $(`#view-${prev}`).classList.remove("in");
    setTimeout(show, Glass.reduced ? 0 : 200);
  }

  // ─── Status, feed and live updates ────────────────────────────────────────
  function renderStatus() {
    const s = $("#status");
    s.classList.remove("live", "away", "sample");
    if (!st.live) { s.classList.add("sample"); $("#status-text").textContent = "Sample data"; return; }
    s.classList.add(st.away ? "away" : "live");
    $("#status-text").textContent = st.away ? `Offline · last seen ${ago(st.feed.generatedAt)}` : `Live · ${ago(st.feed.generatedAt)}`;
    $("#foot-source").textContent = st.away ? `The demo machine was last seen ${ago(st.feed.generatedAt)}. This is its last state.` : `Published by the demo machine ${ago(st.feed.generatedAt)}.`;
  }
  function apply(feed, live) {
    const animate = st.live && live; // stars are born only for what arrives while you watch
    st.feed = feed; st.live = live;
    st.away = live && (Date.now() - Date.parse(feed.generatedAt)) / 1000 > AWAY_S;
    st.m = build(feed);
    renderStatus(); renderNow(); renderTimeline(); renderBudget(); renderKeys();
    Glass.setFill($("#ring"), st.m.frac);
    Glass.ringState($("#ring"), st.m.u.tripped);
    $("#ring").style.setProperty("--frac", st.m.frac); $("#ring").classList.toggle("coral", !!st.m.u.tripped);
    Glass.asleep(st.away);
    if (live) Glass.sweep($("#status"));
    Glass.setDecisions(st.m.decisions.map((d) => ({ key: d.key, kind: d.kind, d })), animate);
    if (!live) $("#foot-source").textContent = feed.note ?? "Sample data from a rehearsal: the live feed could not be reached.";
    if (st.sheet) openSheet(st.sheet);
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

  function toast(text) {
    const el = $("#toast"); $("span", el).textContent = text;
    el.classList.add("show"); Glass.show(el, true);
    clearTimeout(st.toastT); st.toastT = setTimeout(() => { el.classList.remove("show"); Glass.show(el, false); }, 1400);
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────
  function wire() {
    $$(".tab").forEach((b) => b.addEventListener("click", () => go(b.id.slice(4))));
    $("#tabs").addEventListener("keydown", (e) => {
      const i = TABS.indexOf(st.tab);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]; go(n); $(`#tab-${n}`).focus(); }
    });
    document.addEventListener("click", (e) => {
      const goEl = e.target.closest("[data-go]"); if (goEl) { go(goEl.dataset.go); return; }
      const row = e.target.closest(".decision[data-key]"); if (row && !e.target.closest("a")) { openSheet(row.dataset.key, row); return; }
      const cp = e.target.closest("[data-copy]");
      if (cp) {
        const txt = cp.dataset.copy;
        navigator.clipboard?.writeText(txt).then(() => toast("Copied")).catch(() => { const r = document.createRange(); const code = cp.parentElement.querySelector("code"); if (code) { r.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selected: press ⌘C to copy"); } });
        return;
      }
      const sg = e.target.closest(".signer");
      if (sg) { const k = sg.dataset.k; st.signers.has(k) ? st.signers.delete(k) : st.signers.add(k); quorum(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSheet();
      if (/^[1-5]$/.test(e.key) && !e.target.closest?.("input, textarea") && !e.metaKey && !e.ctrlKey && !e.altKey) go(TABS[Number(e.key) - 1]);
      if (e.key === "Enter" && e.target.matches?.(".decision[data-key]")) openSheet(e.target.dataset.key, e.target);
    });
    $("#scrim").addEventListener("click", closeSheet);
    $("#sheet .close").addEventListener("click", closeSheet);
    $$("#filters button").forEach((b) => b.addEventListener("click", () => { st.filter = b.dataset.f; renderTimeline(); }));
    $("#q").addEventListener("input", (e) => { st.q = e.target.value; renderTimeline(); });
    $("#b-tabletoggle").addEventListener("click", () => {
      st.table = !st.table; $("#b-table").hidden = !st.table; $("#b-chartbox").hidden = st.table;
      $("#b-tabletoggle").textContent = st.table ? "Chart" : "Table";
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
    hit.addEventListener("click", (e) => { const mk = Glass.markAt(e.clientX, e.clientY); if (mk) openSheet(mk.data.d.key); });
    // scroll: the sky follows a little, the phone's tab bar steps aside
    const sc = $("#scroller"); let lastY = 0;
    sc.addEventListener("scroll", () => {
      const y = sc.scrollTop, tabs = $("#tabs");
      if (innerWidth <= 760) { if (y > lastY + 6 && y > 80) tabs.classList.add("mini"); else if (y < lastY - 6) tabs.classList.remove("mini"); }
      lastY = y; syncScroll();
    }, { passive: true });
    addEventListener("resize", () => { syncScroll(); clearTimeout(st.rs); st.rs = setTimeout(() => st.m && !$("#view-budget").hidden && chart(), 150); });
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
    if (st.tab === "now" && ring && !ring.closest("[hidden]")) {
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
    st.sample = JSON.parse($("#sample").textContent);
    // glass: navigation (fixed) and content (scrolls)
    Glass.add($("#tabs"), { kind: "bar", scroll: false, delay: 0.25 });
    Glass.add($("#status"), { kind: "bar", scroll: false, delay: 0.35 });
    Glass.add($("#tab-indicator"), { kind: "indicator", scroll: false, manual: indicatorRect, delay: 0.4 });
    Glass.add($("#sheet"), { kind: "sheet", scroll: false, shown: false, manual: sheetRect });
    Glass.add($("#ring"), { kind: "ring", tube: innerWidth <= 760 ? 11 : 13, shown: false });
    Glass.add($("#toast"), { kind: "chip", scroll: false, shown: false });
    $$(".view .glass").forEach((el) => { if (!el.closest("#days")) Glass.add(el, { kind: el.classList.contains("pill") || el.classList.contains("segment") || el.classList.contains("search") ? "chip" : "pane", shown: false }); });
    wire();
    const h = location.hash.slice(1);
    st.tab = TABS.includes(h) ? h : "now";
    // the live feed first; the rehearsal sample only if it cannot be reached in time
    st.fallback = setTimeout(() => { if (!st.feed) apply(st.sample, false); }, 1500);
    go(st.tab, { silent: true });
    st.booted = true;
    syncScroll(); anchor();
    load();
    setInterval(() => { if (st.feed) { renderStatus(); tickNext(); } }, 1000);
  }
  boot();
})();
