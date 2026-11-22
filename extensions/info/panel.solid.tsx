import { RotateCw } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { CopyValue } from '@/components/ui/copy-value.solid.tsx'
import { Row, Rows } from '@/components/ui/rows.solid.tsx'
import type { SystemInfo, Usage } from '@/sdk/solid'
import {
  cn,
  elidePath,
  formatBytes,
  formatTime,
  formatTokens,
  shortenPath,
  useAgent,
  useConversation,
  useModels,
  useNow,
  useRestart,
  useSystem,
} from '@/sdk/solid'
import { Workspaces, useWorkspacesMeta } from '../workspaces/ui.solid.tsx'
import { ErrorText, Meter, Section, Tag } from './parts.solid.tsx'

export function InfoPanel() {
  const system = useSystem()
  return (
    <Show
      when={system()}
      fallback={<div class="p-3 font-mono text-[11.5px] text-muted-foreground">connecting…</div>}
    >
      {(info) => (
        <div class="pb-4">
          <WorkspaceSection />
          <Model />
          <Code system={info()} />
          <Execution system={info()} />
          <Machine machine={info().machine} />
          <Process process={info().process} />
          <Persistence system={info()} />
          <Skills system={info()} />
          <ContextFiles system={info()} />
        </div>
      )}
    </Show>
  )
}

function WorkspaceSection() {
  const meta = useWorkspacesMeta()
  return (
    <Section id="workspaces" meta={meta()} title="Workspace">
      <Workspaces />
    </Section>
  )
}

const displayPath = (system: SystemInfo, path: string, max = 34) =>
  elidePath(shortenPath(path, { home: system.machine.home }), max)

const cost = (value: number) =>
  `$${value < 1 ? value.toFixed(value < 0.01 ? 4 : 3) : value.toFixed(2)}`

function Model() {
  const conversation = useConversation()
  const catalog = useModels()
  const ref = () => conversation().agent.model
  const thinking = () => conversation().agent.thinkingLevel ?? 'off'
  const model = createMemo(() => {
    const selected = ref()
    return catalog()?.models.find(
      (candidate) => candidate.provider === selected?.provider && candidate.id === selected.modelId,
    )
  })
  const subscription = () =>
    catalog()?.providers.find((candidate) => candidate.id === ref()?.provider)?.isUsingSubscription
  const buckets = createMemo(() => {
    const { models, tools } = conversation().usage
    return [
      ...Object.entries(models),
      ...Object.entries(tools).map(([name, bucket]): [string, Usage] => [`tool ${name}`, bucket]),
    ]
  })
  const total = createMemo(() => {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    for (const [, bucket] of buckets()) {
      sum.input += bucket.input
      sum.output += bucket.output
      sum.cacheRead += bucket.cacheRead
      sum.cacheWrite += bucket.cacheWrite
      sum.cost += bucket.cost.total
    }
    return sum
  })
  return (
    <Section id="model" meta={ref()?.modelId ?? 'none'} title="Model & usage">
      <Rows>
        <Row label="provider">
          {ref()?.provider ?? <span class="text-warning">none</span>}
          {subscription() && <span class="text-muted-foreground/70">· subscription</span>}
        </Row>
        <Row label="model">
          <span class="truncate">{ref()?.modelId ?? '—'}</span>
          {model()?.name !== model()?.id && (
            <span class="truncate text-muted-foreground/60">{model()?.name}</span>
          )}
        </Row>
        <Row label="thinking">
          <Show
            when={model()?.reasoning !== false}
            fallback={<span class="text-muted-foreground/70">not supported</span>}
          >
            <span class={thinking() !== 'off' ? 'text-brand' : undefined}>{thinking()}</span>
          </Show>
        </Row>
        <Show when={model()}>
          {(m) => (
            <>
              <Row label="context">
                {formatTokens(m().contextWindow)}
                <span class="text-muted-foreground/60">· out {formatTokens(m().maxTokens)}</span>
              </Row>
              <Row label="price /M">
                <span class="truncate">
                  ↑${m().cost.input} ↓${m().cost.output}
                  {m().cost.cacheRead > 0 && ` R$${m().cost.cacheRead}`}
                </span>
              </Row>
            </>
          )}
        </Show>
        <Row label="tokens">
          <span class="truncate">
            ↑{formatTokens(total().input)} ↓{formatTokens(total().output)} R
            {formatTokens(total().cacheRead)} W{formatTokens(total().cacheWrite)}
          </span>
        </Row>
        <Row label="cost">
          {cost(total().cost)}
          {subscription() && <span class="text-muted-foreground/70">(sub)</span>}
        </Row>
      </Rows>
      <Show when={buckets().length}>
        <div class="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 border-t border-border/50 pt-2 font-mono text-[11px] text-muted-foreground">
          <For each={buckets()} keyed={([name]) => name}>
            {(entry) => <Bucket name={entry()[0]} usage={entry()[1]} />}
          </For>
        </div>
      </Show>
    </Section>
  )
}

