/* Liquid Glass above the page's words: the top bar, the island, the phone's tab bar, menus and toasts.
 *
 * glass.js draws the sky and the panes' glass in WebGL, under the page; it cannot see the page's words.
 * What floats above them is drawn by the browser itself, as a backdrop filter made of an SVG displacement
 * map: the same squircle bevel as the WebGL glass, h = H (1 - (1 - x)^4)^(1/4), refracted by Snell's law
 * with a little more bend for blue than for red (IOR 1.44 / 1.50 / 1.57), so whatever passes under the glass
 * is magnified toward its rim and bends around its corners, with a thin rainbow at the edge.
 *
 * The map is cut in nine tiles, so a shape can grow, shrink or morph every frame without being drawn again:
 * four corners, four edges stretched along themselves, and a still centre. The frost (a blur for the
 * words on the glass to read over the words under it) thins toward the rim, so what bends there stays sharp.
 * The rim's light (the key light swings slowly, the pointer is a second light) is CSS; the shadow is
 * drawn by the WebGL sky, since a shadow on the element itself would move the filter (Chromium measures
 * the filter from the shadow's edge).
 *
 * Chromium draws SVG backdrop filters. Safari and Firefox get a frosted glass of the same shape instead.
 */
const LG = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const chromium = (() => { try { return !!navigator.userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand)); } catch { return false; } })();
  const forced = (() => { try { return new URL(location.href).searchParams.get("lg"); } catch { return null; } })();
  const ok = forced === "0" ? false : forced === "1" ? true : chromium;
  const items = new Map();
  const tiles = new Map();
  let svg = null, n = 0, ro = null;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  /** How far (CSS px) the view is bent `din` px inside the rim: negative is inward, along the outward normal. */
  function bend(din, B, Hh, depth, lim, ior) {
    const x = clamp(din / B, 0, 1);
    if (x >= 1) return 0;
    const xm = Math.max(x, 0.0015), om = 1 - xm, base = Math.max(1 - om ** 4, 1e-5);
    const h = Hh * base ** 0.25, slope = (Hh / B) * om ** 3 * base ** -0.75;
    const nz = 1 / Math.hypot(slope, 1), nxy = slope * nz, eta = 1 / ior;
    const k = 1 - eta * eta * (1 - nz * nz);
    if (k < 0) return 0;
    const f = eta * nz - Math.sqrt(k);
    const v = ((f * nxy) / Math.max(-(-eta + f * nz), 0.06)) * (h + depth);
    return v / (1 + Math.abs(v) / lim);
  }

  /** The tiles for a corner radius r and a bevel: data URLs, R and G the offset (0.5: none). */
  function tileSet(r, B, Hh, depth, lim, S, dpr) {
    const key = [r, B, Hh, depth, lim, S, dpr].map((v) => +v.toFixed(2)).join("|");
    if (tiles.has(key)) return tiles.get(key);
    const c = Math.max(r, B);
    const prof = (din) => bend(Math.max(0, din), B, Hh, depth, lim, 1.5);
    // the rim's share, in blue: the frost thins toward the rim, so what bends there stays sharp
    const rim = (din) => clamp(1 - din / (0.38 * B), 0, 1) ** 2;
    // (u, v): CSS px from the top-left corner, inward → [dx, dy, rim]
    const tl = (u, v) => {
      if (u < r && v < r) { const dx = u - r, dy = v - r, l = Math.hypot(dx, dy) || 1e-6, b = prof(r - l); return [(b * dx) / l, (b * dy) / l, rim(r - l)]; }
      return u < v ? [-prof(u), 0, rim(u)] : [0, -prof(v), rim(v)];
    };
    const draw = (w, h, f) => {
      const W = Math.max(1, Math.ceil(w * dpr)), H = Math.max(1, Math.ceil(h * dpr));
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const [dx, dy, k] = f(((i + 0.5) / W) * w, ((j + 0.5) / H) * h), o = (j * W + i) * 4;
        img.data[o] = Math.round(clamp(0.5 + dx / S, 0, 1) * 255);
        img.data[o + 1] = Math.round(clamp(0.5 + dy / S, 0, 1) * 255);
        img.data[o + 2] = Math.round(clamp(k, 0, 1) * 255); img.data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return cv.toDataURL();
    };
    const t = {
      c,
      tl: draw(c, c, (u, v) => tl(u, v)),
      tr: draw(c, c, (u, v) => { const [dx, dy, k] = tl(c - u, v); return [-dx, dy, k]; }),
      bl: draw(c, c, (u, v) => { const [dx, dy, k] = tl(u, c - v); return [dx, -dy, k]; }),
      br: draw(c, c, (u, v) => { const [dx, dy, k] = tl(c - u, c - v); return [-dx, -dy, k]; }),
      t: draw(1, c, (u, v) => [0, -prof(v), rim(v)]),
      b: draw(1, c, (u, v) => [0, prof(c - v), rim(c - v)]),
      l: draw(c, 1, (u) => [-prof(u), 0, rim(u)]),
      r: draw(c, 1, (u) => [prof(c - u), 0, rim(c - u)]),
    };
    tiles.set(key, t);
    if (tiles.size > 160) tiles.delete(tiles.keys().next().value);
    return t;
  }

  const mk = (name, attrs = {}, kids = []) => { const e = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); kids.forEach((k) => e.append(k)); return e; };
  const TILES = ["tl", "t", "tr", "l", "r", "bl", "b", "br"];

  /** The glass is thicker, and lenses more, the larger it is (Apple). */
  function params(rec, w, h) {
    const o = rec.o, m = Math.min(w, h);
    const r = clamp(o.radius === "capsule" ? m / 2 : o.radius ?? (parseFloat(getComputedStyle(rec.el).borderTopLeftRadius) || 0), 0, m / 2);
    const B = clamp(o.bevel ?? (m <= 64 ? m * 0.36 : 20), 3, m / 2);
    const Hh = o.height ?? B * (m <= 64 ? 0.95 : 0.72);
    const depth = o.depth ?? (m <= 64 ? 40 : 48), lim = o.lim ?? (m <= 64 ? 30 : 38);
    return { r, B, Hh, depth, lim, S: Math.ceil(lim * 2.2) };
  }
  /** (0060) A shape morphed by hand (a drop that spreads into a sheet): the bevel follows the size smoothly,
   *  so a drop is a lens all through and a sheet is flat in the middle, with no step in how much it bends.
   *  Whole pixels, so the tiles of a growing drop are drawn once and kept. */
  function morphParams(rec, w, h) {
    const m = Math.max(2, Math.round(Math.min(w, h))), r = Math.min(rec.m.r, m / 2), B = clamp(Math.round(m * 0.42), 3, 20);
    return { r: Math.round(r * 2) / 2, B, Hh: B * 0.85, depth: 44, lim: 34, S: Math.ceil(34 * 2.2) };
  }

  function build(rec) {
    const o = rec.o, f = mk("filter", { id: rec.id, x: "0", y: "0", width: "1", height: "1", filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
    const flood = mk("feFlood", { "flood-color": "#808000", result: "m0" });
    const imgs = TILES.map((k) => mk("feImage", { preserveAspectRatio: "none", result: `m${k}` }));
    const merge = mk("feMerge", { result: "map" }, [mk("feMergeNode", { in: "m0" }), ...TILES.map((k) => mk("feMergeNode", { in: `m${k}` }))]);
    const disp = (res) => mk("feDisplacementMap", { in: "SourceGraphic", in2: "map", xChannelSelector: "R", yChannelSelector: "G", result: res });
    const dr = disp("dr"), dg = disp("dg"), db = disp("db");
    const cr = mk("feColorMatrix", { in: "dr", type: "matrix", result: "cr", values: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" });
    const cg = mk("feColorMatrix", { in: "dg", type: "matrix", result: "cg", values: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" });
    const cb = mk("feColorMatrix", { in: "db", type: "matrix", result: "cb", values: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" });
    // (no feComposite "arithmetic" anywhere: in Chromium's backdrop filters it comes out half transparent,
    // and a displacement map made by it is ignored. Screen adds disjoint channels; merges do the rest.)
    const add1 = mk("feBlend", { in: "cr", in2: "cg", mode: "screen", result: "crg" });
    const add2 = mk("feBlend", { in: "crg", in2: "cb", mode: "screen", result: "refr" });
    // frost: a blur of what is under it laid over it, thinning toward the rim (the map's blue), where the
    // bending stays sharp
    const blur = mk("feGaussianBlur", { in: "refr", stdDeviation: String(o.blur ?? 2), edgeMode: "duplicate", result: "soft" });
    const m = o.frost ?? 0.5;
    const fa = mk("feFuncA", { type: "linear", slope: String(m), intercept: "0" });
    const softA = mk("feComponentTransfer", { in: "soft", result: "softA" }, [fa]);
    const fro = mk("feMerge", { result: "frosted" }, [mk("feMergeNode", { in: "refr" }), mk("feMergeNode", { in: "softA" })]);
    const rimA = mk("feColorMatrix", { in: "map", type: "matrix", result: "rimA", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0" });
    const rimP = mk("feComposite", { in: "refr", in2: "rimA", operator: "in", result: "rimP" });
    const mix = mk("feMerge", { result: "mix" }, [mk("feMergeNode", { in: "frosted" }), mk("feMergeNode", { in: "rimP" })]);
    const sat = mk("feColorMatrix", { in: "mix", type: "saturate", values: String(o.saturate ?? 1.35), result: "sat" });
    const a = 1 - (o.dim ?? 0.2), b = o.lift ?? 0.02;
    const tone = mk("feComponentTransfer", { in: "sat", result: "out" }, ["R", "G", "B"].map((ch) => mk(`feFunc${ch}`, { type: "linear", slope: String(a), intercept: String(b) })));
    f.append(flood, ...imgs, merge, dr, dg, db, cr, cg, cb, add1, add2, blur, softA, fro, rimA, rimP, mix, sat, tone);
    svg.append(f);
    Object.assign(rec, { f, imgs, disp: [dr, dg, db], tone, blurEl: blur, frostA: fa });
  }

  function ensureSvg() {
    if (svg) return;
    svg = mk("svg", { width: "0", height: "0", "aria-hidden": "true", focusable: "false" });
    svg.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none";
    document.body.append(svg);
    ro = new ResizeObserver((es) => { for (const e of es) update(e.target); });
  }

  /** Make `node` Liquid Glass. o: radius ("capsule" or px; default: its border radius), bevel, height,
   *  depth, lim (px), blur (px), frost (the blurred share, 0..1), dim (0..1), lift, saturate. */
  function attach(node, o = {}) {
    if (!node) return;
    let rec = items.get(node);
    if (rec) { Object.assign(rec.o, o); rec.key = ""; if (rec.f) retune(rec); update(node); return; }
    node.classList.add("lg");
    rec = { el: node, o: { ...o }, id: `lg${++n}`, w: -1, h: -1, key: "" };
    items.set(node, rec);
    if (!ok) { node.classList.add("lg-frost"); return; }
    ensureSvg(); build(rec);
    node.style.setProperty("backdrop-filter", `url(#${rec.id})`);
    ro.observe(node);
    update(node);
  }
  function retune(rec) {
    const o = rec.o, m = o.frost ?? 0.5, a = 1 - (o.dim ?? 0.2), b = o.lift ?? 0.02;
    rec.blurEl.setAttribute("stdDeviation", String(o.blur ?? 2));
    rec.frostA.setAttribute("slope", String(m));
    for (const fn of rec.tone.children) { fn.setAttribute("slope", String(a)); fn.setAttribute("intercept", String(b)); }
  }
  function detach(node) {
    const rec = items.get(node); if (!rec) return;
    items.delete(node); node.classList.remove("lg", "lg-frost"); node.style.removeProperty("backdrop-filter");
    ro?.unobserve(node); rec.f?.remove();
  }
  const place = (imgs, c, x0, y0, w, h) => { // (displacement maps cannot come out of feComposite in Chromium: the tiles are merged)
    const mw = Math.max(0, w - 2 * c), mh = Math.max(0, h - 2 * c);
    const at = { tl: [0, 0, c, c], t: [c, 0, mw, c], tr: [w - c, 0, c, c], l: [0, c, c, mh], r: [w - c, c, c, mh], bl: [0, h - c, c, c], b: [c, h - c, mw, c], br: [w - c, h - c, c, c] };
    imgs.forEach((im, i) => {
      const [x, y, iw, ih] = at[TILES[i]];
      im.setAttribute("x", (x0 + x).toFixed(2)); im.setAttribute("y", (y0 + y).toFixed(2));
      im.setAttribute("width", Math.max(0.001, iw).toFixed(2)); im.setAttribute("height", Math.max(0.001, ih).toFixed(2));
    });
  };
  /** Fit the filter to the element's size now (a ResizeObserver does it too; call it inside animations). */
  function update(node, size) {
    const rec = items.get(node); if (!rec || !rec.f) return;
    const w = size?.w ?? node.offsetWidth, h = size?.h ?? node.offsetHeight;
    if (w < 2 || h < 2) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const P = rec.m ? morphParams(rec, w, h) : params(rec, w, h), key = `${P.r}|${P.B}|${P.Hh}|${P.depth}|${P.lim}|${dpr}`;
    if (key !== rec.key) {
      const t = tileSet(P.r, P.B, P.Hh, P.depth, P.lim, P.S, dpr);
      rec.imgs.forEach((im, i) => im.setAttribute("href", t[TILES[i]]));
      rec.disp[0].setAttribute("scale", String(P.S * 0.92)); rec.disp[1].setAttribute("scale", String(P.S)); rec.disp[2].setAttribute("scale", String(P.S * 1.09));
      rec.key = key; rec.c = t.c; rec.S = P.S; rec.w = -1;
    }
    if (Math.abs(w - rec.w) >= 0.25 || Math.abs(h - rec.h) >= 0.25) {
      rec.w = w; rec.h = h;
      place(rec.imgs, Math.min(rec.c, w / 2, h / 2), 0, 0, w, h);
      rec.f.setAttribute("width", w); rec.f.setAttribute("height", h);
    }
  }
  /** (0060) Animate a piece of glass by hand, every frame: its size (w, h), its corner radius (r), and its
   *  look (blur, frost, dim, lift), all at once. */
  function morph(node, s) {
    const rec = items.get(node); if (!rec) return;
    rec.m = { r: s.r };
    Object.assign(rec.o, { blur: s.blur, frost: s.frost, dim: s.dim, lift: s.lift });
    if (!rec.f) return;
    const k = `${s.blur.toFixed(2)}|${s.frost.toFixed(3)}|${s.dim.toFixed(3)}|${s.lift.toFixed(3)}`;
    if (k !== rec.tk) { rec.tk = k; retune(rec); }
    update(node, { w: s.w, h: s.h });
  }
  /** Draw a growing drop's tiles ahead of time, when the page is idle (the first menu opens without a hitch). */
  function warm(r = 22, from = 6, to = 48) {
    if (!ok) return;
    const dpr = Math.min(2, devicePixelRatio || 1), fake = { m: { r } };
    let m = from;
    const next = (dl) => {
      while (m <= to && (!dl || dl.timeRemaining() > 4)) { const P = morphParams(fake, m, m); tileSet(P.r, P.B, P.Hh, P.depth, P.lim, P.S, dpr); m++; }
      if (m <= to) (window.requestIdleCallback ?? ((f) => setTimeout(f, 60)))(next);
    };
    (window.requestIdleCallback ?? ((f) => setTimeout(f, 60)))(next);
  }
  // Light: the key light swings slowly (±20°), so the rim's highlight travels around every silhouette;
  // the pointer is a second light, a glint on the rim nearest to it.
  let px = -1e4, py = -1e4, raf = 0;
  function lightFrame(t) {
    raf = 0;
    const ang = `${(135 + Math.sin((t / 1000) * 0.09) * 20).toFixed(1)}deg`; // (set on each piece of glass, not on the root: that would restyle the whole page)
    for (const rec of items.values()) {
      if (rec.ang !== ang) { rec.el.style.setProperty("--lg-a", ang); rec.ang = ang; }
      const r = rec.el.getBoundingClientRect(); if (!r.width) continue;
      const dx = Math.max(r.left - px, 0, px - r.right), dy = Math.max(r.top - py, 0, py - r.bottom), g = Math.max(0, 1 - Math.hypot(dx, dy) / 160);
      if (g === 0 && rec.g === 0) continue;
      rec.g = g;
      rec.el.style.setProperty("--lg-px", `${(px - r.left).toFixed(1)}px`); rec.el.style.setProperty("--lg-py", `${(py - r.top).toFixed(1)}px`);
      rec.el.style.setProperty("--lg-g", g.toFixed(3));
    }
  }
  function light(x, y) { px = x; py = y; if (!raf) raf = requestAnimationFrame(lightFrame); }
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") light(e.clientX, e.clientY); }, { passive: true });
  addEventListener("pointerleave", () => light(-1e4, -1e4), { passive: true });
  setInterval(() => { if (!raf && !document.hidden) raf = requestAnimationFrame(lightFrame); }, 400);

  return { ok, attach, detach, update, light, morph, warm, get chromium() { return chromium; } };
})();
