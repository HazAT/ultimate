const solidOf = new WeakMap<object, unknown>()

export const markIsland = (island: object, component: unknown) => solidOf.set(island, component)

export const islandSolid = (component: unknown) =>
  typeof component === 'function' ? solidOf.get(component) : undefined
