import { expect, it } from 'vitest'
import {
  type AgentState,
  loadAgents,
  loginPath,
  renderAgents,
  renderUnits,
  selfUnits,
} from '../scripts/setup-machine.ts'

const options = {
  clone: '/home/u/ultimate',
  project: '/home/u/work/app',
  home: '/home/u',
  node: '/opt/node/bin/node',
  path: '/home/u/app/node_modules/.bin:/home/u/.local/share/pnpm/.tools/@pnpm+exe/11.8.0/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin',
}

function brokenShell(): never {
  throw new Error('rc failed')
}

function line(content: string, key: string) {
  return content.split('\n').filter((entry) => entry.startsWith(`${key}=`))
}

it("renders the project's ultimate unit with absolute paths", () => {
  const units = renderUnits(options)
  expect(units.map((unit) => unit.name)).toEqual(['ultimate.service'])
  const ultimate = units[0].content
  expect(line(ultimate, 'WorkingDirectory')).toEqual(['WorkingDirectory=/home/u/work/app'])
  expect(line(ultimate, 'ExecStart')).toEqual([
    'ExecStart=/opt/node/bin/node /home/u/ultimate/bin/ultimate.ts',
  ])
  expect(line(ultimate, 'Environment')).toContain('Environment=ULTIMATE_NO_OPEN=1')
  expect(line(ultimate, 'Environment').filter((entry) => entry.includes('PATH='))).toEqual([
    'Environment=PATH=/opt/node/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
  ])
  expect(line(ultimate, 'WantedBy')).toEqual(['WantedBy=default.target'])
})

it('lets the supervisor stop its children before systemd force-kills the group', () => {
  const [unit] = renderUnits(options)
  expect(line(unit.content, 'KillMode')).toEqual(['KillMode=mixed'])
  expect(line(unit.content, 'KillSignal')).toEqual(['KillSignal=SIGTERM'])
  expect(line(unit.content, 'TimeoutStopSec')).toEqual(['TimeoutStopSec=30'])
})

it("puts the login shell's PATH first, so a bare service PATH still finds claude, gh and pnpm", () => {
  const calls: [string, string[]][] = []
  const login =
    '/home/u/.local/share/pnpm:/home/u/.local/share/mise/shims:/home/u/.local/bin:/usr/bin'
  // An rc file that prints a greeting must not leak into PATH.
  const path = loginPath('/usr/bin:/usr/local/bin:/bin', '/bin/bash', (shell, args) => {
    calls.push([shell, args])
    return `Welcome!\n__ULTIMATE_PATH__${login}\n`
  })
  expect(calls[0][0]).toBe('/bin/bash')
  expect(calls[0][1][0]).toBe('-lic')
  const [unit] = renderUnits({ ...options, path })
  expect(line(unit.content, 'Environment').find((entry) => entry.includes('PATH='))).toBe(
    'Environment=PATH=/opt/node/bin:/home/u/.local/share/pnpm:/home/u/.local/share/mise/shims:/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
  )
  // A failing shell keeps the script's own PATH.
  expect(loginPath('/usr/bin:/bin', '/bin/zsh', brokenShell)).toBe('/usr/bin:/bin')
})

it('drops PATH entries that are relative or that systemd would misread', () => {
  const [unit] = renderUnits({
    ...options,
    path: '/home/u/My Tools/bin:relative/bin:/home/u/$X/bin::/home/u/.local/bin',
  })
  expect(line(unit.content, 'Environment').find((entry) => entry.includes('PATH='))).toBe(
    'Environment=PATH=/opt/node/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin',
  )
})

it('refuses paths systemd would read differently, naming the path', () => {
  for (const [field, path] of [
    ['clone', '/home/u/my ultimate'],
    ['project', '/home/u/work/a"pp'],
    ['project', "/home/u/work/it's"],
    ['home', '/home/u\\x'],
    ['node', '/opt/node%i/bin/node'],
    ['project', '/home/u/$HOME/app'],
    ['project', '/home/u/tab\there'],
  ] as const)
    expect(() => renderUnits({ ...options, [field]: path })).toThrow(
      `${field} path ${JSON.stringify(path)} contains whitespace`,
    )
  // Ordinary punctuation in paths stays allowed.
  expect(() => renderUnits({ ...options, project: '/home/u/work/my-app_2.0+x@y' })).not.toThrow()
})

/** The text of each top-level <key> in a rendered plist, keyed by name; the value is the raw XML after it. */
function plist(content: string) {
  const body = content.slice(content.indexOf('<dict>') + 6, content.lastIndexOf('</dict>'))
  const entries: Record<string, string> = {}
  for (const part of body.split(/\n  <key>/).slice(1)) {
    const [key, ...rest] = part.split('\n')
    entries[key.replace('</key>', '')] = rest.join('\n').trim()
  }
  return entries
}

const strings = (xml: string) =>
  [...xml.matchAll(/<string>(.*?)<\/string>/g)].map(([, value]) => value)