function Bucket(props: { name: string; usage: Usage }) {
  const input = () => props.usage.input + props.usage.cacheRead + props.usage.cacheWrite
  return (
    <>
      <span class="truncate text-foreground/75" title={props.name}>
        {props.name}
      </span>
      <span class="text-right tabular-nums">
        ↑{formatTokens(input())} ↓{formatTokens(props.usage.output)}
      </span>
      <span class="text-right tabular-nums">{cost(props.usage.cost.total)}</span>
    </>
  )
}

function Code(props: { system: SystemInfo }) {
  const code = () => props.system.code
  const build = () => props.system.build
  const restart = useRestart()
  return (
    <Section
      id="code"
      meta={
        <>
          {code().branch || 'detached'}
          {code().dirty && <span class="text-warning">*</span>}
        </>
      }
      title="Code"
    >
      <Rows>
        <Row label="repo">
          <CopyValue field="repository path" value={code().ultimateRoot}>
            {displayPath(props.system, code().ultimateRoot)}
          </CopyValue>
        </Row>
        <Row label="branch">
          <Show when={code().branch} fallback="—">
            {(branch) => <CopyValue field="host branch" value={branch()} />}
          </Show>
        </Row>
        <Row label="sha">
          <CopyValue field="commit SHA" value={code().sha} />
          {code().dirty ? (
            <span class="text-warning">uncommitted changes</span>
          ) : (
            <span class="text-muted-foreground/60">clean</span>
          )}
        </Row>
        <Row label="build">
          <CopyValue field="build ID" value={build().id}>
            {build().id.slice(0, 7)}
          </CopyValue>
          <span class="truncate text-muted-foreground/60">
            {build().changed.length
              ? `changed ${build().changed.join(', ')}`
              : `gen ${build().generation}`}
          </span>
        </Row>
        <Row label="core">
          <Show
            when={code().coreStale}
            fallback={
              <span class="text-muted-foreground/60">{build().core.slice(0, 12)} · current</span>
            }
          >
            <span class="text-warning">changed · restart pending</span>
            <RestartButton section="Code" restart={restart} />
          </Show>
        </Row>
      </Rows>
      <ErrorText>{restart.error()}</ErrorText>
    </Section>
  )
}

