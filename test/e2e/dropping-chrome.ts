#!/usr/bin/env node
// A stand-in for Chrome: it answers Playwright's launch and a first context, then closes its CDP pipe soon after the
// first page is asked for and keeps running with a child in its process group, as a managed Chrome does seconds into
// its first page when its policy turns off remote debugging. It writes its pid to $DROPPING_CHROME_PID.
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs'

writeFileSync(process.env.DROPPING_CHROME_PID!, `${process.pid}\n`)
// Stands for the renderers; it also keeps this process running once the pipe is gone.
spawn('sleep', ['60'], { stdio: 'ignore' })
const input = createReadStream('', { fd: 3, encoding: 'utf8' })
const output = createWriteStream('', { fd: 4 })
const results: Record<string, unknown> = {
  'Browser.getVersion': {
    product: 'HeadlessChrome/1.0',
    revision: '1',
    userAgent: 'HeadlessChrome/1.0',
    protocolVersion: '1.3',
    jsVersion: '1',
  },
  'Target.attachToBrowserTarget': { sessionId: 'browser' },
  'SystemInfo.getProcessInfo': { processInfo: [{ type: 'browser', id: process.pid, cpuTime: 0 }] },
  'Target.createBrowserContext': { browserContextId: 'context' },
}
let pending = ''
input.on('data', (chunk) => {
  pending += chunk
  for (let end = pending.indexOf('\0'); end !== -1; end = pending.indexOf('\0')) {
    const { id, method, sessionId } = JSON.parse(pending.slice(0, end))
    pending = pending.slice(end + 1)
    if (method === 'Target.createTarget') {
      setTimeout(() => {
        input.destroy()
        output.destroy()
      }, 500)
      continue
    }
    output.write(`${JSON.stringify({ id, sessionId, result: results[method] ?? {} })}\0`)
  }
})
