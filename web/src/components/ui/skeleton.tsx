import { cn } from 'cn'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'animate-sweep rounded-md bg-muted bg-size-[300%_100%] bg-fixed bg-no-repeat bg-[linear-gradient(90deg,transparent_40%,color-mix(in_oklab,var(--color-foreground)_7%,transparent)_50%,transparent_60%)]',
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
