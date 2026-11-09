// An in-memory stand-in for the backup Worker's `/sync` contract (`extensions/cloud/README.md`), as a `fetch`.
import { createHash } from 'node:crypto'
import type { Register } from '../../../lib/cloud.ts'

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** The stub's origin; requests to any other origin go to the real `fetch`. */
export const CLOUD = 'http://127.0.0.1:8787'
const realFetch = globalThis.fetch

/** A Worker with token `token`: snapshot objects, the backup commit with its parent rule, and the register. */
export function cloudStub(token = 'dev') {
  const objects = new Map<string, Uint8Array>()
  const register: Register = { projects: [], machines: [] }
  const commits: Record<string, unknown>[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== CLOUD) return realFetch(request)
    if (request.headers.get('Authorization') !== `Bearer ${token}`)
      return json(401, { error: 'unauthorized' })
    const snapshot = /^\/sync\/snapshots\/([0-9a-f]{64}\/[^/]+\/[^/]+)$/.exec(url.pathname)
    if (snapshot && request.method === 'PUT') {
      // Write-once, like the Worker.
      if (objects.has(snapshot[1])) return json(409, { error: 'Snapshot object already exists' })
      objects.set(snapshot[1], new Uint8Array(await request.arrayBuffer()))
      return new Response(null, { status: 204 })
    }
    if (snapshot && request.method === 'GET') {
      const object = objects.get(snapshot[1])
      return object ? new Response(new Uint8Array(object)) : json(404, { error: 'not found' })
    }
    const backup = /^\/sync\/backups\/([0-9a-f]{64})\/([^/]+)$/.exec(url.pathname)
    if (backup && request.method === 'POST') {
      const [, hash, id] = backup
      const body = (await request.json()) as {
        key: string
        name: string
        machine: string
        parent: string | null
        force?: boolean
        createdAt: number
        bytes: number
        uploaded: number
        tailnet?: string
      }
      commits.push(body)
      if (!objects.has(`${hash}/${id}/manifest`))
        return json(400, { error: 'The backup has no manifest' })
      const project = register.projects.find((entry) => entry.hash === hash)
      if ((project?.latest.id ?? null) !== body.parent && !body.force)
        return json(409, {
          error: `${project!.latest.machine} backed up ${body.name} after this machine last did; restore its backup or back up anyway to replace it`,
          latest: project!.latest,
        })
      const next = {
        id,
        machine: body.machine,
        at: body.createdAt,
        bytes: body.bytes,
        uploaded: body.uploaded,
        parent: body.parent,
        ...(body.tailnet ? { tailnet: body.tailnet } : {}),
      }
      if (project) project.latest = next
      else register.projects.push({ hash, key: body.key, name: body.name, latest: next })
      let machine = register.machines.find((entry) => entry.machine === body.machine)
      if (!machine) {
        machine = { machine: body.machine, at: 0, projects: {} }
        register.machines.push(machine)
      }
      machine.at = body.createdAt
      machine.projects[hash] = {
        name: body.name,
        at: body.createdAt,
        ...(body.tailnet ? { tailnet: body.tailnet } : {}),
      }
      return json(200, { latest: id })
    }
    if (url.pathname === '/sync/register' && request.method === 'GET') return json(200, register)
    return json(404, { error: 'not found' })
  }
  return { fetch, objects, register, commits }
}
