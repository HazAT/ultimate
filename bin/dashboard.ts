import { appendFileSync } from 'node:fs'
import { stripVTControlCharacters } from 'node:util'
import { createLogUpdate } from 'log-update'
import type { CoreReport } from '../server/supervisor-protocol.ts'

const plain = (text: string) =>
  // Child diagnostics must not be able to control the terminal, including carriage returns.
  stripVTControlCharacters(text).replace(/(?![\t\n\u0080-\u009f])\p{Cc}/gu, '')
const row = (text: string) => plain(text).replaceAll('\n', ' ').slice(0, 240)

export function dashboard(logPath: string, output: NodeJS.WriteStream = process.stdout) {
  const tty = output.isTTY
  const render = tty ? createLogUpdate(output, { showCursor: true }) : undefined
  let phase = 'starting'
  let url = ''
  let core: { generation: number; pid?: number } | undefined
  let web = 'waiting'
  let origins: string[] = []
  let last = ''
  let logFailed = false
  let closed = false
  const draw = () => {
    if (closed || !render) return
    render(
      [
        `Ultimate: ${row(origins[0] ?? url) || 'starting'}`,
        ...(origins.length
          ? [
              `  local       ${url}`,
              ...origins.slice(1).map((origin) => `  remote      ${row(origin)}`),
            ]
          : []),
        `  supervisor  ${phase}`,
        `  core        ${core ? `generation ${core.generation} · PID ${core.pid ?? '?'} ` : ''}${core ? (phase === 'checking' ? 'ready' : phase) : 'waiting'}`,
        `  web         ${web} · embedded Vite`,
        `  last        ${row(last) || '—'}`,
        `  log         ${logPath}`,
      ].join('\n'),
    )
  }
  const log = (level: 'info' | 'warn' | 'error', source: string, text: string) => {
    if (closed) return
    text = plain(text)
    try {
      appendFileSync(
        logPath,
        JSON.stringify({ at: new Date().toISOString(), level, source, text }) + '\n',
      )
    } catch (error) {
      if (!logFailed) {
        logFailed = true
        render?.clear()
        output.write(`Warning: cannot write detailed log ${logPath}: ${row(String(error))}\n`)
      }
    }
    last = row(`${source}: ${text}`)
    if (!tty || level !== 'info') {
      render?.clear()
      output.write(`[${level}] ${source}: ${text.trimEnd()}\n`)
    }
    draw()
  }
  return {
    log,
    url(value: string) {
      url = value
      draw()
    },
    lifecycle(value: string, child?: { generation: number; pid?: number }) {
      phase = value
      if (child?.generation !== core?.generation || !child) {
        web = 'waiting'
        origins = []
      }
      core = child
      log('info', 'supervisor', value)
    },
    report(message: CoreReport) {
      if (message.type === 'log') log(message.level, message.source, message.text)
      else if (message.type === 'web') {
        web = message.state
        log('info', 'web', message.state)
      } else {
        // The core logs each change itself (`Ultimate: … (remote)`); the dashboard only keeps the current ones on top.
        origins = message.origins
        draw()
      }
    },
    close() {
      if (closed) return
      draw()
      render?.done()
      closed = true
    },
  }
}
