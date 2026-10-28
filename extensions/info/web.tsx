import { InfoIcon, RotateCwIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  cn,
  defineWebExtension,
  elidePath,
  formatBytes,
  formatTime,
  formatTokens,
  shortenPath,
  useConversation,
  useModels,
  useNow,
  useRestart,
  useSystem,
} from '@/sdk'
import type { SystemInfo, Usage } from '@/sdk'
import { Row, Rows } from '@/components/ui/rows'
import { useWorkspacesMeta, Workspaces as WorkspaceRows } from '../workspaces/ui.tsx'
import { Copy, ErrorText, Meter, Section } from './ui.tsx'
import { ModelLabel } from '../models/ui.tsx'
import { SkillPicker, skillDialog } from './skill-picker.tsx'

const pad = (value: number) => String(value).padStart(2, '0')

/** 3d 04h, 2h 14m, 5m 03s, 42s. */
function uptime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const [d, h, m, s] = [
    Math.floor(seconds / 86400),
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
  if (d) return `${d}d ${pad(h)}h ${pad(m)}m`
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`
  if (m) return `${m}m ${pad(s)}s`
  return `${s}s`
}

/** `~/…` paths, elided in the middle to fit the panel. */
function usePath(system: SystemInfo) {
  return (path: string, max = 34) =>
    elidePath(shortenPath(path, { home: system.machine.home }), max)
}

function Machine({ system }: { system: SystemInfo }) {
  const { machine } = system
  const used = machine.totalMemory - machine.freeMemory
  return (
    <Section id="machine" meta={machine.hostname} title="Machine">
      <Rows>
        <Row label="host">
          {machine.hostname}
          <span className="text-muted-foreground/70">· {machine.user}</span>
        </Row>
        <Row label="os">
          <span className="truncate">
            {machine.platform} {machine.release}
          </span>
        </Row>
        <Row label="arch">{machine.arch}</Row>
        <Row label="cpu">
          <span className="truncate" title={machine.cpuModel}>
            {machine.cpuModel || 'unknown'}
          </span>
          <span className="shrink-0 text-muted-foreground/70">×{machine.cpuCount}</span>
        </Row>
        <Row label="memory">
          <Meter
            className={used / machine.totalMemory > 0.9 ? 'text-warning' : undefined}
            value={used / machine.totalMemory}
          />
          {formatGiB(used)} / {formatGiB(machine.totalMemory)}
        </Row>
      </Rows>
    </Section>
  )
}

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}G`

function Process({ system }: { system: SystemInfo }) {
  const now = useNow(1000)
  const { process } = system
  const restart = useRestart()
  return (
    <Section id="process" meta={`pid ${process.pid}`} title="Process">
      <Rows>
        <Row label="pid">{process.pid}</Row>
        <Row label="node">{process.node}</Row>
        <Row label="uptime">
          <span className="tabular-nums">{uptime(now - Date.parse(process.startedAt))}</span>
          <span className="truncate text-muted-foreground/60">
            since {formatTime(process.startedAt, true)}
          </span>
        </Row>
        <Row label="generation">
          gen {process.generation}
          {restart.pending !== undefined && (
            <span className="text-brand">→ {restart.pending} swapping…</span>
          )}
          <Button
            className="ml-auto h-5 gap-1 px-1.5 font-mono text-[10.5px] text-muted-foreground"
            disabled={restart.busy}
            onClick={restart.run}
            size="sm"
            title="Blue/green swap the core: type-check and boot a new process, then hand over"
            variant="ghost"
          >
            <RotateCwIcon className={cn('size-3', restart.busy && 'animate-spin')} />
            restart
          </Button>
        </Row>
        <Row label="url">
          <Copy value={process.url} />
        </Row>
      </Rows>
      {restart.error && <ErrorText>{restart.error}</ErrorText>}
    </Section>
  )
}

function Persistence({ system }: { system: SystemInfo }) {
  const path = usePath(system)
  const { persistence } = system
  return (
    <Section
      id="persistence"
      meta={formatBytes(persistence.sizeBytes + persistence.walBytes)}
      title="Persistence"
    >
      <Rows>
        <Row label="storage">{persistence.kind}</Row>
        <Row label="path">
          <Copy value={persistence.path}>{path(persistence.path)}</Copy>
        </Row>
        <Row label="size">
          {formatBytes(persistence.sizeBytes)}
          <span className="text-muted-foreground/70">
            + wal {formatBytes(persistence.walBytes)}
          </span>
        </Row>
      </Rows>
    </Section>
  )
}

function Execution({ system }: { system: SystemInfo }) {
  const path = usePath(system)
  const { agent } = useConversation()
  const cwd = agent.cwd ?? system.execution.defaultCwd
  return (
    <Section id="execution" meta="local" title="Execution">
      <Rows>
        <Row label="env">
          {system.execution.kind === 'node-local' ? 'local Node' : system.execution.kind}
        </Row>
        <Row label="cwd">
          <Copy value={cwd}>{path(cwd)}</Copy>
        </Row>
        {cwd !== system.execution.defaultCwd && (
          <Row label="default">
            <Copy value={system.execution.defaultCwd}>{path(system.execution.defaultCwd)}</Copy>
          </Row>
        )}
      </Rows>
    </Section>
  )
}

function Code({ system }: { system: SystemInfo }) {
  const path = usePath(system)
  const { code, build } = system
  const restart = useRestart()
  return (
    <Section
      id="code"
      meta={
        <>
          {code.branch || 'detached'}
          {code.dirty && <span className="text-warning">*</span>}
        </>
      }
      title="Code"
    >
      <Rows>
        <Row label="repo">
          <Copy value={code.ultimateRoot}>{path(code.ultimateRoot)}</Copy>
        </Row>
        <Row label="branch">
          <Copy value={code.branch}>{code.branch || '—'}</Copy>
        </Row>
        <Row label="sha">
          <Copy value={code.sha} />
          {code.dirty ? (
            <span className="text-warning">uncommitted changes</span>
          ) : (
            <span className="text-muted-foreground/60">clean</span>
          )}
        </Row>
        <Row label="build">
          <Copy value={build.id}>{build.id.slice(0, 7)}</Copy>
          <span className="truncate text-muted-foreground/60">
            {build.changed.length
              ? `changed ${build.changed.join(', ')}`
              : `gen ${build.generation}`}
          </span>
        </Row>
        <Row label="core">
          {code.coreStale ? (
            <>
              <span className="text-warning">changed · restart pending</span>
              <Button
                className="ml-auto h-5 gap-1 px-1.5 font-mono text-[10.5px] text-warning hover:text-warning"
                disabled={restart.busy}
                onClick={restart.run}
                size="sm"
                variant="ghost"
              >
                <RotateCwIcon className={cn('size-3', restart.busy && 'animate-spin')} />
                restart
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground/60">{build.core.slice(0, 12)} · current</span>
          )}
        </Row>
      </Rows>
      {restart.error && <ErrorText>{restart.error}</ErrorText>}
    </Section>
  )
}

const cost = (value: number) =>
  `$${value < 1 ? value.toFixed(value < 0.01 ? 4 : 3) : value.toFixed(2)}`

function Model() {
  const { agent, usage } = useConversation()
  const models = useModels()
  const ref = agent.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  const provider = models?.providers.find((candidate) => candidate.id === ref?.provider)
  const buckets: [string, Usage][] = [
    ...Object.entries(usage.models),
    ...Object.entries(usage.tools).map(([name, bucket]): [string, Usage] => [
      `tool ${name}`,
      bucket,
    ]),
  ]
  const total = buckets.reduce(
    (sum, [, bucket]) => ({
      input: sum.input + bucket.input,
      output: sum.output + bucket.output,
      cacheRead: sum.cacheRead + bucket.cacheRead,
      cacheWrite: sum.cacheWrite + bucket.cacheWrite,
      cost: sum.cost + bucket.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
  return (
    <Section
      id="model"
      meta={ref ? <ModelLabel model={ref} thinking={agent.thinkingLevel} /> : 'none'}
      title="Model & usage"
    >
      <Rows>
        <Row label="provider">
          {ref?.provider ?? <span className="text-warning">none</span>}
          {provider?.isUsingSubscription && (
            <span className="text-muted-foreground/70">· subscription</span>
          )}
        </Row>
        <Row label="model">
          <span className="truncate">{ref?.modelId ?? '—'}</span>
          {model && model.name !== model.id && (
            <span className="truncate text-muted-foreground/60">{model.name}</span>
          )}
        </Row>
        <Row label="thinking">
          {model && !model.reasoning ? (
            <span className="text-muted-foreground/70">not supported</span>
          ) : (
            <span
              className={
                agent.thinkingLevel && agent.thinkingLevel !== 'off' ? 'text-brand' : undefined
              }
            >
              {agent.thinkingLevel ?? 'off'}
            </span>
          )}
        </Row>
        {model && (
          <>
            <Row label="context">
              {formatTokens(model.contextWindow)}
              <span className="text-muted-foreground/60">
                · out {formatTokens(model.maxTokens)}
              </span>
            </Row>
            <Row label="price /M">
              <span className="truncate">
                ↑${model.cost.input} ↓${model.cost.output}
                {model.cost.cacheRead > 0 && ` R$${model.cost.cacheRead}`}
              </span>
            </Row>
          </>
        )}
        <Row label="tokens">
          <span className="truncate">
            ↑{formatTokens(total.input)} ↓{formatTokens(total.output)} R
            {formatTokens(total.cacheRead)} W{formatTokens(total.cacheWrite)}
          </span>
        </Row>
        <Row label="cost">
          {cost(total.cost)}
          {provider?.isUsingSubscription && <span className="text-muted-foreground/70">(sub)</span>}
        </Row>
      </Rows>
      {buckets.length > 0 && (
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 border-t border-border/50 pt-2 font-mono text-[11px] text-muted-foreground">
          {buckets.map(([name, bucket]) => (
            <Bucket bucket={bucket} key={name} name={name} />
          ))}
        </div>
      )}
    </Section>
  )
}

function Bucket({ name, bucket }: { name: string; bucket: Usage }) {
  return (
    <>
      <span className="truncate text-foreground/75" title={name}>
        {name}
      </span>
      <span className="text-right tabular-nums">
        ↑{formatTokens(bucket.input + bucket.cacheRead + bucket.cacheWrite)} ↓
        {formatTokens(bucket.output)}
      </span>
      <span className="text-right tabular-nums">{cost(bucket.cost.total)}</span>
    </>
  )
}

function Described({
  name,
  description,
  path,
  tags,
}: {
  name: string
  description: string
  path: string
  tags?: ReactNode
}) {
  return (
    <div className="min-w-0 font-mono text-[11px]">
      <div className="flex min-w-0 items-center gap-1.5">
        <Copy className="text-foreground/90" value={path}>
          {name}
        </Copy>
        {tags}
      </div>
      {description && (
        <p className="line-clamp-2 font-sans text-[11.5px] leading-snug text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  )
}

function Skills({ system }: { system: SystemInfo }) {
  return (
    <Section id="skills" meta={system.skills.length} title="Skills">
      <div className="flex flex-col gap-1.5">
        {system.skills.map((skill) => (
          <Described
            description={skill.description}
            key={skill.path}
            name={skill.name}
            path={skill.path}
            tags={
              <span className="truncate text-muted-foreground/60">
                {skill.scope}
                {skill.manual && ' · manual'}
                {skill.overrides.length > 0 &&
                  ` · overrides ${skill.overrides.length === 1 ? 'one' : skill.overrides.length}`}
              </span>
            }
          />
        ))}
        {system.skills.length === 0 && <Empty>no skills</Empty>}
        {system.skillDiagnostics.map((diagnostic) => (
          <div
            className={`font-mono text-[11px] leading-snug ${diagnostic.type === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}
            key={`${diagnostic.path ?? ''}:${diagnostic.message}`}
            title={diagnostic.path}
          >
            {diagnostic.path && (
              <span className="text-foreground/70">{shortSkill(diagnostic.path)} </span>
            )}
            {diagnostic.message}
          </div>
        ))}
      </div>
    </Section>
  )
}

function ContextFiles({ system }: { system: SystemInfo }) {
  const path = usePath(system)
  return (
    <Section id="context" meta={system.contextFiles.length} title="Context files">
      <div className="flex flex-col gap-0.5 font-mono text-[11.5px] text-foreground/85">
        {system.contextFiles.map((file) => (
          <Copy key={file} value={file}>
            {path(file, 52)}
          </Copy>
        ))}
        {system.contextFiles.length === 0 && <Empty>no AGENTS.md or CLAUDE.md</Empty>}
      </div>
    </Section>
  )
}

function Workspaces() {
  return (
    <Section id="workspaces" meta={useWorkspacesMeta()} title="Workspace">
      <WorkspaceRows />
    </Section>
  )
}

/** `…/name/SKILL.md` as `name`, any other file by its name. */
function shortSkill(path: string) {
  const parts = path.split('/')
  return parts.at(-1) === 'SKILL.md' ? (parts.at(-2) ?? path) : (parts.at(-1) ?? path)
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="font-mono text-[11px] text-muted-foreground/60">{children}</div>
}

function InfoPanel() {
  const system = useSystem()
  if (!system)
    return <div className="p-3 font-mono text-[11.5px] text-muted-foreground">connecting…</div>
  return (
    <div className="pb-4">
      {/* The shown conversation first, then this host, then what loads into every prompt. */}
      <Workspaces />
      <Model />
      <Code system={system} />
      <Execution system={system} />
      <Machine system={system} />
      <Process system={system} />
      <Persistence system={system} />
      <Skills system={system} />
      <ContextFiles system={system} />
    </div>
  )
}

export default defineWebExtension({
  panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: InfoPanel, order: 5 }],
  slots: { overlay: [SkillPicker] },
  commands: [
    {
      id: 'info.open',
      title: 'Show system info',
      run: (context) => context.openPanel('info'),
    },
    {
      id: 'info.skill',
      title: 'Run a skill',
      run: (context) => context.open(skillDialog),
    },
  ],
})
