// Interleaved A/B of conversation switches: two servers on copies of one paused snapshot, measured in turns.
// Usage: node paired.ts <url A> <url B> <start id> <id,id,...> [--runs 6] [--rounds 3]
// Each run is one `switch.ts` session; runs alternate A, B, A, B…, so machine load drifts onto both sides alike.
// Prints the medians per side over every warm switch (rounds after the first), and B minus A.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const [a, b, start, list] = args
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
if (!a || !b || !start || !list)
  throw new Error('Usage: node paired.ts <url A> <url B> <start id> <id,id,...> [--runs 6]')
const runs = Number(flag('--runs') ?? 6)
const rounds = flag('--rounds') ?? '3'
const script = fileURLToPath(new URL('switch.ts', import.meta.url))

type Row = Record<string, number>
const warm: Record<'A' | 'B', Row[]> = { A: [], B: [] }
for (let run = 0; run < runs; run++)
  for (const [side, url] of [
    ['A', a],
    ['B', b],
  ] as const) {
    const out = execFileSync('node', [script, url, start, list, '--rounds', rounds], {
      encoding: 'utf8',
    })
    const rows = out
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Row)
      .filter((row) => row.round > 0)
    warm[side].push(...rows)
    const settled = median(rows.map((row) => row.settledMs))
    console.log(`run ${run} ${side}: warm settledMs median ${settled} (${rows.length} switches)`)
  }

function median(values: number[]) {
  return values.toSorted((x, y) => x - y)[Math.floor(values.length / 2)]
}
const keys = ['viewMs', 'settledMs', 'longMs', 'maxLongMs', 'eventKb']
const sides = Object.fromEntries(
  (['A', 'B'] as const).map((side) => [
    side,
    Object.fromEntries(keys.map((key) => [key, median(warm[side].map((row) => row[key]))])),
  ]),
)
console.log('warm medians A:', sides.A)
console.log('warm medians B:', sides.B)
console.log('B - A:', Object.fromEntries(keys.map((key) => [key, sides.B[key] - sides.A[key]])))
