"use client";

import type { ComponentProps } from "react";

/**
 * shadcn-shaped form primitives (Input, Textarea, NativeSelect, Checkbox) for
 * the schedule surfaces, styled only with `--mutiny-*` variables so they draw
 * the same embedded in a host or standalone. `@permitzip/bim-ui` has no form
 * controls yet; these are the candidates to move there.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cx("mutiny-sched-input", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cx("mutiny-sched-textarea", className)} {...props} />;
}

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="native-select" className={cx("mutiny-sched-select", className)} {...props} />;
}

export function NativeSelectOption(props: ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

/** A native checkbox. Give it a name: wrap it in a label, or set aria-label / aria-labelledby. */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return <input type="checkbox" data-slot="checkbox" className={cx("mutiny-sched-checkbox", className)} {...props} />;
}
