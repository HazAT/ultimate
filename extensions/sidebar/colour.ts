const UNRESERVED_COOL_HUES = [145, 162, 179, 196, 213, 230, 247]
const ULTIMATE_BRAND_COLOUR = { hue: 300, chroma: 0.11 }
const PROJECT_CHROMA = 0.06
const SIBLING_LIGHTNESS_AND_HUE_OFFSETS = [
  { lightnessOffset: 0, hueOffset: 0 },
  { lightnessOffset: -0.1, hueOffset: 8 },
  { lightnessOffset: 0.09, hueOffset: -8 },
  { lightnessOffset: -0.17, hueOffset: 14 },
  { lightnessOffset: 0.15, hueOffset: -14 },
]

const hash = (text: string) => {
  let value = 0
  for (const char of text) value = (value * 31 + char.codePointAt(0)!) >>> 0
  return value
}

export const stemOf = (name: string) => name.toLowerCase().split(/[-_.\s]+/)[0] ?? ''

export function colourOf(name: string, family: readonly string[] = []) {
  const key = name.toLowerCase()
  const stem = stemOf(key)
  const siblings = [...new Set(family.map((item) => item.toLowerCase()))]
    .filter((item) => item !== stem && stemOf(item) === stem)
    .toSorted()
  const place = siblings.indexOf(key)
  const shade =
    SIBLING_LIGHTNESS_AND_HUE_OFFSETS[
      key === stem
        ? 0
        : 1 +
          ((place >= 0 ? place : hash(key.slice(stem.length))) %
            (SIBLING_LIGHTNESS_AND_HUE_OFFSETS.length - 1))
    ]
  const brand = stem === 'ultimate'
  return {
    hue:
      (brand
        ? ULTIMATE_BRAND_COLOUR.hue
        : UNRESERVED_COOL_HUES[hash(stem) % UNRESERVED_COOL_HUES.length]) + shade.hueOffset,
    chroma: brand ? ULTIMATE_BRAND_COLOUR.chroma : PROJECT_CHROMA,
    lightness: shade.lightnessOffset,
  }
}

export const swatchClass =
  'block shrink-0 bg-[oklch(calc(0.74_+_var(--swatch-l))_var(--swatch-c)_var(--swatch-h))] transition-opacity dark:bg-[oklch(calc(0.6_+_var(--swatch-l))_var(--swatch-c)_var(--swatch-h))]'

export function swatchStyle(folder: string, family?: readonly string[]) {
  const { hue, chroma, lightness } = colourOf(folder, family)
  return { '--swatch-h': `${hue}`, '--swatch-c': `${chroma}`, '--swatch-l': `${lightness}` }
}

export const githubMarkPath =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'

export const isHiddenRepo = (visibility: string | undefined) =>
  visibility === 'private' || visibility === 'internal'
