import { expect, it } from 'vitest'
import { base64FromBytes, pathFromDrop } from '../../web/src/lib/drop.ts'

it('takes the absolute path a drag hands over as text', () => {
  // A file manager's uri-list, with its CRLF endings.
  expect(pathFromDrop('file:///Users/x/notes%20for%20today.txt\r\n')).toBe(
    '/Users/x/notes for today.txt',
  )
  // Percent escapes are URLs, so they decode: a space, a `#`, a `?`, a non-ASCII name.
  expect(pathFromDrop('file:///Users/x/a%23b%3Fc%20d.txt')).toBe('/Users/x/a#b?c d.txt')
  expect(pathFromDrop('file:///Users/x/caf%C3%A9.txt')).toBe('/Users/x/café.txt')
  expect(pathFromDrop('file://localhost/Users/x/a.txt')).toBe('/Users/x/a.txt')
  // A plain text drag of a path, as a terminal takes it.
  expect(pathFromDrop('/Users/x/a.txt')).toBe('/Users/x/a.txt')
  expect(pathFromDrop('  /Users/x/a.txt\n')).toBe('/Users/x/a.txt')
  // A uri-list may carry comments and several files: the first one is the dropped file.
  expect(pathFromDrop('# comment\r\nfile:///Users/x/first.txt\r\nfile:///Users/x/second.txt')).toBe(
    '/Users/x/first.txt',
  )
})

it('hands nothing over for text that is not a path', () => {
  expect(pathFromDrop('a paragraph of text')).toBeUndefined()
  expect(pathFromDrop('https://example.com/a.txt')).toBeUndefined()
  // A drag from Finder carries the bare name; a browser never reveals the path behind it.
  expect(pathFromDrop('a.txt')).toBeUndefined()
  // A malformed escape is not a path this can decode.
  expect(pathFromDrop('file:///Users/x/100%.txt')).toBeUndefined()
  expect(pathFromDrop('')).toBeUndefined()
})

it('encodes a dropped file in chunks the browser can take', () => {
  expect(base64FromBytes(new Uint8Array([104, 105]))).toBe('aGk=')
  const large = new Uint8Array(0x8000 + 3).fill(65)
  expect(base64FromBytes(large).length).toBe(Math.ceil(large.length / 3) * 4)
  expect(base64FromBytes(new Uint8Array())).toBe('')
})
