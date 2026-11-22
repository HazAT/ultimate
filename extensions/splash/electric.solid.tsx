/** @jsxImportSource @solidjs/web */
import { Mesh, Program, Renderer, Texture, Triangle } from 'ogl'
import { createEffect } from 'solid-js'

const tracedRasterAreaPx = 640 * 640
const glowCellSizePx = 4
const FAR = 1e20
const ARCS = 5
const PIXEL_BUDGET = 4e6

interface Shape {
  signedDistanceField: Float32Array
  edgePointsInShapeUnits: number[]
  width: number
  height: number
  pad: number
  logoWidth: number
  logoHeight: number
  glow: Float32Array
  glowWidth: number
  glowHeight: number
  glowOffset: number
}

interface Spark {
  ax: number
  ay: number
  bx: number
  by: number
  bow: number
  seed: number
  born: number
  life: number
}

const hexToRgb = (hex: string) => {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  const n = Number.parseInt(h.slice(0, 6), 16)
  return Number.isNaN(n)
    ? [1, 1, 1]
    : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const transformLine = (
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
) => {
  let k = 0
  v[0] = 0
  z[0] = -FAR
  z[1] = FAR
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = FAR
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

const transformGrid = (grid: Float32Array, w: number, h: number) => {
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    transformLine(f, d, v, z, h)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    transformLine(f, d, v, z, w)
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]
  }
}

const blurLine = (
  src: Float32Array,
  dst: Float32Array,
  offset: number,
  stride: number,
  n: number,
  r: number,
) => {
  const scale = 1 / (2 * r + 1)
  let sum = 0
  for (let i = 0; i <= r && i < n; i++) sum += src[offset + i * stride]
  for (let i = 0; i < n; i++) {
    dst[offset + i * stride] = sum * scale
    if (i + r + 1 < n) sum += src[offset + (i + r + 1) * stride]
    if (i - r >= 0) sum -= src[offset + (i - r) * stride]
  }
}

const blurGrid = (grid: Float32Array, w: number, h: number, r: number) => {
  const tmp = new Float32Array(w * h)
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) blurLine(grid, tmp, y * w, 1, w, r)
    for (let x = 0; x < w; x++) blurLine(tmp, grid, x, w, h, r)
  }
}

const sampleField = (shape: Shape, x: number, y: number) => {
  const { signedDistanceField, width, height } = shape
  const cx = Math.min(Math.max(x, 0.5), width - 0.5)
  const cy = Math.min(Math.max(y, 0.5), height - 0.5)
  const x0 = Math.min(Math.floor(cx - 0.5), width - 2)
  const y0 = Math.min(Math.floor(cy - 0.5), height - 2)
  const tx = cx - 0.5 - x0
  const ty = cy - 0.5 - y0
  const i = y0 * width + x0
  const top = signedDistanceField[i] + (signedDistanceField[i + 1] - signedDistanceField[i]) * tx
  const bottom =
    signedDistanceField[i + width] +
    (signedDistanceField[i + width + 1] - signedDistanceField[i + width]) * tx
  return top + (bottom - top) * ty + Math.hypot(x - cx, y - cy)
}

