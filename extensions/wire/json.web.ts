import { plural } from '../../lib/plural.web.ts'

export type Json = null | boolean | number | string | Json[] | JsonObject
export type JsonObject = { [key: string]: Json }

export const isObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isBranch = (value: Json): value is JsonObject | Json[] =>
  typeof value === 'object' && value !== null
export const isShort = (value: string) => value.length <= 96 && !value.includes('\n')

export function parse(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

export const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''

export function hintOf(value: Json): string {
  if (typeof value === 'string') return firstLine(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const hint = hintOf(item)
      if (hint) return hint
    }
  }
  if (!isObject(value)) return ''
  for (const key of [
    'text',
    'thinking',
    'partial_json',
    'delta',
    'description',
    'content',
    'input',
    'arguments',
    'output',
    'summary',
  ]) {
    const field = value[key]
    if (field === undefined) continue
    const hint = hintOf(field)
    if (hint) return hint
  }
  return ''
}

export function kindOf(value: JsonObject | Json[], label: string): string {
  if (Array.isArray(value)) return plural(value.length, 'item')
  const name = typeof value.name === 'string' ? value.name : undefined
  const type = typeof value.type === 'string' && value.type !== label ? value.type : undefined
  const role = typeof value.role === 'string' ? value.role : undefined
  const kind = role
    ? [role, type !== 'message' ? type : undefined].filter(Boolean).join(' · ')
    : [type, name].filter(Boolean).join(' · ')
  const count = Array.isArray(value.content) ? plural(value.content.length, 'block') : ''
  return [kind, count].filter(Boolean).join(' · ')
}

export function markerOf(value: Json) {
  const control = isObject(value) ? value.cache_control : undefined
  if (!isObject(control ?? null)) return undefined
  const { ttl } = control as JsonObject
  return typeof ttl === 'string' ? { ttl } : {}
}

function breakpoints(value: Json, path: string, out: { path: string; ttl?: string }[] = []) {
  if (Array.isArray(value))
    value.forEach((item, index) => breakpoints(item, `${path}[${index}]`, out))
  else if (isObject(value))
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cache_control' && isObject(item))
        out.push({ path, ...(typeof item.ttl === 'string' ? { ttl: item.ttl } : {}) })
      else breakpoints(item, path ? `${path}.${key}` : key, out)
    }
  return out
}

export function requestShape(body: JsonObject) {
  const order =
    'messages' in body ? ['tools', 'system', 'messages'] : ['instructions', 'tools', 'input']
  return {
    order,
    settings: Object.fromEntries(Object.entries(body).filter(([key]) => !order.includes(key))),
    marks: order.flatMap((key) => (body[key] === undefined ? [] : breakpoints(body[key], key))),
  }
}
