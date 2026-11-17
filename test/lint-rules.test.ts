import { expect, it } from 'vitest'
import ultimate from '../lint/ultimate.ts'

type Context = Parameters<(typeof ultimate.rules)['no-raw-timer']['create']>[0]
function context(text = '', reason = '') {
  const reports: string[] = []
  return {
    reports,
    context: {
      filename: 'test/example.test.ts',
      options: [],
      sourceCode: {
        text,
        getCommentsBefore: () => (reason ? [{ value: reason }] : []),
        getCommentsInside: () => [],
        getAllComments: () => [],
      },
      report: ({ message }) => reports.push(message),
    } satisfies Context,
  }
}

const imported = (source: string, name?: string) => ({
  type: 'ImportDeclaration',
  source: { type: 'Literal', value: source },
  specifiers: [{ imported: { type: 'Identifier', name } }],
})

it('rejects process imports and real sleeps, but allows IO yields, fake timers and reasoned exceptions', () => {
  const f = context()
  const rule = ultimate.rules['no-real-wait-in-fast-tests'].create(f.context)
  for (const source of ['node:child_process', 'child_process', 'execa', 'execa/lib'])
    rule.ImportDeclaration(imported(source))
  rule.ImportDeclaration(imported('node:timers/promises', 'setTimeout'))
  expect(f.reports).toHaveLength(5)
  rule.ImportExpression({
    type: 'ImportExpression',
    source: { type: 'Literal', value: 'node:child_process' },
  })
  rule.ImportDeclaration({
    type: 'ImportDeclaration',
    source: { type: 'Literal', value: 'node:timers/promises' },
    specifiers: [{ type: 'ImportNamespaceSpecifier' }],
  })
  expect(f.reports).toHaveLength(7)
  rule.ImportDeclaration(imported('node:timers/promises', 'setImmediate'))
  expect(f.reports).toHaveLength(7)
  const sleep = {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'setTimeout' },
    parent: { type: 'NewExpression', callee: { type: 'Identifier', name: 'Promise' } },
  }
  rule.CallExpression(sleep)
  expect(f.reports).toHaveLength(8)
  const fake = context('vi.useFakeTimers()')
  ultimate.rules['no-real-wait-in-fast-tests'].create(fake.context).CallExpression(sleep)
  expect(fake.reports).toEqual([])
  const reason = context('', 'fast-test-reason: inspect the subprocess boundary')
  ultimate.rules['no-real-wait-in-fast-tests']
    .create(reason.context)
    .ImportDeclaration(imported('node:child_process'))
  expect(reason.reports).toEqual([])
})

it('rejects raw timers, as in the review surface polling the DOM for a diff line', async () => {
  const { parseSync } = await import('vite-plus')
  // Shipped in f16013b (extensions/review/surface.tsx): a 50 ms interval that tries 40 times to find a rendered line.
  const shipped = `
    import { setTimeout as sleep } from 'node:timers/promises'
    const timer = setInterval(() => {
      if (!line && ++tries <= 40) return
      clearInterval(timer)
    }, 50)
    window.setTimeout(done, 0)
    await import('node:timers/promises')
  `
  const f = context()
  const rule = ultimate.rules['no-raw-timer'].create(f.context)
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const typed = node as { type?: string }
    if (typed.type === 'CallExpression') rule.CallExpression(typed as never)
    if (typed.type === 'ImportDeclaration') rule.ImportDeclaration(typed as never)
    if (typed.type === 'ImportExpression') rule.ImportExpression(typed as never)
    for (const value of Object.values(node)) visit(value)
  }
  visit(parseSync('surface.tsx', shipped).program)
  expect(f.reports).toHaveLength(4)
  expect(f.reports[0]).toMatch(/guesses when something has happened.*lib\/timers\.ts/)
})

it('rejects a commented replay: safe, as the restart tool declared it, and accepts the named spreads', async () => {
  const { parseSync } = await import('vite-plus')
  const run = (source: string) => {
    const f = context()
    const rule = ultimate.rules['replay-safe-by-name'].create(f.context)
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      if ((node as { type?: string }).type === 'Property') rule.Property(node as never)
      for (const value of Object.values(node)) visit(value)
    }
    visit(parseSync('server.ts', source).program)
    return f.reports
  }
  // Shipped in extensions/self/server.ts until the replay helpers: a comment was the only reason given.
  const shipped = `defineTool({
    // The target generation is memoized before the swap, so replay reports it without restarting again.
    replay: 'safe',
  })`
  expect(run(shipped)).toEqual([expect.stringMatching(/\.\.\.readOnly.*\.\.\.safeToRerun/)])
  expect(run(`defineTool({ ...readOnly })`)).toEqual([])
  expect(run(`defineTool({ ...safeToRerun('the memoized generation'), replay2: 'safe' })`)).toEqual(
    [],
  )
})

it('rejects server work started and dropped, as the first chapter backup was, and accepts named exceptions', async () => {
  const { parseSync } = await import('vite-plus')
  const run = (source: string) => {
    const f = context()
    const rule = ultimate.rules['no-unowned-work'].create(f.context)
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      if ((node as { type?: string }).type === 'ExpressionStatement')
        rule.ExpressionStatement(node as never)
      for (const value of Object.values(node)) visit(value)
    }
    visit(parseSync('server.ts', source).program)
    return f.reports
  }
  const shipped = `const backupInBackground = () => {
    firstBackup(host).catch((error) => host.notice(\`Chapter backup: \${String(error)}\`))
  }`
  expect(run(shipped)).toEqual([
    expect.stringMatching(/lost on a crash.*defineEffect.*rebuiltOnOpen/),
  ])
  expect(run(`void post(target)`)).toHaveLength(1)
  expect(run(`inBackground(post(target))`)).toHaveLength(1)
  expect(run(`await post(target)`)).toEqual([])
  expect(
    run(`rebuiltOnOpen('each open checks for a first backup again', firstBackup(host))`),
  ).toEqual([])
  expect(run(`notify(push)`)).toEqual([])
})
it('rejects local polling function declarations in favor of the shared real-deadline helper', () => {
  const f = context()
  const rule = ultimate.rules['no-local-test-polling'].create(f.context)
  for (const name of ['until', 'waitFor', 'fixture'])
    rule.FunctionDeclaration({ type: 'FunctionDeclaration', id: { type: 'Identifier', name } })
  expect(f.reports).toHaveLength(2)
})