const traceAlphaShape = (image: HTMLImageElement): Shape | undefined => {
  const iw = image.naturalWidth
  const ih = image.naturalHeight
  if (!iw || !ih) return undefined
  const fit = Math.sqrt(tracedRasterAreaPx / (iw * ih))
  const w = Math.max(2, Math.round(iw * fit))
  const h = Math.max(2, Math.round(ih * fit))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined
  ctx.drawImage(image, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const coverage = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) coverage[i] = data[i * 4 + 3] / 255

  let left = w
  let top = h
  let right = -1
  let bottom = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (coverage[y * w + x] <= 0.01) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return undefined

  const logoWidth = right - left + 1
  const logoHeight = bottom - top + 1
  const size = Math.sqrt(logoWidth * logoHeight)
  const pad = Math.ceil(size * 0.25) + 2
  const width = logoWidth + pad * 2
  const height = logoHeight + pad * 2
  const outer = new Float32Array(width * height)
  const inner = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - pad + left
      const sy = y - pad + top
      const a = sx >= 0 && sy >= 0 && sx < w && sy < h ? coverage[sy * w + sx] : 0
      const i = y * width + x
      if (a >= 1) {
        outer[i] = 0
        inner[i] = FAR
      } else if (a <= 0) {
        outer[i] = FAR
        inner[i] = 0
      } else {
        const e = 0.5 - a
        outer[i] = e > 0 ? e * e : 0
        inner[i] = e < 0 ? e * e : 0
      }
    }
  }
  transformGrid(outer, width, height)
  transformGrid(inner, width, height)

  const signedDistanceField = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++)
    signedDistanceField[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i])

  const points: number[] = []
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const d = signedDistanceField[i]
      if (d > 0) continue
      if (
        signedDistanceField[i - 1] <= 0 &&
        signedDistanceField[i + 1] <= 0 &&
        signedDistanceField[i - width] <= 0 &&
        signedDistanceField[i + width] <= 0
      )
        continue
      const gx = signedDistanceField[i + 1] - signedDistanceField[i - 1]
      const gy = signedDistanceField[i + width] - signedDistanceField[i - width]
      const len = Math.hypot(gx, gy) || 1
      points.push(x + 0.5 - (d * gx) / len, y + 0.5 - (d * gy) / len)
    }
  }
  const stride = Math.max(1, Math.ceil(points.length / 2 / 3000)) * 2
  const edgePointsInShapeUnits: number[] = []
  for (let i = 0; i < points.length; i += stride)
    edgePointsInShapeUnits.push(points[i], points[i + 1])

  const glowPad = Math.ceil((size * 0.7) / glowCellSizePx)
  const glowWidth = Math.ceil(logoWidth / glowCellSizePx) + glowPad * 2
  const glowHeight = Math.ceil(logoHeight / glowCellSizePx) + glowPad * 2
  const tight = new Float32Array(glowWidth * glowHeight)
  for (let y = 0; y < height; y++) {
    const gy = Math.floor((y - pad) / glowCellSizePx) + glowPad
    for (let x = 0; x < width; x++) {
      const gx = Math.floor((x - pad) / glowCellSizePx) + glowPad
      tight[gy * glowWidth + gx] +=
        Math.exp(-Math.abs(signedDistanceField[y * width + x]) / 1.5) /
        (glowCellSizePx * glowCellSizePx)
    }
  }
  const wide = tight.slice()
  const tightRadius = Math.max(1, Math.round((size * 0.035) / glowCellSizePx))
  const wideRadius = Math.max(2, Math.round((size * 0.13) / glowCellSizePx))
  blurGrid(tight, glowWidth, glowHeight, tightRadius)
  blurGrid(wide, glowWidth, glowHeight, wideRadius)
  const tightNorm =
    (Math.sqrt(2 * Math.PI * (tightRadius * tightRadius + tightRadius)) * glowCellSizePx) / 3
  const wideNorm =
    (Math.sqrt(2 * Math.PI * (wideRadius * wideRadius + wideRadius)) * glowCellSizePx) / 3
  const glow = new Float32Array(glowWidth * glowHeight * 2)
  for (let i = 0; i < glowWidth * glowHeight; i++) {
    glow[i * 2] = tight[i] * tightNorm
    glow[i * 2 + 1] = wide[i] * wideNorm
  }

  return {
    signedDistanceField,
    edgePointsInShapeUnits,
    width,
    height,
    pad,
    logoWidth,
    logoHeight,
    glow,
    glowWidth,
    glowHeight,
    glowOffset: pad - glowPad * glowCellSizePx,
  }
}

