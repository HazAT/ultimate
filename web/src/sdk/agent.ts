import { createAgent } from '@ui-sdk/core/agent'

/** The page's ui-sdk agent bridge: `snapshot`, `query`, `act`, and `subscribe` to every component change. */
export type UiAgent = ReturnType<typeof createAgent>
export type UiComponent = ReturnType<UiAgent['snapshot']>[number]
type ActResult = Awaited<ReturnType<UiAgent['act']>>

export const isRef = (name: string) => /^c\d+$/.test(name)

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()

export function createUiAgent() {
  let created: UiAgent | undefined
  const bridge = () => (created ??= createAgent())

  async function named(name: string): Promise<UiComponent | undefined> {
    if (isRef(name)) {
      const byRef = await bridge().query({ within: name })
      return Array.isArray(byRef) && byRef[0]?.ref === name && !byRef[0].offPage
        ? byRef[0]
        : undefined
    }
    const found = await bridge().query({ text: name })
    const exact = Array.isArray(found)
      ? found.filter((item) => !item.offPage && item.label && fold(item.label) === fold(name))
      : []
    return exact.length === 1 ? exact[0] : undefined
  }

  async function act({ steps }: Parameters<UiAgent['act']>[0]) {
    const done: ActResult['steps'] = []
    const appeared = new Set<string>()
    let values: ActResult['values'] = {}
    const touchedNames = new Map<string, string>()
    const touched = new Set<string>()
    let error: ActResult['error']
    for (const [index, step] of steps.entries()) {
      const found = await named(step.ref)
      if (!found && isRef(step.ref)) {
        error = { step: index, message: `No component ${step.ref} on the page.` }
        break
      }
      const one = await bridge().act({ steps: [{ ...step, ref: found?.ref ?? step.ref }] })
      done.push(...one.steps.map((item) => ({ ...item, step: index })))
      for (const item of one.appeared) appeared.add(item.ref)
      values = one.values
      for (const item of one.steps) touched.add(item.ref)
      for (const name of Object.keys(one.values))
        if (touched.has(name.split(' ')[0])) touchedNames.set(name.split(' ')[0], name)
      if (!one.ok) {
        error = one.error && { ...one.error, step: index }
        break
      }
    }
    const live = (await Promise.all([...appeared].map(named))).filter(
      (item): item is UiComponent => !!item,
    )
    const open = (await Promise.all([...touched].map(named))).filter(
      (item): item is UiComponent => item?.open === true,
    )
    if ('more' in values) values = await keepTouched(values, touchedNames)
    return {
      ok: !error,
      ...(error && { error }),
      steps: done,
      ...(open.length ? { open } : {}),
      appeared: live,
      values,
    }
  }

  async function keepTouched(values: ActResult['values'], touchedNames: Map<string, string>) {
    const { more, ...listed } = values
    const restored: [string, unknown][] = []
    for (const [ref, name] of touchedNames) {
      if (Object.keys(listed).some((key) => key.startsWith(`${ref} `))) continue
      const now = await named(ref)
      const key = now && ('checked' in now ? 'checked' : 'value' in now ? 'value' : undefined)
      if (now && key && now.open !== true) restored.push([name, now[key]])
    }
    const touchedRefs = new Set(touchedNames.keys())
    const untouched = Object.keys(listed).filter((name) => !touchedRefs.has(name.split(' ')[0]))
    const kept = restored.slice(0, untouched.length)
    for (const name of untouched.slice(untouched.length - kept.length)) delete listed[name]
    return { ...Object.fromEntries(kept), ...listed, more }
  }

  return { bridge, named, act }
}
export type UiAgentHandle = ReturnType<typeof createUiAgent>
