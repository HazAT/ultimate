import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import type { ExtensionHost } from '../../server/extensions.ts'

const NO_THINKING_OFF = new Set(['claude-sonnet-5.5'])

export function copilotWithoutThinkingOff() {
  // Pi upstream: @earendil-works/pi-ai@1.6.0 providers/data/github-copilot.json lacks thinkingLevelMap.off: null for claude-sonnet-5.5.
  const provider = githubCopilotProvider()
  const withoutOff = <Model extends { id: string; thinkingLevelMap?: object }>(model: Model) =>
    NO_THINKING_OFF.has(model.id)
      ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } }
      : model
  const getAllModels = provider.getAllModels?.bind(provider)
  return {
    ...provider,
    getModels: () => provider.getModels().map(withoutOff),
    ...(getAllModels ? { getAllModels: () => getAllModels().map(withoutOff) } : {}),
  }
}

export function installCopilotThinkingFix(host: ExtensionHost) {
  const shared = host.resource('models.copilot-thinking', () => ({ facets: new Set<symbol>() }))
  const facet = Symbol('models')
  shared.facets.add(facet)
  host.onClose(async () => {
    shared.facets.delete(facet)
    if (!shared.facets.size) host.modelRuntime.unregisterProvider('github-copilot')
  })
  host.modelRuntime.registerNativeProvider(copilotWithoutThinkingOff())
}
