const itemIcons =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
const mutedIcons = "[&_svg:not([class*='text-'])]:text-muted-foreground"
const itemSolid =
  'data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground'

export const menuStyles = {
  content:
    'z-50 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
  contentSolid:
    'max-h-(--available-height) origin-(--transform-origin) text-left font-sans text-[14px] font-normal tracking-normal whitespace-normal normal-case transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none',
  item: `relative flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 ${itemIcons} ${mutedIcons}`,
  itemSolid: `${itemSolid} data-destructive:text-destructive data-destructive:*:[svg]:text-destructive! data-destructive:data-highlighted:bg-destructive/10 data-destructive:data-highlighted:text-destructive dark:data-destructive:data-highlighted:bg-destructive/20`,
  radioItem: `relative flex items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none ${itemIcons}`,
  radioItemSolid: itemSolid,
  indicator: 'pointer-events-none absolute left-2 flex size-3.5 items-center justify-center',
  indicatorIcon: 'size-2 fill-current',
  label: 'px-2 py-1.5 text-sm font-medium data-[inset]:pl-8',
}
