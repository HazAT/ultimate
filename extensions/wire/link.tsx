import { useUiState, useUltimate } from '@/sdk'
import { SYSTEM_TAB_KEY } from '../system/ui.tsx'

export function useOpenWire() {
  const [, setTab] = useUiState<string>(SYSTEM_TAB_KEY, 'agents')
  const { showSurface } = useUltimate()
  return () => {
    setTab('wire')
    showSurface('system')
  }
}
