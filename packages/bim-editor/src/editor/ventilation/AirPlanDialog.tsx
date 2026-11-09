'use client'

import { CircleAlert, CircleCheck, CircleX } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia } from '../../ui/item'

/** One line of a plan: what happens to one element, or why it can't. */
export interface AirPlanLine {
  readonly key: string
  readonly elementId: string
  readonly ok: boolean
  readonly text: string
}

export interface AirPlanDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: string
  /** Short facts above the list (each system's sizing rule). */
  readonly notes?: readonly string[]
  readonly lines: readonly AirPlanLine[]
  /** Why nothing can be planned (nothing selected, nothing to change); replaces the list. */
  readonly empty: string | null
  /** Why the plan can't be applied (editing off, an older model server); the list still shows. */
  readonly blocked: string | null
  readonly confirmLabel: string
  readonly closeLabel: string
  readonly hint: string
  readonly onConfirm: () => void
  readonly onSelect: (elementId: string) => void
  readonly testId: string
}

/**
 * The preview window Mechanical › Connect › To duct and Analyze › Size ducts
 * open: one line per element (what it gets, or why not), nothing changed
 * until the button; one Undo takes it back. Esc and Cancel close it.
 */
export function AirPlanDialog(p: AirPlanDialogProps) {
  const ready = p.lines.filter((l) => l.ok).length
  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid={p.testId}>
        <DialogHeader>
          <DialogTitle>{p.title}</DialogTitle>
          <DialogDescription>{p.description}</DialogDescription>
        </DialogHeader>
        {p.blocked && (
          <Alert data-testid={`${p.testId}-blocked`}>
            <CircleAlert />
            <AlertTitle>Nothing can be changed here yet</AlertTitle>
            <AlertDescription>{p.blocked}</AlertDescription>
          </Alert>
        )}
        {p.empty ? (
          <Empty className="border" data-testid={`${p.testId}-empty`}>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlert />
              </EmptyMedia>
              <EmptyTitle>Nothing to do</EmptyTitle>
              <EmptyDescription>{p.empty}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {p.notes && p.notes.length > 0 && (
              <ul className="text-muted-foreground flex flex-col gap-1 text-sm" data-testid={`${p.testId}-notes`}>
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <ItemGroup className="gap-1" data-testid={`${p.testId}-lines`}>
              {p.lines.map((l) => (
                <Item key={l.key} size="sm" variant="outline" data-ok={l.ok}>
                  <ItemMedia variant="icon">{l.ok ? <CircleCheck className="text-success-700" /> : <CircleX className="text-danger-600" />}</ItemMedia>
                  <ItemContent>
                    <ItemDescription className="text-foreground line-clamp-none text-sm">{l.text}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="ghost" size="sm" onClick={() => p.onSelect(l.elementId)}>
                      Select
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </>
        )}
        <p className="text-muted-foreground text-xs">{p.hint}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => p.onOpenChange(false)}>
            {p.closeLabel}
          </Button>
          <Button onClick={p.onConfirm} disabled={ready === 0 || p.blocked !== null || p.empty !== null} title={p.blocked ?? (ready === 0 ? (p.empty ?? 'Each line says why it can’t be done.') : undefined)} data-testid={`${p.testId}-confirm`}>
            {p.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
