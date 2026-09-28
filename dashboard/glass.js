/* Lancea Watch: the sky and its glass, in WebGL2.
 *
 * Pass 1 renders the sky into a texture with mipmaps: a two-lobed nebula (cyan left, amber right),
 * three layers of stars, a few with JWST spikes, the white star where the lights meet, and what
 * happens up there (meteors, a satellite, a pulsar, a far galaxy, and a star for every decision).
 * Pass 2 draws clear Liquid Glass wherever the page marks a pane, a bar or the budget ring: a squircle
 * bevel, refraction per colour channel (IOR 1.44 / 1.50 / 1.57), weak Fresnel, a rim lit by a light
 * that moves and by the pointer, a hairline, and a soft shadow seen through the glass as well.
 *
 * Two layers of glass, never glass on glass: the page's glass (panes, bars, the ring) and, above it,
 * the overlay (the decision sheet, menus, toasts), which casts its shadow on the page and is never
 * merged with it. Glass appears by gaining its lensing, never by fading (Apple's materialize), and
 * moves like a liquid: every shape in flight is a rectangle on four springs (the edge that leads is
 * stiffer than the one that trails, so it stretches as it travels and settles with a little bounce),
 * and shapes in flight blend with each other the way a GlassEffectContainer blends glass within its
 * spacing (a smooth minimum, Apple's neck). Springs are SwiftUI's: Spring(duration:bounce:).
 * The recipe is the one proven on the DELICTI hero (claude/45); here it runs live.
 */
