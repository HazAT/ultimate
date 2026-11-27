import type { Readable, Writable } from 'node:stream'
import { inProcess } from '../../lib/errors.shared.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Message = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Json
  result?: Json
  error?: { code: number; message: string; data?: Json }
}

export type RpcHandlers = {
  notify(method: string, params: Json): void
  request(method: string, params: Json): Promise<Json>
  disconnect(): void
}

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export function connectRpc(input: Readable, output: Writable, handlers: RpcHandlers) {
  let next = 1
  let closedWith: Error | undefined
  const pending = new Map<number | string, { resolve(v: Json): void; reject(e: Error): void }>()
  const send = (message: Omit<Message, 'jsonrpc'>) => {
    if (!closedWith) output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const answer = (id: number | string, work: Promise<Json>) =>
    work.then(
      (result) => send({ id, result }),
      (error: unknown) =>
        send({
          id,
          error: {
            code: error instanceof RpcError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    )
  const receive = (message: Message) => {
    if (message.method === undefined) {
      const waiting = message.id === undefined ? undefined : pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id!)
      if (message.error) waiting.reject(new RpcError(message.error.code, describe(message.error)))
      else waiting.resolve(message.result ?? null)
    } else if (message.id === undefined) handlers.notify(message.method, message.params ?? null)
    else
      inProcess(
        'an answer to the agent belongs to its connection, which dies with this process',
        answer(message.id, handlers.request(message.method, message.params ?? null)),
      )
  }
  const close = (error: Error) => {
    if (closedWith) return
    closedWith = error
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
  }
  const disconnect = (error: Error) => {
    close(error)
    handlers.disconnect()
  }
  let buffer = ''
  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    if (closedWith) return
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('{')) continue
      try {
        receive(JSON.parse(line) as Message)
      } catch (error) {
        disconnect(new Error('Invalid ACP message', { cause: error }))
        return
      }
    }
  })
  input.on('end', () => close(new Error('The agent closed its connection')))
  input.on('error', disconnect)
  output.on('error', disconnect)
  return {
    request<R = Json>(method: string, params: Json): Promise<R> {
      if (closedWith) return Promise.reject(closedWith)
      const id = next++
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: Json) => void, reject })
        send({ id, method, params })
      })
    },
    notify(method: string, params: Json) {
      if (!closedWith) send({ method, params })
    },
    close,
  }
}

const describe = (error: { message: string; data?: Json }) => {
  const detail =
    typeof error.data === 'string'
      ? error.data
      : error.data &&
          typeof error.data === 'object' &&
          'message' in error.data &&
          typeof error.data.message === 'string'
        ? error.data.message
        : ''
  return detail && detail !== error.message ? `${error.message}: ${detail}` : error.message
}

export type Rpc = ReturnType<typeof connectRpc>
export type { Json }
