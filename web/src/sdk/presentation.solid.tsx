/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { createContext, createMemo, useContext } from 'solid-js'
import type { Accessor } from 'solid-js'
import { useProvided } from './contribution.solid.tsx'
import { PresentationPoint } from './types.ts'
import type { Presentation } from './types.ts'

/** The unmodified shell and conversation presentation. */
export const defaultPresentation: Presentation = {
  titlebar: 'full',
  composer: 'full',
  backgroundUpdates: 'show',
  contextHeader: 'show',
}

const PresentationContext = createContext<Accessor<Presentation>>(() => defaultPresentation)

/** The shell's current presentation. */
export const usePresentation = () => useContext(PresentationContext)

export function PresentationProvider(props: { children: JSX.Element }) {
  const failures = (<span class="contents" />) as HTMLElement
  const provided = useProvided(PresentationPoint, () => null, failures)
  const value = createMemo(() => ({ ...defaultPresentation, ...provided() }))
  return (
    <PresentationContext value={value}>
      {failures}
      {props.children}
    </PresentationContext>
  )
}
