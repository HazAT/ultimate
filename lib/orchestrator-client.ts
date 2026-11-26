import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord/json'
import { isMissing, meansNone } from './errors.ts'
import { alive, readOwner } from './lock.ts'
import { projectHome } from './project-paths.ts'
import { REMOTE_BYTES } from './remote.ts'

export type RunningInstance = {
  project: string
  port: number
  url: string
  pid: number
  home: string
}

export async function listRunningInstances(userHome = homedir()): Promise<RunningInstance[]> {
  const dir = join(userHome, '.ultimate', 'projects')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const found: RunningInstance[] = []
  for (const name of entries) {
    const home = join(dir, name)
    const owner = await readOwner(join(home, 'ultimate.lock')).catch(meansNone)
    if (!owner?.port || !alive(owner.pid)) continue
    found.push({
      project: owner.project ?? name,
      port: owner.port,
      url: `http://127.0.0.1:${owner.port}`,
      pid: owner.pid,
      home,
    })
  }
  return found.toSorted((a, b) => a.port - b.port)
}

export async function resolveInstanceUrl(
  options: { dir?: string; url?: string; userHome?: string } = {},
): Promise<string> {
  const explicit = options.url ?? process.env.ULTIMATE_URL
  if (explicit) return new URL(explicit).origin
  const projectRoot = await realpath(options.dir ?? process.cwd())
  const home = process.env.ULTIMATE_HOME ?? projectHome(projectRoot, options.userHome)
  const owner = await readOwner(join(home, 'ultimate.lock'))
  if (!owner?.port || !alive(owner.pid))
    throw new Error(
      `Ultimate is not running for ${projectRoot}. Start it with \`pnpm start\` or \`ultimate\`, or pass --url.`,
    )
  return `http://127.0.0.1:${owner.port}`
}

export async function callUltimateAction<T = unknown>(
  baseUrl: string,
  extension: string,
  action: string,
  args: JsonValue = null,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const origin = new URL(baseUrl).origin
  const timeoutMs = options.timeoutMs ?? 35_000
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ])
  const response = await fetch(`${origin}/api/extensions/${extension}/actions/${action}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Ultimate-Source': 'agent',
    },
    body: JSON.stringify({ args }),
    signal,
  })
  const text = await response.text()
  if (Buffer.byteLength(text) > REMOTE_BYTES)
    throw new Error(`${extension}/${action} answered more than 1 MiB`)
  let parsed: { result?: T; error?: string }
  try {
    parsed = JSON.parse(text) as { result?: T; error?: string }
  } catch (error) {
    throw new Error(
      `${extension}/${action} returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
      { cause: error },
    )
  }
  if (!response.ok)
    throw new Error(parsed.error ?? `${extension}/${action} failed with HTTP ${response.status}`)
  return parsed.result as T
}

export async function requestUltimateRestart(baseUrl: string, signal?: AbortSignal) {
  const origin = new URL(baseUrl).origin
  const response = await fetch(`${origin}/api/restart`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Ultimate-Source': 'agent',
    },
    body: '{}',
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  })
  const parsed = (await response.json()) as { ok?: boolean; generation?: number; error?: string }
  if (!response.ok || !parsed.ok)
    throw new Error(parsed.error ?? `restart failed with HTTP ${response.status}`)
  return parsed
}

export type InboxItem = {
  entry: number
  kind: string
  from?: number | 'user' | 'remote'
  text?: string
  message?: number
  re?: number
  reply?: boolean
  report?: boolean
  failed?: boolean
  stopped?: boolean
  data?: JsonValue
}

export type InboxResult = {
  orchestratorId: number
  name: string
  cursor: number
  items: InboxItem[]
  branches: { id: number; title?: string; busy: boolean; concluded: boolean; waiting: boolean }[]
  openQuestions: { message: number; conversation: number; at: number; text: string }[]
}

