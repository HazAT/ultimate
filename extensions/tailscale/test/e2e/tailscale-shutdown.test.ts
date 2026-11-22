import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cleanEnv, removeTemp, sourceCopy, temp, until } from '../../../../test/helpers.ts'

// systemd stops a unit by sending SIGTERM to its whole control group: the server child gets it too, starts closing,
// and the supervisor's `exit` reaches it while the Tailscale teardown still runs. The mapping must still go.
it('removes the Tailscale mapping when SIGTERM reaches the supervisor and its child at once', async () => {
  const home = await temp('ultimate-tailscale-stop-')
  try {
    const root = await sourceCopy(home)
    await mkdir(join(home, '.ultimate'), { recursive: true })
    await writeFile(
      join(home, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { enable: ['tailscale'] } }),
    )
    const config = join(home, 'tailscale.json')
    const log = join(home, 'tailscale.log')
    await writeFile(
      config,
      JSON.stringify({
        node: {
          BackendState: 'Running',
          Self: { DNSName: 'rog.example.ts.net.', UserID: 7 },
          User: { '7': { LoginName: 'owner@example.com' } },
          CertDomains: ['rog.example.ts.net'],
        },
        serve: {},
      }),
    )
    const cli = join(home, 'tailscale')
    // A slow `serve status` keeps the teardown running when the supervisor's `exit` arrives.
    await writeFile(
      cli,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
if (args[0] === 'status') console.log(JSON.stringify(config.node));
else if (args.join(' ') === 'serve status --json') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); console.log(JSON.stringify(config.serve)); }
else if (args[0] === 'serve') {
  const port = args.find((arg) => arg.startsWith('--https=')).split('=')[1];
  config.serve.Web ??= {};
  if (args.includes('off')) delete config.serve.Web['rog.example.ts.net:' + port];
  else config.serve.Web['rog.example.ts.net:' + port] = { Handlers: { '/': { Proxy: args.at(-1) } } };
  fs.writeFileSync(${JSON.stringify(config + '.next')}, JSON.stringify(config));
  fs.renameSync(${JSON.stringify(config + '.next')}, ${JSON.stringify(config)});
}
`,
    )
    await chmod(cli, 0o755)
    const mappings = async () =>
      Object.keys(
        (JSON.parse(await readFile(config, 'utf8')) as { serve: { Web?: object } }).serve.Web ?? {},
      )
    const supervisor = spawn(process.execPath, [join(root, 'bin/ultimate.ts'), root, '--no-open'], {
      cwd: root,
      detached: true,
      env: cleanEnv({
        HOME: home,
        ULTIMATE_HOME: join(home, 'state'),
        ULTIMATE_PORT: '0',
        ULTIMATE_NO_OPEN: '1',
        TAILSCALE_COMMAND: cli,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    supervisor.stdout.on('data', (chunk) => (output += chunk))
    supervisor.stderr.on('data', (chunk) => (output += chunk))
    const exited = once(supervisor, 'exit')
    try {
      // Ready is announced after the extensions' openers, the Tailscale mapping among them.
      await until(() => output.includes('Ultimate: http://'))
      expect(await mappings()).toHaveLength(1)
      process.kill(-supervisor.pid!, 'SIGTERM')
      await exited
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null)
        process.kill(-supervisor.pid!, 'SIGKILL')
    }
    expect(await mappings()).toEqual([])
    expect(await readFile(log, 'utf8')).toMatch(/serve --https=\d+ off/)
  } finally {
    await removeTemp(home)
  }
})
