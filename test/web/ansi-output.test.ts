import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AnsiOutput } from '../../web/src/compat/ai/ansi-output.tsx'
import { ToolOutput } from '../../web/src/compat/ai/tool.tsx'

const render = (output: string) => renderToStaticMarkup(createElement(AnsiOutput, { output }))

describe('ANSI output rendering', () => {
  it('renders colour, bold, dim and reset without visible SGR tokens', () => {
    const html = render('\x1b[1;94mHeading\x1b[2mdim\x1b[22mblue\x1b[0mnormal')
    expect(html).toContain('font-weight:bold')
    expect(html).toContain('color:')
    expect(html).toContain('opacity:')
    expect(html).not.toContain('\x1b')
    expect(render('plain')).toBe('<span>plain</span>')
  })

  it('removes unsafe sequences, including their payload, before rendering', () => {
    expect(render('\x1b]52;c;secret\x07\x1b[2K\x1b[?25l\x1bPsecret\x1b\\safe\x00\x7f')).toBe(
      render('safe'),
    )
    expect(render('\x1b]8;;javascript:alert(1)\x1b\\label\x1b]8;;\x1b\\')).toBe(render('label'))
    expect(render('safe\x1b[31;')).toBe(render('safe'))
  })

  it('escapes HTML with or without ANSI formatting', () => {
    const output = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>'
    const html = render(`\x1b[1;31m${output}\x1b[0m`)
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;script&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(render(output)).toContain('&lt;img')
    const brackets = '[hello] [1,2] [1] [;m [31:m [warnm [2K [?25l [1;] [31m [1;94m'
    expect(render(brackets)).toBe(`<span>${brackets}</span>`)
  })

  it('uses the ANSI renderer in shared ToolOutput, including errors', () => {
    const output = '\x1b[1;31mfailed\x1b[0m <script> &'
    const html = renderToStaticMarkup(createElement(ToolOutput, { output, isError: true }))
    expect(html).toContain('Error')
    expect(html).toContain(render(output))
    expect(html).not.toContain('[1;31m')
    expect(html).not.toContain('<script>')
  })
})