const Glass = (() => {
  const MAXB = 28, MAXL = 6, MAXO = 6, MAXD = 8;
  const mq = (q) => { try { return matchMedia(q); } catch { return { matches: false, addEventListener() {} }; } };
  const motionQ = mq("(prefers-reduced-motion: reduce)"), transQ = mq("(prefers-reduced-transparency: reduce)");
  const fineQ = mq("(hover: hover) and (pointer: fine)");

  // SwiftUI's Spring(duration:bounce:) as the stiffness and damping of a unit mass:
  // k = (2π / duration)², c = 4π (1 − bounce) / duration
  const spr = (duration, bounce = 0) => ({ k: (2 * Math.PI / duration) ** 2, c: (4 * Math.PI * (1 - bounce)) / duration });
  const SP = {
    lens: spr(0.52, 0.14), fast: spr(0.2, 0), press: spr(0.28, 0.12), release: spr(0.5, 0.42),
    fill: spr(0.8, 0.16), focus: spr(0.66, 0), layout: spr(0.42, 0.1), radius: spr(0.5, 0),
    flowLead: spr(0.52, 0.12), flowTrail: spr(0.7, 0.12),
    sheetLead: spr(0.46, 0.2), sheetTrail: spr(0.62, 0.2), shrink: spr(0.42, 0), grow: spr(0.46, 0),
    lensLead: spr(0.34, 0.14), lensTrail: spr(0.54, 0.14), lift: spr(0.32, 0.24),
    hoverLead: spr(0.24, 0.1), hoverTrail: spr(0.36, 0.1), hoverIn: spr(0.3, 0),
    drop: spr(0.39, 0.25), sat1: spr(0.3, 0.3), sat2: spr(0.38, 0.28),
    jelly: spr(0.34, 0.52), pop: spr(0.4, 0.34), evaporate: spr(1.1, 0),
  };
  const spring = (o, key, vkey, target, s, dt) => {
    for (let t = dt; t > 1e-6; t -= 0.016) { const h = Math.min(0.016, t), f = -s.k * (o[key] - target) - s.c * o[vkey]; o[vkey] += f * h; o[key] += o[vkey] * h; }
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const box = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
  const plain = (r) => box(r.left, r.top, r.right, r.bottom);
  const around = (x, y, w, h = w) => box(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
  const mid = (r) => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
  const scaled = (r, k) => { const [x, y] = mid(r); return around(x, y, (r.right - r.left) * k, (r.bottom - r.top) * k); };
  const rdist = (a, b) => Math.max(Math.abs(a.left - b.left), Math.abs(a.right - b.right), Math.abs(a.top - b.top), Math.abs(a.bottom - b.bottom));
  const radiusOf = (el) => { try { return parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0; } catch { return 0; } };

  /** A rectangle of liquid: four edges on springs. The edge that leads the motion is stiffer than the
   *  one that trails, so the shape stretches along its path and bunches up, with a bounce, on arrival. */
  class Liquid {
    constructor(r, q = 0) { this.set(r, q); }
    set(r, q = this.q ?? 0) { this.l = r.left; this.r = r.right; this.t = r.top; this.b = r.bottom; this.q = q; this.vl = this.vr = this.vt = this.vb = this.vq = 0; return this; }
    step(g, gq, dt, lead, trail) {
      const dx = (g.left + g.right - this.l - this.r) / 2, dy = (g.top + g.bottom - this.t - this.b) / 2;
      const kx = Math.abs(dx) < 1 ? [lead, lead] : dx > 0 ? [trail, lead] : [lead, trail];
      const ky = Math.abs(dy) < 1 ? [lead, lead] : dy > 0 ? [trail, lead] : [lead, trail];
      spring(this, "l", "vl", g.left, kx[0], dt); spring(this, "r", "vr", g.right, kx[1], dt);
      spring(this, "t", "vt", g.top, ky[0], dt); spring(this, "b", "vb", g.bottom, ky[1], dt);
      if (gq != null) spring(this, "q", "vq", gq, SP.radius, dt);
      if (this.r < this.l + 1) { const m = (this.l + this.r) / 2; this.l = m - 0.5; this.r = m + 0.5; }
      if (this.b < this.t + 1) { const m = (this.t + this.b) / 2; this.t = m - 0.5; this.b = m + 0.5; }
    }
    get rect() { return box(this.l, this.t, this.r, this.b); }
    speed() { return Math.max(Math.abs(this.vl), Math.abs(this.vr), Math.abs(this.vt), Math.abs(this.vb)); }
    dist(g) { return rdist(this, { left: g.left, right: g.right, top: g.top, bottom: g.bottom }); }
  }
  // (Liquid keeps l/r/t/b; rdist reads left/right/top/bottom)
  Object.defineProperties(Liquid.prototype, {
    left: { get() { return this.l; } }, right: { get() { return this.r; } },
    top: { get() { return this.t; } }, bottom: { get() { return this.b; } },
  });

  const S = {
    ok: false, gl: null, cv: null, W: 0, H: 0, PX: 1, scale: 1,
    reduced: motionQ.matches, solid: transQ.matches,
    t0: performance.now(), now: 0, dt: 0.016, last: 0, frame: 0, fade: 0,
    shapes: [], blobs: [], overs: [], lenses: [], drops: [], bursts: [], labels: [],
    marks: [], path: [], hover: -1, gk: 0, okk: 0, touch: null, flowId: 0, scroller: null,
    hoverEl: null, hoverOpt: null,
    focus: { x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, init: false },
    cursor: {
      x: -1e4, y: -1e4, px: -1e4, py: -1e4, vx: 0, vy: 0, on: 0, von: 0, onT: 0, glass: 0, moved: -99, down: 0,
      press: 0, vpress: 0, st: 0, vst: 0, ax: 1, ay: 0, fine: fineQ.matches,
      sat: [{ x: -1e4, y: -1e4, vx: 0, vy: 0 }, { x: -1e4, y: -1e4, vx: 0, vy: 0 }],
    },
    scroll: { y: 0, py: 0, top: 0, bottom: 0, fade: 26 },
    light: 0, stats: { frames: 0, ms: 0 }, slowFrames: 0,
    meteors: [{ t0: -99, dur: 1, a: [0, 0], b: [0, 0] }, { t0: -99, dur: 1, a: [0, 0], b: [0, 0] }], nextMeteor: 4,
    sat: { t0: -999, dur: 60, a: [0, 0], b: [0, 0], flare: 0.5 }, nextSat: 18,
  };

  // ─── Shaders ──────────────────────────────────────────────────────────────
  const VS_FULL = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
void main() { gl_Position = vec4(P[gl_VertexID], 0., 1.); }`;

  const NOISE = `
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = dot(hash22(i) * 2. - 1., f), b = dot(hash22(i + vec2(1, 0)) * 2. - 1., f - vec2(1, 0));
  float c = dot(hash22(i + vec2(0, 1)) * 2. - 1., f - vec2(0, 1)), d = dot(hash22(i + vec2(1, 1)) * 2. - 1., f - vec2(1, 1));
  return a + u.x * (b - a) + u.y * (c - a) + u.x * u.y * (a - b - c + d);
}
float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * gnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3; a *= .5; } return s; }`;

  // The nebula, at half resolution: domain-warped fbm lit by two Gaussian lobes, filaments, dust lanes.
  const FS_NEBULA = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uT; uniform vec2 uA, uB, uRA, uRB, uF;
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbmv(vec2 p) { float a = .5, s = 0.; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p + vec2(1.7, 9.2); a *= .5; } return s; }
void main() {
  // the DELICTI hero's nebula (assets/hero in dziuba0x/delicti), in units of a 440-tall design
  vec2 q = vec2(gl_FragCoord.x - .5 * uRes.x, .5 * uRes.y - gl_FragCoord.y) / uRes.y;
  vec2 P = (q - uF * .85) * 440.;
  vec2 L = vec2(cos(uT), sin(uT)) * .9;
  vec2 w = vec2(fbmv(P * .0042 + .3 * L), fbmv(P * .0042 + vec2(5.2, 1.3) - .3 * L.yx));
  float n = fbmv(P * .0048 + 2.3 * w + .12 * L);
  float dust = fbmv(P * .009 + vec2(3.1, 7.7) + .22 * L + 1.3 * w);
  vec2 da = (q - uA) / uRA, db = (q - uB) / uRB;
  float lc = exp(-dot(da, da)), la = exp(-dot(db, db));
  float dens = smoothstep(.28, .95, n), fil = pow(dens, 1.7);
  vec3 CY = vec3(.031, .63, 1.), AM = vec3(1., .432, .059);
  vec3 neb = CY * lc * (.04 + 1.6 * fil) + AM * la * (.04 + 1.6 * fil);
  neb *= .3 + .95 * smoothstep(.3, .8, dust);
  vec2 fq = q - uF;
  neb += vec3(.84, .79, 1.) * exp(-dot(fq, fq) / (2. * .06 * .06)) * (.02 + .08 * dens);
  vec3 base = vec3(.00006, .00009, .0003) + vec3(.00045, .0006, .0021) * exp(-dot(fq, fq) / (2. * .95 * .95));
  o = vec4(neb + base, max(lc, la) * fil);
}`;

  // The sky, composed at full resolution: nebula, the white star, far galaxy, meteors, satellite,
  // bursts, vignette, tone map, gamma; then the labels printed on the plane.
  const FS_SKY = `#version 300 es
precision highp float;
uniform sampler2D uNeb, uLab;
uniform vec2 uRes; uniform float uPx, uTime, uFade, uGain;
uniform vec2 uFocus; uniform float uFocusOn;
uniform vec4 uGal;
uniform vec4 uMet[2]; uniform vec2 uMetT[2];
uniform vec4 uSat; uniform vec3 uSatT;
uniform vec4 uBurst[6];
uniform vec4 uMeet; uniform vec4 uMeetA; uniform float uDim;
uniform vec4 uLabR[6]; uniform vec4 uLabC[6]; uniform float uLabR2[6]; uniform int uNL;
out vec4 o;
${NOISE}
float seg(vec2 p, vec2 a, vec2 b, out float h) { vec2 pa = p - a, ba = b - a; h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uNeb, uv).rgb * uGain;
  c *= .86 + .28 * smoothstep(-.35, .35, gnoise(p / uPx * .05) + .5 * gnoise(p / uPx * .13));
  c += vec3(.00006, .0001, .00045);
  // the white star where the two lights meet: small and crisp, never a pale core
  vec2 f = (p - uFocus) / uPx; float fr = length(f);
  float st = exp(-fr * fr / 1.2) * 3.2 + exp(-fr / 3.2) * .22 + exp(-fr / 22.) * .03;
  st += (exp(-f.y * f.y / .3) * exp(-abs(f.x) / 11.) + exp(-f.x * f.x / .3) * exp(-abs(f.y) / 11.)) * .7;
  c += vec3(1.) * st * uFocusOn;
  // a far spiral galaxy, turning very slowly
  vec2 g = p - uGal.xy; float ca = cos(uGal.w), sa = sin(uGal.w);
  g = mat2(ca, -sa, sa, ca) * g; g.y /= .42; float gr = length(g) / uGal.z, gt = atan(g.y, g.x);
  float arms = pow(.5 + .5 * cos(2. * gt - 6.2 * log(gr + .06) - uTime * .012), 2.6);
  float gal = exp(-gr * 3.6) * (.18 + .82 * arms) * exp(-gr * gr * 1.4) * .05 + exp(-gr * gr * 90.) * .16;
  c += mix(vec3(.65, .78, 1.), vec3(1., .86, .7), exp(-gr * 5.)) * gal;
  // meteors
  for (int i = 0; i < 2; i++) {
    float t = (uTime - uMetT[i].x) / uMetT[i].y; if (t < 0. || t > 1.) continue;
    vec2 a = uMet[i].xy, b = uMet[i].zw; float e = 1. - (1. - t) * (1. - t);
    vec2 head = mix(a, b, e), dir = normalize(b - a); vec2 tail = head - dir * length(b - a) * (.34 - .12 * t);
    float h; float d = seg(p, tail, head, h) / uPx;
    float I = exp(-d * d / .7) * pow(h, 2.4) * sin(3.14159 * t) * 1.6 + exp(-length(p - head) / uPx / 2.) * sin(3.14159 * t) * .4;
    c += (i == 0 ? vec3(.78, .92, 1.) : vec3(1., .9, .78)) * I;
  }
  // a satellite crossing, with one glint of sunlight off its panels
  float sT = (uTime - uSatT.x) / uSatT.y;
  if (sT > 0. && sT < 1.) {
    vec2 sp = mix(uSat.xy, uSat.zw, sT); float sr = length(p - sp) / uPx;
    float fl = 1. + 22. * exp(-pow((sT - uSatT.z) * uSatT.y * 1.6, 2.));
    c += vec3(1., .97, .92) * exp(-sr * sr / .5) * .09 * fl * smoothstep(0., .03, sT) * smoothstep(1., .97, sT);
  }
  // births (white) and strikes (coral)
  for (int i = 0; i < 6; i++) {
    float dt = uTime - uBurst[i].z; if (dt < 0. || dt > 3.) continue;
    float r = length(p - uBurst[i].xy) / uPx;
    float ring = exp(-pow(r - dt * 46., 2.) / 5.) * exp(-dt * 1.5) * .6;
    float flash = exp(-r * r / (8. + dt * 60.)) * exp(-dt * 2.4) * 2.4;
    c += (uBurst[i].w > .5 ? vec3(1., .42, .42) : vec3(1.)) * (ring + flash);
  }
  float mt = (uTime - uMeet.x) / 1.3;
  if (mt > 0. && mt < 1.) {
    float e = mt * mt * (3. - 2. * mt);
    vec2 ca = mix(uMeetA.xy, uFocus, e), cb = mix(uMeetA.zw, uFocus, e);
    float fa = exp(-dot(p - ca, p - ca) / pow(15. * uPx, 2.)), fb = exp(-dot(p - cb, p - cb) / pow(15. * uPx, 2.));
    float env = sin(3.14159 * mt);
    c += (vec3(.03, .63, 1.) * fa + vec3(1., .43, .06) * fb) * env * 1.6;
    c += vec3(1.) * exp(-length(p - uFocus) / uPx / 6.) * smoothstep(.8, 1., mt) * 2.5;
  }
  vec2 v = (uv - .5) * vec2(uRes.x / uRes.y, 1.);
  c *= mix(.5, 1., smoothstep(1.1, .2, length(v)));
  c *= uDim;
  c *= uFade;
  c = 1. - exp(-1.25 * c);
  c = pow(max(c, 0.), vec3(1. / 2.2));
  for (int i = 0; i < 6; i++) {
    if (i >= uNL) break;
    vec4 r = uLabR[i]; vec2 lp = (p - r.xy) / r.zw;
    if (lp.x < 0. || lp.y < 0. || lp.x > 1. || lp.y > 1.) continue;
    float a = texture(uLab, vec2(lp.x * uLabC[i].w, (uLabR2[i] + lp.y) / 6.)).a;
    c += uLabC[i].rgb * a * uFade;
  }
  o = vec4(c, 1.);
}`;

  // Stars as points: three layers, integer-frequency twinkle, a few JWST six-point spikes, a pulsar.
  const VS_STARS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aLook;
layout(location = 2) in vec3 aCol;
uniform vec2 uRes; uniform float uPx, uTime, uFade, uTw; uniform vec2 uPar; uniform sampler2D uNeb;
out vec3 vCol; out float vB; out float vKind; out float vSize;
void main() {
  float mag = aLook.x, layer = aLook.y, kind = aLook.z, ph = aLook.w;
  float lf = layer < .5 ? .25 : layer < 1.5 ? .55 : 1.;
  vec2 pos = (aPos * 1.08 - .04) * uRes + uPar * lf;
  float fq = floor(1. + ph * 4.);
  float tw = 1. + uTw * (.1 + .22 * layer) * sin(6.2831853 * (fq * uTime / 10. + ph * 7.));
  float b = mag * tw;
  if (kind > 1.5) b *= .3 + 1.4 * pow(.5 + .5 * sin(6.2831853 * uTime / 1.3373), 18.);
  b *= smoothstep(ph * .8, ph * .8 + .4, uFade * 1.25);
  float neb = textureLod(uNeb, vec2(pos.x / uRes.x, 1. - pos.y / uRes.y), 0.).a;
  if (layer < 1.5) b *= 1. - .55 * smoothstep(.2, 1., neb);
  vB = b; vCol = aCol; vKind = kind;
  float size = (kind > .5 && kind < 1.5) ? 60. : (2.6 + 4.2 * mag * mag + layer * 1.3);
  vSize = size * uPx; gl_PointSize = vSize;
  gl_Position = vec4(pos.x / uRes.x * 2. - 1., 1. - pos.y / uRes.y * 2., 0., 1.);
}`;
  const FS_STARS = `#version 300 es
precision highp float;
in vec3 vCol; in float vB; in float vKind; in float vSize;
uniform float uPx;
out vec4 o;
void main() {
  vec2 c = (gl_PointCoord - .5) * vSize / uPx; float r = length(c);
  float s = exp(-r * r / .45) * 1.2 + exp(-r / 1.) * .1;
  if (vKind > .5 && vKind < 1.5) {
    float L = 21., sp = 0.;
    vec2 d1 = vec2(0., 1.), d2 = vec2(.8660254, .5), d3 = vec2(.8660254, -.5);
    sp += exp(-pow(dot(c, vec2(d1.y, -d1.x)), 2.) / .16) * exp(-abs(dot(c, d1)) / L);
    sp += exp(-pow(dot(c, vec2(d2.y, -d2.x)), 2.) / .16) * exp(-abs(dot(c, d2)) / (L * .85));
    sp += exp(-pow(dot(c, vec2(d3.y, -d3.x)), 2.) / .16) * exp(-abs(dot(c, d3)) / (L * .85));
    sp += exp(-c.y * c.y / .1) * exp(-abs(c.x) / 6.) * .5;
    s += sp * .6 + exp(-r / 3.5) * .12;
  }
  float edge = vSize / uPx * .5;
  s *= smoothstep(edge, edge - 3., r);
  o = vec4(vCol * s * vB, 1.);
}`;

  // Decisions as stars: our white four-point star for a co-signature; coral for a refusal or strike.
  const VS_MARKS = `#version 300 es
layout(location = 0) in vec2 aPx;
layout(location = 1) in vec4 aM;
uniform vec2 uRes; uniform float uPx, uTime; uniform float uHover;
out float vKind; out float vAge; out float vSize; out float vNew; out float vHot;
void main() {
  vKind = aM.x; vAge = uTime - aM.y; vNew = aM.w;
  vHot = abs(float(gl_VertexID) - uHover) < .5 ? 1. : 0.;
  float grow = 1. + 1.1 * exp(-max(vAge, 0.) * 2.2) + vHot * .5;
  vSize = aM.z * uPx * 3. * grow; gl_PointSize = vSize;
  gl_Position = vec4(aPx.x / uRes.x * 2. - 1., 1. - aPx.y / uRes.y * 2., 0., 1.);
}`;
  const FS_MARKS = `#version 300 es
precision highp float;
in float vKind; in float vAge; in float vSize; in float vNew; in float vHot;
uniform float uPx, uTime, uFade;
out vec4 o;
void main() {
  vec2 c = (gl_PointCoord - .5) * vSize / uPx; float r = length(c);
  float L = vSize / uPx * .12;
  vec3 col; float s;
  if (vKind < .5) {
    s = exp(-r * r / .8) * 1.3 + (exp(-c.y * c.y / .2) * exp(-abs(c.x) / L) + exp(-c.x * c.x / .2) * exp(-abs(c.y) / L)) * .95 + exp(-r / 2.6) * .14;
    col = vec3(1.);
  } else {
    s = exp(-r * r / 1.1) * 1.1 + (vKind > 1.5 ? exp(-pow(r - L * 1.6, 2.) / .7) * .7 : 0.);
    col = vec3(1., .42, .42);
  }
  float pulse = vNew > .5 ? 1.05 + .25 * sin(uTime * 2.2) : .95;
  s *= pulse * (1. + vHot * .6) * smoothstep(0., .4, vAge) * uFade;
  s *= smoothstep(vSize / uPx * .5, vSize / uPx * .5 - 2., r);
  o = vec4(col * s, 1.);
}`;
  const VS_PATH = `#version 300 es
layout(location = 0) in vec2 aPx;
uniform vec2 uRes;
void main() { gl_Position = vec4(aPx.x / uRes.x * 2. - 1., 1. - aPx.y / uRes.y * 2., 0., 1.); }`;
  const FS_PATH = `#version 300 es
precision highp float;
uniform float uA;
out vec4 o;
void main() { o = vec4(vec3(uA), 1.); }`;

  // The glass. Two layers: the page's glass, and the overlay above it (a sheet, a menu, a toast).
  const FS_GLASS = `#version 300 es
precision highp float;
uniform sampler2D uSky;
uniform vec2 uRes; uniform float uPx, uTime, uSolid;
uniform int uN; uniform vec4 uA[${MAXB}]; uniform vec4 uB[${MAXB}]; uniform vec4 uC[${MAXB}];
uniform float uGK;
uniform int uNL; uniform vec4 uLA[${MAXL}]; uniform vec4 uLB[${MAXL}]; uniform float uLL[${MAXL}];
uniform int uNO; uniform vec4 uOA[${MAXO}]; uniform vec4 uOB[${MAXO}]; uniform float uOK;
uniform int uND; uniform vec4 uD[${MAXD}]; uniform vec4 uDE[${MAXD}];
uniform vec4 uCur;
uniform vec4 uTouch;
uniform vec2 uLight;
uniform vec4 uEdge;
out vec4 o;

vec3 sdRR(vec2 p, vec4 a, float r) {
  vec2 q = p - a.xy; vec2 s = vec2(q.x < 0. ? -1. : 1., q.y < 0. ? -1. : 1.); q = abs(q) - a.zw + r;
  vec2 m = max(q, 0.); float lm = length(m);
  float d = lm + min(max(q.x, q.y), 0.) - r;
  vec2 g = (q.x > 0. && q.y > 0.) ? m / lm : (q.x > q.y ? vec2(1., 0.) : vec2(0., 1.));
  return vec3(d, g * s);
}
vec3 sdRing(vec2 p, vec2 c, float R, float w) { vec2 q = p - c; float l = max(length(q), 1e-3); float s = l < R ? -1. : 1.; return vec3(abs(l - R) - w, q / l * s); }
// a drop stretched along its motion: an ellipse (axis e.zw, stretch e.x along it, e.y across)
vec3 sdDrop(vec2 p, vec4 d, vec4 e) {
  vec2 q = p - d.xy, ax = e.zw, ay = vec2(-e.w, e.z);
  vec2 l = vec2(dot(q, ax) / e.x, dot(q, ay) / e.y);
  float len = max(length(l), 1e-3); vec2 nl = l / len;
  vec2 g = ax * (nl.x / e.x) + ay * (nl.y / e.y);
  return vec3((len - d.z) * min(e.x, e.y), g / max(length(g), 1e-4));
}
vec3 smin3(vec3 a, vec3 b, float k) {
  if (k < .01) return a.x < b.x ? a : b;
  float h = clamp(.5 + .5 * (b.x - a.x) / k, 0., 1.);
  return vec3(mix(b.x, a.x, h) - k * h * (1. - h), mix(b.yz, a.yz, h));
}
float edgeVis(vec2 p) { return smoothstep(uEdge.x, uEdge.x + uEdge.z, p.y) * (1. - smoothstep(uEdge.y - uEdge.z, uEdge.y, p.y)); }
bool scrolls(int i) { return (int(uC[i].w + .5) & 1) != 0; }
bool grouped(int i) { return (int(uC[i].w + .5) & 2) != 0; }
vec3 shapeD(int i, vec2 p) {
  if (abs(uB[i].y - 2.) < .5) return sdRing(p, uA[i].xy, uA[i].z, uC[i].y);
  return sdRR(p, uA[i], uB[i].x);
}
// the page's glass: panes in flight blend with each other (a GlassEffectContainer and its spacing),
// the rest stay separate, and drops merge with whatever glass they meet
vec3 sceneBase(vec2 p, out int idx, out float dm) {
  vec3 best = vec3(1e5, 0., 1.), grp = vec3(1e5, 0., 1.); idx = -1; dm = 0.;
  int gi = -1; float gd = 1e5;
  for (int i = 0; i < ${MAXB}; i++) {
    if (i >= uN) break;
    vec3 d = shapeD(i, p);
    if (grouped(i)) { if (d.x < gd) { gd = d.x; gi = i; } grp = grp.x > 9e4 ? d : smin3(grp, d, uGK); }
    else if (d.x < best.x) { best = d; idx = i; }
  }
  if (gi >= 0 && grp.x < best.x) { best = grp; idx = gi; }
  for (int j = 0; j < ${MAXD}; j++) {
    if (j >= uND) break;
    if (uD[j].z < .5) continue;
    vec3 dd = sdDrop(p, uD[j], uDE[j]);
    float k = (idx >= 0 ? 16. : 24.) * uPx;
    float h = clamp(.5 + .5 * (dd.x - best.x) / k, 0., 1.);
    best = smin3(best, dd, k);
    dm = max(dm * h, 1. - h);
  }
  return best;
}
float shadowBase(vec2 p) {
  float best = 1e5;
  for (int i = 0; i < ${MAXB}; i++) {
    if (i >= uN) break;
    float l = uB[i].z * (scrolls(i) ? edgeVis(p) : 1.);
    if (l < .003) continue;
    best = min(best, shapeD(i, p).x + (1. - l) * 40. * uPx);
  }
  for (int j = 0; j < ${MAXD}; j++) { if (j >= uND) break; best = min(best, sdDrop(p, uD[j], uDE[j]).x); }
  return best;
}
// the overlay: its shapes blend only with each other (a sheet and the drop it was pulled from)
vec3 sceneOver(vec2 p, out int idx) {
  vec3 best = vec3(1e5, 0., 1.); idx = -1; float bd = 1e5;
  for (int i = 0; i < ${MAXO}; i++) {
    if (i >= uNO) break;
    vec3 d = sdRR(p, uOA[i], uOB[i].x);
    if (d.x < bd) { bd = d.x; idx = i; }
    best = best.x > 9e4 ? d : smin3(best, d, uOK);
  }
  return best;
}
float shadowOver(vec2 p) {
  float best = 1e5;
  for (int i = 0; i < ${MAXO}; i++) { if (i >= uNO) break; best = min(best, sdRR(p, uOA[i], uOB[i].x).x + (1. - uOB[i].z) * 60. * uPx); }
  return best;
}
vec2 toUV(vec2 p) { return vec2(p.x / uRes.x, 1. - p.y / uRes.y); }
vec2 bend(vec3 t, float h, float depth, float lim) { vec2 v = t.xy / max(-t.z, .06) * (h + depth); return v / (1. + length(v) / lim); }

// Liquid Glass, for either layer. kind: 0 pane, 1 bar, 2 ring, 4 sheet, 5 chip; dm: how much of a drop
vec3 glassAt(vec2 p, vec2 uv, vec3 s, float kind, float hh, float tube, float lens, float lift, float dm, float layer, out float x) {
  float B, Hh, lod, mixb, dim, rimk, hairk;
  if (kind < .5)       { B = min(22. * uPx, hh * .92); Hh = 13. * uPx; lod = 3.3; mixb = .86; dim = .26; rimk = .62; hairk = .26; }
  else if (kind < 1.5) { B = min(hh, 17. * uPx); Hh = B * .95; lod = 2.4; mixb = .74; dim = .26; rimk = 1.; hairk = .34; }
  else if (kind < 2.5) { B = tube; Hh = tube * 1.1; lod = 1.1; mixb = .4; dim = .06; rimk = 1.; hairk = .36; }
  else if (kind < 4.5) { B = min(26. * uPx, hh * .92); Hh = 15. * uPx; lod = 4.2; mixb = .93; dim = .5; rimk = .72; hairk = .26; }
  else                 { B = min(hh, 15. * uPx); Hh = B * .9; lod = 2.2; mixb = .66; dim = .22; rimk = .9; hairk = .32; }
  float dr = 13. * uPx;
  B = mix(B, dr, dm); Hh = mix(Hh, dr * .9, dm); lod = mix(lod, .6, dm); mixb = mix(mixb, .2, dm); dim = mix(dim, 0., dm); rimk = mix(rimk, 1., dm); hairk = mix(hairk, .36, dm);
  Hh *= lens * (1. + lift * .45);
  float d = s.x;
  // squircle bevel h = H (1 - (1 - x)^4)^(1/4)
  x = clamp(-d / B, 0., 1.);
  float xm = max(x, .0015), om = 1. - xm, base = max(1. - om * om * om * om, 1e-5);
  float h = Hh * pow(base, .25);
  float dh = -(Hh / B) * om * om * om * pow(base, -.75);
  vec2 grad = normalize(s.yz + 1e-6);
  vec2 gh = dh * grad * step(d, 0.);
  // lenses inside the glass: a selection, and the highlight the pointer's drop turns into
  float fillL = 0.;
  for (int i = 0; i < ${MAXL}; i++) {
    if (i >= uNL) break;
    if (abs(uLL[i] - layer) > .5) continue;
    vec3 di = sdRR(p, uLA[i], uLB[i].x);
    fillL = max(fillL, (1. - smoothstep(-1.5 * uPx, .5 * uPx, di.x)) * uLB[i].y * uLB[i].w);
    if (di.x < 0.) {
      float Bi = min(uLA[i].w * .9, 14. * uPx), xi = clamp(-di.x / Bi, 0., 1.), omi = 1. - max(xi, .0015), bi = max(1. - omi * omi * omi * omi, 1e-5);
      float Hi = uLA[i].w * uLB[i].z * uLB[i].y;
      h += Hi * pow(bi, .25);
      gh += -(Hi / Bi) * omi * omi * omi * pow(bi, -.75) * normalize(di.yz + 1e-6);
    }
  }
  // the pointer presses a shallow dome into the glass beneath it
  if (uCur.z > .001 && abs(kind - 2.) > .5) {
    vec2 cq = p - uCur.xy; float sg = 80. * uPx; float e = exp(-dot(cq, cq) / (2. * sg * sg));
    float Hc = 7. * uPx * uCur.z * smoothstep(0., .25, x);
    h += Hc * e; gh += Hc * e * (-cq / (sg * sg));
  }
  // a finger (or a held click) swells the glass beneath it and lights it from within
  float glow = 0.;
  if (uTouch.z > .001 && abs(uTouch.w - layer) < .5) {
    vec2 tq = p - uTouch.xy; float r2 = dot(tq, tq), sg = 64. * uPx, e = exp(-r2 / (2. * sg * sg));
    float Ht = 11. * uPx * uTouch.z * smoothstep(0., .25, x);
    h += Ht * e; gh += Ht * e * (-tq / (sg * sg));
    glow = exp(-r2 / (2. * pow(120. * uPx, 2.))) * uTouch.z;
  }
  vec3 n = normalize(vec3(-gh, 1.));
  // refraction per channel: dispersion at the rims
  float depth = 46. * uPx, lim = 38. * uPx;
  vec3 V = vec3(0., 0., -1.);
  vec2 oR = bend(refract(V, n, 1. / 1.44), h, depth, lim);
  vec2 oG = bend(refract(V, n, 1. / 1.50), h, depth, lim);
  vec2 oB = bend(refract(V, n, 1. / 1.57), h, depth, lim);
  vec2 uR = toUV(p + oR), uG = toUV(p + oG), uBl = toUV(p + oB);
  vec3 sharp = vec3(texture(uSky, uR).r, texture(uSky, uG).g, texture(uSky, uBl).b);
  vec3 soft = vec3(textureLod(uSky, uR, lod).r, textureLod(uSky, uG, lod).g, textureLod(uSky, uBl, lod).b);
  vec3 col = mix(sharp, soft, mixb * lens);
  // the shadow on the plane, seen through the page's glass
  if (layer < .5) col *= 1. - .3 * (1. - smoothstep(-14. * uPx, 42. * uPx, shadowBase(p + oG - vec2(0., 12. * uPx)))) * lens * .8;
  // the dimming layer for clear glass under text (HIG: about 35 %)
  col *= 1. - dim * lens * smoothstep(0., .4, x);
  col += (kind < 1.5 || kind > 3.5 ? .016 : .0) * lens * smoothstep(0., .3, x);
  // weak Fresnel against a dark environment: cyan on the left, amber on the right
  float F = .02 + .5 * pow(1. - n.z, 5.);
  vec3 env = mix(vec3(.03, .10, .14), vec3(.14, .09, .03), smoothstep(.15, .85, uv.x));
  col = mix(col, env, F * lens);
  // light: a rim on the side facing the key light (brighter near a finger), a weaker one opposite, a hairline, a glint
  float rimMask = pow(1. - x, 7.);
  vec2 nxy = length(n.xy) > 1e-4 ? normalize(n.xy) : vec2(0.);
  float face = max(dot(nxy, uLight), 0.), back = max(-dot(nxy, uLight), 0.);
  col += rimMask * (face * .95 + back * .4 * (col * 1.8 + .06)) * rimk * lens * (1. + 1.6 * glow);
  col += exp(-d * d / (.45 * uPx * uPx)) * hairk * lens;
  vec3 L3 = normalize(vec3(uLight * .78, .62)), Hv = normalize(L3 + vec3(0., 0., 1.));
  float ndh = max(dot(n, Hv), 0.);
  col += (pow(ndh, 120.) * .9 + pow(ndh, 18.) * .09) * lens * rimk * (1. - .85 * fillL);
  // the pointer is a second light: glints on the nearest rims, a faint sheen beneath it
  if (uCur.w > .001) {
    vec2 cq = uCur.xy - p; float cd = length(cq);
    vec3 Lc = normalize(vec3(cq, 170. * uPx)), Hc = normalize(Lc + vec3(0., 0., 1.));
    float fall = exp(-cd / (240. * uPx));
    col += pow(max(dot(n, Hc), 0.), 60.) * .9 * fall * uCur.w * lens * (1. - smoothstep(.25, .6, x));
    col += exp(-cd * cd / (2. * pow(130. * uPx, 2.))) * .04 * uCur.z * lens * smoothstep(0., .5, x);
  }
  // the light a finger lets into the glass
  col += glow * vec3(.86, .94, 1.) * .1 * smoothstep(0., .35, x) * lens;
  col = mix(col, min(col * 1.06 + vec3(.05), vec3(.32)), fillL * ((kind > .5 && kind < 1.5) || kind > 4.5 ? 1. : .55));
  return col;
}

vec3 shadeBase(vec2 p, vec2 uv, vec3 sky) {
  int idx; float dm;
  vec3 s = sceneBase(p, idx, dm);
  float d = s.x;
  float kind = idx >= 0 ? uB[idx].y : 5.;
  float lens = idx >= 0 ? uB[idx].z : 1.;
  if (idx >= 0 && scrolls(idx)) lens *= edgeVis(p);
  lens = mix(lens, 1., dm);
  // the plane under the glass carries a soft, wide shadow, seen through the glass too
  float sh = shadowBase(p - vec2(0., 12. * uPx));
  float shadow = .3 * (1. - smoothstep(-14. * uPx, 42. * uPx, sh)) * lens + .08 * (1. - smoothstep(0., 5. * uPx, d)) * step(0., d) * lens;
  vec3 plane = sky * (1. - shadow);
  // the pointer's drop focuses a little of the key light onto the sky beneath it: a caustic
  if (uND > 0 && uD[0].w > 1.5) {
    vec2 cq = p - uD[0].xy - vec2(4., 11.) * uPx; float cr = max(uD[0].z * .42, uPx);
    plane += vec3(1., .97, .9) * exp(-dot(cq, cq) / (2. * cr * cr)) * .13 * smoothstep(3. * uPx, 10. * uPx, uD[0].z);
  }
  if (d > 1.5 * uPx || lens < .003) return plane + exp(-d * d / (.5 * uPx * uPx)) * .25 * lens;
  float x;
  vec3 col = glassAt(p, uv, s, kind, idx >= 0 ? uA[idx].w : 12. * uPx, idx >= 0 ? uC[idx].y : 0., lens, idx >= 0 ? uB[idx].w : 0., dm, 0., x);
  // the budget ring: amber light fills the spent part of the tube, and bubbles drift through it
  if (kind > 1.5 && kind < 2.5) {
    vec2 rq = p - uA[idx].xy; float a = fract(atan(rq.x, -rq.y) / 6.2831853 + 1.);
    float Rr = uA[idx].z, wt = uC[idx].y * .78, fr = uC[idx].x, across = length(rq) - Rr;
    float sEnd = (a - fr) * 6.2831853 * Rr, sBeg = a * 6.2831853 * Rr;
    float body = step(0., sBeg) * step(sEnd, 0.) * smoothstep(wt + uPx, wt - uPx, abs(across));
    vec2 endP = uA[idx].xy + Rr * vec2(sin(fr * 6.2831853), -cos(fr * 6.2831853)), begP = uA[idx].xy + vec2(0., -Rr);
    float caps = max(smoothstep(wt + uPx, wt - uPx, length(p - endP)), smoothstep(wt + uPx, wt - uPx, length(p - begP)));
    float fill = max(body * smoothstep(-.5 * uPx, .5 * uPx, -sEnd), caps) * step(.0005, fr);
    float core = 1. - abs(across) / max(wt, 1.);
    bool coral = uC[idx].z < -.5;
    vec3 amber = coral ? vec3(1., .42, .42) * (.8 + .2 * sin(uTime * 1.8)) : vec3(1., .68, .27);
    float shimmer = .92 + .08 * sin(a * 110. - uTime * 1.4) * sin(a * 37. + uTime * .6);
    col = mix(col, col * .35 + amber * (.28 + .62 * core * core) * shimmer, fill * .86 * lens);
    col += vec3(1., .9, .72) * fill * pow(max(core, 0.), 6.) * .22 * lens;
    // bubbles (a CAEmitterLayer in a tube): rise along the liquid toward its end and vanish there
    if (fr > .02 && !coral) {
      float bub = 0.;
      for (int k = 0; k < 7; k++) {
        float fk = float(k);
        float ph = fract(fk * .371 + uTime * (.035 + .02 * fract(fk * .618)) / max(fr, .2));
        float ang = ph * fr * 6.2831853;
        float acr = sin(uTime * (.9 + fk * .23) + fk * 2.1) * wt * .42;
        vec2 bp = uA[idx].xy + (Rr + acr) * vec2(sin(ang), -cos(ang));
        float br = (1.1 + 1.4 * fract(fk * .73)) * uPx, dd = length(p - bp);
        float life = smoothstep(0., .12, ph) * smoothstep(1., .8, ph);
        bub += (smoothstep(br + uPx, br, dd) - .65 * smoothstep(br - .3 * uPx, br - 1.3 * uPx, dd)) * life;
        bub += smoothstep(.9 * uPx, 0., length(p - bp + vec2(.35, .35) * br)) * .8 * life;
      }
      col += vec3(1., .94, .82) * bub * .3 * fill * lens;
    }
  }
  // a sweep of light across a bar when it has news
  if (idx >= 0 && uC[idx].z > 0.) {
    float st = (uTime - uC[idx].z) / .9;
    if (st > 0. && st < 1.) {
      float bx = mix(uA[idx].x - uA[idx].z - 40. * uPx, uA[idx].x + uA[idx].z + 40. * uPx, st);
      col += exp(-pow((p.x - bx + (p.y - uA[idx].y) * .5) / (26. * uPx), 2.)) * .16 * sin(3.14159 * st) * lens;
    }
  }
  if (uSolid > .5) col = mix(col, vec3(.045, .05, .08), .82 * smoothstep(0., .15, x) * lens);
  // antialiased silhouette
  float aa = smoothstep(-1.2 * uPx, 1.2 * uPx, d);
  return mix(col, plane + exp(-d * d / (.5 * uPx * uPx)) * .25 * lens, aa);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 sky = texture(uSky, uv).rgb;
  int oi = -1; vec3 so = vec3(1e5, 0., 1.);
  if (uNO > 0) so = sceneOver(p, oi);
  float ol = oi >= 0 ? uOB[oi].z : 0.;
  // deep inside the overlay the page's glass is never seen, so it is not drawn
  vec3 col = (so.x < -2. * uPx && ol > .995) ? vec3(0.) : shadeBase(p, uv, sky);
  if (oi >= 0) {
    // the overlay floats higher: its shadow on the page is wider and further down
    float osh = shadowOver(p - vec2(0., 20. * uPx));
    col *= 1. - .36 * (1. - smoothstep(-24. * uPx, 80. * uPx, osh)) * ol;
    if (so.x < 1.5 * uPx) {
      float x;
      vec3 oc = glassAt(p, uv, so, uOB[oi].y, uOA[oi].w, 0., ol, uOB[oi].w, 0., 1., x);
      if (uSolid > .5) oc = mix(oc, vec3(.045, .05, .08), .86 * smoothstep(0., .15, x));
      float aa = smoothstep(-1.2 * uPx, 1.2 * uPx, so.x);
      vec3 under = col + exp(-so.x * so.x / (.5 * uPx * uPx)) * .25 * ol;
      col = mix(mix(col, oc, smoothstep(0., .35, ol)), under, aa);
    }
  }
  o = vec4(col, 1.);
}`;

  // ─── GL plumbing ──────────────────────────────────────────────────────────
  function compile(gl, vs, fs) {
    const make = (type, src) => {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) + "\n" + src.split("\n").slice(0, 6).join("\n"));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vs)); gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  function target(gl, w, h, mip) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  let P = {}, T = {}, V = {}, B = {};

  function init(canvas) {
    S.cv = canvas;
    let gl;
    try { gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false }); } catch { gl = null; }
    if (!gl) return false;
    S.gl = gl;
    try {
      P.neb = compile(gl, VS_FULL, FS_NEBULA);
      P.sky = compile(gl, VS_FULL, FS_SKY);
      P.stars = compile(gl, VS_STARS, FS_STARS);
      P.marks = compile(gl, VS_MARKS, FS_MARKS);
      P.path = compile(gl, VS_PATH, FS_PATH);
      P.glass = compile(gl, VS_FULL, FS_GLASS);
    } catch (e) { console.warn("glass: WebGL2 shaders did not compile, using the plain page", e); return false; }
    V.empty = gl.createVertexArray();
    V.stars = gl.createVertexArray(); B.stars = gl.createBuffer();
    V.marks = gl.createVertexArray(); B.marks = gl.createBuffer();
    V.path = gl.createVertexArray(); B.path = gl.createBuffer();
    T.lab = gl.createTexture();
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); S.ok = false; document.documentElement.classList.add("no-gl"); });
    // the highlight the pointer's drop turns into over a control (iPadOS's pointer, in glass)
    S.lenses.push({ key: "hover", hover: true, lr: null, str: 0, vs: 0, lift: 0, vlift: 0, height: 0.2, tint: 0.62, layer: 0 });
    S.ok = true;
    resize(); drawLabels();
    if (document.fonts?.ready) document.fonts.ready.then(drawLabels);
    addEventListener("resize", () => { resize(); drawLabels(); });
    listen();
    motionQ.addEventListener?.("change", (e) => { S.reduced = e.matches; });
    transQ.addEventListener?.("change", (e) => { S.solid = e.matches; });
    requestAnimationFrame(loop);
    return true;
  }

  function resize() {
    const gl = S.gl, dpr = Math.min(devicePixelRatio || 1, 2) * (window.__lanceaTestScale || 1);
    S.PX = dpr * S.scale;
    const w = Math.max(2, Math.round(innerWidth * S.PX)), h = Math.max(2, Math.round(innerHeight * S.PX));
    if (w === S.W && h === S.H) return;
    S.W = w; S.H = h; S.cv.width = w; S.cv.height = h;
    for (const k of ["neb", "sky"]) if (T[k]) { gl.deleteTexture(T[k].tex); gl.deleteFramebuffer(T[k].fb); }
    T.neb = target(gl, Math.max(2, w >> 1), Math.max(2, h >> 1), false);
    T.sky = target(gl, w, h, true);
    S.nebDirty = true;
    makeStars();
    layoutMarks();
  }

  // Stars: sparse on purpose. Density scales with the area of the view.
  function makeStars() {
    const gl = S.gl, R = rng(20260928), area = (innerWidth * innerHeight) / (1440 * 900);
    const counts = [Math.round(1500 * area), Math.round(460 * area), Math.round(110 * area)];
    const temps = [[0.72, 0.84, 1], [0.86, 0.92, 1], [1, 1, 1], [1, 0.95, 0.86], [1, 0.84, 0.66]];
    const data = []; let bright = 0;
    counts.forEach((n, layer) => {
      for (let i = 0; i < n; i++) {
        const mag = Math.pow(R(), layer === 0 ? 2.8 : layer === 1 ? 2.2 : 1.7) * (layer === 0 ? 0.75 : layer === 1 ? 1.0 : 1.2) + 0.1;
        let kind = 0;
        if (layer === 2 && mag > 0.9 && bright < Math.max(4, Math.round(8 * area))) { kind = 1; bright++; }
        const c = temps[Math.min(4, Math.floor(Math.pow(R(), 1.3) * 5))];
        data.push(R(), R(), kind === 1 ? 1 : mag, layer, kind, R(), c[0], c[1], c[2]);
      }
    });
    // one pulsar, mid-layer, somewhere quiet
    data.push(0.9, 0.14, 0.6, 1, 2, 0.37, 0.8, 0.9, 1);
    S.starN = data.length / 9;
    gl.bindVertexArray(V.stars); gl.bindBuffer(gl.ARRAY_BUFFER, B.stars);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const st = 9 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, st, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, st, 24);
    gl.bindVertexArray(null);
  }

  // Labels printed on the sky plane (so glass passing over them bends them): an atlas, four rows.
  function drawLabels() {
    if (!S.ok) return;
    const gl = S.gl, PX = S.PX, rowH = Math.round(24 * PX), w = 1024 * Math.ceil(PX);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = rowH * 6;
    const c = cv.getContext("2d");
    const texts = ["WITNESS 01", "AGENT SAID", "WITNESS 02", "TRANSACTION DOES", "AGREEMENT IS EVIDENCE"];
    c.font = `500 ${Math.round(11 * PX)}px "Geist Mono", ui-monospace, Menlo, monospace`;
    c.textBaseline = "middle"; c.fillStyle = "#fff";
    S.labels = texts.map((t, i) => {
      let x = 2, sp = 11 * PX * 0.14;
      for (const ch of t) { c.fillText(ch, x, rowH * i + rowH / 2); x += c.measureText(ch).width + sp; }
      return { w: Math.ceil(x) / PX, h: rowH / PX, frac: Math.ceil(x) / w };
    });
    gl.bindTexture(gl.TEXTURE_2D, T.lab);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ─── Shapes from the page ─────────────────────────────────────────────────
  const KIND = { pane: 0, bar: 1, ring: 2, sheet: 4, chip: 5 };
  const find = (el) => S.shapes.find((s) => s.el === el);
  function add(el, opts = {}) {
    if (!el) return null;
    let sh = find(el);
    if (sh) return sh;
    sh = {
      el, kind: KIND[opts.kind ?? "pane"], scroll: opts.scroll !== false, lens: 0, v: 0, target: opts.shown === false ? 0 : 1,
      press: 0, pv: 0, pressT: 0, delay: opts.delay ?? 0, since: S.now, fill: 0, fv: 0, fillT: 0, tube: opts.tube ?? 13,
      rect: null, radius: opts.radius, manual: opts.manual, held: false, lr: null, last: null, fast: false, sweep: 0,
    };
    S.shapes.push(sh);
    return sh;
  }
  function remove(el) { S.shapes = S.shapes.filter((s) => s.el !== el); }
  /** Materialize (on) or dematerialize (off) a shape's glass. {instant} skips the spring, {fast} leaves quickly. */
  function show(el, on, delay = 0, o = {}) {
    const s = find(el); if (!s) return;
    s.held = false; s.target = on ? 1 : 0; s.delay = delay; s.since = S.now; s.fast = !!o.fast;
    if (o.instant || S.reduced) { s.lens = s.target; s.v = 0; if (!on) s.last = null; }
  }
  function setFill(el, f) { const s = find(el); if (s) { if (Math.abs(s.fillT - f) > 0.001) S.lastInput = S.now; s.fillT = clamp(f, 0, 1); } }
  function press(el, on) { const s = find(el); if (s) s.pressT = on ? 1 : 0; }

  // The glass follows the page each frame. Panes that scroll glide to a new layout (a pane that grows, a
  // column that reflows) instead of jumping; the spring runs in the scroller's coordinates, so scrolling
  // itself is never lagged.
  function settle(s, r) {
    const sy = S.scroller ? S.scroller.scrollTop : 0;
    const g = box(r.left, r.top + sy, r.right, r.bottom + sy);
    if (!s.lr || s.held || s.lens < 0.05 || S.reduced || rdist(s.lr, g) > 480) s.lr = s.lr ? s.lr.set(g, 0) : new Liquid(g, 0);
    else s.lr.step(g, null, S.dt, SP.layout, SP.layout);
    return box(s.lr.l, s.lr.t - sy, s.lr.r, s.lr.b - sy);
  }
  function rectOf(s) {
    if (!s.held && s.lens < 0.003 && s.target === 0) { s.rect = null; return null; }
    let r = s.manual ? s.manual() : s.el.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < 1) {
      // hidden by the page while its glass is still dematerialising: it stays where it was until it is gone
      if (s.last && s.lens > 0.003 && !s.held) r = s.last;
      else { s.rect = null; return null; }
    } else {
      if (s.scroll && s.kind === 0 && !s.manual) r = settle(s, r);
      s.last = plain(r);
    }
    s.rect = r;
    if (s.radius == null) s.radius = radiusOf(s.el);
    if (s.held || r.bottom < -80 || r.top > innerHeight + 80) return null;
    return r;
  }

  // ─── Flow: the glass of one view becomes the glass of the next ────────────
  // Each pane of the new layout is born from a pane of the old one (in reading order), so where there are
  // more new panes than old ones a pane divides, and where there are fewer, panes merge. In flight they
  // are one body of liquid; they part as they slow down. The new view's words arrive as their glass lands.
  const onScreen = (r) => box(r.left, Math.max(r.top, -60), r.right, Math.max(Math.max(r.top, -60) + 8, Math.min(r.bottom, innerHeight + 60)));
  const reading = (a, b) => { const ra = a.rect ?? a, rb = b.rect ?? b; return Math.abs(ra.top - rb.top) > 12 ? ra.top - rb.top : ra.left - rb.left; };
  function snapshot(root) {
    const out = [];
    for (const s of S.shapes) {
      if (s.held || s.kind === 2 || !s.rect || s.lens < 0.2) continue;
      if (root && !root.contains(s.el)) continue;
      const r = s.rect; if (r.bottom < 0 || r.top > innerHeight || r.width < 2) continue;
      out.push({ rect: onScreen(r), radius: Math.min(s.radius ?? 0, r.width / 2, r.height / 2), kind: s.kind });
    }
    for (const b of S.blobs) if (b.lens > 0.2) out.push({ rect: b.lr.rect, radius: b.lr.q, kind: b.kind });
    return out.sort(reading);
  }
  function flow(from, targets, o = {}) {
    S.blobs.length = 0;
    const tos = targets.map(find).filter(Boolean);
    for (const s of tos) { s.held = true; s.lens = 0; s.v = 0; s.target = 0; s.lr = null; if (s.radius == null) s.radius = radiusOf(s.el); }
    S.flowOn = { onLand: o.onLand };
    if (!S.ok || S.reduced || !from.length || !tos.length) {
      tos.forEach((s, j) => { s.held = false; s.target = 1; s.since = S.now; s.delay = S.reduced ? 0 : 0.05 + j * 0.045; if (S.reduced) s.lens = 1; o.onLand?.(s.el); });
      // nothing to flow into: the old glass dissolves where it is
      if (!tos.length) for (const f of from) S.blobs.push({ lr: new Liquid(f.rect, f.radius), from: f.rect, kind: f.kind, to: null, delay: 0, t0: S.now, lens: 1, vlens: 0 });
      return;
    }
    const n = tos.length, m = from.length, used = new Set(), stagger = o.stagger ?? 0.032;
    const mk = (f, s, j, merge) => S.blobs.push({
      lr: new Liquid(f.rect, f.radius), kind: s.kind, to: s, delay: Math.min(0.28, j * stagger), t0: S.now, merge,
      landed: false, revealed: merge, d0: Math.max(1, rdist(f.rect, onScreen(s.el.getBoundingClientRect()))), lens: 1, vlens: 0, liq: 0,
    });
    tos.forEach((s, j) => { const i = n === 1 ? 0 : Math.min(m - 1, Math.floor((j * m) / n)); used.add(i); mk(from[i], s, j, false); });
    from.forEach((f, i) => { if (!used.has(i)) mk(f, tos[Math.min(n - 1, Math.round((i * n) / m))], i, true); });
  }
  function updateFlow(dt) {
    if (!S.blobs.length) { S.gk += (0 - S.gk) * Math.min(1, dt * 8); return; }
    let fastest = 0, done = true;
    for (const b of S.blobs) {
      if (!b.to) {
        b.lr.step(scaled(b.from, 0.9), null, dt, SP.lensLead, SP.lensLead); spring(b, "lens", "vlens", 0, SP.lens, dt);
        if (b.lens > 0.01) done = false;
        continue;
      }
      if (S.now - b.t0 < b.delay) { done = false; continue; }
      const r0 = b.to.el.getBoundingClientRect();
      if (r0.width < 1) { b.landed = true; continue; }
      const g = onScreen(r0);
      b.lr.step(g, Math.min(b.to.radius ?? 0, g.width / 2, g.height / 2), dt, SP.flowLead, SP.flowTrail);
      const sp = b.lr.speed();
      fastest = Math.max(fastest, sp);
      // in flight a pane is a drop: its corners round off with speed, and it lifts a little
      b.liq += (smooth(60, 1100, sp) - b.liq) * Math.min(1, dt * 12);
      const d = rdist(b.lr, g);
      if (!b.revealed && 1 - d / b.d0 > 0.7) { b.revealed = true; S.flowOn?.onLand?.(b.to.el); }
      if (!b.landed && ((d < 0.75 && b.lr.speed() < 16) || S.now - b.t0 > 2.6)) b.landed = true;
      if (!b.landed) done = false;
    }
    S.gk += (24 * smooth(40, 700, fastest) - S.gk) * Math.min(1, dt * 10);
    if (done) {
      for (const b of S.blobs) {
        if (!b.to || b.merge) continue;
        const s = b.to; s.held = false; s.lens = 1; s.v = 0; s.target = 1; s.lr = null;
        if (!b.revealed) S.flowOn?.onLand?.(s.el);
      }
      S.blobs.length = 0; S.flowOn = null;
    }
  }

  // ─── Overlay: a sheet, a menu or a toast, pulled out of the glass it came from ───
  // matchedGeometry: the overlay's glass starts as its source (a row, a star, a button) and flows to where
  // the page puts it; a drop left at the source keeps a liquid neck to it until it snaps, then shrinks
  // away. Closing reverses it: the glass flows back and sinks into the source. With no source it
  // materializes where it stands.
  function overlay(el, o = {}) {
    if (!S.ok || !el) return;
    const goal = el.getBoundingClientRect();
    let ov = S.overs.find((x) => x.el === el);
    const src = o.from ? plain(o.from) : scaled(goal, 0.94);
    const q0 = o.fromRadius ?? radiusOf(el);
    if (!ov) {
      ov = { el, kind: KIND[o.kind ?? "sheet"], lr: new Liquid(src, q0), lens: o.from ? 0.45 : 0, vl: 0, press: 0, pv: 0, pressT: 0, p: 0, tether: null };
      ov.tether = o.from && !S.reduced ? { lr: new Liquid(src, q0) } : null;
      S.overs.push(ov);
    } else ov.tether = null; // opened again while it was closing: it simply turns around
    ov.state = "in"; ov.onFrame = o.onFrame; ov.onDone = null; ov.radius = radiusOf(el); ov.sink = false; ov.p = 0;
    ov.d0 = Math.max(1, rdist(ov.lr, goal));
    if (S.reduced) { ov.lr.set(goal, ov.radius); ov.lens = 1; ov.p = 1; ov.tether = null; }
  }
  function overlayOut(el, o = {}) {
    const ov = S.overs.find((x) => x.el === el);
    if (!ov) { o.onDone?.(); return; }
    ov.state = "out"; ov.onDone = o.onDone; ov.onFrame = null; ov.sink = false;
    ov.to = o.to ? plain(o.to) : null; ov.toRadius = o.toRadius ?? 14; ov.from = ov.lr.rect;
    const [x, y] = ov.to ? mid(ov.to) : [0, 0];
    ov.tether = ov.to && !S.reduced ? { lr: new Liquid(around(x, y, 0, 0), 0) } : null;
    if (S.reduced || !S.ok) { S.overs = S.overs.filter((x2) => x2 !== ov); o.onDone?.(); }
  }
  function updateOverlays(dt) {
    let moving = 0;
    for (const ov of [...S.overs]) {
      const t = ov.tether;
      if (ov.state === "in") {
        const g = ov.el.getBoundingClientRect();
        if (g.width < 1) { overlayOut(ov.el); continue; }
        ov.lr.step(g, ov.radius, dt, SP.sheetLead, SP.sheetTrail);
        spring(ov, "lens", "vl", 1, SP.lens, dt);
        ov.liq = (ov.liq ?? 0) + (smooth(80, 1400, ov.lr.speed()) - (ov.liq ?? 0)) * Math.min(1, dt * 12);
        ov.p = Math.max(ov.p, 1 - Math.min(1, rdist(ov.lr, g) / ov.d0));
        if (t) {
          const [x, y] = mid(t.lr); t.lr.step(around(x, y, 0, 0), 0, dt, SP.shrink, SP.shrink);
          if (t.lr.r - t.lr.l < 1.5 && t.lr.b - t.lr.t < 1.5) ov.tether = null;
        }
        ov.onFrame?.(ov.p);
      } else {
        ov.liq = (ov.liq ?? 0) + (smooth(80, 1400, ov.lr.speed()) - (ov.liq ?? 0)) * Math.min(1, dt * 12);
        if (ov.to) {
          ov.lr.step(ov.to, ov.toRadius, dt, SP.sheetLead, SP.sheetTrail);
          if (t) t.lr.step(ov.to, ov.toRadius, dt, SP.grow, SP.grow);
          if (!ov.sink && rdist(ov.lr, ov.to) < 5) ov.sink = true;
          if (ov.sink) spring(ov, "lens", "vl", 0, SP.fast, dt);
        } else {
          ov.lr.step(scaled(ov.from, 0.9), null, dt, SP.lensLead, SP.lensLead);
          spring(ov, "lens", "vl", 0, SP.lens, dt);
        }
        if (ov.lens < 0.01) { S.overs = S.overs.filter((x) => x !== ov); ov.onDone?.(); continue; }
      }
      moving = Math.max(moving, ov.lr.speed());
    }
    const want = S.overs.some((x) => x.tether) ? 44 * smooth(20, 380, moving) : 0;
    S.okk += (want - S.okk) * Math.min(1, dt * 10);
  }

  // ─── Lenses inside the glass: selections, and the pointer's highlight ─────
  /** A lens that swells inside a bar: get() returns {rect, radius, lift, layer} or null. */
  function lens(key, get, o = {}) {
    S.lenses = S.lenses.filter((x) => x.key !== key);
    const L = { key, get, hover: false, lr: null, str: 0, vs: 0, lift: 0, vlift: 0, height: o.height ?? 0.28, tint: o.tint ?? 1, layer: o.layer ?? 0 };
    S.lenses.push(L);
    return L;
  }
  /** The control under the pointer: the pointer's drop sinks into the glass and becomes its highlight. */
  function hover(el, o) { S.hoverEl = el || null; S.hoverOpt = o || null; }
  const pointerBox = (r) => around(S.cursor.x, S.cursor.y, 2 * r);
  function hoverGoal() {
    const el = S.hoverEl, o = S.hoverOpt ?? {}, c = S.cursor;
    if (!el || !el.isConnected || !c.fine || S.reduced || !c.onT) return null;
    const r = el.getBoundingClientRect(); if (r.width < 1) return null;
    const ix = o.inset?.[0] ?? 0, iy = o.inset?.[1] ?? 0;
    const rect = box(r.left - ix, r.top - iy, r.right + ix, r.bottom + iy);
    const radius = o.radius === "capsule" ? Math.min(rect.width, rect.height) / 2 : Math.min(o.radius ?? 14, rect.width / 2, rect.height / 2);
    return { rect, radius, layer: o.layer ?? 0, lift: 0 };
  }
  function updateLenses(dt) {
    for (const L of S.lenses) {
      const g = L.hover ? hoverGoal() : L.get?.();
      if (g) {
        if (!L.lr || L.str < 0.02) L.lr = L.hover ? new Liquid(pointerBox(9), 9) : new Liquid(g.rect, g.radius);
        if (S.reduced) { L.lr.set(g.rect, g.radius); L.str = 1; L.lift = 0; }
        else {
          L.lr.step(g.rect, g.radius, dt, L.hover ? SP.hoverLead : SP.lensLead, L.hover ? SP.hoverTrail : SP.lensTrail);
          spring(L, "str", "vs", 1, L.hover ? SP.hoverIn : SP.lens, dt);
          spring(L, "lift", "vlift", g.lift ?? 0, SP.lift, dt);
        }
        L.layer = g.layer ?? 0;
      } else if (L.lr) {
        if (L.hover) L.lr.step(pointerBox(7), 7, dt, SP.hoverLead, SP.hoverTrail);
        spring(L, "str", "vs", 0, SP.fast, dt);
        if (L.str < 0.004) { L.str = 0; L.vs = 0; }
      }
    }
  }

  // ─── Pointer and touch ────────────────────────────────────────────────────
  function listen() {
    addEventListener("pointermove", (e) => {
      const c = S.cursor; c.fine = e.pointerType === "mouse";
      c.x = e.clientX; c.y = e.clientY; c.moved = S.now; c.onT = c.fine ? 1 : 0;
      if (S.touch && e.buttons) { S.touch.x = e.clientX; S.touch.y = e.clientY; }
    }, { passive: true });
    addEventListener("pointerleave", () => { S.cursor.onT = 0; });
    document.addEventListener("mouseleave", () => { S.cursor.onT = 0; });
    for (const ev of ["scroll", "keydown", "wheel", "touchstart"]) addEventListener(ev, () => { S.lastInput = S.now; }, { passive: true, capture: true });
    // Apple's interactive glass: under a finger the glass swells a little, lights up from where it is
    // touched, and springs back with a bounce when let go. A tap on the sky squashes the pointer's drop.
    addEventListener("pointerdown", (e) => {
      const c = S.cursor; c.down = 1; S.lastInput = S.now;
      if (e.pointerType !== "mouse") { c.fine = false; c.onT = 0; }
      const hit = hitTest(e.clientX, e.clientY);
      if (hit && hit.rec.kind !== 2) { hit.rec.pressT = 1; S.touch = { x: e.clientX, y: e.clientY, rec: hit.rec, layer: hit.layer }; }
      else if (c.fine && !S.reduced) c.vst -= 4.5;
    }, { passive: true });
    const up = () => { for (const s of S.shapes) s.pressT = 0; for (const o of S.overs) o.pressT = 0; S.cursor.down = 0; };
    addEventListener("pointerup", up, { passive: true });
    addEventListener("pointercancel", up, { passive: true });
  }
  function hitTest(x, y) {
    const inside = (r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    for (let i = S.overs.length - 1; i >= 0; i--) { const o = S.overs[i]; if (o.lens > 0.2 && o.state === "in" && inside(o.lr)) return { rec: o, layer: 1 }; }
    for (let i = S.shapes.length - 1; i >= 0; i--) { const s = S.shapes[i]; if (!s.held && s.lens > 0.2 && inside(s.rect)) return { rec: s, layer: 0 }; }
    return null;
  }
  function burst(x, y, coral) { S.bursts.push({ x, y, t0: S.now, coral }); if (S.bursts.length > 6) S.bursts.shift(); }

  // ─── Decisions in the sky ─────────────────────────────────────────────────
  // An Archimedean spiral around the white star: the oldest decision closest, the newest outermost.
  let decisions = [];
  /** animateNew: true for what arrives live (the two lights meet, a star is born with a burst);
   *  "soft" for scrubbing through time (new stars simply swell into place). */
  function setDecisions(list, animateNew) {
    const was = new Map(decisions.map((d) => [d.key, d.born]));
    const soft = animateNew === "soft";
    if (animateNew) S.lastInput = S.now;
    decisions = list.map((d, i) => ({ ...d, born: was.has(d.key) ? (soft ? was.get(d.key) : -99) : soft && !S.reduced ? S.now : !animateNew ? -99 : S.now + 0.25 + i * 0.02 }));
    layoutMarks();
    const known = new Set(was.keys());
    if (animateNew && !soft) {
      const fresh = decisions.filter((d) => !known.has(d.key));
      if (fresh.some((d) => d.kind === 0) && !S.reduced) S.meetT = S.now + 0.2;
      fresh.forEach((d) => { d.born = S.now + (d.kind === 0 ? 1.45 : 0.3); setTimeout(() => { const m = S.marks.find((x) => x.key === d.key); if (m) burst(m.x, m.y, d.kind > 0); }, d.kind === 0 ? 1450 : 300); });
    }
  }
  function layoutMarks() {
    const out = []; let th = 0; const r0 = 30, pitch = 12, step = 15;
    decisions.forEach((d, i) => {
      const r = r0 + (pitch / (2 * Math.PI)) * th;
      out.push({ key: d.key, dx: Math.cos(th - Math.PI / 2) * r, dy: Math.sin(th - Math.PI / 2) * r, kind: d.kind, born: d.born, newest: i === decisions.length - 1, data: d });
      th += step / r;
    });
    S.marks = out;
  }
  function focus(x, y, r, marks = true, instant) { S.focus.tx = x; S.focus.ty = y; S.focus.r = r; S.focus.marksT = marks ? 1 : 0; if (instant || !S.focus.init) { S.focus.x = x; S.focus.y = y; S.focus.init = true; } }
  function markAt(x, y) {
    let best = -1, bd = 14 * 14;
    S.marks.forEach((m, i) => { const dx = m.x - x, dy = m.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
    S.hover = best; return best >= 0 ? S.marks[best] : null;
  }

  function markHover(key) { S.hoverKey = key || null; }
  function hoverIndex() { if (S.hoverKey) { const i = S.marks.findIndex((m) => m.key === S.hoverKey); if (i >= 0) return i; } return S.hover; }
  function markPos(key) { const m = S.marks.find((x) => x.key === key); return m && S.focus.marks > 0.5 ? { x: m.x, y: m.y } : null; }

  // ─── The loop ─────────────────────────────────────────────────────────────
  // The pointer's drop: a droplet of glass that follows the pointer, stretches as it moves and wobbles
  // when it stops, sheds two small droplets when flung (they catch up and merge again), pops back when the
  // pointer wakes, evaporates when it rests, focuses a caustic on the sky, and sinks into any glass it
  // meets, where it turns into the highlight of the control beneath.
  function updateCursor(dt) {
    const c = S.cursor, now = S.now;
    const idle = now - c.moved > 2.6;
    const want = c.fine && !S.reduced && !idle && c.onT ? 1 : 0;
    spring(c, "on", "von", want, want ? SP.pop : SP.evaporate, dt);
    if (!want && c.on < 0.003) { c.on = 0; c.von = 0; }
    if (c.px < -1e3) { c.px = c.x; c.py = c.y; for (const t of c.sat) { t.x = c.x; t.y = c.y; } }
    spring(c, "px", "vx", c.x, SP.drop, dt); spring(c, "py", "vy", c.y, SP.drop, dt);
    let lead = { x: c.px, y: c.py };
    c.sat.forEach((t, i) => {
      spring(t, "x", "vx", lead.x, i ? SP.sat2 : SP.sat1, dt); spring(t, "y", "vy", lead.y, i ? SP.sat2 : SP.sat1, dt);
      // surface tension: a droplet never strays far
      const dx = t.x - lead.x, dy = t.y - lead.y, d = Math.hypot(dx, dy), max = i ? 46 : 64;
      if (d > max) { t.x = lead.x + (dx / d) * max; t.y = lead.y + (dy / d) * max; }
      lead = t;
    });
    const v = Math.hypot(c.vx, c.vy);
    if (v > 60) { const k = Math.min(1, dt * 16); c.ax += (c.vx / v - c.ax) * k; c.ay += (c.vy / v - c.ay) * k; const l = Math.hypot(c.ax, c.ay) || 1; c.ax /= l; c.ay /= l; }
    spring(c, "st", "vst", Math.min(0.34, v / 3600), SP.jelly, dt);
    c.st = clamp(c.st, -0.3, 0.45);
    spring(c, "press", "vpress", c.down && !S.touch ? 1 : 0, c.down ? SP.press : SP.release, dt);
    const over = c.fine ? hitTest(c.x, c.y) : null;
    c.glass += ((over && over.rec.kind !== 2 ? 1 : 0) - c.glass) * Math.min(1, dt * 6);
  }
  function update(dt) {
    const c = S.cursor, now = S.now;
    // shapes: lens (materialize), press, ring fill
    for (const s of S.shapes) {
      if (s.held) { s.lens = 0; s.v = 0; }
      else {
        const tgt = now - s.since >= s.delay ? s.target : s.lens < 0.01 ? 0 : s.target === 0 ? 0 : s.lens;
        if (S.reduced) { s.lens = tgt; s.v = 0; } else spring(s, "lens", "v", tgt, tgt === 0 && s.fast ? SP.fast : SP.lens, dt);
        if (s.lens < 0) { s.lens = 0; s.v = 0; }
      }
      spring(s, "press", "pv", s.pressT, s.pressT ? SP.press : SP.release, dt);
      if (S.reduced) s.fill = s.fillT; else spring(s, "fill", "fv", s.fillT, SP.fill, dt);
    }
    for (const o of S.overs) spring(o, "press", "pv", o.pressT, o.pressT ? SP.press : SP.release, dt);
    if (S.touch && !S.touch.rec.pressT && Math.abs(S.touch.rec.press) < 0.004 && Math.abs(S.touch.rec.pv) < 0.05) S.touch = null;
    updateFlow(dt); updateOverlays(dt); updateLenses(dt); updateCursor(dt);
    // focus (the white star and its spiral) glides to where the page puts it
    if (S.reduced) { S.focus.x = S.focus.tx; S.focus.y = S.focus.ty; } else { spring(S.focus, "x", "vx", S.focus.tx, SP.focus, dt); spring(S.focus, "y", "vy", S.focus.ty, SP.focus, dt); }
    S.focus.marks = (S.focus.marks ?? 1) + ((S.focus.marksT ?? 1) - (S.focus.marks ?? 1)) * Math.min(1, (S.realDt ?? dt) * (S.reduced ? 60 : 5));
    for (const m of S.marks) { m.x = S.focus.x + m.dx; m.y = S.focus.y + m.dy; }
    // key light swings slowly (±20°) so highlights travel around every silhouette
    S.light = (-2.36) + (S.reduced ? 0 : Math.sin(now * 0.09) * 0.35);
    // events
    if (!S.reduced) {
      if (now > S.nextMeteor) {
        const m = S.meteors.find((x) => now - x.t0 > x.dur) ?? S.meteors[0];
        const w = innerWidth, h = innerHeight, left = Math.random() < 0.5;
        const ax = w * (0.15 + Math.random() * 0.7), ay = h * (0.05 + Math.random() * 0.4);
        const ang = (left ? Math.PI - 0.5 : 0.5) + (Math.random() - 0.5) * 0.35, len = 200 + Math.random() * 260;
        m.a = [ax, ay]; m.b = [ax + Math.cos(ang) * len, ay + Math.sin(ang) * len]; m.t0 = now; m.dur = 0.65 + Math.random() * 0.55;
        S.nextMeteor = now + 7 + Math.random() * 13;
      }
      if (now > S.nextSat) {
        const w = innerWidth, h = innerHeight, top = Math.random() < 0.5;
        S.sat = { t0: now, dur: 48 + Math.random() * 30, a: [-20, h * (top ? 0.12 : 0.5) + Math.random() * h * 0.2], b: [w + 20, h * (top ? 0.3 : 0.2) + Math.random() * h * 0.3], flare: 0.3 + Math.random() * 0.4 };
        S.nextSat = now + S.sat.dur + 30 + Math.random() * 60;
      }
    }
    // drops: the pointer's first (it casts the caustic), its two droplets, then the margins' drops
    S.drops.length = 0;
    const r0 = 12.5 * Math.max(0, c.on) * (1 - c.glass) * (1 + 0.26 * c.press);
    if (r0 > 0.6) {
      const k = 1 + c.st;
      S.drops.push({ x: c.px, y: c.py, r: r0, sx: k, sy: 1 / k, ax: c.ax, ay: c.ay, cursor: true });
      let lead = { x: c.px, y: c.py };
      c.sat.forEach((t, i) => {
        const rr = r0 * (i ? 0.3 : 0.42) * smooth(6, 22, Math.hypot(t.x - lead.x, t.y - lead.y));
        if (rr > 0.6) S.drops.push({ x: t.x, y: t.y, r: rr });
        lead = t;
      });
    }
    // a lens lifted by a finger rises out of its bar as a clear drop, larger than the bar, and merges back
    for (const L of S.lenses) {
      if (L.hover || !L.lr || L.lift < 0.02 || L.str < 0.2) continue;
      const q = L.lr, hw = (q.r - q.l) / 2, hh = (q.b - q.t) / 2, r = (hh + 7) * L.lift;
      if (r > 0.6) S.drops.push({ x: (q.l + q.r) / 2, y: (q.t + q.b) / 2, r, sx: Math.max(1, (hw + 7) / (hh + 7)), sy: 1, ax: 1, ay: 0 });
    }
    // decorative drops in the margins (wide screens only); they meet, merge and part
    const content = Math.min(1200, innerWidth - 64), margin = (innerWidth - content) / 2;
    if (!S.reduced && margin > 70 && S.fade > 0.6) {
      const t = now * 0.16;
      const mk = (side, ph, r, yb) => {
        const cx = side < 0 ? margin * 0.5 : innerWidth - margin * 0.5;
        const reach = Math.max(0, Math.sin(t * 0.7 + ph)) ** 6;
        const x = cx + Math.sin(t + ph) * margin * 0.18 + side * -1 * reach * (margin * 0.42);
        const y = innerHeight * yb + Math.sin(t * 0.61 + ph * 2) * innerHeight * 0.12;
        S.drops.push({ x, y, r: r * Math.min(1, (S.fade - 0.6) * 3) });
      };
      mk(-1, 0.3, 12, 0.46); mk(-1, 2.6, 7, 0.52); mk(1, 1.4, 10, 0.62);
    }
    const sv = (S.scroll.y - (S.scroll.py ?? S.scroll.y)) / Math.max(dt, 0.001); S.scroll.py = S.scroll.y;
    S.sloshV = (S.sloshV ?? 0); S.slosh = (S.slosh ?? 0);
    if (!S.reduced) spring(S, "slosh", "sloshV", clamp(sv * 0.000012, -0.018, 0.018), { k: 60, c: 7 }, dt); else S.slosh = 0;
    S.bursts = S.bursts.filter((b) => now - b.t0 < 3);
  }

  function loop(ms) {
    requestAnimationFrame(loop);
    if (!S.ok || document.hidden || window.__lanceaFreeze) return;
    const now = (ms - S.t0) / 1000, real = Math.max(0.001, now - S.now), dt = Math.min(0.12, real);
    // when nobody has touched the page for a while, 30 frames a second is plenty for a sky
    const busy = S.blobs.length || S.overs.length || S.touch || S.cursor.down;
    const idle = now - Math.max(S.cursor.moved, S.lastInput ?? 0) > 8 && !busy;
    if (idle && !S.reduced && real < 1 / 45 && (S.skip = !S.skip)) return;
    S.now = now; S.dt = dt; S.frame++; S.realDt = Math.min(0.5, real);
    S.fade = S.reduced ? 1 : Math.min(1, S.fade + dt / 1.8);
    const t1 = performance.now();
    try { update(dt); render(); } catch (e) { if (!S.err) { S.err = e; console.error("glass:", e); } window.__lanceaErr = String(e && e.stack || e); }
    const cost = performance.now() - t1;
    S.stats.frames++; S.stats.ms = S.stats.ms * 0.95 + cost * 0.05; S.stats.real = (S.stats.real ?? real) * 0.9 + real * 0.1;
    // keep it smooth on slower machines: step the resolution down if frames run long
    if (real > 0.024 && !idle && S.frame > 90) { if (++S.slowFrames > 40 && S.scale > 0.6) { S.scale = Math.max(0.6, S.scale - 0.15); S.slowFrames = 0; S.W = 0; resize(); drawLabels(); } }
    else S.slowFrames = Math.max(0, S.slowFrames - 1);
    window.__lanceaStats = { fps: +(1 / S.stats.real).toFixed(1), cpuMs: +S.stats.ms.toFixed(2), scale: S.scale, shapes: S.shapes.length, marks: S.marks.length, blobs: S.blobs.length, overs: S.overs.length };
  }
  // for tests: what the glass holds right now
  window.__lanceaDump = () => ({
    drops: S.drops.map((d) => [Math.round(d.x), Math.round(d.y), +d.r.toFixed(1)]),
    lenses: S.lenses.filter((L) => L.lr && L.str > 0.004).map((L) => [L.key, Math.round(L.lr.l), Math.round(L.lr.t), Math.round(L.lr.r), Math.round(L.lr.b), +L.str.toFixed(2)]),
    blobs: S.blobs.length, overs: S.overs.length, touch: !!S.touch,
    shapes: S.shapes.filter((x) => x.rect && x.lens > 0.01).map((x) => [x.el.id || x.el.className.split(" ")[0], Math.round(x.rect.left), Math.round(x.rect.top), Math.round(x.rect.width), +x.lens.toFixed(2)]),
  });
  // for tests: advance the clock by hand while the page is frozen (window.__lanceaFreeze)
  window.__lanceaStep = (sec = 0.1, n = 6) => {
    if (!S.ok) return false;
    for (let i = 0; i < n; i++) { S.now += sec / n; S.dt = sec / n; S.realDt = sec / n; S.frame++; S.fade = Math.min(1, S.fade + sec / n / 1.8); update(sec / n); if (i < n - 1) for (const s of S.shapes) rectOf(s); }
    render(); return true;
  };

  function render() {
    const gl = S.gl, W = S.W, H = S.H, PX = S.PX, now = S.now;
    const aspect = W / H;
    // lobes: cyan left, amber right; closer together on a tall screen
    const fq = [(S.focus.x * PX - W / 2) / H, (Math.min(Math.max(S.focus.y, innerHeight * 0.16), innerHeight * 0.7) * PX - H / 2) / H];
    // the two witnesses flank the white star: cyan to its left, amber to its right (above and below on a phone)
    const tall = aspect < 0.9;
    const lobeA = tall ? [fq[0] - 0.12, fq[1] - 0.3] : [fq[0] - 0.62, fq[1] - 0.02];
    const lobeB = tall ? [fq[0] + 0.14, fq[1] + 0.28] : [fq[0] + 0.4, fq[1] + 0.1];
    const radA = tall ? [0.42, 0.3] : [0.64, 0.42], radB = tall ? [0.4, 0.3] : [0.44, 0.44];
    const moved = Math.abs(fq[0] - (S.nebF?.[0] ?? 9)) + Math.abs(fq[1] - (S.nebF?.[1] ?? 9)) > 0.0006;
    const scrollPar = S.reduced ? 0 : S.scroll.y;
    const par = [(S.cursor.px > -1e3 && !S.reduced ? (S.cursor.px / innerWidth - 0.5) * -10 : 0) * PX, (-scrollPar * 0.05 + (S.cursor.py > -1e3 && !S.reduced ? (S.cursor.py / innerHeight - 0.5) * -8 : 0)) * PX];

    // 1a. nebula at half resolution, a few times a second (it changes slowly)
    if (S.nebDirty || moved || (!S.reduced && S.frame % 3 === 0)) {
      S.nebDirty = false; S.nebF = fq;
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.neb.fb); gl.viewport(0, 0, T.neb.w, T.neb.h);
      gl.useProgram(P.neb.p); gl.bindVertexArray(V.empty); gl.disable(gl.BLEND);
      gl.uniform2f(P.neb.u.uRes, T.neb.w, T.neb.h);
      gl.uniform1f(P.neb.u.uT, S.reduced ? 0.6 : now * 0.01);
      gl.uniform2f(P.neb.u.uA, lobeA[0], lobeA[1]); gl.uniform2f(P.neb.u.uB, lobeB[0], lobeB[1]);
      gl.uniform2f(P.neb.u.uRA, radA[0], radA[1]); gl.uniform2f(P.neb.u.uRB, radB[0], radB[1]);
      gl.uniform2f(P.neb.u.uF, fq[0], fq[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // 1b. the sky at full resolution
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.sky.fb); gl.viewport(0, 0, W, H);
    gl.useProgram(P.sky.p); gl.bindVertexArray(V.empty); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.neb.tex); gl.uniform1i(P.sky.u.uNeb, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.lab); gl.uniform1i(P.sky.u.uLab, 1);
    const u = P.sky.u;
    gl.uniform2f(u.uRes, W, H); gl.uniform1f(u.uPx, PX); gl.uniform1f(u.uTime, now); gl.uniform1f(u.uFade, easeFade(S.fade)); gl.uniform1f(u.uGain, 1.0);
    gl.uniform2f(u.uFocus, S.focus.x * PX, S.focus.y * PX); gl.uniform1f(u.uFocusOn, S.focus.init ? 0.3 + 0.7 * S.focus.marks : 0);
    const gx = innerWidth * (aspect < 1 ? 0.8 : 0.1), gy = innerHeight * (aspect < 1 ? 0.62 : 0.84);
    gl.uniform4f(u.uGal, gx * PX + par[0] * 0.3, gy * PX + par[1] * 0.3, 34 * PX, 0.6);
    const met = [], metT = [];
    for (const m of S.meteors) { met.push(m.a[0] * PX, m.a[1] * PX, m.b[0] * PX, m.b[1] * PX); metT.push(m.t0, m.dur); }
    gl.uniform4fv(u.uMet, met); gl.uniform2fv(u.uMetT, metT);
    gl.uniform4f(u.uSat, S.sat.a[0] * PX, S.sat.a[1] * PX, S.sat.b[0] * PX, S.sat.b[1] * PX); gl.uniform3f(u.uSatT, S.sat.t0, S.sat.dur, S.sat.flare);
    const bu = new Float32Array(24).fill(-99);
    S.bursts.forEach((b, i) => { bu.set([b.x * PX, b.y * PX, b.t0, b.coral ? 1 : 0], i * 4); });
    gl.uniform4fv(u.uBurst, bu);
    const lpx = (q) => [q[0] * H + W / 2, q[1] * H + H / 2];
    const ma = lpx(lobeA), mb = lpx(lobeB);
    gl.uniform4f(u.uMeet, S.meetT ?? -99, 0, 0, 0); gl.uniform4f(u.uMeetA, ma[0], ma[1], mb[0], mb[1]);
    S.dim = (S.dim ?? 1) + ((S.dimT ?? 1) - (S.dim ?? 1)) * Math.min(1, (S.realDt ?? 0.016) * 2);
    gl.uniform1f(u.uDim, S.dim);
    // labels on the sky plane: the witnesses on either side of the ring, agreement under the star
    const labR = [], labC = [], labRow = [];
    const place = (row, x, y, align, rgb, a0) => {
      const L = S.labels[row]; if (!L) return;
      const ey = y / PX, ev = Math.min(1, Math.max(0, (ey - S.scroll.top) / 30)) * Math.min(1, Math.max(0, (S.scroll.bottom - 24 - ey) / 30));
      const a = a0 * S.focus.marks * ev; if (a < 0.01) return;
      const w = L.w * PX, m = 16 * PX; let lx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      lx = Math.min(Math.max(lx, m), W - m - w);
      labR.push(lx, y, w, L.h * PX); labC.push(rgb[0] * a, rgb[1] * a, rgb[2] * a, L.frac); labRow.push(row);
    };
    const fx = S.focus.x * PX, fy = S.focus.y * PX, rr = (S.focus.r || (tall ? 110 : 170)) * PX, gap = 30 * PX, lh = 17 * PX;
    const cyanL = [0.21, 0.81, 1], amberL = [1, 0.68, 0.27];
    if (!tall) {
      place(0, fx - rr - gap, fy - lh, "right", cyanL, 0.62); place(1, fx - rr - gap, fy, "right", cyanL, 0.38);
      place(2, fx + rr + gap, fy + lh * 2, "left", amberL, 0.6); place(3, fx + rr + gap, fy + lh * 3, "left", amberL, 0.36);
    }
    if (S.focus.init) place(4, fx, fy + spiralR() * PX + 30 * PX, "center", [1, 1, 1], 0.34);
    gl.uniform4fv(u.uLabR, labR.length ? labR : [0, 0, 0, 0]); gl.uniform4fv(u.uLabC, labC.length ? labC : [0, 0, 0, 0]);
    gl.uniform1fv(u.uLabR2, labRow.length ? labRow : [0]); gl.uniform1i(u.uNL, labR.length / 4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // stars and decisions, additive
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.stars.p); gl.bindVertexArray(V.stars);
    gl.uniform2f(P.stars.u.uRes, W, H); gl.uniform1f(P.stars.u.uPx, PX); gl.uniform1f(P.stars.u.uTime, now);
    gl.uniform1f(P.stars.u.uFade, S.fade); gl.uniform1f(P.stars.u.uTw, S.reduced ? 0 : 1); gl.uniform2f(P.stars.u.uPar, par[0], par[1]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.neb.tex); gl.uniform1i(P.stars.u.uNeb, 0);
    gl.drawArrays(gl.POINTS, 0, S.starN);
    if (S.marks.length && S.focus.marks > 0.01) {
      const path = [], data = [];
      for (const m of S.marks) { path.push(m.x * PX, m.y * PX); data.push(m.x * PX, m.y * PX, m.kind, m.born, m.kind === 0 ? 9 : 7.5, m.newest ? 1 : 0); }
      gl.useProgram(P.path.p); gl.bindVertexArray(V.path); gl.bindBuffer(gl.ARRAY_BUFFER, B.path);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([S.focus.x * PX, S.focus.y * PX, ...path]), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.uniform2f(P.path.u.uRes, W, H); gl.uniform1f(P.path.u.uA, 0.07 * S.fade * S.focus.marks);
      gl.drawArrays(gl.LINE_STRIP, 0, S.marks.length + 1);
      gl.useProgram(P.marks.p); gl.bindVertexArray(V.marks); gl.bindBuffer(gl.ARRAY_BUFFER, B.marks);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
      gl.uniform2f(P.marks.u.uRes, W, H); gl.uniform1f(P.marks.u.uPx, PX); gl.uniform1f(P.marks.u.uTime, now);
      gl.uniform1f(P.marks.u.uFade, S.fade * S.focus.marks); gl.uniform1f(P.marks.u.uHover, hoverIndex());
      gl.drawArrays(gl.POINTS, 0, S.marks.length);
    }
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, T.sky.tex); gl.generateMipmap(gl.TEXTURE_2D);


    // 2. glass, to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.useProgram(P.glass.p); gl.bindVertexArray(V.empty);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.sky.tex);
    const g = P.glass.u;
    gl.uniform1i(g.uSky, 0); gl.uniform2f(g.uRes, W, H); gl.uniform1f(g.uPx, PX); gl.uniform1f(g.uTime, now); gl.uniform1f(g.uSolid, S.solid ? 1 : 0);
    // the page's glass loses most of its lensing under an open sheet: never glass on glass
    S.back = (S.back ?? 0) + ((S.backT ?? 0) - (S.back ?? 0)) * Math.min(1, (S.realDt ?? 0.016) * 6);
    const back = 1 - 0.72 * S.back;
    const A = new Float32Array(MAXB * 4), Bv = new Float32Array(MAXB * 4), C = new Float32Array(MAXB * 4);
    let n = 0;
    for (const s of S.shapes) {
      const r = rectOf(s);
      if (!r || n >= MAXB) continue;
      const cx = (r.left + r.width / 2) * PX, cy = (r.top + r.height / 2) * PX, lensE = s.scroll ? s.lens * back : s.lens, fl = s.scroll ? 1 : 0;
      if (s.kind === 2) {
        const R = (Math.min(r.width, r.height) / 2 - s.tube) * PX;
        A.set([cx, cy, R, R], n * 4); Bv.set([0, 2, lensE, Math.max(0, s.press)], n * 4); C.set([clamp(s.fill + (S.slosh ?? 0), 0, 1), s.tube * PX, s.coral ? -1 : 0, fl], n * 4);
      } else {
        // pressed glass swells (a few points), and after the bounce settles back
        const inf = s.press * (s.kind === 0 ? 3 : 2);
        const hw = Math.max(0.5, (r.width / 2 + inf) * PX), hh = Math.max(0.5, (r.height / 2 + inf) * PX);
        A.set([cx, cy, hw, hh], n * 4); Bv.set([clamp((s.radius + inf) * PX, 0, Math.min(hw, hh)), s.kind, lensE, Math.max(0, s.press)], n * 4); C.set([0, 0, s.sweep ?? 0, fl], n * 4);
      }
      n++;
    }
    for (const b of S.blobs) {
      if (n >= MAXB) break;
      const q = b.lr, hw = Math.max(0.5, ((q.r - q.l) / 2) * PX), hh = Math.max(0.5, ((q.b - q.t) / 2) * PX), lq = b.liq ?? 0;
      const rad = clamp(q.q * PX, 0, Math.min(hw, hh)), round = rad + (Math.min(hw, hh, 90 * PX) - rad) * 0.8 * lq;
      A.set([((q.l + q.r) / 2) * PX, ((q.t + q.b) / 2) * PX, hw, hh], n * 4); Bv.set([Math.max(rad, round), b.kind, b.lens * back, 0.7 * lq], n * 4); C.set([0, 0, 0, 3], n * 4);
      n++;
    }
    gl.uniform1i(g.uN, n); gl.uniform4fv(g.uA, A); gl.uniform4fv(g.uB, Bv); gl.uniform4fv(g.uC, C); gl.uniform1f(g.uGK, S.gk * PX);
    // lenses inside the glass
    const LA = new Float32Array(MAXL * 4), LB = new Float32Array(MAXL * 4), LL = new Float32Array(MAXL);
    let nl = 0;
    for (const L of S.lenses) {
      if (nl >= MAXL || !L.lr || L.str < 0.004) continue;
      const q = L.lr, inf = 3 * L.lift, hw = Math.max(0.5, ((q.r - q.l) / 2 + inf) * PX), hh = Math.max(0.5, ((q.b - q.t) / 2 + inf) * PX);
      LA.set([((q.l + q.r) / 2) * PX, ((q.t + q.b) / 2) * PX, hw, hh], nl * 4);
      LB.set([clamp((q.q + inf) * PX, 0, Math.min(hw, hh)), L.str, L.height * (1 + 0.8 * L.lift), Math.min(1, L.tint * (1 + 0.3 * L.lift))], nl * 4);
      LL[nl] = L.layer; nl++;
    }
    gl.uniform1i(g.uNL, nl); gl.uniform4fv(g.uLA, LA); gl.uniform4fv(g.uLB, LB); gl.uniform1fv(g.uLL, LL);
    // the overlay: each shape, and the drop it is being pulled from (or is sinking into)
    const OA = new Float32Array(MAXO * 4), OB = new Float32Array(MAXO * 4);
    let no = 0;
    const putO = (q, kind, lensV, pr, lq = 0) => {
      if (no >= MAXO) return;
      const inf = pr * 2.5, hw = Math.max(0.5, ((q.r - q.l) / 2 + inf) * PX), hh = Math.max(0.5, ((q.b - q.t) / 2 + inf) * PX);
      const rad = clamp((q.q + inf) * PX, 0, Math.min(hw, hh)), round = rad + (Math.min(hw, hh, 120 * PX) - rad) * 0.7 * lq;
      OA.set([((q.l + q.r) / 2) * PX, ((q.t + q.b) / 2) * PX, hw, hh], no * 4);
      OB.set([Math.max(rad, round), kind, lensV, Math.max(0, pr) + 0.6 * lq], no * 4); no++;
    };
    for (const ov of S.overs) { putO(ov.lr, ov.kind, ov.lens, ov.press, ov.liq ?? 0); if (ov.tether) putO(ov.tether.lr, ov.kind, ov.lens, 0); }
    gl.uniform1i(g.uNO, no); gl.uniform4fv(g.uOA, OA); gl.uniform4fv(g.uOB, OB); gl.uniform1f(g.uOK, S.okk * PX);
    // drops
    const D = new Float32Array(MAXD * 4), DE = new Float32Array(MAXD * 4);
    let nd = 0;
    for (const d of S.drops) {
      if (nd >= MAXD) break;
      D.set([d.x * PX, d.y * PX, Math.max(0, d.r) * PX, d.cursor ? 2 : 1], nd * 4); DE.set([d.sx ?? 1, d.sy ?? 1, d.ax ?? 1, d.ay ?? 0], nd * 4); nd++;
    }
    gl.uniform1i(g.uND, nd); gl.uniform4fv(g.uD, D); gl.uniform4fv(g.uDE, DE);
    const c = S.cursor, t = S.touch;
    gl.uniform4f(g.uCur, c.px * PX, c.py * PX, c.glass * (S.reduced ? 0 : 1), c.fine && !S.reduced ? Math.max(c.on, c.glass) : 0);
    gl.uniform4f(g.uTouch, t ? t.x * PX : -1e4, t ? t.y * PX : -1e4, t && !S.reduced ? Math.max(0, t.rec.press) : 0, t ? t.layer : 0);
    gl.uniform2f(g.uLight, Math.cos(S.light), Math.sin(S.light));
    gl.uniform4f(g.uEdge, S.scroll.top * PX, S.scroll.bottom * PX, S.scroll.fade * PX, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const easeFade = (f) => 1 - Math.pow(1 - f, 3);
  function spiralR() { const m = S.marks[S.marks.length - 1]; return m ? Math.hypot(m.dx, m.dy) : 0; }

  function backdrop(on) { S.backT = on ? 1 : 0; }
  // (anything that animates keeps the page at full frame rate for a while)
  function sweep(el) { const s = find(el); S.lastInput = S.now; if (s && !S.reduced) s.sweep = S.now; }
  function ringState(el, coral) { const s = find(el); if (s) s.coral = !!coral; }
  function asleep(on) { S.dimT = on ? 0.72 : 1; }
  const debug = { meteor() { S.nextMeteor = 0; }, sat() { S.nextSat = 0; }, meet() { S.meetT = S.now; }, burst };
  function setScroll(y, top, bottom) { S.scroll.y = y; S.scroll.top = top; S.scroll.bottom = bottom; }
  function setScroller(el) { S.scroller = el; }
  function stats() { return window.__lanceaStats; }
  return {
    init, add, remove, show, setFill, press, burst, setDecisions, focus, markAt, markHover, markPos, setScroll, setScroller,
    backdrop, sweep, ringState, asleep, snapshot, flow, overlay, overlayOut, lens, hover, debug, stats,
    get ok() { return S.ok; }, get reduced() { return S.reduced; }, get solid() { return S.solid; }, get now() { return S.now; },
    get flowing() { return S.blobs.length > 0; },
  };
})();
