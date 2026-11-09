import type { ComponentType, ComponentProps, ReactNode } from "react";
import { Button } from "./ui/button";
import { Badge, Spinner } from "./ui/primitives";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * The primitives MutinyBIM's shell draws with. By default these are the vendored
 * shadcn components in `./ui`. A host that already ships shadcn can hand its own
 * in through `<MutinyThemeProvider components={...}>`; they must accept the same
 * props (shadcn's public API), so a host's `@/components/ui/button` drops in.
 */
export interface MutinyComponents {
  readonly Button: ComponentType<ComponentProps<typeof Button>>;
  readonly Badge: ComponentType<ComponentProps<typeof Badge>>;
  readonly Spinner: ComponentType<ComponentProps<typeof Spinner>>;
  readonly Tooltip: ComponentType<{ children?: ReactNode }>;
  readonly TooltipTrigger: ComponentType<{ asChild?: boolean; children?: ReactNode }>;
  readonly TooltipContent: ComponentType<{ children?: ReactNode; side?: "top" | "right" | "bottom" | "left" }>;
}

export const defaultComponents: MutinyComponents = {
  Button,
  Badge,
  Spinner,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
};
