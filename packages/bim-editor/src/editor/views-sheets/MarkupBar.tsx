'use client'

import { Check, Eraser, Highlighter, PenTool, Sparkles } from 'lucide-react'
import { MARKUP_WIDTH_PRESETS } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Separator } from '../../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { MARKUP_COLOR_SWATCHES, switchMarkupTool, type MarkupBrushState } from './markup-tools'

interface Props {
  readonly brush: MarkupBrushState
  readonly onChange: (next: MarkupBrushState) => void
  readonly onDone: () => void
  readonly openCount: number
}

/**
 * Compact Slack-huddle-style floating bar for sheet review markups:
 * Felt-tip Marker or Highlighter, ink colour, thickness, optional Smart Shapes,
 * Eraser, and Done.
 */
export function MarkupBar({ brush, onChange, onDone, openCount }: Props) {
  const widths = MARKUP_WIDTH_PRESETS[brush.tool]

  return (
    <div
      className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 shadow-md backdrop-blur"
      data-testid="sheet-markup-bar"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-0.5" role="group" aria-label="Markup tool">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={!brush.eraser && brush.tool === 'marker' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              aria-pressed={!brush.eraser && brush.tool === 'marker'}
              data-testid="markup-tool-marker"
              onClick={() => onChange(switchMarkupTool(brush, 'marker'))}
            >
              <PenTool className="size-3.5" />
              Marker
            </Button>
          </TooltipTrigger>
          <TooltipContent>Felt-tip marker for quick redlines, leaders and handwriting (M)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={!brush.eraser && brush.tool === 'highlighter' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              aria-pressed={!brush.eraser && brush.tool === 'highlighter'}
              data-testid="markup-tool-highlighter"
              onClick={() => onChange(switchMarkupTool(brush, 'highlighter'))}
            >
              <Highlighter className="size-3.5" />
              Highlighter
            </Button>
          </TooltipTrigger>
          <TooltipContent>Broad translucent highlighter stroke (H)</TooltipContent>
        </Tooltip>
      </div>

      <Separator orientation="vertical" className="h-4" />

      <div className="flex items-center gap-1" role="group" aria-label="Ink colour">
        {MARKUP_COLOR_SWATCHES.map((swatch, idx) => {
          const active = !brush.eraser && brush.color.toLowerCase() === swatch.color.toLowerCase()
          return (
            <Tooltip key={swatch.color}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={swatch.label}
                  aria-pressed={active}
                  data-testid={`markup-color-${swatch.color.slice(1)}`}
                  onClick={() => onChange({ ...brush, color: swatch.color, eraser: false })}
                  className={`size-5 rounded-full border p-0 transition-transform hover:bg-transparent ${active ? 'scale-110 ring-2 ring-foreground ring-offset-1 ring-offset-background' : 'border-black/20 hover:scale-105'}`}
                  style={{ backgroundColor: swatch.color }}
                />
              </TooltipTrigger>
              <TooltipContent>{swatch.label} ({idx + 1})</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <Separator orientation="vertical" className="h-4" />

      <div className="flex items-center gap-0.5" role="group" aria-label="Stroke thickness">
        {widths.map((preset, idx) => {
          const active = !brush.eraser && Math.abs(brush.widthMm - preset.widthMm) < 0.3
          const dotPx = idx === 0 ? 5 : idx === 1 ? 8 : 12
          return (
            <Tooltip key={preset.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={active ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  className="size-7 rounded-full"
                  aria-label={`${preset.label} (${preset.widthMm} mm)`}
                  aria-pressed={active}
                  data-testid={`markup-width-${preset.id}`}
                  onClick={() => onChange({ ...brush, widthMm: preset.widthMm, eraser: false })}
                >
                  <span
                    className="rounded-full"
                    style={{
                      width: dotPx,
                      height: dotPx,
                      backgroundColor: brush.color,
                      opacity: brush.tool === 'highlighter' ? 0.55 : 0.95,
                    }}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{preset.label} ({preset.widthMm} mm on paper)</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <Separator orientation="vertical" className="h-4" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={brush.smartShapes ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 rounded-full px-2 text-xs"
            aria-pressed={brush.smartShapes}
            data-testid="markup-smart-shapes"
            onClick={() => onChange({ ...brush, smartShapes: !brush.smartShapes, eraser: false })}
          >
            <Sparkles className="size-3.5" />
            Smart snap
          </Button>
        </TooltipTrigger>
        <TooltipContent>Optional: straightens near-straight lines (snaps H/V), circles and rectangles on release; leaves handwriting untouched (S)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={brush.eraser ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 rounded-full px-2 text-xs"
            aria-pressed={brush.eraser}
            data-testid="markup-tool-eraser"
            onClick={() => onChange({ ...brush, eraser: !brush.eraser })}
          >
            <Eraser className="size-3.5" />
            Erase
          </Button>
        </TooltipTrigger>
        <TooltipContent>Click or drag across markup strokes to erase them (E)</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="h-4" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 rounded-full px-2.5 text-xs"
            data-testid="markup-done"
            onClick={onDone}
          >
            <Check className="size-3.5" />
            Done{openCount > 0 ? ` (${openCount})` : ''}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Finish marking up and return to Select (Esc)</TooltipContent>
      </Tooltip>
    </div>
  )
}
