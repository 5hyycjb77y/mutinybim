'use client'

import { Fragment, useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../../ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../ui/dropdown-menu'
import type { DrawingMenu, DrawingMenuAction, DrawingMenuItem } from './drawing-menu-items'

interface Props {
  /** Pixels from the canvas's top-left where the right-click landed; null when closed. */
  readonly at: { readonly x: number; readonly y: number } | null
  readonly menu: DrawingMenu | null
  readonly onClose: () => void
  readonly onRun: (action: DrawingMenuAction) => void
}

function groups(items: readonly DrawingMenuItem[]): DrawingMenuItem[][] {
  const out: DrawingMenuItem[][] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (!last || item.groupStart) out.push([item])
    else last.push(item)
  }
  return out
}

/** The drawing and sheet right-click menu at the pointer. Esc or a click away closes it; a greyed item says why it can't run. */
export function DrawingContextMenu({ at, menu, onClose, onRun }: Props) {
  const [confirming, setConfirming] = useState<DrawingMenuItem | null>(null)
  return (
    <>
      <DropdownMenu open={at !== null && menu !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="w-64" data-testid="drawing-context-menu">
          <DropdownMenuLabel className="truncate text-xs text-muted-foreground">{menu?.title}</DropdownMenuLabel>
          {menu &&
            groups(menu.items).map((group, i) => (
              <Fragment key={group[0]?.id ?? i}>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {group.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      disabled={item.disabledReason !== undefined}
                      title={item.disabledReason}
                      className="flex-col items-start gap-0 data-[disabled]:opacity-100"
                      data-testid={`drawing-menu-${item.id}`}
                      onSelect={() => {
                        if (item.confirm) setConfirming(item)
                        else onRun(item.id)
                      }}
                    >
                      <span className={item.disabledReason ? 'text-muted-foreground' : undefined}>{item.label}</span>
                      {(item.disabledReason ?? item.hint) && (
                        <span className="text-xs text-muted-foreground" data-testid={item.disabledReason ? `drawing-menu-${item.id}-why` : undefined}>
                          {item.disabledReason ?? item.hint}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </Fragment>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-testid="drawing-menu-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirming) onRun(confirming.id)
                setConfirming(null)
              }}
            >
              {confirming?.confirm?.confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
