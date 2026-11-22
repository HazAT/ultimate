import { describe, expect, it } from 'vitest'
import { AnsiOutput } from '../../web/src/components/ai/ansi-output.solid.tsx'
import { ToolOutput } from '../../web/src/components/ai/tool.solid.tsx'
import { renderSolid } from './solid-dom-setup.ts'

const renderAnsi = (output: string) => renderSolid(() => <AnsiOutput output={output} />)

describe('ANSI output rendering', () => {
  it('renders colour, bold, dim and reset without visible SGR tokens', () => {
    const container = renderAnsi('\x1b[1;94mHeading\x1b[2mdim\x1b[22mblue\x1b[0mnormal')
    const [heading, dim, blue] = container.querySelectorAll<HTMLSpanElement>('span > span')
    expect(container.textContent).toBe('Headingdimbluenormal')
    expect(heading.style.fontWeight).toBe('bold')
    expect(heading.style.color).toBe('rgb(85, 85, 255)')
    expect(dim.style.opacity).toBe('0.7')
    expect(blue.style.fontWeight).toBe('')
    expect(blue.style.opacity).toBe('')
    expect(blue.style.color).toBe(heading.style.color)
    expect(container.firstElementChild?.lastChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.firstElementChild?.lastChild?.textContent).toBe('normal')
    expect(renderAnsi('plain').innerHTML).toBe('<span>plain</span>')
  })

  it('removes unsafe sequences, including their payload, before rendering', () => {
    expect(
      renderAnsi('\x1b]52;c;secret\x07\x1b[2K\x1b[?25l\x1bPsecret\x1b\\safe\x00\x7f').innerHTML,
    ).toBe(renderAnsi('safe').innerHTML)
    expect(renderAnsi('\x1b]8;;javascript:alert(1)\x1b\\label\x1b]8;;\x1b\\').innerHTML).toBe(
      renderAnsi('label').innerHTML,
    )
    expect(renderAnsi('safe\x1b[31;').innerHTML).toBe(renderAnsi('safe').innerHTML)
  })

  it('escapes HTML with or without ANSI formatting', () => {
    const output = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>'
    for (const text of [output, `\x1b[1;31m${output}\x1b[0m`]) {
      const container = renderAnsi(text)
      expect(container.textContent).toBe(output)
      expect(container.querySelector('img, script')).toBeNull()
      expect(container.innerHTML).toContain('&lt;img')
      expect(container.innerHTML).toContain('&amp;')
      expect(container.innerHTML).toContain('&lt;script&gt;')
    }
    const brackets = '[hello] [1,2] [1] [;m [31:m [warnm [2K [?25l [1;] [31m [1;94m'
    expect(renderAnsi(brackets).innerHTML).toBe(`<span>${brackets}</span>`)
  })

  it('uses the ANSI renderer in shared ToolOutput, including errors', () => {
    const output = '\x1b[1;31mfailed\x1b[0m <script> &'
    const container = renderSolid(() => <ToolOutput output={output} isError />)
    const body = container.querySelector('pre')
    expect(container.textContent).toContain('Error')
    expect(body?.innerHTML).toBe(renderAnsi(output).innerHTML)
    expect(body?.textContent).toBe('failed <script> &')
    expect(body?.querySelector('script')).toBeNull()
  })
})
