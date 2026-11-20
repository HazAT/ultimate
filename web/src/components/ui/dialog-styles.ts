export const dialogStyles = {
  overlay: 'fixed inset-0 z-50 bg-black/50',
  overlayReact:
    'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
  overlaySolid:
    'transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none',
  content:
    'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none sm:max-w-lg',
  contentReact:
    'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
  contentSolid:
    'm-0 text-left font-sans text-[14px] font-normal tracking-normal whitespace-normal text-foreground normal-case transition-[opacity,scale] data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none',
  close:
    "absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  closeReact: 'data-[state=open]:bg-accent data-[state=open]:text-muted-foreground',
  header: 'flex flex-col gap-2 text-center sm:text-left',
  title: 'text-lg leading-none font-semibold',
  description: 'text-sm text-muted-foreground',
}
