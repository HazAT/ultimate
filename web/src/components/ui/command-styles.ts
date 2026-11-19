export const commandStyles = {
  root: 'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
  dialogHeader: 'sr-only',
  dialogContent: 'overflow-hidden p-0',
  dialogCommand:
    '**:data-[slot=command-input-wrapper]:h-11 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-11 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4',
  inputWrapper: 'flex h-9 items-center gap-2 border-b px-3',
  searchIcon: 'size-4 shrink-0 opacity-50',
  input:
    'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
  list: 'max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto',
  empty: 'py-6 text-center text-sm',
  emptySolid: 'not-data-empty:hidden',
  group: 'overflow-hidden p-1 text-foreground',
  groupReact:
    '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
  headingSolid: 'px-2 py-1.5 text-xs font-medium text-muted-foreground',
  item: "relative flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
  itemReact:
    'cursor-default data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
  itemSolid:
    'data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground',
  shortcut: 'ml-auto text-xs tracking-widest text-muted-foreground',
}
