export const variants = [
  {
    id: 'chiptune',
    label: 'Chiptune',
    detail: '8-bit: coins for wins, a power-up when work lands',
  },
  { id: 'orchestra', label: 'Orchestra', detail: 'Each role an instrument, one key and tempo' },
  { id: 'crazy', label: 'Crazy', detail: 'Drums and glitches for every call, crunchy and loud' },
] as const
export type Variant = (typeof variants)[number]['id']

export const variantOf = (stored: string) =>
  variants.find((variant) => variant.id === (stored === 'ambient' ? 'chiptune' : stored))
