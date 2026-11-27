import {
  api,
  defineWebExtension,
  errorMessage,
  getConversation,
  getState,
  notify,
  refreshModels,
} from '@/sdk/solid'
import { FellBack } from './fallback.solid.tsx'
import { agentsPanel } from './family-state.web.ts'
import { LoginDialog } from './login.solid.tsx'
import { ModelPicker } from './picker.solid.tsx'
import { RefreshCatalogAction } from './refs.ts'
import { nextThinking, openLogin, openPicker, thinkingDialog } from './state.web.ts'
import { Switched } from './switched.solid.tsx'
import { ModelControl } from './toolbar.solid.tsx'

export default defineWebExtension({
  entries: { 'pi.assistant': Switched, 'models.fallback': FellBack },
  slots: {
    'composer.toolbar': ModelControl,
    overlay: [ModelPicker, LoginDialog],
  },
  commands: [
    {
      id: 'model.families',
      title: 'Model families…',
      run: (context) => context.openPanel(agentsPanel),
    },
    {
      id: 'model.pick',
      title: 'Pick a model',
      run: (context) => {
        if (!getConversation(context.conversationId).loading) openPicker(context)
      },
    },
    {
      id: 'model.thinking',
      title: 'Set the thinking level',
      run: (context) => context.open(thinkingDialog(context.conversationId)),
    },
    {
      id: 'model.thinking.cycle',
      title: 'Cycle the thinking level',
      keys: 'shift+tab',
      whileTyping: true,
      run: async (context) => {
        const { agent, loading } = getConversation(context.conversationId)
        if (loading) return undefined
        const ref = agent.model
        const thinking = agent.thinkingLevel
        const model = getState().models?.models.find(
          (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
        )
        if (!model?.reasoning) return undefined
        return api.configure(
          { thinkingLevel: nextThinking(thinking, model) },
          context.conversationId,
        )
      },
    },
    {
      id: 'model.catalog.refresh',
      title: 'Refresh model catalog',
      run: async () => {
        try {
          const { errors } = await api.action(RefreshCatalogAction, null)
          await refreshModels()
          const failed = Object.entries(errors)
          notify(
            failed.length
              ? {
                  level: 'warning',
                  message: `Model catalog refreshed, except ${failed.map(([provider, message]) => `${provider} (${message})`).join(', ')}`,
                }
              : { level: 'info', message: 'Model catalog refreshed' },
          )
        } catch (error) {
          notify({ level: 'error', message: errorMessage(error) })
        }
      },
    },
    {
      id: 'auth.login',
      title: 'Log in to a provider',
      run: (context) => openLogin(context),
    },
  ],
})
