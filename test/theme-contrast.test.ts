import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'

/**
 * WCAG contrast for the design tokens, computed the way a browser composites: in gamma-encoded sRGB, with an
 * opacity utility applied over the surface the text sits on. `attachments/contrast.py` composites in linear light
 * and applies one alpha, so its numbers disagree with what a screen reader user sees.
 */
function oklchToLinear(L: number, C: number, H: number) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((value) => Math.min(1, Math.max(0, value)))
}
const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
const luminance = (rgb: number[]) =>
  0.2126 * decode(rgb[0]) + 0.7152 * decode(rgb[1]) + 0.0722 * decode(rgb[2])
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
/** `text-<token>/<alpha>`: the utility's alpha over the surface, both gamma-encoded, as CSS composites. */
function contrast(token: string, alpha: number, surface: string, tokens: Tokens) {
  const fg = oklchToLinear(...tokens[token]).map(encode)
  const bg = oklchToLinear(...tokens[surface]).map(encode)
  const mixed = fg.map((value, index) => value * alpha + bg[index] * (1 - alpha))
  return ratio(luminance(mixed), luminance(bg))
}

type Tokens = Record<string, [number, number, number]>

/** The token values in a `:root` or `.dark` block of `web/src/index.css`. */
function theme(selector: string): Tokens {
  const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8')
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`No ${selector} block in index.css`)
  const block = css.slice(start, css.indexOf('}', start))
  const tokens: Tokens = {}
  for (const [, name, L, C, H] of block.matchAll(
    /--([a-z-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\)/g,
  ))
    tokens[name] = [Number(L), Number(C), Number(H)]
  // A token may alias another (`--error: var(--destructive)`), so a lookup follows the reference.
  for (const [, name, target] of block.matchAll(/--([a-z-]+):\s*var\(--([a-z-]+)\)/g))
    if (tokens[target]) tokens[name] = tokens[target]
  return tokens
}

const light = theme(':root')
const dark = theme('.dark')

/** Every surface a piece of chrome text can sit on. */
const surfaces = ['background', 'card', 'popover', 'secondary', 'muted', 'accent', 'sidebar']
it.each([
  ['light', light],
  ['dark', dark],
])('%s dimmed text clears AA on every surface it is drawn on', (_name, tokens) => {
  // No opacity modifier is used on `muted-foreground`: a scalar alpha past roughly /80 cannot clear 4.5:1 at any
  // token lightness, so the token itself is the readable colour and `text-muted-foreground` is used bare.
  for (const surface of surfaces)
    expect(contrast('muted-foreground', 1, surface, tokens)).toBeGreaterThanOrEqual(4.5)
})

it.each([
  ['light', light],
  ['dark', dark],
])('%s control outlines clear 3:1 against the surfaces controls sit on', (_name, tokens) => {
  for (const surface of ['background', 'card'])
    expect(contrast('input', 1, surface, tokens), `--input on ${surface}`).toBeGreaterThanOrEqual(3)
})

it.each([
  ['light', light],
  ['dark', dark],
])('%s focus ring clears 3:1 wherever it is drawn', (_name, tokens) => {
  // The ring is opaque in the token; a call site must not dim it, which `ring-ring/` would.
  for (const surface of surfaces)
    expect(contrast('ring', 1, surface, tokens), `--ring on ${surface}`).toBeGreaterThanOrEqual(3)
})

it('light status colors clear AA on every surface, as text', () => {
  // Dark theme's are already far above it; light's were the failing pair (success 4.33, warning 3.89).
  for (const token of ['success', 'warning', 'error'])
    for (const surface of ['background', 'card', 'muted', 'secondary'])
      expect(contrast(token, 1, surface, light), `--${token} on ${surface}`).toBeGreaterThanOrEqual(
        4.5,
      )
})

it('never dims muted text with a partial opacity modifier', () => {
  // `text-muted-foreground/70` cannot clear 4.5:1 at any token lightness (an alpha over a light page tops out around
  // /80), so the token itself is the readable colour. `/0` is the one allowed value: hidden until hovered.
  const offenders: string[] = []
  for (const dir of ['web/src', 'extensions'])
    for (const file of readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })) {
      const path = String(file)
      if (!path.endsWith('.tsx')) continue
      const text = readFileSync(new URL(`../${dir}/${path}`, import.meta.url), 'utf8')
      if (/text-muted-foreground\/(?!0\b)\d/.test(text)) offenders.push(`${dir}/${path}`)
    }
  expect(offenders).toEqual([])
})

it.each([
  ['light', light],
  ['dark', dark],
])('%s never dims the focus indicator, including the global fallback outline', (_name, tokens) => {
  // `--ring` is opaque, so a call site's `/50` (or the base-layer `outline-ring/50`) composites it twice. The
  // fallback outline is what every focusable element gets before it opts into a ring, so it must clear 3:1 too.
  const css = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8')
  const dimmed = [...css.matchAll(/\b(?:outline|ring)-ring\/(?!0\b)\d+/g)].map((match) => match[0])
  expect(dimmed).toEqual([])
  for (const surface of surfaces)
    expect(contrast('ring', 1, surface, tokens), `--ring on ${surface}`).toBeGreaterThanOrEqual(3)
})
