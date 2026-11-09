'use client'

import { Component, type ReactNode } from 'react'
import { RotateCw, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Spinner } from '../../ui/spinner'

/**
 * A schedule docked as a tab beside the plan (round 12 E12): full height at
 * the right of the canvas, left of Properties when Properties is open, so the
 * plan and the schedule are both in view. Generic: any schedule record can
 * open here (an add-on's schedule for one record). It shows loading, an error with
 * Retry, and why editing is off ("Read only: …") above the schedule.
 */
export interface ScheduleTabProps {
  readonly title: string
  /** Properties is open on the right: the tab sits left of it. */
  readonly besideProperties: boolean
  readonly loading: boolean
  /** Why editing is off, in the operator's words; null when the person can edit. */
  readonly readOnly: string | null
  readonly onClose: () => void
  /** Draws the schedule again after an error. */
  readonly onRetry: () => void
  /** A schedule that can't be drawn, in words, with what to do (shown instead of the children). */
  readonly unavailable?: { readonly title: string; readonly description: string } | null
  readonly children: ReactNode
}

class ScheduleErrorBoundary extends Component<{ readonly onRetry: () => void; readonly resetKey: string; readonly children: ReactNode }, { readonly message: string | null; readonly key: string }> {
  state = { message: null as string | null, key: this.props.resetKey }

  static getDerivedStateFromError(err: unknown): { message: string } {
    return { message: err instanceof Error ? err.message : String(err) }
  }

  static getDerivedStateFromProps(props: { readonly resetKey: string }, state: { readonly message: string | null; readonly key: string }) {
    return props.resetKey === state.key ? null : { message: null, key: props.resetKey }
  }

  componentDidCatch(err: unknown) {
    console.error('[ScheduleTab] the schedule could not be drawn', err)
  }

  render() {
    if (this.state.message === null) return this.props.children
    return (
      <Alert variant="destructive" className="m-3 w-auto" data-testid="schedule-tab-error">
        <AlertTitle>This schedule couldn&apos;t be drawn</AlertTitle>
        <AlertDescription>
          <p>{this.state.message}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              this.setState({ message: null })
              this.props.onRetry()
            }}
          >
            <RotateCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
}

export function ScheduleTab({ title, besideProperties, loading, readOnly, onClose, onRetry, unavailable, children }: ScheduleTabProps) {
  return (
    <section
      className={`absolute inset-y-0 z-20 flex w-[min(44rem,55%)] flex-col border-l bg-background shadow-sm ${besideProperties ? 'right-80' : 'right-0'}`}
      aria-label={title}
      data-testid="schedule-tab"
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="truncate text-sm font-medium" data-testid="schedule-tab-title">
          {title}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close the schedule" onClick={onClose} data-testid="schedule-tab-close">
          <X />
        </Button>
      </header>
      {readOnly && (
        <p className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground" data-testid="schedule-tab-read-only">
          Read only: {readOnly}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground" role="status" data-testid="schedule-tab-loading">
            <Spinner />
            Loading the schedule…
          </div>
        ) : unavailable ? (
          <Empty data-testid="schedule-tab-unavailable">
            <EmptyHeader>
              <EmptyTitle>{unavailable.title}</EmptyTitle>
              <EmptyDescription>{unavailable.description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScheduleErrorBoundary onRetry={onRetry} resetKey={title}>
            {children}
          </ScheduleErrorBoundary>
        )}
      </div>
    </section>
  )
}