export function createOrchestratorClient(baseUrl: string, name?: string) {
  const withName = <T extends Record<string, unknown>>(args: T) => (name ? { ...args, name } : args)
  return {
    baseUrl,
    ensure: () =>
      callUltimateAction<{ id: number; name: string; root?: number; ultimateId?: number }>(
        baseUrl,
        'orchestrator',
        'ensure',
        withName({}),
      ),
    status: (since?: number) =>
      callUltimateAction<JsonValue>(
        baseUrl,
        'status',
        'status',
        since === undefined ? {} : { since },
      ),
    branch: (input: {
      prompt: string
      title?: string
      root?: number
      family?: string
      isolated?: boolean
    }) =>
      callUltimateAction<{ id: number; message: number; orchestratorId: number }>(
        baseUrl,
        'orchestrator',
        'branch',
        withName(input),
      ),
    message: (input: { to: string; text: string; reply?: boolean; steer?: boolean }) =>
      callUltimateAction<{ message: number; orchestratorId: number }>(
        baseUrl,
        'orchestrator',
        'message',
        withName(input),
      ),
    note: (input: { to: number | 'root'; text: string }) =>
      callUltimateAction<{ ok: true; orchestratorId: number }>(
        baseUrl,
        'orchestrator',
        'note',
        withName(input),
      ),
    inbox: (input: { since?: number; limit?: number } = {}) =>
      callUltimateAction<InboxResult>(baseUrl, 'orchestrator', 'inbox', withName(input)),
    wait: (
      input: { since?: number; limit?: number; timeoutMs?: number } = {},
      signal?: AbortSignal,
    ) =>
      callUltimateAction<InboxResult & { timedOut: boolean }>(
        baseUrl,
        'orchestrator',
        'wait',
        withName(input),
        { timeoutMs: Math.min((input.timeoutMs ?? 20_000) + 10_000, 40_000), signal },
      ),
    async waitUntil(
      input: { since?: number; limit?: number; timeoutSeconds?: number } = {},
      signal?: AbortSignal,
    ): Promise<InboxResult & { timedOut: boolean }> {
      const end = Date.now() + Math.max(1, input.timeoutSeconds ?? 120) * 1000
      let since = input.since ?? 0
      for (;;) {
        const remaining = end - Date.now()
        if (remaining <= 0 || signal?.aborted) {
          const snapshot = await callUltimateAction<InboxResult>(
            baseUrl,
            'orchestrator',
            'inbox',
            withName({ since, ...(input.limit === undefined ? {} : { limit: input.limit }) }),
            { signal },
          )
          return { ...snapshot, timedOut: snapshot.items.length === 0 }
        }
        const slice = Math.min(remaining, 20_000)
        const result = await callUltimateAction<InboxResult & { timedOut: boolean }>(
          baseUrl,
          'orchestrator',
          'wait',
          withName({
            since,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            timeoutMs: slice,
          }),
          { timeoutMs: slice + 10_000, signal },
        )
        if (result.items.length > 0 || signal?.aborted) return { ...result, timedOut: false }
        since = Math.max(since, result.cursor)
      }
    },
    entries: (
      conversationId: number,
      options: { limit?: number; before?: number; kinds?: string[] } = {},
    ) =>
      callUltimateAction<JsonValue>(baseUrl, 'codemode', 'read', {
        op: 'entries',
        args: [conversationId, options],
      }),
    search: (
      text: string,
      options: { conversationId?: number; limit?: number; kinds?: string[] } = {},
    ) =>
      callUltimateAction<JsonValue>(baseUrl, 'codemode', 'read', {
        op: 'search',
        args: [text, options],
      }),
    conversations: () =>
      callUltimateAction<JsonValue>(baseUrl, 'codemode', 'read', { op: 'conversations', args: [] }),
    addresses: () => callUltimateAction<JsonValue>(baseUrl, 'messages', 'addresses', {}),
    conclude: (ids: number[]) =>
      callUltimateAction<JsonValue>(baseUrl, 'conversations', 'conclude', { ids }),
    resume: (ids: number[]) =>
      callUltimateAction<JsonValue>(baseUrl, 'conversations', 'resume', { ids }),
    remember: (ops: JsonValue[], root?: number) =>
      callUltimateAction<{ root: number; summary: string }>(baseUrl, 'orchestrator', 'remember', {
        ops,
        ...(root === undefined ? {} : { root }),
      }),
    memory: (root?: number) =>
      callUltimateAction<{ root?: number; memories: Record<string, JsonValue> }>(
        baseUrl,
        'orchestrator',
        'memory',
        root === undefined ? {} : { root },
      ),
    todoAdd: (text: string, owner: 'user' | 'ultimate' = 'ultimate', key?: string) =>
      callUltimateAction<JsonValue>(baseUrl, 'todos', 'add', {
        text,
        owner,
        ...(key === undefined ? {} : { key }),
      }),
    todoDone: (id: number) => callUltimateAction<JsonValue>(baseUrl, 'todos', 'done', { id }),
    answerQuestion: (messageId: number, text: string) =>
      callUltimateAction<JsonValue>(baseUrl, 'questions', 'answer', { messageId, text }),
    dismissQuestion: (messageId: number) =>
      callUltimateAction<JsonValue>(baseUrl, 'questions', 'dismiss', { messageId }),
    restart: (signal?: AbortSignal) => requestUltimateRestart(baseUrl, signal),
  }
}

export type OrchestratorClient = ReturnType<typeof createOrchestratorClient>
