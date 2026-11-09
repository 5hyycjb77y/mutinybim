import type { SavedVersion } from '@permitzip/bim-kernel'

/**
 * What counts as a "version" you can start a branch from (round 8b question 1).
 * The one place the answer lives, so it can flip.
 *
 * Recommended and built: versions someone saved with a name ("Save version"),
 * every issued drawing set, and "right now". Saved versions are kept until
 * deleted. The alternative ("every single saved edit, listed by time") would
 * add `every_edit` here and a revision list from the model server.
 */
export type VersionSource = 'now' | 'saved' | 'issued'

export const VERSION_SOURCES: readonly VersionSource[] = ['now', 'saved', 'issued']

/** An issued drawing set, as the Views & Sheets history lists it. */
export interface IssuedSet {
  readonly issueId: string
  readonly name: string
  readonly modelRevision: number
  readonly issuedAt: string
  readonly issuedByName?: string
}

export type VersionEntry =
  | { readonly kind: 'now'; readonly key: 'now'; readonly revision: number; readonly label: string; readonly detail: string }
  | { readonly kind: 'saved'; readonly key: string; readonly revision: number; readonly label: string; readonly detail: string; readonly version: SavedVersion }
  | { readonly kind: 'issued'; readonly key: string; readonly revision: number; readonly label: string; readonly detail: string; readonly set: IssuedSet }

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The Versions list, newest first: "Now" on top, then saved versions and issued sets by revision. */
export function versionEntries(input: {
  readonly head: number
  readonly saved: readonly SavedVersion[]
  readonly issued: readonly IssuedSet[]
  readonly sources?: readonly VersionSource[]
  /** Display names for the people who saved versions (unknown ids are shown as "someone"). */
  readonly names?: Readonly<Record<string, string>>
}): VersionEntry[] {
  const sources = new Set(input.sources ?? VERSION_SOURCES)
  const rows: VersionEntry[] = []
  if (sources.has('saved')) {
    for (const v of input.saved) {
      rows.push({ kind: 'saved', key: `saved:${v.versionId}`, revision: v.revision, label: v.name, detail: `Saved version ${v.revision}, ${when(v.savedAt)} by ${input.names?.[v.savedBy] ?? 'someone on the project'}`, version: v })
    }
  }
  if (sources.has('issued')) {
    for (const s of input.issued) {
      rows.push({ kind: 'issued', key: `issued:${s.issueId}`, revision: s.modelRevision, label: s.name, detail: `Issued set, version ${s.modelRevision}, ${when(s.issuedAt)}${s.issuedByName ? ` by ${s.issuedByName}` : ''}`, set: s })
    }
  }
  rows.sort((a, b) => b.revision - a.revision || a.label.localeCompare(b.label))
  return sources.has('now') ? [{ kind: 'now', key: 'now', revision: input.head, label: 'Now', detail: `The model as it is (version ${input.head})` }, ...rows] : rows
}
