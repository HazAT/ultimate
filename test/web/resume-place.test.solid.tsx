import { afterEach, expect, it } from 'vitest'
import { capturePlace, restorePlace } from '../../web/src/sdk/resume-place.ts'

afterEach(() => document.body.replaceChildren())

function page(html: string) {
  document.body.innerHTML = html
  return (selector: string) => document.querySelector<HTMLInputElement>(selector)!
}

it('keeps named text fields and the caret, never a password, and drops typed keys it cannot place', () => {
  let field = page(`
    <textarea data-resume="prompt:1"></textarea>
    <input data-resume="search" id="search" type="search">
    <input data-resume="secret" type="password">
    <input id="unnamed" type="text">`)
  field('textarea').value = 'hello world'
  field('#search').value = 'deploys'
  field('[type=password]').value = 'hunter2'
  field('#unnamed').value = 'not opted in'
  field('textarea').focus()
  field('textarea').setSelectionRange(5, 5)
  const place = capturePlace({})
  expect(place.fields).toEqual({ 'prompt:1': 'hello world', search: 'deploys' })

  field = page(
    `<textarea data-resume="prompt:1"></textarea><input data-resume="search" id="search" type="search">`,
  )
  field('#search').value = 'typed on the new page'
  restorePlace(place, 'XY')
  expect(field('textarea').value).toBe('helloXY world')
  expect(document.activeElement).toBe(field('textarea'))
  expect(field('textarea').selectionStart).toBe(7)
  expect(field('#search').value).toBe('typed on the new page')

  field = page(`<textarea data-resume="prompt:1"></textarea>`)
  restorePlace({ ...place, fields: {} }, 'XY')
  expect(field('textarea').value).toBe('')
  page(`<textarea data-resume="prompt:2"></textarea>`)
  restorePlace(place, 'XY')
  expect(document.body.textContent).not.toContain('XY')
})
