// Streamdown's diagram plugin, loading Mermaid only when a message first shows a diagram: `@streamdown/mermaid`
// imports it up front, half a megabyte on every page load.
import type { DiagramPlugin, MermaidErrorComponentProps } from 'streamdown'
import { CodeBlock } from './code-block.tsx'

let swatch: CanvasRenderingContext2D | null | undefined

/** A theme token as hex: Mermaid derives shades from its colours and reads no `oklch()`. */
function hex(token: string) {
  swatch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!swatch) return undefined
  swatch.clearRect(0, 0, 1, 1)
  swatch.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`)
  swatch.fillRect(0, 0, 1, 1)
  const [red = 0, green = 0, blue = 0] = swatch.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/** Mermaid's `base` theme in the page's tokens, read as a diagram renders, after the page switched theme. */
const colours = (theme: 'dark' | 'light') => ({
  theme: 'base' as const,
  darkMode: theme === 'dark',
  fontFamily: getComputedStyle(document.body).fontFamily,
  themeVariables: {
    fontSize: '13px',
    background: hex('background'),
    primaryColor: hex('secondary'),
    primaryTextColor: hex('foreground'),
    primaryBorderColor: hex('input'),
    secondaryColor: hex('accent'),
    tertiaryColor: hex('card'),
    lineColor: hex('muted-foreground'),
    textColor: hex('foreground'),
    clusterBkg: hex('card'),
    clusterBorder: hex('border'),
    edgeLabelBackground: hex('background'),
    noteBkgColor: hex('muted'),
    noteBorderColor: hex('input'),
    noteTextColor: hex('foreground'),
  },
})

/** The diagram plugin for one theme: Streamdown renders every diagram again when it gets a new plugin. */
export const diagramPlugin = (theme: 'dark' | 'light'): DiagramPlugin => ({
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid: () => ({
    // Each render sets the theme itself.
    initialize: () => undefined,
    async render(id, source) {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        ...colours(theme),
      })
      return mermaid.render(id, source)
    },
  }),
})

/**
 * A chart Mermaid cannot parse, or one still streaming in, stays its highlighted source: the diagram's frame already
 * carries the language and the copy button, so it reads as the code block it was written as.
 */
export function MermaidSource({ chart }: MermaidErrorComponentProps) {
  return (
    <CodeBlock
      className="rounded-none border-none bg-transparent [&_pre]:pt-0 [&_pre]:pb-2.5"
      code={chart}
      language="mermaid"
    />
  )
}
