import { expect, it } from 'vitest'
import { formatBashCommand } from '../../bash-command.tsx'

const steps = (command: string) =>
  formatBashCommand(command).steps.map(({ operator, text }) =>
    operator ? [operator, text] : [text],
  )

it('splits lists at the operators bash runs, keeping pipes and redirects within a step', () => {
  const command = 'pnpm check 2>&1 | tail -20 && git add -A || echo failed; git status &'
  expect(steps(command)).toEqual([
    ['pnpm check 2>&1 | tail -20'],
    ['&&', 'git add -A'],
    ['||', 'echo failed'],
    [';', 'git status &'],
  ])
  expect(formatBashCommand(command).summary).toBe(
    'pnpm check | tail && git add || echo; git status &',
  )
})

it('ignores operators and program names inside quotes, substitutions, and heredocs', () => {
  const command = `git commit -m "fix: run pnpm test && git push later" && echo "$(date; id)"`
  expect(steps(command)).toEqual([
    ['git commit -m "fix: run pnpm test && git push later"'],
    ['&&', 'echo "$(date; id)"'],
  ])
  expect(formatBashCommand(command).summary).toBe('git commit && echo')
  const heredoc = "cat > notes.md <<'EOF'\npnpm test && git push\nEOF"
  expect(formatBashCommand(heredoc).summary).toBe('cat')
})

it("lists each step's pipeline programs for the header arrows", () => {
  expect(
    formatBashCommand(
      'git -C x status 2>&1 | head -3 && timeout 5 pnpm test || echo no; for f in a; do :; done | sort',
    ).steps.map((step) => step.programs),
  ).toEqual([['git status', 'head'], ['pnpm test'], ['echo'], ['for', 'sort']])
})

it('names programs through wrappers, env assignments, git -C and package runners', () => {
  for (const [command, summary] of [
    ['timeout 120 pnpm test test/a.test.ts 2>&1 | tail -20', 'pnpm test | tail'],
    ['ULTIMATE_FAUX=1 env PORT=4800 pnpm start --no-open', 'pnpm start'],
    ['git -C /home/haza/Projects/ultimate push origin main', 'git push'],
    ['pnpm exec vp check', 'pnpm exec vp'],
    ['sudo -n rm -rf /tmp/x', 'rm'],
    ['for f in *.ts; do wc -l "$f"; done | sort -n', 'for | sort'],
    ['pnpm check || { tail -40 log; exit 1; }', 'pnpm check || { }'],
  ])
    expect(formatBashCommand(command).summary).toBe(summary)
})

it('extracts every heredoc body with a file name that picks its highlighting', () => {
  const command = [
    "cd /work && cat > src/a.ts <<'EOF'",
    'export const a = 1',
    'EOF',
    'python3 - <<PY',
    'print(1)',
    'PY',
    'node --input-type=module <<"JS" | head',
    'console.log(1)',
    'JS',
    'git commit -F - <<MSG',
    'feat: x',
    'MSG',
  ].join('\n')
  const display = formatBashCommand(command)
  expect(display.directory).toBe('/work')
  expect(display.summary).toBe('cat; python3; node | head; git commit')
  expect(display.steps.map((step) => step.heredocs)).toEqual([
    [{ body: 'export const a = 1\n', closing: 'EOF', file: 'src/a.ts' }],
    [{ body: 'print(1)\n', closing: 'PY', file: 'heredoc.py' }],
    [{ body: 'console.log(1)\n', closing: 'JS', file: 'heredoc.js' }],
    [{ body: 'feat: x\n', closing: 'MSG' }],
  ])
  expect(display.steps.map((step) => step.text)).toEqual([
    "cat > src/a.ts <<'EOF'",
    'python3 - <<PY',
    'node --input-type=module <<"JS" | head',
    'git commit -F - <<MSG',
  ])
})

it('lifts only a literal leading cd into the directory', () => {
  expect(formatBashCommand("cd '/path with spaces' && git status")).toMatchObject({
    directory: '/path with spaces',
    steps: [{ text: 'git status' }],
    summary: 'git status',
  })
  for (const command of [
    'cd - && pwd',
    'cd ~/x && pwd',
    'cd "$HOME" && pwd',
    'cd /path/* && pwd',
    'cd /path; pwd',
    'cd -- /path && pwd',
  ]) {
    expect(formatBashCommand(command).directory).toBeUndefined()
    expect(formatBashCommand(command).steps[0].text.startsWith('cd')).toBe(true)
  }
})

it('keeps unparsable input as one raw step', () => {
  for (const command of ["echo 'unfinished", 'for f in *.ts; do echo $f', 'pwd &&']) {
    expect(formatBashCommand(command)).toEqual({
      steps: [{ text: command, programs: [], heredocs: [] }],
      summary: command.split('\n')[0],
    })
  }
})
