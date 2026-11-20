import { parse } from 'unbash'
import type { AndOr, Command, PipelineNode, Statement, Word } from 'unbash'

export interface Heredoc {
  body: string
  closing: string
  file?: string
}

export interface BashStep {
  operator?: '&&' | '||' | ';'
  text: string
  programs: string[]
  heredocs: Heredoc[]
}

export interface BashCommand {
  directory?: string
  steps: BashStep[]
  summary: string
}

const interpreters: Record<string, string> = {
  python: 'heredoc.py',
  python3: 'heredoc.py',
  node: 'heredoc.js',
  bun: 'heredoc.ts',
  deno: 'heredoc.ts',
  tsx: 'heredoc.ts',
  sqlite3: 'heredoc.sql',
  psql: 'heredoc.sql',
  bash: 'heredoc.sh',
  sh: 'heredoc.sh',
  ruby: 'heredoc.rb',
}
const wrappers = new Set(['timeout', 'sudo', 'env', 'nice', 'nohup', 'command', 'exec', 'stdbuf'])
const subcommands = new Set(['git', 'pnpm', 'npm', 'yarn', 'bun', 'gh', 'docker', 'cargo', 'go'])
const runners = new Set(['exec', 'dlx', 'run', 'x'])
const compounds: Record<string, string> = { Subshell: '( )', BraceGroup: '{ }' }

function unwrappedProgram(command: Command): string[] {
  const words = [command.name, ...command.args].map((word) =>
    word?.type === 'Word' ? word.value : (word?.text ?? ''),
  )
  let index = 0
  while (wrappers.has(words[index] ?? '')) {
    index++
    while (/^(-|\d|\w+=)/.test(words[index] ?? '')) index++
  }
  return words.slice(index)
}

function label(command: Command) {
  const [name = '', ...args] = unwrappedProgram(command)
  if (!subcommands.has(name)) return name
  const rest = args.filter((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-C')
  const sub = rest[0]
  if (!sub) return name
  return runners.has(sub) && rest[1] ? `${name} ${sub} ${rest[1]}` : `${name} ${sub}`
}

function stages(node: PipelineNode): PipelineNode[] {
  return node.type === 'Pipeline' ? [...node.commands] : [node]
}

function stageLabel(node: PipelineNode): string {
  if (node.type === 'Command') return label(node)
  if (node.type === 'Redirected') return stageLabel(node.command)
  if (node.type === 'Time' || node.type === 'Negation')
    return node.command ? stageLabel(node.command) : ''
  if (node.type === 'Pipeline') return node.commands.map(stageLabel).filter(Boolean).join(' | ')
  if (node.type === 'Function') return `${node.name.value}()`
  return compounds[node.type] ?? node.type.toLowerCase()
}

function heredocs(source: string, node: PipelineNode): Heredoc[] {
  return stages(node).flatMap((stage) => {
    const command = stage.type === 'Command' ? stage : undefined
    const redirects = command?.redirects ?? (stage.type === 'Redirected' ? stage.redirects : [])
    let target: string | undefined
    for (const redirect of redirects)
      if (redirect.type === 'Redirect' && redirect.operator.startsWith('>'))
        target ??= redirect.target?.value
    const file = target ?? (command && interpreters[unwrappedProgram(command)[0] ?? ''])
    return redirects.flatMap((redirect) =>
      redirect.type === 'HereDoc' && redirect.closing
        ? [
            {
              body: redirect.body.text,
              closing: source.slice(redirect.closing.pos, redirect.closing.end),
              ...(file ? { file } : {}),
            },
          ]
        : [],
    )
  })
}

function literalDirectory(word: Word | undefined) {
  if (!word || /[$`*?[\]]/.test(word.text) || /^[-~]/.test(word.value)) return undefined
  return word.value
}

export function formatBashCommand(command: string): BashCommand {
  const rawDisplayCommand: BashCommand = {
    steps: [{ text: command, programs: [], heredocs: [] }],
    summary: command.split('\n')[0],
  }
  const script = parse(command)
  if (script.errors?.length || script.source !== undefined) return rawDisplayCommand
  const steps: BashStep[] = []
  const summary: string[] = []
  const push = (
    statement: Statement,
    node: PipelineNode,
    operator: BashStep['operator'],
    last: boolean,
  ) => {
    const end = last ? statement.end : node.end
    steps.push({
      ...(operator ? { operator } : {}),
      text: command.slice(node.pos, end),
      programs: stages(node).map(stageLabel).filter(Boolean),
      heredocs: heredocs(command, node),
    })
    const name = stageLabel(node)
    if (name)
      summary.push(`${summary.length ? (operator === ';' ? '; ' : ` ${operator} `) : ''}${name}`)
    if (last && statement.background) summary.push(' &')
  }
  for (const statement of script.commands) {
    const list: AndOr | undefined =
      statement.command.type === 'AndOr' ? statement.command : undefined
    const nodes = list ? list.commands : [statement.command as PipelineNode]
    nodes.forEach((node, index) =>
      push(
        statement,
        node,
        index ? list!.operators[index - 1] : steps.length ? ';' : undefined,
        index === nodes.length - 1,
      ),
    )
  }
  if (!steps.length) return rawDisplayCommand
  const first = script.commands[0].command
  const cd = first.type === 'AndOr' ? first.commands[0] : undefined
  const directory =
    cd?.type === 'Command' &&
    cd.name?.value === 'cd' &&
    cd.args.length === 1 &&
    !cd.redirects.length
      ? literalDirectory(cd.args[0] as Word)
      : undefined
  if (directory) {
    steps.shift()
    delete steps[0].operator
    summary.shift()
    summary[0] = summary[0].replace(/^ && /, '')
  }
  return { ...(directory ? { directory } : {}), steps, summary: summary.join('') }
}
