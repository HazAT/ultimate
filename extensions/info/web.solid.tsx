import { InfoIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { InfoPanel } from './panel.solid.tsx'
import { SkillPicker, skillDialog } from './skill-picker.solid.tsx'

export default defineWebExtension({
  panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: InfoPanel, order: 5 }],
  slots: { overlay: [SkillPicker] },
  commands: [
    {
      id: 'info.open',
      title: 'Show system info',
      run: (context) => context.openPanel('info'),
    },
    {
      id: 'info.skill',
      title: 'Run a skill',
      run: (context) => context.open(skillDialog),
    },
  ],
})
