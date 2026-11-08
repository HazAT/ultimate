// What the repository weighs in estimated tokens (bytes ÷ 4, `lib/token-weight.ts`): by area, the heaviest files and
// the weekly trend from history. Usage: pnpm weigh [rev] (default HEAD).
import { git } from '../lib/git.ts'
import { areas, filesAt, tokensOf } from '../lib/token-weight.ts'
import { formatTokens } from '../web/src/sdk/format.ts'

const cwd = process.cwd()
const rev = process.argv[2] ?? 'HEAD'
const files = await filesAt(cwd, rev)
const sum = (list: { bytes: number }[]) =>
  tokensOf(list.reduce((total, file) => total + file.bytes, 0))
const total = sum(files)
const row = (...cells: string[]) =>
  cells[0].padEnd(12) +
  cells
    .slice(1)
    .map((cell) => cell.padStart(8))
    .join('')

console.log(row('area', 'files', 'tokens', 'share'))
for (const area of areas) {
  const own = files.filter((file) => file.area === area)
  if (own.length)
    console.log(
      row(
        area,
        String(own.length),
        formatTokens(sum(own)),
        `${Math.round((sum(own) / total) * 100)}%`,
      ),
    )
}
console.log(row('total', String(files.length), formatTokens(total), ''))

console.log('\nheaviest files')
for (const file of files.toSorted((a, b) => b.bytes - a.bytes).slice(0, 10))
  console.log(`${formatTokens(tokensOf(file.bytes)).padStart(6)}  ${file.path}`)

console.log('\nweekly trend')
const weeks: string[] = []
for (let at = Date.now(); weeks.length < 8; at -= 7 * 24 * 3600 * 1000) {
  const day = new Date(at).toISOString().slice(0, 10)
  const commit = await git(cwd, 'rev-list', '-1', `--before=${day} 23:59`, rev)
  if (!commit) break
  const then = sum(await filesAt(cwd, commit))
  weeks.unshift(`${day}  ${formatTokens(then).padStart(6)}`)
}
for (const week of weeks) console.log(week)
