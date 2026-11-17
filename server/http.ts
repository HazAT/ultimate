// Pi upstream: @earendil-works/pi-coding-agent@1.5.2 src/core/http-dispatcher.ts — copied, not exported; prevents early provider stream termination. Drop when Pi exports configureHttpDispatcher and applyHttpProxySettings.
/*
MIT License — Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { EventEmitter } from 'node:events'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import * as undici from 'undici'

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.toLowerCase() === 'disabled') {
      return 0
    }
    if (trimmed.length === 0) {
      return undefined
    }
    return parseHttpIdleTimeoutMs(Number(trimmed))
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.floor(value)
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
  const proxy = httpProxy?.trim()
  if (!proxy) return
  process.env.HTTP_PROXY ??= proxy
  process.env.HTTPS_PROXY ??= proxy
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {}

function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, 'error', ignoreUndiciDispatcherError)
  }
  return dispatcher
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options))
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions)
  }
  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  )
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs)
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`)
  }
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      proxyTunnel: true,
      bodyTimeout: normalizedTimeoutMs,
      connect: {
        autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      },
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  )
  setDefaultAutoSelectFamilyAttemptTimeout(DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS)
  undici.setGlobalDispatcher(dispatcher)
}
