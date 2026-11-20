import { InfoIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { InfoPanel } from './panel.solid.tsx'
import { SkillPicker, skillDialog } from './skill-picker.solid.tsx'

export default defineWebExtension({
  panels: [{ id: 'info', title: 'Info', icon: InfoIcon, component: island(InfoPanel), order: 5 }],
  slots: { overlay: [island(SkillPicker)] },
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
