"use client";

import { MonitorIcon, MoonIcon, SunIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { isMutinyColorScheme, type MutinyColorScheme } from "./color-scheme";
import { useMutinyColorScheme, useMutinyPresentation } from "./theme-provider";
import { cn } from "./ui/cn";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const OPTIONS: readonly { readonly value: MutinyColorScheme; readonly label: string; readonly hint: string; readonly Icon: LucideIcon }[] = [
  { value: "light", label: "Light", hint: "Light theme", Icon: SunIcon },
  { value: "dark", label: "Dark", hint: "Dark theme", Icon: MoonIcon },
  { value: "system", label: "System", hint: "Match your computer's light or dark setting", Icon: MonitorIcon },
];

export interface ThemeToggleProps {
  readonly className?: string;
  readonly "data-testid"?: string;
}

/**
 * Light / Dark / System, always visible, for standalone MutinyBIM. Renders
 * nothing when MutinyBIM is embedded or the provider has no way to change the
 * scheme: the host's own theme setting is the one control then.
 */
export function ThemeToggle({ className, "data-testid": testId = "mutiny-theme-toggle" }: ThemeToggleProps) {
  const { preference, resolved, setPreference, error } = useMutinyColorScheme();
  const presentation = useMutinyPresentation();
  if (presentation === "embedded" || !setPreference) return null;
  return (
    <div className={cn("inline-flex items-center gap-1.5", className)} data-testid={testId} data-resolved={resolved}>
      <ToggleGroup
        type="single"
        value={preference}
        onValueChange={(value) => {
          // Radix sends "" when the pressed item is clicked again; keep the current pick.
          if (isMutinyColorScheme(value)) setPreference(value);
        }}
        aria-label="Theme"
      >
        {OPTIONS.map(({ value, label, hint, Icon }) => (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={value} aria-label={`${label} theme`} data-testid={`mutiny-theme-${value}`}>
                <Icon aria-hidden="true" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="bottom">{value === "system" ? `${hint} (now ${resolved})` : hint}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
      {error ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="alert" aria-label={error} className="inline-flex text-(--mutiny-warning)" data-testid="mutiny-theme-error">
              <TriangleAlertIcon className="size-4" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{error}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
