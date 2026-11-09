import { isBranchId } from '@permitzip/bim-kernel'

/**
 * Which branch the Building Model has open, as `?branch=<id>` on its address.
 * The page writes it, so a host that bookmarks the page's address per agent
 * thread knows which branch the operator is on, and that thread's agent edits
 * that branch.
 */
export const BRANCH_PARAM = 'branch'

const PLACEHOLDER_ORIGIN = 'https://host.invalid'

/** The branch id in an address (absolute or relative), or null for Main or an unusable value. */
export function branchIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null
  let url: URL
  try {
    url = new URL(href, PLACEHOLDER_ORIGIN)
  } catch (err) {
    console.error('[branch-href] not an address; treating it as Main', { href, err })
    return null
  }
  const value = url.searchParams.get(BRANCH_PARAM)
  return value && isBranchId(value) ? value : null
}

/** The same address with the branch set (null: Main, the parameter removed). Keeps a relative address relative. */
export function withBranch(href: string, branchId: string | null): string {
  const url = new URL(href, PLACEHOLDER_ORIGIN)
  if (branchId) url.searchParams.set(BRANCH_PARAM, branchId)
  else url.searchParams.delete(BRANCH_PARAM)
  const relative = `${url.pathname}${url.search}${url.hash}`
  return url.origin === PLACEHOLDER_ORIGIN && !/^https?:/i.test(href) ? relative : url.toString()
}
