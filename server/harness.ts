import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { projectHome } from '../lib/project-paths.ts'
import type { Source } from '../lib/project-paths.ts'
import { compareExtensions } from '../lib/discovery.ts'
import { acquireLock } from '../lib/lock.ts'
import { identify } from '../lib/process-group.ts'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { FauxProviderHandle } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { AgentDoc, createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { UiState } from '../shared/ui-state.ts'
import { listModels } from './models.ts'
import { guardToolArguments, modelTrace } from './tool-arguments.ts'
import { readFamilies } from '../lib/families-settings.ts'
import { callTrace } from './trace.ts'
import { projectSkills } from './skills.ts'
import { requestSwap } from './supervisor-protocol.ts'
import { activeChapter, finishChapterSwitch } from '../lib/chapters.ts'
import { defaultAgent } from '../lib/agents.ts'
import type {
  ConversationId,
  Cursor,
  EnvTarget,
  Extension,
  HarnessSettings,
  ModelRef,
  Report,
  CompactionPolicy,
  Page,
  SubmissionQuery,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createBuild } from './build.ts'
import { spawn } from '../lib/spawn.ts'
import { applyHttpProxySettings, configureHttpDispatcher } from './http.ts'
import type { Notice } from '../shared/protocol.ts'

export { context }

export function reportMessage({ error, ...info }: Report): string {
  const parts: string[] = []
  if ('task' in info && info.task)
    parts.push(`task #${info.task.id} (${info.task.kind}) in #${info.task.conversationId}`)
  else if ('conversationId' in info && info.conversationId !== undefined)
    parts.push(`#${info.conversationId}`)
  if ('extension' in info && info.extension) parts.push(`extension ${info.extension}`)
  if (info.kind === 'host_error') parts.push(`host callback ${info.callback}`)
  const reason = 'reason' in info ? ` (${info.reason.replaceAll('_', ' ')})` : ''
  const about = parts.length > 0 ? `: ${parts.join(', ')}` : ''
  return `${info.kind.replaceAll('_', ' ')}${reason}${about}. ${String(error)}`
}

export function compactionProfile(contextWindow: number): Partial<CompactionPolicy> {
  if (contextWindow >= 1_000_000)
    return { reserveTokens: 32768, keepRecentTokens: 60000, backgroundTokens: 131072 }
  if (contextWindow >= 500_000)
    return { reserveTokens: 32768, keepRecentTokens: 40000, backgroundTokens: 65536 }
  return {}
}

const maxNodeTimeoutMs = 2147483647

export function createHarnessSettings(
  settings: SettingsManager,
  contextWindow: (provider: string, modelId: string) => number | undefined,
  extensions: () => Extension[],
): HarnessSettings {
  return {
    get extensions() {
      return extensions()
    },
    get stream() {
      const provider = settings.getProviderRetrySettings()
      const idle = settings.getHttpIdleTimeoutMs()
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? maxNodeTimeoutMs : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      }
    },
    get compaction() {
      const configured = settings.getSettings().compaction?.modelOverrides ?? {}
      const lazilyResolvedModelOverrides = new Proxy(configured, {
        get(entries, key) {
          if (typeof key !== 'string' || !key.includes('/')) return Reflect.get(entries, key)
          const slash = key.indexOf('/')
          const window = contextWindow(key.slice(0, slash), key.slice(slash + 1)) ?? 0
          return { ...compactionProfile(window), ...entries[key] }
        },
      })
      return { ...settings.getCompactionSettings(), modelOverrides: lazilyResolvedModelOverrides }
    },
    get retry() {
      return settings.getRetrySettings()
    },
    get steeringMode() {
      return settings.getSteeringMode()
    },
    followUpMode: 'all',
  }
}
export interface HostOptions {
  ultimateRoot: string
  projectRoot?: string
  userHome?: string
  home?: string
  faux?: FauxProviderHandle
  report?: (notice: Notice) => void
}
export async function prepareHarness(options: HostOptions) {
  const { ultimateRoot } = options
  const projectRoot = await realpath(options.projectRoot ?? ultimateRoot)
  const userHome = options.userHome ?? process.env.ULTIMATE_USER_HOME ?? homedir()
  const builds = createBuild(ultimateRoot)
  const home = options.home ?? process.env.ULTIMATE_HOME ?? projectHome(projectRoot, userHome)
  await mkdir(home, { recursive: true })
  let chapter = await activeChapter(home)
  const runtime = await ModelRuntime.create()
  const settings = SettingsManager.create(projectRoot)
  applyHttpProxySettings(settings.getGlobalSettings().httpProxy)
  configureHttpDispatcher(settings.getHttpIdleTimeoutMs())
  const registry = createRegistry()
  const extensionOrders = new Map<string, number>()
  const extensionSources = new Map<string, Source>()
  const envs = new Map<string, NodeExecutionEnv>()
  const processHelperExecutionEnv = ({ cwd = projectRoot }: EnvTarget) => {
    let found = envs.get(cwd)
    if (!found) {
      found = new NodeExecutionEnv({ cwd, spawn })
      envs.set(cwd, found)
    }
    return found
  }
  const trace = callTrace(() => chapter.trace)
  const modelCalls = modelTrace(trace)
  registry.install(modelCalls.extension)
  const guardedRuntime = guardToolArguments(runtime, modelCalls)
  const contextWindow = (provider: string, modelId: string) =>
    guardedRuntime.getModel(provider, modelId)?.contextWindow
  const { faux } = options
  if (faux) {
    runtime.registerNativeProvider(faux.provider)
    await runtime.refresh({ allowNetwork: false })
  }
  const defaultAgentAfterRegistration = async () => {
    const family = (await readFamilies(userHome, projectRoot)).families.default
    const agent = defaultAgent(await guardedRuntime.getAvailable(), settings, family)
    return faux
      ? { ...agent, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }
      : agent
  }
  let active:
    | {
        harness: Harness
        root: { id: ConversationId }
        storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>
      }
    | undefined
  return {
    async uiState(caller: Context) {
      if (!active) throw new Error('Harness is not open')
      return (await active.harness.snapshot(UiState, active.root.id, caller)) ?? {}
    },
    scanSubmissions(
      query: SubmissionQuery,
      limit: number,
      cursor: Cursor | undefined,
      caller: Context,
    ): Promise<Page<SubmissionRecord, Cursor>> {
      if (!active) throw new Error('Harness is not open')
      return active.storage.scanSubmissions(query, limit, cursor, caller)
    },
    models: async () => (await listModels(guardedRuntime)).models,
    model: (ref: ModelRef) => guardedRuntime.getModel(ref.provider, ref.modelId),
    skills: (cwd: string) => projectSkills({ ultimateRoot, projectRoot, userHome }, cwd).skills,
    restart: (approved: (generation: number) => Promise<void>) =>
      requestSwap(approved, builds.current()),
    ultimateRoot,
    projectRoot,
    userHome,
    builds,
    build: builds.current,
    home,
    get database() {
      return chapter.database
    },
    get chapter() {
      return chapter
    },
    callTrace: trace,
    modelRuntime: guardedRuntime,
    settings,
    registry,
    extensionOrders,
    extensionSources,
    faux,
    async open(resume = true) {
      const coreStartForStaleOwnerCheck = identify(process.pid)
      if (!coreStartForStaleOwnerCheck)
        throw new Error(`Cannot identify Ultimate core pid ${process.pid}`)
      const owner = await acquireLock(
        join(home, 'storage.lock'),
        { pid: process.pid, coreStart: coreStartForStaleOwnerCheck },
        process.env.ULTIMATE_SUPERVISED === '1' ? 10000 : 0,
      )
      let harness: Harness | undefined
      let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined
      try {
        const resetOrRestoreIncomplete = existsSync(join(home, 'reset.json'))
        if (resetOrRestoreIncomplete)
          throw new Error(
            `A reset or restore of ${home} was interrupted; rerun pnpm reset or pnpm restore`,
          )
        await finishChapterSwitch(home, async (file) => {
          const created = await openNodeSqliteStorage(file)
          await created.close(context)
        })
        chapter = await activeChapter(home)
        storage = await openNodeSqliteStorage(chapter.database)
        harness = await Harness.open(
          storage,
          {
            models: guardedRuntime,
            registry,
            settings: createHarnessSettings(settings, contextWindow, () =>
              registry
                .snapshot()
                .installed()
                .toSorted((a, b) =>
                  compareExtensions(
                    {
                      name: a.name,
                      source: extensionSources.get(a.name) ?? 'builtin',
                      order: extensionOrders.get(a.name),
                    },
                    {
                      name: b.name,
                      source: extensionSources.get(b.name) ?? 'builtin',
                      order: extensionOrders.get(b.name),
                    },
                  ),
                ),
            ),
            env: processHelperExecutionEnv,
            onReport: (report) =>
              options.report?.({ level: 'error', message: reportMessage(report) }),
          },
          context,
        )
        const currentDefaultRootAgent = await defaultAgentAfterRegistration()
        const root = await harness.root(context, { agent: { cwd: projectRoot } })
        await root.commit(async (tx) => {
          await tx.doc(UiState, root.id)
          Object.assign(await tx.doc(AgentDoc, root.id), currentDefaultRootAgent)
        }, context)
        active = { harness, root, storage }
        const openedHarness = harness
        if (resume) openedHarness.resume()
        return {
          harness: openedHarness,
          root,
          async close() {
            active = undefined
            await openedHarness.close(context)
            for (const execution of envs.values()) await execution.cleanup(context)
            envs.clear()
            await owner.close()
          },
        }
      } catch (error) {
        active = undefined
        if (harness) await harness.close(context)
        else await storage?.close(context)
        await owner.close()
        throw error
      }
    },
  }
}
export type PreparedHost = Awaited<ReturnType<typeof prepareHarness>>
export type OpenHost = Awaited<ReturnType<PreparedHost['open']>>