function Execution(props: { system: SystemInfo }) {
  const agent = useAgent()
  const execution = () => props.system.execution
  const cwd = () => agent().cwd ?? execution().defaultCwd
  return (
    <Section id="execution" meta="local" title="Execution">
      <Rows>
        <Row label="env">{execution().kind === 'node-local' ? 'local Node' : execution().kind}</Row>
        <Row label="cwd">
          <CopyValue field="working directory" value={cwd()}>
            {displayPath(props.system, cwd())}
          </CopyValue>
        </Row>
        <Show when={cwd() !== execution().defaultCwd}>
          <Row label="default">
            <CopyValue field="default directory" value={execution().defaultCwd}>
              {displayPath(props.system, execution().defaultCwd)}
            </CopyValue>
          </Row>
        </Show>
      </Rows>
    </Section>
  )
}

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)}G`

function Machine(props: { machine: SystemInfo['machine'] }) {
  const machine = () => props.machine
  const used = () => machine().totalMemory - machine().freeMemory
  return (
    <Section id="machine" meta={machine().hostname} title="Machine">
      <Rows>
        <Row label="host">
          {machine().hostname}
          <span class="text-muted-foreground/70">· {machine().user}</span>
        </Row>
        <Row label="os">
          <span class="truncate">
            {machine().platform} {machine().release}
          </span>
        </Row>
        <Row label="arch">{machine().arch}</Row>
        <Row label="cpu">
          <span class="truncate" title={machine().cpuModel}>
            {machine().cpuModel || 'unknown'}
          </span>
          <span class="shrink-0 text-muted-foreground/70">×{machine().cpuCount}</span>
        </Row>
        <Row label="memory">
          <Meter label="Memory utilization" value={used() / machine().totalMemory} />
          {formatGiB(used())} / {formatGiB(machine().totalMemory)}
        </Row>
      </Rows>
    </Section>
  )
}

const pad = (value: number) => String(value).padStart(2, '0')

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

function Process(props: { process: SystemInfo['process'] }) {
  const now = useNow()
  const process = () => props.process
  const restart = useRestart()
  return (
    <Section id="process" meta={`pid ${process().pid}`} title="Process">
      <Rows>
        <Row label="pid">{process().pid}</Row>
        <Row label="node">{process().node}</Row>
        <Row label="uptime">
          <span class="tabular-nums">{uptime(now() - Date.parse(process().startedAt))}</span>
          <span class="truncate text-muted-foreground/60">
            since {formatTime(process().startedAt, true)}
          </span>
        </Row>
        <Row label="generation">
          gen {process().generation}
          {restart.pending() !== undefined && (
            <span class="text-brand">→ {restart.pending()} swapping…</span>
          )}
          <RestartButton section="Process" restart={restart} />
        </Row>
        <Row label="url">
          <CopyValue field="host URL" value={process().url} />
        </Row>
      </Rows>
      <ErrorText>{restart.error()}</ErrorText>
    </Section>
  )
}

function RestartButton(props: {
  section: 'Code' | 'Process'
  restart: ReturnType<typeof useRestart>
}) {
  return (
    <Button
      aria-label={`Restart host from ${props.section}`}
      class={cn(
        'ml-auto h-5 gap-1 px-1.5 font-mono text-[10.5px]',
        props.section === 'Code' ? 'text-warning hover:text-warning' : 'text-muted-foreground',
      )}
      data-agent-confirm="Restarts the shared Ultimate host."
      disabled={props.restart.busy()}
      onClick={() => props.restart.run()}
      size="sm"
      title="Type-check and boot a new process, then hand over"
      variant="ghost"
    >
      <RotateCw class={cn('size-3', props.restart.busy() && 'animate-spin')} />
      restart
    </Button>
  )
}

function Persistence(props: { system: SystemInfo }) {
  const persistence = () => props.system.persistence
  return (
    <Section
      id="persistence"
      meta={formatBytes(persistence().sizeBytes + persistence().walBytes)}
      title="Persistence"
    >
      <Rows>
        <Row label="storage">{persistence().kind}</Row>
        <Row label="path">
          <CopyValue field="storage path" value={persistence().path}>
            {displayPath(props.system, persistence().path)}
          </CopyValue>
        </Row>
        <Row label="size">
          {formatBytes(persistence().sizeBytes)}
          <span class="text-muted-foreground/70">+ wal {formatBytes(persistence().walBytes)}</span>
        </Row>
      </Rows>
    </Section>
  )
}

function Skills(props: { system: SystemInfo }) {
  const skills = () => props.system.skills
  return (
    <Section id="skills" meta={skills().length} title="Skills">
      <div class="flex flex-col gap-1.5">
        <For each={skills()} keyed={(skill) => skill.path} fallback={<Empty>no skills</Empty>}>
          {(skill) => (
            <div class="min-w-0 font-mono text-[11px]">
              <div class="flex min-w-0 items-center gap-1.5 text-foreground/90">
                <CopyValue field="skill path" value={skill().path}>
                  {skill().name}
                </CopyValue>
                <Tag>{skill().scope}</Tag>
                <span class="truncate text-muted-foreground/60">
                  {skill().manual && 'manual'}
                  {skill().manual && skill().overrides.length > 0 && ' · '}
                  {skill().overrides.length > 0 &&
                    `overrides ${skill().overrides.length === 1 ? 'one' : skill().overrides.length}`}
                </span>
              </div>
              <Show when={skill().description}>
                <p class="line-clamp-2 font-sans text-[11.5px] leading-snug text-muted-foreground">
                  {skill().description}
                </p>
              </Show>
            </div>
          )}
        </For>
        <For
          each={props.system.skillDiagnostics}
          keyed={(diagnostic) => `${diagnostic.path ?? ''}:${diagnostic.message}`}
        >
          {(diagnostic) => (
            <div
              class={cn(
                'font-mono text-[11px] leading-snug',
                diagnostic().type === 'error' ? 'text-destructive' : 'text-warning',
              )}
              title={diagnostic().path}
            >
              <Show when={diagnostic().path}>
                {(path) => <span class="text-foreground/70">{shortSkill(path())} </span>}
              </Show>
              {diagnostic().message}
            </div>
          )}
        </For>
      </div>
    </Section>
  )
}

function shortSkill(path: string) {
  const parts = path.split('/')
  return parts.at(-1) === 'SKILL.md' ? (parts.at(-2) ?? path) : (parts.at(-1) ?? path)
}

function ContextFiles(props: { system: SystemInfo }) {
  return (
    <Section id="context" meta={props.system.contextFiles.length} title="Context files">
      <div class="flex flex-col gap-0.5 font-mono text-[11.5px] text-foreground/85">
        <For each={props.system.contextFiles} fallback={<Empty>no AGENTS.md or CLAUDE.md</Empty>}>
          {(file) => (
            <CopyValue field="context file" value={file}>
              {displayPath(props.system, file, 52)}
            </CopyValue>
          )}
        </For>
      </div>
    </Section>
  )
}

function Empty(props: { children: string }) {
  return <div class="font-mono text-[11px] text-muted-foreground/60">{props.children}</div>
}