const outwardShapeArc = (
  shape: Shape,
  time: number,
  focus?: { x: number; y: number; radius: number },
): Spark | undefined => {
  const { edgePointsInShapeUnits, logoWidth, logoHeight } = shape
  const count = edgePointsInShapeUnits.length / 2
  if (count < 2) return undefined
  const size = Math.sqrt(logoWidth * logoHeight)
  let i = Math.floor(Math.random() * count)
  if (focus) {
    let found = false
    for (let attempt = 0; attempt < 40 && !found; attempt++) {
      const j = Math.floor(Math.random() * count)
      if (
        Math.hypot(
          edgePointsInShapeUnits[j * 2] - focus.x,
          edgePointsInShapeUnits[j * 2 + 1] - focus.y,
        ) < focus.radius
      ) {
        i = j
        found = true
      }
    }
    if (!found) return undefined
  }
  const ax = edgePointsInShapeUnits[i * 2]
  const ay = edgePointsInShapeUnits[i * 2 + 1]
  for (let attempt = 0; attempt < 24; attempt++) {
    const j = Math.floor(Math.random() * count)
    const bx = edgePointsInShapeUnits[j * 2]
    const by = edgePointsInShapeUnits[j * 2 + 1]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < size * 0.08 || len > size * 0.3) continue
    const nx = -(by - ay) / len
    const ny = (bx - ax) / len
    const bow = len * (0.2 + Math.random() * 0.3)
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    const left = sampleField(shape, mx + nx * bow, my + ny * bow)
    const right = sampleField(shape, mx - nx * bow, my - ny * bow)
    if (Math.max(left, right) <= 0) continue
    return {
      ax,
      ay,
      bx,
      by,
      bow: left >= right ? bow : -bow,
      seed: 1 + Math.random() * 60,
      born: time,
      life: 0.35 + Math.random() * 0.45,
    }
  }
  return undefined
}

const vertex = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const fragment = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D tField;
uniform sampler2D tGlow;
uniform vec4 uMap;
uniform vec4 uSize;
uniform vec2 uResolution;
uniform float uUnit;
uniform float uTime;
uniform float uPresence;
uniform float uSweep;
uniform float uHead;
uniform vec4 uPulse;
uniform float uFlash;
uniform vec3 uColor;
uniform vec3 uGlowColor;
uniform float uIntensity;
uniform float uGlow;
uniform float uThickness;
uniform float uStrands;
uniform float uBend;
uniform float uCrackle;
uniform float uFlicker;
uniform float uFill;
uniform float uInk;
uniform vec4 uArcEnds[${ARCS}];
uniform vec4 uArcShape[${ARCS}];

in vec2 vUv;
out vec4 fragColor;

uint scramble(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float shape(vec2 p) {
  vec2 f = (p - uMap.xy) / uMap.z;
  vec2 c = clamp(f, vec2(0.5), uSize.xy - 0.5);
  return (textureLod(tField, c / uSize.xy, 0.0).r + length(f - c)) * uMap.z;
}

vec2 aura(vec2 p) {
  vec2 f = (p - uMap.xy) / uMap.z - uMap.w;
  return textureLod(tGlow, f / (uSize.zw * ${glowCellSizePx}.0), 0.0).rg;
}

vec4 corner(ivec2 c, uint seed) {
  uint h = scramble(uint(c.x) * 0x8da6b343u + uint(c.y) * 0xd8163841u + seed * 0xcb1ab31fu);
  return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) / 127.5 - 1.0;
}

