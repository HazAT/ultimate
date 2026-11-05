// Installs Ultimate as a service: on Linux a systemd user unit with linger, so it starts at boot without a login; on
// macOS a launchd agent in ~/Library/LaunchAgents, which runs while the user is logged in.
// Usage: pnpm setup:machine [--project <dir>] [--dry-run]. See "Cloud backups" in extensions/cloud/README.md.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export interface UnitOptions {
  /** The Ultimate clone that holds bin/ultimate.ts. */
  clone: string
  /** The project ultimate.service opens. */
  project: string
  home: string
  node: string
  /** The user's PATH (`loginPath`), kept after node so the agent finds the same tools as in a terminal. */
  path: string
}

export interface Unit {
  name: string
  content: string
}

/** One service, as both the systemd unit and the launchd agent run it. */
interface Service {
  unit: string
  label: string
  description: string
  cwd: string
  env: Record<string, string>
  args: string[]
}

function unit(description: string, service: string[]) {
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...service,
    'Restart=on-failure',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** Whitespace and the characters systemd treats specially in unit values: quotes, escapes, specifiers, variables. */
const special = /[\s"'\\%$]/

/** Paths go into units unescaped, so one systemd would read differently is refused rather than escaped. */
export function checkPaths(paths: Record<string, string>) {
  for (const [name, path] of Object.entries(paths))
    if (special.test(path))
      throw new Error(
        `${name} path ${JSON.stringify(path)} contains whitespace or one of " ' \\ % $, which systemd units treat specially; move it to a plain path.`,
      )
}

/**
 * The changed units this script runs inside, which it must not restart: the one whose InvocationID is the
 * process's INVOCATION_ID, and under Ultimate's supervisor ultimate.service.
 */
export function selfUnits(
  changed: string[],
  env: { INVOCATION_ID?: string; ULTIMATE_SUPERVISED?: string },
  invocation: (unit: string) => string,
) {
  return changed.filter(
    (name) =>
      (env.ULTIMATE_SUPERVISED === '1' && name === 'ultimate.service') ||
      (!!env.INVOCATION_ID && invocation(name) === env.INVOCATION_ID),
  )
}

const marker = '__ULTIMATE_PATH__'

/**
 * The PATH of the user's interactive login shell, where `~/.local/bin`, version managers' shims (mise, asdf) and
 * `PNPM_HOME` are added, followed by `current`'s entries. The script's own PATH alone is not enough: run from a
 * service, over ssh or by an agent it can be the bare `/usr/bin:/bin`, and the agent's `claude`, `gh` and `pnpm` would
 * be missing from the units. A shell that fails or prints no PATH leaves `current`.
 */
export function loginPath(
  current: string,
  shell = process.env.SHELL || userInfo().shell || '/bin/sh',
  run: (shell: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }),
) {
  let login = ''
  try {
    // Interactive too: many setups (mise activate, PNPM_HOME) extend PATH only in the rc file.
    login =
      run(shell, ['-lic', `printf '\n${marker}%s\n' "$PATH"`])
        .split('\n')
        .find((line) => line.startsWith(marker))
        ?.slice(marker.length) ?? ''
  } catch {
    // A broken rc file must not stop the setup: the script's own PATH still goes into the units.
  }
  return [login, current].filter(Boolean).join(':')
}

/**
 * The services' PATH: node's folder, the user's absolute entries, then the system folders. pnpm run prepends
 * node_modules/.bin folders and its own version-pinned folder (.tools/@pnpm+exe/<version>), which disappears when pnpm
 * updates itself; a service must depend on neither. `misread` drops entries the service format cannot hold as is.
 */
export function servicePath(node: string, path: string, misread?: RegExp) {
  const user = path
    .split(':')
    .filter(
      (entry) =>
        entry.startsWith('/') &&
        !entry.includes('/node_modules/') &&
        !entry.includes('/.tools/') &&
        !misread?.test(entry),
    )
  return [...new Set([dirname(node), ...user, '/usr/local/bin', '/usr/bin', '/bin'])].join(':')
}

function services(options: UnitOptions, path: string): Service[] {
  const { clone, project, node } = options
  return [
    {
      unit: 'ultimate.service',
      label: 'com.ultimate.app',
      description: `Ultimate (${project})`,
      cwd: project,
      env: { PATH: path, ULTIMATE_NO_OPEN: '1' },
      args: [node, join(clone, 'bin/ultimate.ts')],
    },
  ]
}

/** Renders the unit files; pure, so the side effects stay in main. Throws for a path systemd would misread. */
export function renderUnits(options: UnitOptions): Unit[] {
  const { clone, project, home, node } = options
  checkPaths({ clone, project, home, node })
  // An entry systemd would misread is left out rather than escaped.
  const path = servicePath(node, options.path, special)
  return services(options, path).map((service) => ({
    name: service.unit,
    content: unit(service.description, [
      `WorkingDirectory=${service.cwd}`,
      ...Object.entries(service.env).map(([key, value]) => `Environment=${key}=${value}`),
      `ExecStart=${service.args.join(' ')}`,
    ]),
  }))
}

export interface Agent {
  label: string
  /** The plist file name in ~/Library/LaunchAgents. */
  name: string
  content: string
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const string = (value: string) => `<string>${xml(value)}</string>`

/** The log file launchd writes an agent's stdout and stderr to. */
export const agentLog = (home: string, label: string) =>
  join(home, 'Library/Logs/ultimate', `${label}.log`)

/**
 * Renders the launchd agents; pure, so the side effects stay in main. Plists escape every value, so no path is
 * refused. KeepAlive restarts an agent only after a failed exit, as Restart=on-failure does: bin/ultimate.ts exits 0
 * when asked to stop, and an agent that keeps coming back after a deliberate stop would fight the user.
 */
export function renderAgents(options: UnitOptions): Agent[] {
  const path = servicePath(options.node, options.path)
  return services(options, path).map(({ label, cwd, env, args }) => {
    const log = agentLog(options.home, label)
    return {
      label,
      name: `${label}.plist`,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  ${string(label)}`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...args.map((arg) => `    ${string(arg)}`),
        '  </array>',
        '  <key>WorkingDirectory</key>',
        `  ${string(cwd)}`,
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        ...Object.entries(env).flatMap(([key, value]) => [
          `    <key>${xml(key)}</key>`,
          `    ${string(value)}`,
        ]),
        '  </dict>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <dict>',
        '    <key>SuccessfulExit</key>',
        '    <false/>',
        '  </dict>',
        '  <key>StandardOutPath</key>',
        `  ${string(log)}`,
        '  <key>StandardErrorPath</key>',
        `  ${string(log)}`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    }
  })
}

export interface AgentState {
  label: string
  file: string
  state: 'new' | 'replaced' | 'unchanged'
}

/**
 * Loads the agents into the user's GUI domain. A new or replaced agent is booted out and bootstrapped again, which
 * restarts it on the new plist; an unchanged one is bootstrapped only when not loaded. The replaced agent this
 * script runs inside is left alone: launchd sets XPC_SERVICE_NAME to the job's label, and under Ultimate's supervisor
 * it is com.ultimate.app. `launchctl` runs one command and returns its exit status.
 */
export function loadAgents(
  agents: AgentState[],
  uid: number,
  env: { XPC_SERVICE_NAME?: string; ULTIMATE_SUPERVISED?: string },
  launchctl: (args: string[]) => number,
  log: (line: string) => void,
) {
  const domain = `gui/${uid}`
  for (const { label, file, state } of agents) {
    const target = `${domain}/${label}`
    if (state === 'unchanged') {
      if (launchctl(['print', target]) !== 0) launchctl(['bootstrap', domain, file])
      continue
    }
    const inside =
      state === 'replaced' &&
      ((env.ULTIMATE_SUPERVISED === '1' && label === 'com.ultimate.app') ||
        env.XPC_SERVICE_NAME === label)
    if (inside) {
      log(`${label} changed: restart it yourself.`)
      continue
    }
    // Fails when the agent is not loaded yet, which is just what bootout should leave behind.
    launchctl(['bootout', target])
    if (launchctl(['bootstrap', domain, file]) !== 0)
      throw new Error(`launchctl bootstrap ${domain} ${file} failed.`)
  }
}

function main() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    console.error(
      `pnpm setup:machine supports Linux (systemd) and macOS (launchd), not ${process.platform}.`,
    )
    process.exit(1)
  }
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  })
  const dry = values['dry-run'] === true
  const home = homedir()
  const clone = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const options = {
    clone,
    project: resolve(values.project ?? clone),
    home,
    node: process.execPath,
    path: loginPath(process.env.PATH ?? ''),
  }

  const mkdir = (dir: string) => {
    if (existsSync(dir)) return
    console.log(`$ mkdir -p ${dir}`)
    if (!dry) mkdirSync(dir, { recursive: true })
  }
  /** Writes each changed file and says whether it is new, replaced or unchanged. */
  const write = (dir: string, files: { name: string; content: string }[]) =>
    files.map(({ name, content }) => {
      const file = join(dir, name)
      const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
      const state = current === content ? 'unchanged' : current === undefined ? 'new' : 'replaced'
      if (state === 'unchanged') {
        console.log(`${file}: unchanged`)
        if (dry) console.log(content)
      } else {
        console.log(`${file}: ${state}\n${content}`)
        if (!dry) writeFileSync(file, content)
      }
      return { name, file, state } as const
    })

  if (process.platform === 'darwin') {
    const agents = renderAgents(options)
    const dir = join(home, 'Library/LaunchAgents')
    mkdir(dir)
    mkdir(join(home, 'Library/Logs/ultimate'))
    const written = write(dir, agents)
    loadAgents(
      agents.map(({ label }, index) => ({ label, ...written[index] })),
      process.getuid!(),
      process.env,
      (args) => {
        // print only asks whether an agent is loaded, so it runs on a dry run too.
        if (args[0] === 'print')
          return spawnSync('launchctl', args, { stdio: 'ignore' }).status ?? 1
        console.log(`$ launchctl ${args.join(' ')}`)
        if (dry) return 0
        return spawnSync('launchctl', args, { stdio: 'inherit' }).status ?? 1
      },
      console.log,
    )
    console.log('The agent runs while you are logged in.')
    if (dry) console.log('Dry run: nothing changed.')
    return
  }

  const units = renderUnits(options)
  const run = (command: string, args: string[]) => {
    console.log(`$ ${command} ${args.join(' ')}`)
    if (!dry) execFileSync(command, args, { stdio: 'inherit' })
  }
  const dir = join(home, '.config/systemd/user')
  mkdir(dir)
  const changed = write(dir, units)
    .filter(({ state }) => state === 'replaced')
    .map(({ name }) => name)
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', '--now', ...units.map(({ name }) => name)])
  // Restarting the unit this script runs inside would kill the script with it.
  const inside = selfUnits(changed, process.env, (name) =>
    query(['show', name, '-p', 'InvocationID']),
  )
  for (const name of changed) {
    if (inside.includes(name)) console.log(`${name} changed: restart ${name} yourself.`)
    else run('systemctl', ['--user', 'restart', name])
  }
  const user = userInfo().username
  const linger = execFileSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    encoding: 'utf8',
  }).trim()
  if (linger === 'yes') console.log(`Linger is already enabled for ${user}.`)
  else run('loginctl', ['enable-linger', user])
  if (dry) console.log('Dry run: nothing changed.')
}

function query(args: string[]) {
  return execFileSync('systemctl', ['--user', ...args, '--value'], { encoding: 'utf8' }).trim()
}

if (import.meta.main) main()
