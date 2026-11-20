/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { omit } from 'solid-js'

function Form(props: Omit<JSX.IntrinsicElements['form'], 'onSubmit' | 'action' | 'method'>) {
  const rest = omit(props, 'children')
  return (
    <form {...rest} onSubmit={(event) => event.preventDefault()}>
      {props.children}
    </form>
  )
}

export { Form }