vec2 drift(vec2 p, uint seed, out mat2 jac) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  ivec2 c = ivec2(i);
  vec4 ga = corner(c, seed);
  vec4 gb = corner(c + ivec2(1, 0), seed);
  vec4 gc = corner(c + ivec2(0, 1), seed);
  vec4 gd = corner(c + ivec2(1, 1), seed);
  vec2 fb = f - vec2(1.0, 0.0);
  vec2 fc = f - vec2(0.0, 1.0);
  vec2 fd = f - vec2(1.0);
  vec2 va = vec2(dot(ga.xy, f), dot(ga.zw, f));
  vec2 vb = vec2(dot(gb.xy, fb), dot(gb.zw, fb));
  vec2 vc = vec2(dot(gc.xy, fc), dot(gc.zw, fc));
  vec2 vd = vec2(dot(gd.xy, fd), dot(gd.zw, fd));
  vec2 k = va - vb - vc + vd;
  vec4 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd);
  jac = mat2(
    g.xy + du * (u.yx * k.x + vec2(vb.x - va.x, vc.x - va.x)),
    g.zw + du * (u.yx * k.y + vec2(vb.y - va.y, vc.y - va.y))
  );
  return va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
}

float wobble(vec2 p, uint seed) {
  mat2 jac;
  return drift(p, seed, jac).x;
}

vec2 wander(vec2 p, float t, uint seed, float reachScale, out mat2 jac, out vec2 sway) {
  vec2 q = p / uUnit;
  mat2 ja;
  mat2 jb;
  mat2 jc;
  mat2 jd;
  vec2 a = drift(q * 0.028 + vec2(t * 0.29, t * 0.21), seed, ja);
  vec2 b = drift(q * 0.085 + a * 0.4 + vec2(t * 0.83, -t * 0.61) + 17.0, seed + 1u, jb);
  vec2 c = drift(p / 9.0 + b * 0.6 + vec2(t * 1.9, t * 1.3) + 5.0, seed + 2u, jc);
  vec2 d = drift(p / 4.1 + vec2(-t * 2.7, t * 2.2) + 11.0, seed + 3u, jd);
  float bendAmp = uBend * 8.0 * reachScale;
  float rippleAmp = uBend * 3.2 * reachScale;
  float crinkleAmp = uCrackle * 1.5 * reachScale;
  jac = ja * (0.028 * bendAmp) + jb * (0.085 * rippleAmp) + jc * (crinkleAmp / 9.0) + jd * (crinkleAmp * 0.35 / 4.1);
  sway = (a * bendAmp + b * rippleAmp) * uUnit;
  return sway + (c + d * 0.35) * crinkleAmp;
}

vec2 ripple(vec2 p, out float surge) {
  surge = 0.0;
  if (uPulse.w <= 0.0) return vec2(0.0);
  float shapeHalfWidth = uMap.z * uSize.x * 0.5;
  vec2 d = p - uPulse.xy;
  float dist = length(d);
  float halfWidthsPerSecond = 2.2;
  float ringWidthFraction = 0.2;
  float front = (dist - uPulse.z * shapeHalfWidth * halfWidthsPerSecond) / (shapeHalfWidth * ringWidthFraction);
  surge = exp(-front * front) * uPulse.w * exp(-uPulse.z * 1.7) * smoothstep(shapeHalfWidth * 0.05, shapeHalfWidth * 0.3, dist);
  return d / max(dist, 1.0) * surge * cos(front * 2.2) * uUnit * 7.5;
}

vec2 glowShape(float line, float spread, float w) {
  float x = abs(line);
  float y = abs(spread);
  return vec2(exp(-x * x / (w * w * 0.5)) + exp(-y / (w * 2.2)) * 0.6, exp(-y / (w * 4.5)) * 0.5);
}

