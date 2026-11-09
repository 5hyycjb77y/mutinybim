'use client'

import { ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react'
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'

export type ToolHintTone = 'info' | 'warning'

const KEY_NAMES = /\b(Shift|Tab|Esc|Enter|Alt|Option|Ctrl|Cmd|Space|Backspace)\b/g

function withKeyChips(text: string) {
  const parts = text.split(KEY_NAMES)
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <kbd key={i} className="mx-px rounded-sm border border-border bg-muted px-1 font-sans text-[0.6875rem] leading-4 font-medium text-foreground">
        {part}
      </kbd>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

/**
 * The live tool hint as a slim status line along the bottom of the canvas.
 * Product decision, Oct 22: the old card at top-centre sat over the drawing. This floats
 * (absolute, never takes layout space) and ignores the pointer so hovering and
 * dragging under it still reach the canvas; only the expand chevron takes clicks.
 * Key names render as chips without changing the text content tests read.
 */
export function ToolHintBar({
  text,
  tone = 'info',
  testId = 'building-model-tool-hint',
  className,
  style,
}: {
  text: string
  tone?: ToolHintTone
  testId?: string
  className?: string
  /** Where it sits beside a side rail the person resized (its right edge). */
  style?: CSSProperties
}) {
  const textRef = useRef<HTMLSpanElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || expanded) return
    setTruncated(el.scrollWidth > el.clientWidth)
  }, [text, expanded])

  return (
    <div className={cn('pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center', className)} style={style} data-testid="tool-hint-bar" data-tone={tone}>
      <div
        className={cn(
          'flex max-w-2xl min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs backdrop-blur-sm',
          tone === 'warning' ? 'border-warning-300 bg-warning-50/95 text-warning-800' : 'border-border/70 bg-background/90 text-muted-foreground',
        )}
      >
        {tone === 'warning' && <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
        <span ref={textRef} className={cn('min-w-0', expanded ? 'whitespace-normal' : 'truncate')} role="status" aria-live="polite" data-testid={testId}>
          {withKeyChips(text)}
        </span>
        {(truncated || expanded) && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="pointer-events-auto -my-0.5 shrink-0 self-start text-current"
            aria-label={expanded ? 'Show less of the hint' : 'Show the full hint'}
            aria-expanded={expanded}
            title={expanded ? undefined : text}
            onClick={() => setExpanded((v) => !v)}
            data-testid="tool-hint-expand"
          >
            {expanded ? <ChevronDown /> : <ChevronUp />}
          </Button>
        )}
      </div>
    </div>
  )
}
