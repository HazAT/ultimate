// License — Copyright (c) 2025 Paperclip AI (MIT). Derived from Paperclip local-process-sandbox.ts.
const net = require('node:net')
const { spawn } = require('node:child_process')
const [socketPath, executable, ...args] = process.argv.slice(2)
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath)
  client.pipe(upstream)
  upstream.pipe(client)
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
})
server.listen(3128, '127.0.0.1', () => {
  const child = spawn(executable, args, { stdio: 'inherit', env: process.env })
  child.on('exit', (code) => server.close(() => process.exit(code == null ? 1 : code)))
})
