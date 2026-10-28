/**
 * A conversation whose model's provider definitely has no login here switches, as its next run's input is placed, to
 * the same model on another provider, its definition's pin or the configured default, and says so with one
 * `models.fallback` entry. A subscription never switches to a pay-per-token login: then nothing replaces it, the
 * conversation keeps its model and the entry asks the user. An availability Pi has not settled switches nothing.
 */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { configuredModel, familyDefault, hasLogin } from '../../lib/agents.ts'
import { Pin } from './api.ts'
import type { Fallback } from './refs.ts'

type Ref = { provider: string; modelId: string }
const name = (ref: Ref) => `${ref.provider}/${ref.modelId}`

/**
 * Claude runs on its subscription only through Claude Code, never inside Pi; Pi marks its `anthropic` OAuth a
 * subscription, but here that provider is the pay-per-token Anthropic API, so a fallback never treats it as one.
 */
const BILLED = new Set(['anthropic'])

/** Whether `provider`'s login is a subscription, as Pi marks it: an OAuth login whose provider says `isSubscription`. */
function subscription(host: ExtensionHost, provider: string) {
  return !BILLED.has(provider) && host.modelRuntime.isUsingSubscription(provider)
}

export async function fallback(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const agent = await tx.doc(AgentDoc, conversationId)
  const runtime = host.modelRuntime
  const available = runtime.getAvailableSnapshot()
  // Nothing has a login yet (an empty snapshot says nothing about this model), or this one still has one.
  if (!agent.model || !available.length || hasLogin(available, agent.model)) return undefined
  const from = agent.model
  // Certain evidence only: the snapshot has no login for it and a fresh check agrees. A provider still registering,
  // or a check that fails or times out, leaves the model as it is; its request fails with its own error.
  if (runtime.getProvider(from.provider) && (await mayHaveLogin(host, from.provider)))
    return undefined
  const fresh = runtime.getAvailableSnapshot()
  const paid = wasSubscription(host, from.provider)
  // Same model elsewhere first, then the definition's pin, then the configured default; a subscription takes only
  // another subscription.
  const allowed = (provider: string) => !paid || subscription(host, provider)
  const same = fresh.find(
    (model) =>
      model.id === from.modelId && model.provider !== from.provider && allowed(model.provider),
  )
  const candidates: [Ref | undefined, Fallback['reason']][] = [
    [same && { provider: same.provider, modelId: same.id }, 'same'],
    [await host.want(Pin)?.pin(tx, conversationId), 'pin'],
    [configuredModel(fresh, host.settings, await familyDefault(host)), 'default'],
  ]
  const found = candidates.find(([ref]) => hasLogin(fresh, ref) && allowed(ref!.provider))
  const data: Fallback = found
    ? { from: name(from), to: name(found[0]!), reason: found[1] }
    : { from: name(from), reason: 'none' }
  if (!found && (await alreadyAsked(tx, conversationId, data.from))) return undefined
  if (found) {
    const to = found[0]!
    agent.model = { provider: to.provider, modelId: to.modelId }
    const model = runtime.getModel(to.provider, to.modelId)
    if (model && agent.thinkingLevel)
      agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
  }
  const content = found
    ? `Model ${data.from} has no login here; this conversation now runs on ${data.to}.`
    : `Model ${data.from} has no login here and no subscription login can replace it, so this conversation keeps it until the user logs in to ${from.provider} or picks another model.`
  return {
    entries: [
      { kind: 'models.fallback', data, model: [{ role: 'user', content, timestamp: Date.now() }] },
    ],
  }
}

/** How long the fresh check may take; it runs inside the input's transaction, and only when a login looks gone. */
const CHECK_MS = 5_000

/**
 * Check `provider`'s login again now, as Pi does: true when it has one after all (the snapshot was stale or still
 * pending), and when the check fails or times out, since that is no evidence either way.
 */
async function mayHaveLogin(host: ExtensionHost, provider: string) {
  try {
    return !!(await host.modelRuntime.checkAuth(provider, {
      signal: AbortSignal.timeout(CHECK_MS),
    }))
  } catch (error) {
    host.notice(`Checking the ${provider} login failed, keeping the model: ${String(error)}`)
    return true
  }
}

/**
 * Pi's subscription mark of a provider whose login is gone, so its login type is no longer known: its OAuth method
 * says `isSubscription`.
 */
function wasSubscription(host: ExtensionHost, provider: string) {
  return (
    !BILLED.has(provider) &&
    host.modelRuntime.getProvider(provider)?.auth.oauth?.isSubscription === true
  )
}

/** Whether this conversation's newest fallback entry already asks about `from`, so each next input says it once. */
async function alreadyAsked(tx: Tx, conversationId: ConversationId, from: string) {
  for (let page = await tx.scanEntries({ conversationId }, 200); ;) {
    const entry = page.items.find((item) => item.kind === 'models.fallback')
    if (entry) {
      const data = entry.data as Fallback
      return data.reason === 'none' && data.from === from
    }
    if (!page.next) return false
    page = await tx.scanEntries({ conversationId }, 200, page.next)
  }
}
