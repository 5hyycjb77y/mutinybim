"use client";

import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { useMutinyComponents } from "./theme-provider";
import { FULLSCREEN_UNSUPPORTED, openInNewWindow, useFullscreen } from "./fullscreen";

export interface WindowControlsProps {
  /** The element that goes full screen (the BIM root). */
  readonly fullscreenTarget: HTMLElement | null;
  /** Where "Open in new window" goes; omit when already in a standalone window. */
  readonly newWindowHref?: string;
  /** Window name, so a second click focuses the same window instead of opening another. */
  readonly newWindowName?: string;
  /** Shows a problem to the person (the host's toast, an inline alert…). */
  readonly onProblem: (message: string) => void;
}

/** "Open in full screen" / "Exit full screen" and "Open in new window" for a BIM header or ribbon. */
export function WindowControls({ fullscreenTarget, newWindowHref, newWindowName = "mutinybim", onProblem }: WindowControlsProps) {
  const { Button, Tooltip, TooltipTrigger, TooltipContent } = useMutinyComponents();
  const { active, supported, toggle } = useFullscreen(fullscreenTarget);
  const fullLabel = active ? "Exit full screen" : "Open in full screen";
  const fullHint = !supported ? FULLSCREEN_UNSUPPORTED : active ? "Exit full screen (Esc)" : "Open in full screen. Esc exits.";

  return (
    <span className="inline-flex items-center gap-1" data-testid="mutiny-window-controls">
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Disabled buttons swallow hover; the wrapper keeps the reason reachable. */}
          <span tabIndex={supported ? -1 : 0} className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={fullLabel}
              aria-pressed={active}
              disabled={!supported}
              data-testid="mutiny-fullscreen"
              onClick={() => {
                void toggle().then((problem) => {
                  if (problem) onProblem(problem);
                });
              }}
            >
              {active ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{fullHint}</TooltipContent>
      </Tooltip>
      {newWindowHref ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open in new window"
              data-testid="mutiny-new-window"
              onClick={() => {
                const problem = openInNewWindow(newWindowHref, newWindowName);
                if (problem) onProblem(problem);
              }}
            >
              <ExternalLink />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in new window, with nothing else on screen</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