it('renders the darwin agent with the systemd arguments, PATH, logs and on-failure restarts', () => {
  const agents = renderAgents({ ...options, home: '/Users/u' })
  expect(agents.map(({ name }) => name)).toEqual(['com.ultimate.app.plist'])
  const app = plist(agents[0].content)
  expect(strings(app.Label)).toEqual(['com.ultimate.app'])
  expect(strings(app.ProgramArguments)).toEqual([
    '/opt/node/bin/node',
    '/home/u/ultimate/bin/ultimate.ts',
  ])
  expect(strings(app.WorkingDirectory)).toEqual(['/home/u/work/app'])
  expect(app.EnvironmentVariables).toContain('<key>ULTIMATE_NO_OPEN</key>\n    <string>1</string>')
  expect(strings(app.EnvironmentVariables)[0]).toBe(
    '/opt/node/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
  )
  expect(app.RunAtLoad).toBe('<true/>')
  expect(app.KeepAlive).toContain('<key>SuccessfulExit</key>\n    <false/>')
  expect(strings(app.StandardOutPath)).toEqual([
    '/Users/u/Library/Logs/ultimate/com.ultimate.app.log',
  ])
  expect(app.StandardErrorPath).toBe(app.StandardOutPath)
})

it('escapes plist values instead of refusing paths', () => {
  const agents = renderAgents({
    ...options,
    project: `/Users/u/R&D <"x"> it's`,
    path: '/Users/u/My Tools/bin:/opt/a&b',
  })
  const app = plist(agents[0].content)
  expect(app.WorkingDirectory).toBe(
    '<string>/Users/u/R&amp;D &lt;&quot;x&quot;&gt; it&apos;s</string>',
  )
  // Whitespace is fine in a plist, so PATH keeps that entry.
  expect(strings(app.EnvironmentVariables)[0]).toBe(
    '/opt/node/bin:/Users/u/My Tools/bin:/opt/a&amp;b:/usr/local/bin:/usr/bin:/bin',
  )
})

it('reloads new and changed agents, loads unloaded unchanged ones and never restarts itself', () => {
  const agents: AgentState[] = [
    { label: 'com.ultimate.app', file: '/L/app.plist', state: 'replaced' },
    { label: 'com.example.kept', file: '/L/kept.plist', state: 'unchanged' },
    { label: 'com.example.other', file: '/L/other.plist', state: 'new' },
  ]
  const plan = (env: Record<string, string>, loaded: string[] = []) => {
    const calls: string[] = []
    const log: string[] = []
    loadAgents(
      agents,
      501,
      env,
      (args) => {
        calls.push(args.join(' '))
        if (args[0] === 'print') return loaded.includes(args[1]) ? 0 : 113
        // bootout of an agent that is not loaded fails, and must not stop the plan.
        return args[0] === 'bootout' ? 3 : 0
      },
      (message) => log.push(message),
    )
    return { calls, log }
  }
  expect(plan({}).calls).toEqual([
    'bootout gui/501/com.ultimate.app',
    'bootstrap gui/501 /L/app.plist',
    'print gui/501/com.example.kept',
    'bootstrap gui/501 /L/kept.plist',
    'bootout gui/501/com.example.other',
    'bootstrap gui/501 /L/other.plist',
  ])
  // A loaded unchanged agent is left running.
  expect(plan({}, ['gui/501/com.example.kept']).calls).not.toContain(
    'bootstrap gui/501 /L/kept.plist',
  )
  // Inside the changed app agent, found by the label launchd puts in XPC_SERVICE_NAME.
  const self = plan({ XPC_SERVICE_NAME: 'com.ultimate.app' }, ['gui/501/com.example.kept'])
  expect(self.calls).toEqual([
    'print gui/501/com.example.kept',
    'bootout gui/501/com.example.other',
    'bootstrap gui/501 /L/other.plist',
  ])
  expect(self.log).toEqual(['com.ultimate.app changed: restart it yourself.'])
  // Under Ultimate's supervisor the Ultimate agent is left alone; any other agent still reloads.
  const supervised = plan({ ULTIMATE_SUPERVISED: '1' }, ['gui/501/com.example.kept'])
  expect(supervised.calls).toEqual(self.calls)
  // A failing bootstrap stops the setup.
  expect(() =>
    loadAgents(
      agents,
      501,
      {},
      () => 1,
      () => {},
    ),
  ).toThrow('launchctl bootstrap gui/501 /L/app.plist failed.')
})

it('never restarts the unit it runs inside: by InvocationID, and ultimate.service when supervised', () => {
  const changed = ['ultimate.service', 'other.service']
  const ids: Record<string, string> = {
    'ultimate.service': 'aaa',
    'other.service': 'bbb',
  }
  const invocation = (name: string) => ids[name] ?? ''
  // Run by hand outside any unit: everything restarts.
  expect(selfUnits(changed, {}, invocation)).toEqual([])
  // Inside another unit, found by its InvocationID.
  expect(selfUnits(changed, { INVOCATION_ID: 'bbb' }, invocation)).toEqual(['other.service'])
  // Under Ultimate's supervisor, ultimate.service is left alone.
  expect(selfUnits(changed, { ULTIMATE_SUPERVISED: '1' }, invocation)).toEqual(['ultimate.service'])
  // An unknown INVOCATION_ID matches nothing; an empty one never matches a unit without an id.
  expect(selfUnits(changed, { INVOCATION_ID: 'zzz' }, invocation)).toEqual([])
  expect(selfUnits(['other.service'], { INVOCATION_ID: '' }, () => '')).toEqual([])
  // Only changed units are considered.
  expect(selfUnits(['ultimate.service'], { ULTIMATE_SUPERVISED: '1' }, invocation)).toEqual([
    'ultimate.service',
  ])
  expect(selfUnits([], { ULTIMATE_SUPERVISED: '1' }, invocation)).toEqual([])
})
