import { systemRules, type SystemKind } from '@permitzip/bim-kernel'

/** The name a new system of `kind` gets unless the person types one: its kind and the next number ("Vent 2"). */
export function proposedSystemName(kind: SystemKind, systems: readonly { readonly kind: SystemKind }[]): string {
  return `${systemRules(kind).label} ${systems.filter((s) => s.kind === kind).length + 1}`
}
