"use client";

import { useId } from "react";
import { Button } from "../../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { cn } from "../../ui/cn";
import {
  MOVE_MODE_HELP,
  MOVE_MODE_LABEL,
  type OriginMoveMode,
} from "../coordinates";

const MODES: readonly OriginMoveMode[] = ["move_point", "relocate_project"];

/**
 * A site (dashed), the building on it (filled) and the origin marker (circle).
 * Marker only: the marker slides, the building stays. Building on the site: the
 * building and its marker slide together across the site.
 */
function Illustration({ mode }: { readonly mode: OriginMoveMode }) {
  const building = mode === "relocate_project";
  const arrow = `bm-move-arrow-${useId().replace(/:/g, "")}`;
  return (
    <span
      className="flex h-10 w-14 shrink-0"
      data-testid={`move-mode-illustration-${mode}`}
    >
      <svg viewBox="0 0 56 40" className="size-full!" aria-hidden>
        <rect
          x="1.5"
          y="1.5"
          width="53"
          height="37"
          rx="2"
          className="fill-none stroke-muted-foreground/50"
          strokeDasharray="3 2"
        />
        <rect
          x={building ? 8 : 14}
          y="12"
          width="18"
          height="16"
          rx="1"
          className={cn(
            "stroke-foreground/40",
            building ? "fill-muted-foreground/15" : "fill-muted-foreground/30",
          )}
        />
        {building && (
          <rect
            x="22"
            y="12"
            width="18"
            height="16"
            rx="1"
            className="fill-muted-foreground/30 stroke-foreground/50"
          />
        )}
        <circle
          cx={building ? 10 : 16}
          cy="26"
          r="2.5"
          className="fill-none stroke-info-600/50"
        />
        <circle
          cx={building ? 24 : 40}
          cy={building ? 26 : 20}
          r="2.5"
          className="fill-info-600"
        />
        <path
          d={building ? "M13 34 H33" : "M19 26 L36 21"}
          className="stroke-info-600"
          strokeWidth="1.25"
          markerEnd={`url(#${arrow})`}
          fill="none"
        />
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 6 6"
            refX="5"
            refY="3"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0 0 L6 3 L0 6 z" className="fill-info-600" />
          </marker>
        </defs>
      </svg>
    </span>
  );
}

function Option({ mode }: { readonly mode: OriginMoveMode }) {
  return (
    <span className="flex items-center gap-2.5 text-left">
      <Illustration mode={mode} />
      <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
        <span className="text-sm font-medium">{MOVE_MODE_LABEL[mode]}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {MOVE_MODE_HELP[mode]}
        </span>
      </span>
    </span>
  );
}

/**
 * The one question a move asks: does only the origin marker move, or does the
 * building move on the site? `onCommit` is a pair of buttons that act on click
 * (the remembered choice is focused, so Enter takes it); `onChange` is a picker.
 */
export function MoveModeChoice(
  props: { readonly value: OriginMoveMode; readonly testIdPrefix: string } & (
    | { readonly onCommit: (mode: OriginMoveMode) => void }
    | { readonly onChange: (mode: OriginMoveMode) => void }
  ),
) {
  const { value, testIdPrefix } = props;
  if ("onCommit" in props) {
    return (
      <div
        className="flex flex-col gap-1.5"
        role="group"
        aria-label="How the origin moves"
      >
        {MODES.map((m) => (
          <Button
            key={m}
            type="button"
            variant={m === value ? "secondary" : "outline"}
            className="h-auto justify-start py-2"
            autoFocus={m === value}
            data-default={m === value || undefined}
            data-testid={`${testIdPrefix}-${m}`}
            onClick={() => props.onCommit(m)}
          >
            <Option mode={m} />
          </Button>
        ))}
      </div>
    );
  }
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      orientation="vertical"
      className="w-full flex-col items-stretch"
      value={value}
      onValueChange={(v) =>
        (v === "move_point" || v === "relocate_project") && props.onChange(v)
      }
      aria-label="How the origin moves"
    >
      {MODES.map((m) => (
        <ToggleGroupItem
          key={m}
          value={m}
          className="h-auto justify-start py-2"
          data-testid={`${testIdPrefix}-${m}`}
        >
          <Option mode={m} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
