import { createEffect } from 'solid-js'
import { shortenPath, useAgent, useStore } from '@/sdk/solid'

export const text = (value: unknown) => (typeof value === 'string' ? value : '')

export function usePath(path: () => string) {
  const agent = useAgent()
  const defaultCwd = useStore((state) => state.system?.execution.defaultCwd)
  const home = useStore((state) => state.system?.machine.home)
  return () => shortenPath(path(), { cwd: agent().cwd ?? defaultCwd(), home: home() })
}

export function useFollow(following: () => boolean, content: () => unknown) {
  let element: HTMLElement | undefined
  createEffect(
    () => [following(), content()] as const,
    ([follow]) => {
      if (follow && element) element.scrollTop = element.scrollHeight
    },
  )
  return (node: HTMLElement) => {
    element = node
  }
}

export const Caret = () => (
  <span class="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-brand align-middle" />
)
