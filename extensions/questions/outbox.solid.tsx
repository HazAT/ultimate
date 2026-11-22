/** @jsxImportSource @solidjs/web */
import type { JsonValue } from '@earendil-works/chord/json'
import { onSettled } from 'solid-js'
import { actionRef, api, writerNow, writingAs } from '@/sdk/solid'

export type Outgoing = { extension: string; name: string; args: JsonValue }
type Unsent = Outgoing & { who: string }

const PREFIX = 'ultimate.questions.unsent.'
let leaving = false
addEventListener('pagehide', () => (leaving = true))
addEventListener('pageshow', () => (leaving = false))

const post = ({ extension, name, args }: Outgoing, keepalive: boolean) =>
  api.action(actionRef<JsonValue, unknown>(extension, name), args, { keepalive })

export async function sendKept(outgoing: Outgoing, keepalive: boolean) {
  const key = PREFIX + crypto.randomUUID()
  localStorage.setItem(key, JSON.stringify({ ...outgoing, who: writerNow() } satisfies Unsent))
  try {
    const result = await post(outgoing, keepalive)
    localStorage.removeItem(key)
    return result
  } catch (failure) {
    if (!leaving) localStorage.removeItem(key)
    throw failure
  }
}

export function ResendUnsentAnswers() {
  onSettled(() => void resendUnsent())
  return null
}

async function resendUnsent() {
  const keys = Object.keys(localStorage).filter((key) => key.startsWith(PREFIX))
  for (const key of keys) {
    const stored = localStorage.getItem(key)
    if (stored === null) continue
    localStorage.removeItem(key)
    const { who, ...outgoing } = JSON.parse(stored) as Unsent
    await writingAs(who, () => post(outgoing, false)).catch((failure: unknown) => {
      if ((failure as { status?: number }).status === 0) localStorage.setItem(key, stored)
    })
  }
}
