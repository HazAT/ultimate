import { cn } from 'cn'
import type { CSSProperties, ElementType } from 'react'

export interface ShimmerProps {
  children: string
  as?: ElementType
  className?: string
  spread?: number
}

export const Shimmer = ({
  children,
  as: Component = 'span',
  className,
  spread: highlightPxPerCharacter = 2,
}: ShimmerProps) => (
  <Component
    className={cn(
      'inline-block animate-shimmer bg-size-[250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box]',
      className,
    )}
    style={
      {
        '--spread': `${children.length * highlightPxPerCharacter}px`,
        backgroundImage:
          'linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--color-foreground), #0000 calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
      } as CSSProperties
    }
  >
    {children}
  </Component>
)