void addArc(vec2 p, vec4 ends, vec4 info, float t, inout vec3 light, inout float energy, inout float hot) {
  if (info.y < 0.002) return;
  vec2 ab = ends.zw - ends.xy;
  float len = max(length(ab), 1.0);
  vec2 dir = ab / len;
  vec2 rel = p - ends.xy;
  float s = dot(rel, dir);
  float h = dot(rel, vec2(-dir.y, dir.x));
  float margin = abs(info.x) + uCrackle * (2.0 + len * 0.08) + uThickness * 12.0 + 10.0;
  if (s < -margin || s > len + margin || abs(h) > margin) return;
  float u = clamp(s / len, 0.0, 1.0);
  float taper = sin(3.14159265 * u);
  float bendSlope = s > 0.0 && s < len ? 3.14159265 / len * cos(3.14159265 * u) : 0.0;
  float beyond = max(-s, 0.0) + max(s - len, 0.0);
  for (int c = 0; c < 2; c++) {
    uint seed = uint(info.z * 131.0) + uint(c) * 29u + 7u;
    float jag = 0.0;
    float jagSlope = 0.0;
    float wave = max(len * 0.3, 14.0);
    float weight = uCrackle * (1.5 + len * 0.05) * (c == 0 ? 1.0 : 1.5);
    for (int o = 0; o < 3; o++) {
      mat2 jac;
      float n = drift(vec2(s / wave + info.z * 3.0, t * (1.4 + float(o) * 1.1)), seed + uint(o), jac).x;
      jag += n * weight;
      jagSlope += jac[0].x * weight / wave;
      wave *= 0.42;
      weight *= 0.4;
    }
    float offset = (info.x + jag) * taper;
    float offsetSlope = (info.x + jag) * bendSlope + jagSlope * taper;
    float across = (h - offset) / sqrt(1.0 + offsetSlope * offsetSlope);
    float gap = length(vec2(beyond, across));
    float w = uThickness * (c == 0 ? 0.9 : 0.6);
    vec2 g = glowShape(gap, gap, w);
    float k = info.y * (c == 0 ? 1.0 : 0.45);
    light += (uColor * g.x + uGlowColor * g.y * uGlow) * k;
    energy += (g.x + g.y * uGlow) * k;
    hot += exp(-gap * gap / (w * w * 0.16)) * k * (c == 0 ? 1.0 : 0.0);
  }
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  float t = uTime;
  vec3 light = vec3(0.0);
  float energy = 0.0;
  float hot = 0.0;

  float surge;
  vec2 pr = p - ripple(p, surge);
  float heat = min(surge * 1.4, 2.0);
  float heatCap = min(exp(-uPulse.z * 1.7) * uPulse.w * 1.4, 2.0);
  float base = shape(pr);
  float breath = 1.0 + uFlicker * 0.6 * wobble(vec2(t * 2.1, 7.0), 3u);
  float soft = uUnit * 40.0;
  float grow = uPresence * smoothstep(uSweep + soft, uSweep - soft, p.x);
  float front = (p.x - uSweep) / (uUnit * 20.0);
  float head = uHead * exp(-front * front);

  float edge = abs(base);
  vec2 halo = aura(pr);
  float ink = uInk;
  float bloom = (halo.x * 0.16 + halo.y * 0.08) * (1.0 - ink * 0.65) * uGlow * (1.0 + heat * 1.2);
  float body = smoothstep(0.75, -0.75, base) * uFill * (0.06 + 1.2 * min(halo.x, 1.0));
  light += uGlowColor * bloom * grow * grow;
  energy += bloom * grow * grow;

  float reachScale = mix(0.15, 1.0, grow) * (1.0 + heat * 0.9);
  float reach = (uUnit * uBend * 16.0 + uCrackle * 3.0) * (1.0 + heatCap * 0.9) + uThickness * 20.0 + 8.0;
  if (edge < reach && grow > 0.0) {
    float fade = smoothstep(reach, reach * 0.55, edge);
    vec2 q = pr / uUnit;
    float count = min(uStrands + heat * 2.5, 6.0);
    float limit = min(uStrands + heatCap * 2.5, 6.0);
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      if (fi >= limit) break;
      float present = clamp(count - fi, 0.0, 1.0);
      if (present <= 0.0) continue;
      uint seed = uint(i) * 7u + 3u;
      mat2 jac;
      vec2 sway;
      float lead = i == 0 ? 1.0 : 0.0;
      vec2 warped = pr + wander(pr, t * (1.0 + fi * 0.19), seed, reachScale * mix(0.6 + fi * 0.2, 0.7, lead), jac, sway);
      float dw = shape(warped);
      vec2 slope = vec2(shape(warped + vec2(1.0, 0.0)), shape(warped + vec2(0.0, 1.0))) - dw;
      float d = dw / max(length(slope + jac * slope), 0.3);
      float spread = shape(pr + sway);
      float swell = 0.5 + 0.5 * wobble(q * 0.06 + vec2(t * 0.9, fi * 5.1 - t * 0.6), seed + 8u);
      float w = uThickness * mix(0.5, 1.0, lead) * (0.5 + swell);
      float vis = mix(0.3 + 0.45 * smoothstep(-0.25, 0.2, wobble(q * 0.035 + vec2(t * 0.21, fi * 3.7), seed + 5u)), 1.0, lead);
      float spark = 1.0 - uFlicker * 0.3 * (0.5 + 0.5 * wobble(vec2(t * 6.0, fi * 2.3), seed + 6u));
      float weight = max(vis, heat * 0.85) * spark * fade * present * (0.7 + 0.6 * swell);
      vec2 g = glowShape(d, spread, w) * weight;
      float soft = mix(1.0, mix(0.5, 1.0, lead), ink);
      vec3 stroke = mix(uColor, uGlowColor, ink * (1.0 - lead) * 0.65);
      float haze = uGlow * (1.0 + heat) * (1.0 - ink * 0.7);
      light += stroke * g.x * soft + uGlowColor * g.y * haze;
      energy += g.x * soft + g.y * haze;
      hot += exp(-d * d / (w * w * 0.16)) * lead * weight;
    }
    light *= grow;
    energy *= grow;
  }

  for (int i = 0; i < ${ARCS}; i++) addArc(pr, uArcEnds[i], uArcShape[i], t, light, energy, hot);

  float gain = uIntensity * breath * 1.4 * (1.0 + head * 2.0) * (1.0 + heat * 0.45) * (1.0 + uFlash * 0.3);
  float alpha = 1.0 - exp(-energy * gain);
  vec3 color = mix(1.0 - exp(-light * gain), alpha * light / max(energy, 1e-4), ink);
  color = mix(color, vec3(alpha), clamp(hot * grow, 0.0, 1.0) * ink * 0.85);
  float tint = (1.0 - exp(-body * gain * 1.2)) * grow * grow * (1.0 - ink * 0.82);
  color += uGlowColor * tint * (1.0 - alpha);
  alpha += tint * (1.0 - alpha);
  float grain = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
  alpha = clamp(alpha + grain, 0.0, 1.0);
  fragColor = vec4(clamp(color + grain, 0.0, alpha), alpha);
}
`

export interface ElectricProps {
  alphaImageSrc: string
  color: string
  glowColor: string
  containerSizeFraction?: number
  intensity?: number
  glow?: number
  strandWidthPx?: number
  outlineFilaments?: number
  bend?: number
  crackle?: number
  edgeArcRate?: number
  flicker?: number
  fill?: number
  speed?: number
  presence: () => number
  sweepLeftToRight?: () => number
  burstCount?: () => number
  theme: 'dark' | 'light'
  class?: string
}

export function Electric(props: ElectricProps) {
  let element: HTMLDivElement | undefined
  const attach = (src: string) => {
    if (!element) return undefined
    const renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: false })
    const gl = renderer.gl
    if (!renderer.isWebgl2) {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return undefined
    }
    gl.clearColor(0, 0, 0, 0)
    const canvas = gl.canvas
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    element.appendChild(canvas)

    const texture = (channels: number, internalFormat: number, format: number) =>
      new Texture(gl, {
        image: new Float32Array(channels),
        width: 1,
        height: 1,
        internalFormat,
        format,
        type: gl.FLOAT,
        minFilter: gl.LINEAR,
        magFilter: gl.LINEAR,
        generateMipmaps: false,
        flipY: false,
        unpackAlignment: 1,
      })
    const signedDistanceField = texture(1, WebGL2RenderingContext.R16F, WebGL2RenderingContext.RED)
    const halo = texture(2, WebGL2RenderingContext.RG16F, WebGL2RenderingContext.RG)
    const arcEnds = Array.from({ length: ARCS * 4 }, () => 0)
    const arcShape = Array.from({ length: ARCS * 4 }, () => 0)
    const uniforms = {
      tField: { value: signedDistanceField },
      tGlow: { value: halo },
      uMap: { value: [0, 0, 1, 0] },
      uSize: { value: [1, 1, 1, 1] },
      uResolution: { value: [1, 1] },
      uUnit: { value: 1 },
      uTime: { value: 0 },
      uPresence: { value: 0 },
      uSweep: { value: 0 },
      uHead: { value: 0 },
      uPulse: { value: [0, 0, 0, 0] },
      uFlash: { value: 0 },
      uColor: { value: [1, 1, 1] },
      uGlowColor: { value: [1, 1, 1] },
      uIntensity: { value: 1 },
      uGlow: { value: 1 },
      uThickness: { value: 1.5 },
      uStrands: { value: 4 },
      uBend: { value: 0.6 },
      uCrackle: { value: 1.5 },
      uFlicker: { value: 0.6 },
      uFill: { value: 0 },
      uInk: { value: 0 },
      uArcEnds: { value: arcEnds },
      uArcShape: { value: arcShape },
    }
    const mesh = new Mesh(gl, {
      geometry: new Triangle(gl),
      program: new Program(gl, {
        vertex,
        fragment,
        uniforms,
        depthTest: false,
        depthWrite: false,
      }),
    })

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    const sparks: Spark[] = []
    let shape: Shape | undefined
    let ink: number | undefined
    let time = 0
    let bursts = 0
    let pulse: number | undefined
    let width = 1
    let height = 1
    let raf = 0
    let last = performance.now()
    let visible = true

    const image = new Image()
    image.decoding = 'async'
    const traced = () => {
      shape = traceAlphaShape(image)
      if (!shape) return
      signedDistanceField.image = shape.signedDistanceField
      signedDistanceField.width = shape.width
      signedDistanceField.height = shape.height
      signedDistanceField.needsUpdate = true
      halo.image = shape.glow
      halo.width = shape.glowWidth
      halo.height = shape.glowHeight
      halo.needsUpdate = true
    }
    image.addEventListener('load', traced)
    image.src = src

    const resize = () => {
      width = Math.max(1, element.clientWidth)
      height = Math.max(1, element.clientHeight)
      renderer.dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / (width * height)))
      renderer.setSize(width, height)
      uniforms.uResolution.value = [width, height]
    }

    const frame = (now: number) => {
      raf = 0
      const s = props
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now
      if (shape) {
        const presence = s.presence()
        const reveal = s.sweepLeftToRight?.() ?? 1
        const scale = s.containerSizeFraction ?? 0.7
        const speed = s.speed ?? 2.5
        const arcs = s.edgeArcRate ?? 1
        const fit = Math.max(
          1e-4,
          Math.min((width * scale) / shape.logoWidth, (height * scale) / shape.logoHeight),
        )
        const ox = width / 2 - (shape.pad + shape.logoWidth / 2) * fit
        const oy = height / 2 - (shape.pad + shape.logoHeight / 2) * fit
        time += dt * speed * (reducedMotion ? 0.2 : 1)

        for (let i = sparks.length - 1; i >= 0; i--)
          if (time - sparks[i].born > sparks[i].life) sparks.splice(i, 1)
        const fired = s.burstCount?.() ?? 0
        if (fired > bursts && !reducedMotion) {
          pulse = now
          sparks.length = 0
          const centre = {
            x: shape.pad + shape.logoWidth / 2,
            y: shape.pad + shape.logoHeight / 2,
          }
          for (let i = 0; i < ARCS * 3 && sparks.length < ARCS; i++) {
            const spark = outwardShapeArc(shape, time, {
              ...centre,
              radius: shape.logoWidth * 0.3,
            })
            if (spark) sparks.push(spark)
          }
        }
        bursts = fired
        const age = pulse === undefined ? 0 : (now - pulse) / 1000
        if (age > 2) pulse = undefined
        uniforms.uPulse.value = [width / 2, height / 2, age, pulse === undefined ? 0 : 1]
        uniforms.uFlash.value = pulse === undefined ? 0 : Math.exp(-age * 7)
        if (
          !reducedMotion &&
          presence > 0.8 &&
          reveal >= 1 &&
          sparks.length < ARCS &&
          Math.random() < dt * speed * arcs * 2.2
        ) {
          const spark = outwardShapeArc(shape, time)
          if (spark) sparks.push(spark)
        }
        for (let i = 0; i < ARCS; i++) {
          const o = i * 4
          const spark = sparks[i]
          if (!spark) {
            arcShape[o + 1] = 0
            continue
          }
          const k = (time - spark.born) / spark.life
          arcEnds[o] = ox + spark.ax * fit
          arcEnds[o + 1] = oy + spark.ay * fit
          arcEnds[o + 2] = ox + spark.bx * fit
          arcEnds[o + 3] = oy + spark.by * fit
          arcShape[o] = spark.bow * fit
          arcShape[o + 1] = Math.sin(Math.PI * Math.min(1, Math.max(0, k))) * presence
          arcShape[o + 2] = spark.seed
        }

        const targetInk = s.theme === 'light' ? 1 : 0
        ink ??= targetInk
        ink += (targetInk - ink) * (1 - Math.exp(-dt / 0.25))
        uniforms.uMap.value = [ox, oy, fit, shape.glowOffset]
        uniforms.uSize.value = [shape.width, shape.height, shape.glowWidth, shape.glowHeight]
        uniforms.uUnit.value = (Math.sqrt(shape.logoWidth * shape.logoHeight) * fit) / 100
        uniforms.uTime.value = time
        uniforms.uPresence.value = presence
        uniforms.uSweep.value =
          reveal >= 1 ? width * 4 : ox + (shape.pad + shape.logoWidth * reveal) * fit
        uniforms.uHead.value = Math.sin(Math.PI * Math.min(1, reveal))
        uniforms.uColor.value = hexToRgb(s.color)
        uniforms.uGlowColor.value = hexToRgb(s.glowColor)
        uniforms.uIntensity.value = s.intensity ?? 1
        uniforms.uGlow.value = s.glow ?? 1
        uniforms.uThickness.value = s.strandWidthPx ?? 1.5
        uniforms.uStrands.value = Math.max(1, Math.min(6, Math.round(s.outlineFilaments ?? 4)))
        uniforms.uBend.value = s.bend ?? 0.6
        uniforms.uCrackle.value = s.crackle ?? 1.5
        uniforms.uFlicker.value = reducedMotion ? 0 : (s.flicker ?? 0.6)
        uniforms.uFill.value = s.fill ?? 0
        uniforms.uInk.value = ink
        renderer.render({ scene: mesh })
      }
      if (visible) raf = requestAnimationFrame(frame)
    }

    const start = () => {
      if (raf || !visible) return
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(element)
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      start()
    })
    intersectionObserver.observe(element)
    resize()
    start()

    return () => {
      visible = false
      cancelAnimationFrame(raf)
      image.removeEventListener('load', traced)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }
  createEffect(() => props.alphaImageSrc, attach)

  return <div class={props.class} ref={element} />
}
