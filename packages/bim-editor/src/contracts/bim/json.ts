/**
 * A JSON value as the Building Model's routes send it (a stored scope, a
 * sign-off payload). Same shape as the database's `Json`; editor-facing
 * modules use this one so they import nothing from the host, and
 * `lib/bim/editor-shape-checks.ts` holds the two equal.
 */
export type BimJson = string | number | boolean | null | { [key: string]: BimJson | undefined } | BimJson[]
